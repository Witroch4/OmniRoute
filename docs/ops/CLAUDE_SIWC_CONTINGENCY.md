---
title: "Claude Code contingency through Witdev SIWC"
---

# Claude Code contingency through Witdev SIWC

The Claude Code provider page has an opt-in **SIWC contingency · Terra latest** switch.
When enabled, authorized Claude Code Opus, Sonnet and Haiku requests use the configured
Witdev Platform Sign in with ChatGPT target. Existing client URLs, model names and tool
executors remain the same. Disabling the switch restores the existing Claude route.

The target is an ordinary encrypted OpenAI-compatible connection to the platform
LiteLLM inference ingress, serving `witdev_siwc/gpt-terra-latest`. The SIWC gateway
resolves that alias against the account's current visible Terra models. OAuth refresh
credentials stay with the single existing SIWC gateway; OM stores only a restricted
LiteLLM virtual key.

Persisted `/api/settings` configuration:

```json
{
  "claudeSiwcContingency": {
    "enabled": false,
    "targetModel": "siwc/witdev_siwc/gpt-terra-latest",
    "connectionId": "<configured-connection-id>"
  }
}
```

Witdev's provisioning command is `scripts/siwc/provision_om_contingency.py` in
`witdev-platform-core`. It registers the target, copies the resolved model's existing
equivalent-price record, tests the connection, and leaves the switch off. The ingress
accepts only inference and model-listing paths; it exposes no LiteLLM management API.

The original request's endpoint, model, blocked/hidden model, connection and quota-scope
authorization still applies. Only the exact operator-configured target is granted as an
internal replacement. Missing or unavailable target configuration fails explicitly.
Existing normalized USD accounting and client model echo use the originally requested
Claude model; logs record the actual SIWC target. Responses carry
`X-OmniRoute-Contingency: claude-siwc`.

Combos defer source Claude availability checks while this switch is active; target
availability is checked during actual dispatch. A depleted source account must not make
the combo skip the SIWC replacement. Explicit combo policy and key admission remain in
force, and SIWC failures must not change Claude's breaker or cooldown state.

Function tools remain client-executed. The SIWC gateway groups them into a collision-free
namespace and preserves names, arguments and call IDs through JSON and streaming turns.
Hosted tools unsupported by SIWC fail explicitly. Tool capability is not a promise of
every provider-specific hosted feature.

Focused coverage lives in `tests/unit/claude-siwc-contingency.test.ts`. The platform's
`scripts/siwc/claude_code_tools_smoke.py` exercises real Claude Code Read, Write, Edit
and Bash calls against a disposable fixture; the operator enables contingency for
that test and restores its prior setting afterward.
