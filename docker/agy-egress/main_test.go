package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type recordedRequest struct {
	method        string
	url           string
	header        http.Header
	contentLength int64
	body          string
}

type recordingTransport struct {
	got      *recordedRequest
	status   int
	respBody string
	respHdr  http.Header
}

func (rt *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body := ""
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		body = string(raw)
	}
	rt.got = &recordedRequest{
		method:        req.Method,
		url:           req.URL.String(),
		header:        req.Header.Clone(),
		contentLength: req.ContentLength,
		body:          body,
	}
	hdr := rt.respHdr
	if hdr == nil {
		hdr = http.Header{"Content-Type": {"application/json"}}
	}
	return &http.Response{
		StatusCode: rt.status,
		Header:     hdr,
		Body:       io.NopCloser(strings.NewReader(rt.respBody)),
		Request:    req,
	}, nil
}

const testToken = "0123456789abcdef-test"

func newTestEgress(rt *recordingTransport) *egress {
	return &egress{token: []byte(testToken), client: &http.Client{Transport: rt}, scheme: "https"}
}

func forward(e *egress, method, path, host, token, body string, extra map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set(headerHost, host)
	req.Header.Set(headerToken, token)
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

var nodeFetchHeaders = map[string]string{
	"User-Agent":      "antigravity/cli/1.4.7 (aidev_client; os_type=linux; arch=arm64; cl=1006008713; auth_method=consumer)",
	"Authorization":   "Bearer tok",
	"Content-Type":    "application/json",
	"Accept-Encoding": "gzip",
	"Accept":          "*/*",
	"Accept-Language": "*",
	"Sec-Fetch-Mode":  "cors",
	"Connection":      "keep-alive",
	"X-Extra":         "leak",
}

func TestGenerationIsChunkedWithOnlyTheCLIHeaders(t *testing.T) {
	rt := &recordingTransport{status: 200, respBody: "data: {}\n\n"}
	rec := forward(newTestEgress(rt), "POST", "/v1internal:streamGenerateContent?alt=sse",
		"daily-cloudcode-pa.googleapis.com", testToken, `{"request":{}}`, nodeFetchHeaders)

	if rec.Code != 200 || rec.Body.String() != "data: {}\n\n" {
		t.Fatalf("unexpected response %d %q", rec.Code, rec.Body.String())
	}
	if rt.got.url != "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse" {
		t.Fatalf("target %q", rt.got.url)
	}
	if rt.got.contentLength != -1 {
		t.Fatalf("generation must be chunked (unknown length), got %d", rt.got.contentLength)
	}
	if rt.got.body != `{"request":{}}` {
		t.Fatalf("body %q", rt.got.body)
	}
	want := map[string]bool{"User-Agent": true, "Authorization": true, "Content-Type": true}
	for name := range rt.got.header {
		if !want[name] {
			t.Fatalf("header %q must not reach Google (Node fetch artefact or internal)", name)
		}
	}
	if len(rt.got.header) != 3 {
		t.Fatalf("expected exactly the 3 CLI headers, got %v", rt.got.header)
	}
}

func TestMetadataKeepsAContentLength(t *testing.T) {
	rt := &recordingTransport{status: 200, respBody: `{"ok":true}`}
	forward(newTestEgress(rt), "POST", "/v1internal:loadCodeAssist", "daily-cloudcode-pa.googleapis.com",
		testToken, `{"metadata":{"ideType":"ANTIGRAVITY"}}`, nodeFetchHeaders)
	if rt.got.contentLength != int64(len(`{"metadata":{"ideType":"ANTIGRAVITY"}}`)) {
		t.Fatalf("metadata call must carry its length, got %d", rt.got.contentLength)
	}
}

func TestRejectsWrongTokenAndForeignHosts(t *testing.T) {
	rt := &recordingTransport{status: 200}
	e := newTestEgress(rt)
	if rec := forward(e, "GET", "/x", "daily-cloudcode-pa.googleapis.com", "wrong-token-xxxxxxxx", "", nil); rec.Code != 401 {
		t.Fatalf("wrong token: %d", rec.Code)
	}
	if rec := forward(e, "GET", "/x", "example.com", testToken, "", nil); rec.Code != 403 {
		t.Fatalf("foreign host: %d", rec.Code)
	}
	if rt.got != nil {
		t.Fatal("nothing may be sent upstream for a refused call")
	}
}

func TestPassesStatusAndRetryAfterButNotHopByHop(t *testing.T) {
	rt := &recordingTransport{
		status:   429,
		respBody: `{"error":{"code":429}}`,
		respHdr: http.Header{
			"Content-Type":   {"application/json"},
			"Retry-After":    {"7"},
			"Connection":     {"close"},
			"Content-Length": {"22"},
		},
	}
	rec := forward(newTestEgress(rt), "POST", "/v1internal:streamGenerateContent?alt=sse",
		"daily-cloudcode-pa.googleapis.com", testToken, "{}", nodeFetchHeaders)
	if rec.Code != 429 || rec.Header().Get("Retry-After") != "7" {
		t.Fatalf("status/Retry-After lost: %d %v", rec.Code, rec.Header())
	}
	if rec.Header().Get("Connection") != "" {
		t.Fatal("hop-by-hop header leaked")
	}
}

func TestTokenIsOptional(t *testing.T) {
	rt := &recordingTransport{status: 200}
	e := &egress{client: &http.Client{Transport: rt}, scheme: "https"}
	if rec := forward(e, "POST", "/v1internal:loadCodeAssist", "daily-cloudcode-pa.googleapis.com", "", "{}", nil); rec.Code != 200 {
		t.Fatalf("no token configured: %d", rec.Code)
	}
}

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestEgress(&recordingTransport{}).ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != 200 {
		t.Fatalf("healthz %d", rec.Code)
	}
}
