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
  // Anthropic-native shim: the only Copilot endpoint that surfaces prompt-cache
  // token counts (cached_tokens) for Claude models, and avoids round-tripping
  // tool_use/tool_result/thinking content blocks through the OpenAI shape.
  // Routed via each claude-* model's targetFormat: "claude" below (see
  // executors/github.ts buildUrl/buildHeaders). Port of decolua/9router#2608.
  messagesUrl: "https://api.githubcopilot.com/v1/messages",
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
  // All claude-* entries below carry targetFormat: "claude" so chatCore.ts
  // translates the request to Anthropic-native shape before the executor ever
  // sees it, and the github executor's buildUrl()/buildHeaders() route them at
  // messagesUrl (/v1/messages) instead of /chat/completions. Port of
  // decolua/9router#2608 (author: yidecode) — see executors/github.ts.
  // Limits and capabilities verified against Copilot /models on 2026-09-05.
  // Grok 4.6 was absent; its existing metadata is retained.
  //
  // Fork: this list is the fork account's own Copilot picker, not upstream's
  // curated fifteen. Upstream entries this account cannot call (policy.state
  // "disabled" → `400 The requested model is not supported`, measured 2026-09-03
  // and 2026-10-12: gpt-6-astra, gpt-5.6-sol, claude-fable-5.1, claude-opus-5)
  // stay out; GitHub's announced retirements (registry/github/retiredModels.ts)
  // were dropped from it in the 3.8.53 sync. The order is locked against
  // GITHUB_COPILOT_STATIC_FALLBACK_MODELS (services/githubCopilotModels.ts).
  models: [
    {
      id: "claude-fable-5",
      name: "Claude Fable 5",
      targetFormat: "claude",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    {
      id: "claude-opus-4.8-fast",
      name: "Claude Opus 4.8 (fast mode)",
      targetFormat: "claude",
      contextLength: 1000000,
      maxOutputTokens: 64000,
      unsupportedParams: ["temperature", "top_p", "top_k"],
      maxInputTokens: 936000,
      toolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsXHighEffort: true,
      supportedThinkingEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      targetFormat: "claude",
      contextLength: 1000000,
      maxOutputTokens: 64000,
      unsupportedParams: ["temperature", "top_p", "top_k"],
      maxInputTokens: 936000,
      toolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsXHighEffort: true,
      supportedThinkingEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      targetFormat: "claude",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    // 2026-10-12: policy.state="enabled", picker=true, multiplier 1; limits are the ones
    // GET api.githubcopilot.com/models reports (328000 context / 128000 output),
    // /v1/messages + /chat/completions only (Claude never goes to /responses on
    // Copilot). Answered a real completion through OmniRoute the same day.
    // unsupportedParams mirrors the claude/anthropic registries' claude-sonnet-5-5.
    // Copilot's id is dotted (`claude-sonnet-5.5`); upstream's dashed
    // `claude-sonnet-5-5` is not what this account's /models lists.
    {
      id: "claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      targetFormat: "claude",
      contextLength: 328000,
      maxOutputTokens: 128000,
      // Sonnet 5.5 caps effort at xhigh (same tiers as the claude/anthropic entries).
      supportedThinkingEfforts: ["low", "medium", "high", "xhigh"],
      unsupportedParams: ["temperature", "top_p", "top_k"],
    },
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      targetFormat: "claude",
      contextLength: 1000000,
      maxOutputTokens: 64000,
      maxInputTokens: 936000,
      toolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsXHighEffort: true,
      supportedThinkingEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    // 2026-10-12: GET api.githubcopilot.com/models on this account lists it with
    // policy.state="enabled", model_picker_enabled=true, billing multiplier 1,
    // supported_endpoints ["/v1/messages", "/chat/completions"] and limits
    // 200000 context / 100000 output (numbers below are those limits, not the
    // 1M/128K Anthropic publishes for the first-party API). Claude never goes to
    // /responses on Copilot (see GithubExecutor.supportsResponsesEndpoint).
    // Anthropic documents non-default temperature/top_p/top_k as 400 on Haiku 5.5;
    // stripped here defensively (not probed through Copilot: the account's
    // monthly premium quota was exhausted when this was registered).
    {
      id: "claude-haiku-5.5",
      name: "Claude Haiku 5.5",
      targetFormat: "claude",
      contextLength: 200000,
      maxOutputTokens: 100000,
      unsupportedParams: ["temperature", "top_p", "top_k"],
    },
    {
      id: "claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      targetFormat: "claude",
      contextLength: 144000,
      maxOutputTokens: 32000,
      maxInputTokens: 128000,
      toolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
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
    // gemini-3.8-flash: the fork measured 265536 context on 2026-09-03; upstream's
    // capture two days later (tests/fixtures/providers/github-copilot-capabilities.json)
    // reports 1048576 / 983040 prompt, which is what is kept here.
    {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      contextLength: 1048576,
      maxOutputTokens: 65536,
      targetFormat: "openai",
      maxInputTokens: 983040,
      toolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportedThinkingEfforts: ["low", "medium", "high"],
    },
    {
      id: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
    // 2026-10-12: policy.state="enabled", picker=true, multiplier 1. /responses
    // only (supported_endpoints ["/responses", "ws:/responses"]; no
    // /chat/completions), 400000 context / 128000 output per capabilities.limits.
    {
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      targetFormat: "openai-responses",
      contextLength: 400000,
      maxOutputTokens: 128000,
    },
    {
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      targetFormat: "openai-responses",
      maxOutputTokens: 128000,
      contextLength: 1050000,
      maxInputTokens: 922000,
      toolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsXHighEffort: true,
      supportedThinkingEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      targetFormat: "openai-responses",
      maxOutputTokens: 128000,
      contextLength: 1050000,
      maxInputTokens: 922000,
      toolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsXHighEffort: true,
      supportedThinkingEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    // xAI Grok on Copilot — /responses-only (supported_endpoints: ["/responses"];
    // 400 on /chat/completions). Distinct from xAI-direct (chat-capable) — see
    // the separate `xai` provider. Live-verified context 500k / output 128k.
    // grok-4.7: policy.state undefined (not gated), picker=true, /responses only,
    // 328000 context / 128000 output per capabilities.limits. Answered a real
    // completion through OmniRoute on 2026-10-12. ⚠️ No pricing row exists for ANY
    // Copilot grok id (4.5/4.6 either): cost resolves to "missing", i.e. US$0 in the
    // OM cost views. Not invented here — add a row once xAI publishes the price.
    {
      id: "grok-4.7",
      name: "Grok 4.7",
      targetFormat: "openai-responses",
      contextLength: 328000,
      maxOutputTokens: 128000,
    },
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
      maxInputTokens: 128000,
      toolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportedThinkingEfforts: ["low", "medium", "high"],
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
    // gpt-4.1: policy.state="enabled" but the account's /models lists no
    // supported_endpoints for it; it answers on /chat/completions (HTTP 200, verified
    // through OmniRoute 2026-10-12), so no targetFormat. Priced by the gh row.
    { id: "gpt-4.1", name: "GPT-4.1", contextLength: 128000, maxOutputTokens: 16384 },
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
      targetFormat: "openai",
      contextLength: 1048576,
      maxInputTokens: 917504,
      maxOutputTokens: 131072,
      toolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportedThinkingEfforts: ["low", "high", "max"],
    },
    {
      id: "mai-code-1-flash",
      name: "MAI-Code-1-Flash",
      targetFormat: "openai-responses",
      contextLength: 256000,
      maxOutputTokens: 128000,
    },
    // Copilot-side model selection (required for Copilot Free): chatCore resolves
    // `auto` to a concrete model via POST /auto before routing — see
    // handlers/chatCore/copilotAutoModel.ts. Vision is decided per request.
    { id: "auto", name: "Auto", toolCalling: true },
  ],
};
