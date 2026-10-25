// agy-egress re-originates OmniRoute's agy CLI traffic with Go's own net/http, so what
// reaches Google is built by the same runtime the official agy CLI is built with.
//
// Captured 2026-10-25 from agy 1.4.7 (see README.md): the CLI's Cloud Code client is a
// Go net/http client with a custom TLS config — a ClientHello with NO ALPN, so
// HTTP/1.1 — that writes `Host, User-Agent, Content-Length|Transfer-Encoding,
// Authorization, Content-Type, Accept-Encoding: gzip` in that order, streams the
// generation body chunked and lets the transport add and undo gzip. Node's fetch
// (undici) differs on every point: OpenSSL ClientHello offering h2, extra `accept`,
// `accept-language` and `sec-fetch-mode` headers, `connection: keep-alive`, its own
// header order. Those are not fixable from Node, so OmniRoute hands the request to
// this process and Go writes it.
//
// Protocol (internal network only): OmniRoute sends the request to
// http://<egress>/<original path and query> with `X-Agy-Egress-Host` (the Google host)
// and, when AGY_EGRESS_TOKEN is set, `X-Agy-Egress-Token`. Only User-Agent, Authorization and Content-Type are
// copied; Go adds Host, the body framing and Accept-Encoding itself. The response is
// streamed back as it arrives (SSE), already decompressed.
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	headerHost  = "X-Agy-Egress-Host"
	headerToken = "X-Agy-Egress-Token"
	maxBodySize = 64 << 20
)

// Hosts the official CLI talks to for Cloud Code and its OAuth client. Nothing else
// is reachable through this process.
var allowedHosts = map[string]bool{
	"daily-cloudcode-pa.googleapis.com":         true,
	"cloudcode-pa.googleapis.com":               true,
	"daily-cloudcode-pa.sandbox.googleapis.com": true,
	"oauth2.googleapis.com":                     true,
	"www.googleapis.com":                        true,
}

// The only request headers the CLI sets itself; Go's transport writes the rest.
var forwardedHeaders = []string{"User-Agent", "Authorization", "Content-Type"}

// Response headers that belong to this hop, not to the payload.
var hopByHop = map[string]bool{
	"Connection":          true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
	"Content-Length":      true,
}

// The CLI streams generation bodies (Transfer-Encoding: chunked); metadata calls
// carry a Content-Length.
func isGenerationPath(path string) bool {
	return strings.Contains(path, ":streamGenerateContent") ||
		strings.Contains(path, ":generateContent")
}

func newTransport(useEnvProxy bool) *http.Transport {
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		// A non-nil TLS config without NextProtos: no ALPN, HTTP/1.1 — like the CLI.
		TLSClientConfig:       &tls.Config{},
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 5 * time.Minute,
		ExpectContinueTimeout: time.Second,
	}
	if useEnvProxy {
		transport.Proxy = http.ProxyFromEnvironment
	}
	return transport
}

type egress struct {
	token  []byte
	client *http.Client
	scheme string // "https"; tests point it elsewhere
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{"code": status, "message": "agy-egress: " + message},
	})
}

func (e *egress) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/healthz" {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
		return
	}
	if len(e.token) > 0 && subtle.ConstantTimeCompare([]byte(r.Header.Get(headerToken)), e.token) != 1 {
		writeError(w, http.StatusUnauthorized, "bad token")
		return
	}
	host := strings.ToLower(strings.TrimSpace(r.Header.Get(headerHost)))
	if !allowedHosts[host] {
		writeError(w, http.StatusForbidden, "host not allowed")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodySize))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request body unreadable or too large")
		return
	}

	target := e.scheme + "://" + host + r.URL.RequestURI()
	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, reader)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad target")
		return
	}
	for _, name := range forwardedHeaders {
		if value := r.Header.Get(name); value != "" {
			req.Header.Set(name, value)
		}
	}
	if len(body) > 0 && isGenerationPath(r.URL.Path) {
		req.ContentLength = -1 // unknown length → chunked, as the CLI streams it
		req.GetBody = nil
	}

	started := time.Now()
	resp, err := e.client.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return // the caller went away; nothing to answer
		}
		log.Printf("%s %s%s -> upstream error: %v", r.Method, host, r.URL.Path, err)
		writeError(w, http.StatusBadGateway, "upstream request failed")
		return
	}
	defer resp.Body.Close()

	for name, values := range resp.Header {
		if hopByHop[http.CanonicalHeaderKey(name)] {
			continue
		}
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32<<10)
	var written int64
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				break
			}
			written += int64(n)
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			break
		}
	}
	log.Printf("%s %s%s -> %d %dms %dB", r.Method, host, r.URL.Path, resp.StatusCode,
		time.Since(started).Milliseconds(), written)
}

// healthcheck is the Docker HEALTHCHECK of the scratch image (no shell, no curl).
func healthcheck(listen string) int {
	addr := listen
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func main() {
	listen := os.Getenv("AGY_EGRESS_LISTEN")
	if listen == "" {
		listen = ":8787"
	}
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck(listen))
	}
	// Optional shared secret. The egress listens on the internal Docker network only and
	// reaches nothing but the Google hosts above; set it for defence in depth.
	token := os.Getenv("AGY_EGRESS_TOKEN")
	if token != "" && len(token) < 16 {
		log.Fatal("AGY_EGRESS_TOKEN, when set, must be 16+ chars")
	}
	// Only for fingerprint checks through a local capture proxy.
	useEnvProxy := os.Getenv("AGY_EGRESS_USE_ENV_PROXY") == "1"

	handler := &egress{
		token: []byte(token),
		client: &http.Client{
			Transport: newTransport(useEnvProxy),
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		scheme: "https",
	}
	server := &http.Server{
		Addr:              listen,
		Handler:           handler,
		ReadHeaderTimeout: 30 * time.Second,
	}
	log.Printf("agy-egress listening on %s", listen)
	log.Fatal(server.ListenAndServe())
}
