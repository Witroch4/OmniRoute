import type { RegistryEntry } from "../../../shared.ts";

// OpenCode Go v2 (2026-10-24). The official docs (https://opencode.ai/docs/go/) serve every model under
// `https://opencode.ai/inference/go/<format>/…` — one base per wire format — and no longer mention the
// old `https://opencode.ai/zen/go/v1`. `baseUrl` is the OpenAI base (chat completions and responses);
// OpencodeExecutor.buildUrl derives the Anthropic (`/anthropic/v1/messages`) and Google
// (`/google/v1beta/models/<id>:generateContent`) endpoints from it for models whose `targetFormat` says so.
// The model list and each model's format are copied from that page; nothing here is inferred from a name.
export const opencode_goProvider: RegistryEntry = {
  id: "opencode-go",
  alias: "opencode-go",
  format: "openai",
  executor: "opencode",
  baseUrl: "https://opencode.ai/inference/go/openai/v1",
  modelsUrl: "https://opencode.ai/inference/go/v1/models",
  // (#532) Key validation still hits the main zen endpoint (same key works for both tiers).
  testKeyBaseUrl: "https://opencode.ai/zen/v1",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  defaultContextLength: 200000,
  models: [
    // ── OpenAI chat completions ──────────────────────────────────────────────
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
    { id: "kimi-k3", name: "Kimi K3" },
    // Kimi chat traffic must use `kimi-k2.7-code`; the live API rejects the plain `kimi-k2.7` alias.
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "longcat-2.0", name: "LongCat 2.0" },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview (free)" },
    // Requires "Global" under Privacy → Regions in the OpenCode Console workspace, otherwise the
    // upstream answers 400 "This Go model requires Global regions" (measured 2026-10-24).
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", supportsReasoning: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supportsReasoning: true },
    // OpencodeExecutor rewrites these aliases to the canonical upstream id and injects reasoning_effort.
    { id: "deepseek-v4-pro-low", name: "DeepSeek V4 Pro (low effort)", supportsReasoning: true },
    {
      id: "deepseek-v4-pro-medium",
      name: "DeepSeek V4 Pro (medium effort)",
      supportsReasoning: true,
    },
    { id: "deepseek-v4-pro-high", name: "DeepSeek V4 Pro (high effort)", supportsReasoning: true },
    { id: "deepseek-v4-pro-max", name: "DeepSeek V4 Pro (max effort)", supportsReasoning: true },
    { id: "mimo-v2.6-flash", name: "MiMo-V2.6 Flash" },
    { id: "mimo-v2.6-pro", name: "MiMo-V2.6 Pro" },
    { id: "mimo-v2.5", name: "MiMo-V2.5" },
    { id: "mimo-v2.5-pro", name: "MiMo-V2.5-Pro" },
    { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash" },
    { id: "hy4-preview", name: "Hunyuan4 Preview" },
    { id: "hy3", name: "Hunyuan3" },
    { id: "step-5-preview", name: "Step 5 Preview" },
    { id: "beam-free", name: "Beam (free)" },
    // ── OpenAI responses ─────────────────────────────────────────────────────
    { id: "gpt-6-luna", name: "GPT-6 Luna", targetFormat: "openai-responses" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", targetFormat: "openai-responses" },
    { id: "grok-4.7", name: "Grok 4.7", targetFormat: "openai-responses" },
    {
      id: "muse-spark-1.3-contributor",
      name: "Muse Spark 1.3 (contributor)",
      targetFormat: "openai-responses",
    },
    {
      id: "muse-spark-1.2-contributor",
      name: "Muse Spark 1.2 (contributor)",
      targetFormat: "openai-responses",
    },
    // ── Anthropic messages ───────────────────────────────────────────────────
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", targetFormat: "claude" },
    // #3110: MiniMax M3 via OpenCode Go tier
    {
      id: "minimax-m3",
      name: "MiniMax M3",
      targetFormat: "claude",
      contextLength: 1048576,
      supportsVision: true,
    },
    // Issue #2822: these Qwen models are text-only — supportsVision: false keeps combo routing from
    // sending image blocks to a vision-incapable upstream.
    { id: "qwen3.8-max", name: "Qwen3.8 Max", targetFormat: "claude", supportsVision: false },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", targetFormat: "claude", supportsVision: false },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus", targetFormat: "claude", supportsVision: false },
    // ── Google ───────────────────────────────────────────────────────────────
    // "Contributor": served only to workspaces that allow paid endpoints that train on request data.
    {
      id: "gemini-4-argon-contributor",
      name: "Gemini 4 Argon (contributor)",
      targetFormat: "gemini",
    },
  ],
};
