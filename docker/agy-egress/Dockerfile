# agy-egress — see README.md. Go 1.27 is pinned on purpose: its default crypto/tls
# ClientHello matched the official agy CLI 1.4.7 byte for byte in the 2026-10-25
# capture (Go 1.26 lacked the ML-DSA signature schemes the CLI advertises). Re-run
# the capture before changing it.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOTOOLCHAIN=local \
    go build -trimpath -ldflags="-s -w" -o /out/agy-egress .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/agy-egress /agy-egress
USER 65534:65534
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["/agy-egress", "-healthcheck"]
ENTRYPOINT ["/agy-egress"]
