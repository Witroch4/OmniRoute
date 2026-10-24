---
title: Codex principal account quota reset
---

# Codex principal account quota reset

The operator requires the existing `GET /api/usage/om-usage?provider=codex` command to
follow Prolite, the principal Codex account. Every Codex API key must use that
account's observed reset boundary for its USD quota. Spend remains aggregated
across all connections, including Go; model budget routing shares that boundary.

Persist `providerQuotaResetReferences` in the existing settings store. Each provider
reference explicitly names its connection, quota window and duration. Configure
Codex to the production Prolite connection's `session` window, duration seven days.
Do not hardcode production IDs or infer the principal account from array order,
remaining quota or plan names. An explicit connection query can still inspect Go
without changing the API key's billing boundary.

Resolve provider scope from the key's model permissions when no provider is passed.
Never borrow another provider's reset when a provider is explicitly scoped. Read
newer persisted quota snapshots over an older dashboard cache. Recover existing
reset observations and record subsequent principal-window resets, including early
credit resets. Timestamp changes without replenishment must not erase spend.

Preserve existing Claude windows, cutoff masking, normalized billing, key limits,
family rules, minimum spend and model/account permissions. A principal account
may define a provider billing cycle even for keys restricted to another account;
it does not grant access to that principal account for inference.

Validate with real SQLite spend on both Codex accounts before/after an observed
reset, multiple keys, stale caches, early resets, cutoff exhaustion, explicit Go
inspection, malformed references and unchanged Claude behavior. Push exact source,
build ARM64 on ryzenwit, back up production, deploy and verify the original command.
