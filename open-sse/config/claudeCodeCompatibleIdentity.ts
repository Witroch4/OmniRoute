import {
  CLAUDE_CODE_CLIENT_VERSION,
  CLAUDE_CODE_RUNTIME_VERSION,
  CLAUDE_CODE_SDK_PACKAGE_VERSION,
  getClaudeCodeClientVersion,
  getClaudeCodeUserAgent,
} from "@/shared/constants/claudeCodeClient";

export const CLAUDE_CODE_COMPATIBLE_VERSION = CLAUDE_CODE_CLIENT_VERSION;
export function getClaudeCodeCompatibleVersion(): string {
  return getClaudeCodeClientVersion();
}
/** Module-load snapshot. Wire UA uses getClaudeCodeUserAgent("sdk-cli"). */
export const CLAUDE_CODE_COMPATIBLE_USER_AGENT = getClaudeCodeUserAgent("sdk-cli");
export { getClaudeCodeUserAgent };
export const CLAUDE_CODE_COMPATIBLE_STAINLESS_PACKAGE_VERSION = CLAUDE_CODE_SDK_PACKAGE_VERSION;
export const CLAUDE_CODE_COMPATIBLE_STAINLESS_RUNTIME_VERSION = CLAUDE_CODE_RUNTIME_VERSION;
// Fork: Claude Haiku 5.5 (1M context, registered in the claude/anthropic catalogs) is served at 1M
// without the `context-1m` beta — prompts over 300K went through OM with no beta header — so it is
// native like Opus 5.5 and Fable 5.1, not a beta-gated Sonnet.
const CONTEXT_1M_NATIVE_MODELS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-haiku-5-5",
];

export function modelHasNativeContext1m(model: string | null | undefined): boolean {
  const normalizedModel = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^.*?(?=claude-)/, "")
    .replace(/(\d)\.(\d)/g, "$1-$2")
    .replace(/-\d{8}$/, "");

  return CONTEXT_1M_NATIVE_MODELS.some(
    (supported) =>
      normalizedModel === supported ||
      (normalizedModel.startsWith(`${supported}-`) &&
        !/^\d/.test(normalizedModel.slice(supported.length + 1)))
  );
}
