import type { RegistryEntry } from "../../shared.ts";
import {
  GPT_5_5_CODEX_CAPABILITIES,
  getGitHubCopilotChatHeaders,
  resolvePublicCred,
} from "../../shared.ts";

export const githubProvider: RegistryEntry = {
  id: "github",
  alias: "gh",
  format: "openai",
  executor: "github",
  baseUrl: "https://api.githubcopilot.com/chat/completions",
  responsesBaseUrl: "https://api.githubcopilot.com/responses",
  authType: "oauth",
  authHeader: "bearer",
  // GitHub Copilot is a public device-flow OAuth client: it has a public client_id but
  // NO client_secret. Populate clientId so token refresh carries it (9router#442) — without
  // it, refresh requests omit/garble client_id and GitHub rejects them. Embedded via
  // resolvePublicCred per Hard Rule #11 (never a string literal).
  oauth: {
    clientIdEnv: "GITHUB_OAUTH_CLIENT_ID",
    clientIdDefault: resolvePublicCred("github_copilot_id"),
  },
  defaultContextLength: 128000,
  headers: getGitHubCopilotChatHeaders(),
  models: [
    {
      id: "claude-fable-5",
      name: "Claude Fable 5",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    {
      id: "claude-opus-4.8-fast",
      name: "Claude Opus 4.8 (fast mode)",
      contextLength: 1000000,
      maxOutputTokens: 64000,
      unsupportedParams: ["temperature", "top_p", "top_k"],
    },
    {
      id: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      contextLength: 1000000,
      maxOutputTokens: 64000,
      unsupportedParams: ["temperature", "top_p", "top_k"],
    },
    {
      id: "claude-opus-4.7",
      name: "Claude Opus 4.7",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    {
      id: "claude-opus-4.5",
      name: "Claude Opus 4.5",
      contextLength: 200000,
      maxOutputTokens: 32000,
    },
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    {
      id: "claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      contextLength: 200000,
      maxOutputTokens: 32000,
    },
    {
      id: "claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      contextLength: 200000,
      maxOutputTokens: 32000,
    },
    // #2911: Gemini on Copilot must use chat/completions, not the Responses API.
    {
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    {
      id: "gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    { id: "gpt-5.5", name: "GPT-5.5", ...GPT_5_5_CODEX_CAPABILITIES, maxOutputTokens: 128000 },
    // Ported from upstream: models this GitHub Copilot account serves but the
    // fork's registry never listed. Kept to the account's own picker.
    //
    // 2026-09-03: the account's own GET /models is the machine-readable arbiter
    // here — each entry carries `policy.state` and `model_picker_enabled`, and
    // `capabilities.limits` gives the real ceilings (which is where the numbers
    // below come from; do not copy them from a sibling model). Measured on that
    // response, claude-opus-5, claude-fable-5.1 and gpt-5.6-sol are
    // policy.state="disabled" / picker=false and answer
    // `400 The requested model is not supported.` when called anyway — that 400
    // is GitHub enforcing account policy, not something a registry entry can
    // fix, so they stay out until enabled on the GitHub side. gemini-3.8-flash
    // and kimi-k3 are policy.state="enabled" and both answered a real
    // completion, so they come in.
    {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      contextLength: 265536,
      maxOutputTokens: 65536,
    },
    {
      id: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    {
      id: "gemini-3.6-flash",
      name: "Gemini 3.6 Flash",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    {
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      targetFormat: "openai-responses",
      maxOutputTokens: 128000,
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      targetFormat: "openai-responses",
      maxOutputTokens: 128000,
    },
    // xAI Grok on Copilot — /responses-only (supported_endpoints: ["/responses"];
    // 400 on /chat/completions). Distinct from xAI-direct (chat-capable) — see
    // the separate `xai` provider. Live-verified context 500k / output 128k.
    {
      id: "grok-4.6",
      name: "Grok 4.6",
      targetFormat: "openai-responses",
      contextLength: 500000,
      maxOutputTokens: 128000,
    },
    {
      id: "grok-4.5",
      name: "Grok 4.5",
      targetFormat: "openai-responses",
      contextLength: 500000,
      maxOutputTokens: 128000,
    },
    // MAI (Microsoft AI) — /responses-only on Copilot (400 on /chat/completions).
    {
      id: "mai-code-1.1-flash",
      name: "MAI-Code-1.1-Flash",
      targetFormat: "openai-responses",
      contextLength: 256000,
      maxOutputTokens: 128000,
    },
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      targetFormat: "openai-responses",
      supportsXHighEffort: true,
      contextLength: 1050000,
      maxOutputTokens: 128000,
    },
    {
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      targetFormat: "openai-responses",
      contextLength: 400000,
      maxOutputTokens: 128000,
    },
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3-Codex",
      targetFormat: "openai-responses",
      contextLength: 400000,
      maxOutputTokens: 128000,
    },
    {
      id: "gpt-5-mini",
      name: "GPT-5 mini",
      targetFormat: "openai-responses",
      contextLength: 264000,
      maxOutputTokens: 64000,
    },
    {
      id: "gpt-4o-2024-11-20",
      name: "GPT-4o",
      contextLength: 128000,
      maxOutputTokens: 16384,
    },
    { id: "gpt-4o-mini", name: "GPT-4o mini", contextLength: 128000, maxOutputTokens: 4096 },
    {
      id: "gpt-4-0125-preview",
      name: "GPT 4 Turbo",
      contextLength: 128000,
      maxOutputTokens: 4096,
    },
    {
      id: "kimi-k3",
      name: "Kimi K3",
      contextLength: 1048576,
      maxOutputTokens: 131072,
    },
    {
      id: "kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      contextLength: 256000,
      maxOutputTokens: 32000,
    },
    {
      id: "mai-code-1-flash",
      name: "MAI-Code-1-Flash",
      targetFormat: "openai-responses",
      contextLength: 256000,
      maxOutputTokens: 128000,
    },
    {
      id: "oswe-vscode-prime",
      name: "Raptor mini",
      targetFormat: "openai-responses",
      contextLength: 264000,
      maxOutputTokens: 64000,
    },
  ],
};
