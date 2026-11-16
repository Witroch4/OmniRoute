/**
 * "Codex only" key gate.
 *
 * A key whose endpoints are exactly the `chat:responses` subcategory (the
 * "OpenAI Responses (Codex)" checkbox, without the whole `chat` category) is
 * reserved for official Codex clients. The subcategory only proves the wire
 * protocol, so this gate also checks the client signature
 * (`evaluateCodexClientSignature`) on BOTH transports: HTTP `/v1/responses`
 * (handleChat) and the Responses WebSocket bridge.
 *
 * Mode (`CODEX_CLIENT_GATE_MODE`, no rebuild needed):
 * - `observe` (default): never blocks; every Responses call is evaluated and the
 *   caller logs the verdict, so real clients (IDE extension, desktop app) can be
 *   checked before enforcing.
 * - `enforce`: a Codex-only key whose call fails the signature is refused.
 * - `off`: nothing is evaluated.
 */

import { isCodexOnlyEndpointSelection } from "@/shared/constants/endpointCategories";
import {
  evaluateCodexClientSignature,
  type CodexClientSignatureResult,
} from "@/shared/utils/codexClientSignature";

export const CODEX_ONLY_MESSAGE =
  "Uso não permitido: esta chave é exclusiva do app Codex (Codex only). " +
  "A requisição não veio de um cliente Codex. / " +
  "Not allowed: this API key is restricted to the Codex app and the request is not from a Codex client.";

export type CodexGateMode = "observe" | "enforce" | "off";

type GateKeyInfo =
  | { id?: string | null; name?: string | null; allowedEndpoints?: string[] | null }
  | null
  | undefined;

export interface CodexGateObservation extends CodexClientSignatureResult {
  mode: CodexGateMode;
  codexOnlyKey: boolean;
  /** True when this call would be refused in `enforce` mode. */
  wouldBlock: boolean;
}

export type CodexOnlyGateVerdict =
  | { blocked: false; observation: CodexGateObservation | null }
  | { blocked: true; message: string; observation: CodexGateObservation };

export function codexGateMode(): CodexGateMode {
  const raw = (process.env.CODEX_CLIENT_GATE_MODE ?? "").trim().toLowerCase();
  if (raw === "enforce" || raw === "off") return raw;
  return "observe";
}

export function checkCodexOnlyGate(input: {
  apiKeyInfo: GateKeyInfo;
  headers: Pick<Headers, "get"> | null | undefined;
  body: unknown;
  mode?: CodexGateMode;
}): CodexOnlyGateVerdict {
  const mode = input.mode ?? codexGateMode();
  if (mode === "off") return { blocked: false, observation: null };

  const codexOnlyKey = Boolean(
    input.apiKeyInfo && isCodexOnlyEndpointSelection(input.apiKeyInfo.allowedEndpoints)
  );
  const result = evaluateCodexClientSignature(input.headers, input.body);
  const observation: CodexGateObservation = {
    ...result,
    mode,
    codexOnlyKey,
    wouldBlock: codexOnlyKey && !result.ok,
  };

  if (mode === "enforce" && observation.wouldBlock) {
    return { blocked: true, message: CODEX_ONLY_MESSAGE, observation };
  }
  return { blocked: false, observation };
}

/** One compact, secret-free line for logs. */
export function describeCodexGateObservation(
  observation: CodexGateObservation,
  keyInfo: GateKeyInfo,
  transport: "http" | "ws"
): string {
  const s = observation.signals;
  return (
    `codex-client-gate mode=${observation.mode} transport=${transport} ` +
    `key=${keyInfo?.id ?? "none"} name=${JSON.stringify(keyInfo?.name ?? null)} ` +
    `codexOnlyKey=${observation.codexOnlyKey} score=${observation.score}/7 ok=${observation.ok} ` +
    `wouldBlock=${observation.wouldBlock} originator=${JSON.stringify(observation.originator)} ` +
    `ua=${JSON.stringify(observation.userAgentProduct)} signals=` +
    `${s.installationId ? "I" : "-"}${s.turnMetadata ? "T" : "-"}` +
    `${s.originator ? "O" : "-"}${s.userAgent ? "U" : "-"}${s.sessionHeader ? "S" : "-"}`
  );
}
