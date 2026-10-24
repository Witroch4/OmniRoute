import type { RegistryEntry } from "../../shared.ts";
import {
  GPT_5_6_CODEX_CAPABILITIES,
  GPT_5_5_CODEX_CAPABILITIES,
  getCodexDefaultHeaders,
  resolvePublicCred,
} from "../../shared.ts";

export const codexProvider: RegistryEntry = {
  id: "codex",
  alias: "cx",
  format: "openai-responses",
  executor: "codex",
  // Codex /responses is upstream-streaming even when the client requested stream:false.
  // Mark it forceStream so chatCore drains terminal SSE into JSON instead of waiting for EOF.
  forceStream: true,
  baseUrl: "https://chatgpt.com/backend-api/codex/responses",
  reasoningTransport: "opaque",
  authType: "oauth",
  authHeader: "bearer",
  defaultContextLength: 400000,
  headers: getCodexDefaultHeaders(),
  oauth: {
    clientIdEnv: "CODEX_OAUTH_CLIENT_ID",
    clientIdDefault: resolvePublicCred("codex_id"),
    clientSecretEnv: "CODEX_OAUTH_CLIENT_SECRET",
    clientSecretDefault: "",
    tokenUrl: "https://auth.openai.com/oauth/token",
  },
  models: [
    // GPT-6 Astra — top of the Codex picker as of 2026-09-04.
    // ⚠️ The id was CONFIRMED by probing, not guessed from the display name:
    // `gpt-6-astra` came back with "The 'gpt-6-astra' model requires a newer
    // version of Codex. Please upgrade", while `gpt-6`, `astra` and the other
    // spellings answered "model is not supported". A version gate names the
    // model, so it reads exactly like a missing entitlement — same trap as the
    // Fable 5.1 400 in 2026-09-02. That is why the impersonated CLI version was
    // bumped alongside this entry (see config/codexClient.ts).
    // Astra shares GPT-5.6's Codex limits: the live OAuth catalog reports
    // max_context_window=872000 (context_window=272000 is the pricing tier).
    { id: "gpt-6-astra", name: "GPT 6 Astra", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6-astra-ultra", name: "GPT 6 Astra (Ultra)", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6-astra-max", name: "GPT 6 Astra (Max)", ...GPT_5_6_CODEX_CAPABILITIES },
    {
      id: "gpt-6-astra-xhigh",
      name: "GPT 6 Astra (xHigh)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      timeoutMs: 1200000,
    },
    {
      id: "gpt-6-astra-high",
      name: "GPT 6 Astra (High)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      timeoutMs: 1200000,
    },
    { id: "gpt-6-astra-medium", name: "GPT 6 Astra (Medium)", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6-astra-low", name: "GPT 6 Astra (Low)", ...GPT_5_6_CODEX_CAPABILITIES },
    // GPT-6 Sol / GPT-6 Luna — launched 2026-09-23. Ids and capabilities from
    // OpenAI's public manifest (codex-rs/models-manager/models.json): both have
    // context_window 272000 / max_context_window 872000 (the 5.6 profile);
    // Sol exposes low..ultra (6 tiers), Luna low..max (no ultra, like 5.6 Luna).
    // Both need minimal_client_version 0.155.0 — see config/codexClient.ts.
    // Fork order: newest first — GPT-6.1 Sol ahead of GPT-6 Sol (tests/unit/codex-gpt61-sol).
    // Sol and Luna report the same windows as Astra; the live catalog offers Sol at
    // low..ultra and Luna at low..max, like the GPT-5.6 Sol/Luna split.
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6.1-sol-ultra", name: "GPT 6.1 Sol (Ultra)", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6.1-sol-max", name: "GPT 6.1 Sol (Max)", ...GPT_5_6_CODEX_CAPABILITIES },
    {
      id: "gpt-6.1-sol-xhigh",
      name: "GPT 6.1 Sol (xHigh)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      timeoutMs: 1200000,
    },
    {
      id: "gpt-6.1-sol-high",
      name: "GPT 6.1 Sol (High)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      timeoutMs: 1200000,
    },
    { id: "gpt-6.1-sol-medium", name: "GPT 6.1 Sol (Medium)", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6.1-sol-low", name: "GPT 6.1 Sol (Low)", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6-sol", name: "GPT 6 Sol", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6-sol-ultra", name: "GPT 6 Sol (Ultra)", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6-sol-max", name: "GPT 6 Sol (Max)", ...GPT_5_6_CODEX_CAPABILITIES },
    {
      id: "gpt-6-sol-xhigh",
      name: "GPT 6 Sol (xHigh)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      timeoutMs: 1200000,
    },
    {
      id: "gpt-6-sol-high",
      name: "GPT 6 Sol (High)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      timeoutMs: 1200000,
    },
    { id: "gpt-6-sol-medium", name: "GPT 6 Sol (Medium)", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6-sol-low", name: "GPT 6 Sol (Low)", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6-luna", name: "GPT 6 Luna", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6-luna-max", name: "GPT 6 Luna (Max)", ...GPT_5_6_CODEX_CAPABILITIES },
    {
      id: "gpt-6-luna-xhigh",
      name: "GPT 6 Luna (xHigh)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      timeoutMs: 1200000,
    },
    {
      id: "gpt-6-luna-high",
      name: "GPT 6 Luna (High)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      timeoutMs: 1200000,
    },
    { id: "gpt-6-luna-medium", name: "GPT 6 Luna (Medium)", ...GPT_5_6_CODEX_CAPABILITIES },
    { id: "gpt-6-luna-low", name: "GPT 6 Luna (Low)", ...GPT_5_6_CODEX_CAPABILITIES },
    {
      id: "gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-sol-ultra",
      name: "GPT 5.6 Sol (Ultra)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-sol-max",
      name: "GPT 5.6 Sol (Max)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-sol-xhigh",
      name: "GPT 5.6 Sol (xHigh)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      // #6354: reasoning-heavy tier — more header-wait room than the global default.
      timeoutMs: 1200000,
    },
    {
      id: "gpt-5.6-sol-high",
      name: "GPT 5.6 Sol (High)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      // #6354: reasoning-heavy tier — more header-wait room than the global default.
      timeoutMs: 1200000,
    },
    {
      id: "gpt-5.6-sol-medium",
      name: "GPT 5.6 Sol (Medium)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-sol-low",
      name: "GPT 5.6 Sol (Low)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-terra",
      name: "GPT 5.6 Terra",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-terra-ultra",
      name: "GPT 5.6 Terra (Ultra)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-terra-max",
      name: "GPT 5.6 Terra (Max)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-terra-xhigh",
      name: "GPT 5.6 Terra (xHigh)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      // #6354: reasoning-heavy tier — more header-wait room than the global default.
      timeoutMs: 1200000,
    },
    {
      id: "gpt-5.6-terra-high",
      name: "GPT 5.6 Terra (High)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      // #6354: reasoning-heavy tier — more header-wait room than the global default.
      timeoutMs: 1200000,
    },
    {
      id: "gpt-5.6-terra-medium",
      name: "GPT 5.6 Terra (Medium)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-terra-low",
      name: "GPT 5.6 Terra (Low)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT 5.6 Luna",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-luna-max",
      name: "GPT 5.6 Luna (Max)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-luna-xhigh",
      name: "GPT 5.6 Luna (xHigh)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      // #6354: reasoning-heavy tier — more header-wait room than the global default.
      timeoutMs: 1200000,
    },
    {
      id: "gpt-5.6-luna-high",
      name: "GPT 5.6 Luna (High)",
      ...GPT_5_6_CODEX_CAPABILITIES,
      // #6354: reasoning-heavy tier — more header-wait room than the global default.
      timeoutMs: 1200000,
    },
    {
      id: "gpt-5.6-luna-medium",
      name: "GPT 5.6 Luna (Medium)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    {
      id: "gpt-5.6-luna-low",
      name: "GPT 5.6 Luna (Low)",
      ...GPT_5_6_CODEX_CAPABILITIES,
    },
    // gpt-5.5 codex OAuth backend caps context at 400K (not the public-API
    // 1.05M). Public refs : openai/codex#19208, #19319, #19464 ;
    // opencode#24171. max_output_tokens is stripped server-side
    // (litellm#21193, codex#4138) so 128K is informational only.
    // The usable INPUT budget is smaller than the 400K window (part is
    // reserved for output), so max_input_tokens must be distinct from
    // context_length or coding agents never auto-compact (#6191). OpenAI's
    // own live catalog reports ~272K for gpt-5.5 in Codex.
    {
      id: "gpt-5.5",
      name: "GPT 5.5",
      ...GPT_5_5_CODEX_CAPABILITIES,
      contextLength: 400000,
      // #6191: input cap per reporter; TODO confirm exact value
      maxInputTokens: 272000,
      maxOutputTokens: 128000,
    },
    {
      id: "gpt-5.5-xhigh",
      name: "GPT 5.5 (xHigh)",
      ...GPT_5_5_CODEX_CAPABILITIES,
      contextLength: 400000,
      // #6191: input cap per reporter; TODO confirm exact value
      maxInputTokens: 272000,
      maxOutputTokens: 128000,
      // #6354: reasoning-heavy tier — more header-wait room than the global default.
      timeoutMs: 1200000,
    },
    {
      id: "gpt-5.5-high",
      name: "GPT 5.5 (High)",
      ...GPT_5_5_CODEX_CAPABILITIES,
      contextLength: 400000,
      // #6191: input cap per reporter; TODO confirm exact value
      maxInputTokens: 272000,
      maxOutputTokens: 128000,
      // #6354: reasoning-heavy tier — more header-wait room than the global default.
      timeoutMs: 1200000,
    },
    {
      id: "gpt-5.5-medium",
      name: "GPT 5.5 (Medium)",
      ...GPT_5_5_CODEX_CAPABILITIES,
      contextLength: 400000,
      // #6191: input cap per reporter; TODO confirm exact value
      maxInputTokens: 272000,
      maxOutputTokens: 128000,
    },
    {
      id: "gpt-5.5-low",
      name: "GPT 5.5 (Low)",
      ...GPT_5_5_CODEX_CAPABILITIES,
      contextLength: 400000,
      // #6191: input cap per reporter; TODO confirm exact value
      maxInputTokens: 272000,
      maxOutputTokens: 128000,
    },
  ],
};
