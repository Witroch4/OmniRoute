# Microsoft 365 Copilot volume protection

The BizChat consumer endpoint can return a volume-limit notice as bot text or
`item.result.message`, even when the transport is successful. The M365 executor
normalizes the observed complete notice, structured throttle results, WebSocket
upgrade HTTP 429 and image-upload HTTP 429 into a rate-limit error.

An early throttle returns HTTP 429 with `Retry-After: 900`. This is an operator
cooling policy, not a Microsoft-published quota or guaranteed reset time. A
throttle after answer streaming begins is an SSE error carrying status 429 and
`retryAfterSeconds: 900`; an already-sent HTTP status cannot be changed.
Longer valid upstream `Retry-After` hints take precedence over this local minimum.

The existing connection cooldown is persisted in `rate_limited_until`, survives
restart, and is checked again at executor dispatch before uploading images or
opening a socket. This blocks requests selected before a previous turn was
throttled. Post-success cleanup uses the existing atomic conditional clear for
M365, so stale credentials cannot erase a newly written cooldown. Normal answers
quoting the notice as part of a larger answer remain valid.

For the active operator connection, enable protection using the dashboard toggle
or authenticated `POST /api/rate-limits` with `{ "connectionId": "<id>", "enabled": true }`.
Set queue overrides using authenticated `PUT /api/providers/{id}`:

```json
{
  "maxConcurrent": 1,
  "rateLimitOverrides": { "rpm": 2, "minTime": 30000, "maxConcurrent": 1 }
}
```

The provider-update route enables protection in memory when overrides change;
the rate-limits toggle persists it for restart. The provider-update schema does
not accept `rateLimitProtection`, so sending that field there does not save it.

`minTime` is in milliseconds. The top-level concurrency setting holds the
account semaphore through the whole streamed response; the override controls
the existing Bottleneck queue. These caps are local operator choices and do not
claim to describe Microsoft limits. They apply to text and image turns sharing
this connection. Chat activity in the Microsoft web UI also shares the account's
upstream limits and is outside OmniRoute's queue.

During a cooling period callers should honor `Retry-After`; avoid immediately
repeating rejected turns. After expiry a new request may be attempted through
the normal queue. Another upstream throttle starts a new cooling period. Do not
clear the persisted deadline or rotate credentials to bypass the restriction.

Regression coverage: `tests/unit/copilot-m365-protocol-smoke.test.ts` and
`tests/unit/rate-limit-manager.test.ts`, plus the existing auth recovery tests.
