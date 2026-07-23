# API-Key Quota-Preflight Bypass Design

## Problem

Provider quota preflight persists a shared connection cooldown in
`provider_connections.rate_limited_until` with
`last_error_source = "quota_preflight"`. An API key carrying
`policy:bypass-provider-quota` skips the quota-policy evaluator, but the normal
availability filter rejects that persisted cooldown first. Consequently, one
non-bypass request can globally block later bypass requests using the same
provider connection.

## Required Behavior

- Bypass remains request-scoped; enabling it must not clear shared database
  state.
- A request with `policy:bypass-provider-quota` may select a connection whose
  active cooldown was created by `quota_preflight`.
- Requests without bypass continue to honor that cooldown.
- Bypass must not ignore cooldowns created by actual upstream errors, including
  real HTTP 429 responses.
- Existing model lockouts, terminal connection states, connection exclusions,
  allowlists, and API-key USD limits remain unchanged.

## Design

Add a narrow eligibility predicate in the credential-selection service. The
predicate recognizes only an active connection cooldown whose
`lastErrorSource` is `quota_preflight`, and only returns true when the caller
set `bypassQuotaPolicy`.

Use the predicate in the normal connection availability filter. Do not mutate
the connection row and do not enable the broader
`allowRateLimitedConnections` option, because that option would also cross real
provider cooldowns.

## Rejected Alternatives

- Clear connection state when bypass is enabled: rejected because provider
  connections are shared by multiple API keys, so one key would alter routing
  for all callers.
- Treat bypass as `allowRateLimitedConnections`: rejected because it would
  hammer providers during real 429 cooldowns.
- Store cooldowns per API key: rejected as disproportionate schema and routing
  complexity for a request-scoped policy exception.

## Tests

Add behavioral coverage in `tests/unit/sse-auth.test.ts`:

1. A preflight-sourced cooldown is rejected without bypass and selected with
   bypass.
2. A real provider-sourced cooldown remains rejected with bypass.
3. The persisted connection state is unchanged after bypass selection.

Run the focused auth suite, bypass-scope suite, core typecheck, ESLint on
changed files, migration-numbering check, and the production build before
deployment.
