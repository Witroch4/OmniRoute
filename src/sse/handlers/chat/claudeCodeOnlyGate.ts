/**
 * "Claude Code only" key gate.
 *
 * A key whose endpoints are exactly the `chat:messages` subcategory (the
 * "Anthropic-native only (Claude Code)" checkbox) is reserved for the Claude Code
 * client. The subcategory only proves the wire protocol, so this gate also checks
 * the client signature (`evaluateClaudeCodeSignature`) and answers
 * "Uso não permitido" when it is missing — which is what stops a script or bot from
 * riding such a key.
 *
 * Runs in `handleChat` after the key policy and before any routing, on the body the
 * client actually sent. `/v1/messages/count_tokens` never reaches `handleChat`.
 *
 * Emergency off-switch (no rebuild): `CLAUDE_CODE_SIGNATURE_GATE_OFF=1` in the
 * container environment.
 */

import { isClaudeCodeOnlyEndpointSelection } from "@/shared/constants/endpointCategories";
import { evaluateClaudeCodeSignature } from "@/shared/utils/claudeCodeSignature";

export const CLAUDE_CODE_ONLY_MESSAGE =
  "Uso não permitido: esta chave é exclusiva do Claude Code (Claude Code only). " +
  "A requisição não veio de um cliente Claude Code. / " +
  "Not allowed: this API key is restricted to Claude Code and the request is not from a Claude Code client.";

type GateKeyInfo = { id?: string | null; allowedEndpoints?: string[] | null } | null | undefined;

export type ClaudeCodeOnlyGateVerdict =
  | { blocked: false }
  | { blocked: true; message: string; score: number; signals: Record<string, boolean> };

function gateDisabled(): boolean {
  const raw = process.env.CLAUDE_CODE_SIGNATURE_GATE_OFF;
  return typeof raw === "string" && /^(1|true|yes|on)$/i.test(raw.trim());
}

export function checkClaudeCodeOnlyGate(input: {
  apiKeyInfo: GateKeyInfo;
  headers: Pick<Headers, "get"> | null | undefined;
  body: unknown;
}): ClaudeCodeOnlyGateVerdict {
  if (!input.apiKeyInfo || !isClaudeCodeOnlyEndpointSelection(input.apiKeyInfo.allowedEndpoints)) {
    return { blocked: false };
  }
  if (gateDisabled()) return { blocked: false };

  const result = evaluateClaudeCodeSignature(input.headers, input.body);
  if (result.ok) return { blocked: false };
  return {
    blocked: true,
    message: CLAUDE_CODE_ONLY_MESSAGE,
    score: result.score,
    signals: { ...result.signals },
  };
}
