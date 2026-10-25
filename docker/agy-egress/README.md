# agy-egress

A tiny Go sidecar that re-originates OmniRoute's `agy` CLI-identity traffic with Go's
own `net/http`, so the connection Google sees is built by the same runtime the official
`agy` CLI is built with — not by Node's `fetch` (undici).

## Why

OmniRoute already sends the official CLI's User-Agent, headers and request body for the
`cli` client profile (`open-sse/config/antigravityCliClient.ts`,
`open-sse/services/antigravityCliEnvelope.ts`). But the **transport fingerprint** below
the application layer is the Node runtime's and cannot be changed from Node:

Captured 2026-10-25, `agy` 1.4.7 vs OmniRoute through the same local TLS-terminating
proxy (`handoffs/2026-10-25-agy-capture-proxy2.py`), nothing forwarded to Google for the
generation call:

| | official `agy` CLI | OmniRoute via Node `fetch` |
|---|---|---|
| TLS ClientHello ALPN | none (HTTP/1.1) | `h2`, `http/1.1` |
| ClientHello JA3 / groups / sig-algs | Go `crypto/tls` | OpenSSL (undici) — different |
| request headers | `Host, User-Agent, Content-Length\|Transfer-Encoding, Authorization, Content-Type, Accept-Encoding` | the above **plus** `connection: keep-alive`, `accept: */*`, `accept-language: *`, `sec-fetch-mode: cors` |

The CLI is a legitimate client of this account; the mismatch is a false-positive risk,
not a capability we lack. Routing those requests through Go closes it: with Go 1.27 the
sidecar's ClientHello matched the CLI's byte for byte (JA3, groups, signature algorithms)
and the header layout was identical, verified end to end with a real OmniRoute request.

## What it does

- Listens on the **internal Docker network only**. OmniRoute sends the original request
  to `http://<egress>/<path+query>` with `X-Agy-Egress-Host` (the Google host) and, when
  configured, `X-Agy-Egress-Token`.
- Forwards only `User-Agent`, `Authorization` and `Content-Type`; Go writes `Host`, the
  body framing (chunked for generation, `Content-Length` for metadata) and
  `Accept-Encoding` itself.
- Only five hosts are reachable (`daily-cloudcode-pa`, `cloudcode-pa`,
  `daily-cloudcode-pa.sandbox`, `oauth2.googleapis.com`, `www.googleapis.com`); anything
  else is refused without a connection.
- Streams the response back as it arrives (SSE), already decompressed.

Go 1.27 is pinned in the Dockerfile on purpose — Go 1.26's default ClientHello lacked the
ML-DSA signature schemes the CLI advertises. Re-run the capture before changing it.

## Build and run

```bash
docker build -t omniroute-agy-egress:local docker/agy-egress
```

`docker/agy-egress/compose.example.yml` has a service to merge into the OmniRoute
compose. Point OmniRoute at it with:

```
ANTIGRAVITY_EGRESS_URL=http://omniroute-agy-egress:8787
# ANTIGRAVITY_EGRESS_TOKEN=<16+ char secret>   # optional, set on both sides
```

When `ANTIGRAVITY_EGRESS_URL` is unset OmniRoute keeps egressing directly through Node;
when it is set the sidecar is mandatory for CLI-identity requests (they fail if it is
down rather than silently going out with Node's fingerprint).

## Limits to know

- **Mandatory once enabled.** With `ANTIGRAVITY_EGRESS_URL` set, CLI-identity requests that cannot reach the sidecar
  fail (HTTP 502/connection error) instead of falling back to Node's fingerprint. Rolling back is removing that one
  variable and recreating OmniRoute.
- **No per-connection proxy.** OmniRoute hands the request to the sidecar over the internal network, so an HTTP/SOCKS
  proxy assigned to the connection would apply to the hop to the sidecar, not to Google. The sidecar itself egresses
  directly (set `HTTPS_PROXY` on it with `AGY_EGRESS_USE_ENV_PROXY=1` if the host needs one).
- **Only the CLI identity is routed.** gemini-cli (same Google hosts, its own Node identity) and the legacy `ide`
  client profile keep using OmniRoute's own transport.
- **The token is optional.** The sidecar listens on the internal network only and reaches nothing but the five Google
  hosts above; `AGY_EGRESS_TOKEN` is defence in depth if other containers share that network.

## Re-running the fingerprint check

`handoffs/2026-10-25-agy-capture-proxy2.py <workdir> <port>` is a local TLS-terminating
proxy that records each client's ClientHello and headers and answers the generation call
itself (nothing reaches Google). Run the official CLI through it once
(`HTTPS_PROXY=http://127.0.0.1:<port> SSL_CERT_FILE=<workdir>/ca.pem agy -p ...`), then
the sidecar with `AGY_EGRESS_USE_ENV_PROXY=1` and the same proxy, and diff the recorded
`requests.jsonl`.
