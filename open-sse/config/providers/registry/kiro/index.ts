import type { RegistryEntry } from "../../shared.ts";
import { getKiroServiceHeaders } from "../../shared.ts";

export const kiroProvider: RegistryEntry = {
  id: "kiro",
  alias: "kr",
  format: "kiro",
  executor: "kiro",
  baseUrl: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
  authType: "oauth",
  authHeader: "bearer",
  defaultContextLength: 200000,
  headers: getKiroServiceHeaders(),
  oauth: {
    tokenUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
    authUrl: "https://prod.us-east-1.auth.desktop.kiro.dev",
  },
  // Model IDs must match Kiro's real upstream catalog exactly — an unknown id
  // makes Kiro return `400 "Invalid model. Please select a different model"`.
  // Fabricated ids (auto-kiro, claude-opus-4.x, claude-fable-5, claude-sonnet-4.6)
  // were removed after live VPS validation: Kiro offers no Opus/Fable, its Sonnet
  // is 4.5 (not 4.6), and there is no "auto" model id (it was sent verbatim and
  // 400'd). See kiro cluster #6112/#6113/#6099.
  //
  // 2026-07-25: "claude-sonnet-5" was re-validated live against a real Amazon Q
  // connection with healthy quota and consistently 400'd "Invalid model" — it is
  // not plan-gated, it simply does not exist in Kiro's current catalog (the live
  // Kiro app model picker lists "Claude Sonnet 4.5" and a separate "Claude Sonnet
  // 4" — a regular hybrid-reasoning tier — with no "Sonnet 5" entry at all).
  // Replaced with "claude-sonnet-4", confirmed live (200 OK) on the same account
  // that rejected "claude-sonnet-5".
  models: [
    {
      id: "claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      contextLength: 200000,
      maxOutputTokens: 64000,
    },
    {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      contextLength: 200000,
      maxOutputTokens: 64000,
    },
    {
      id: "claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      contextLength: 200000,
      maxOutputTokens: 64000,
    },
    { id: "deepseek-3.2", name: "DeepSeek V3.2" },
    { id: "minimax-m2.5", name: "MiniMax M2.5" },
    { id: "minimax-m2.1", name: "MiniMax M2.1" },
    { id: "glm-5", name: "GLM-5" },
    { id: "qwen3-coder-next", name: "Qwen3 Coder Next" },
  ],
};
