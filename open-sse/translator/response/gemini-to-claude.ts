import { register } from "../registry.ts";
import { FORMATS } from "../formats.ts";
import { isAbortFinishReason } from "../../utils/finishReason.ts";
import { restoreDeclaredToolName } from "../../services/declaredToolCasing.ts";
import {
  buildClaudeWebSearchBlockEvents,
  toClaudeWebSearchResults,
} from "../helpers/claudeServerWebSearch.ts";

/**
 * Web hits out of Gemini Google Search grounding metadata (`groundingChunks[].web`,
 * snake_case on some upstreams).
 */
function collectGroundingWebItems(grounding) {
  const chunks = grounding.groundingChunks || grounding.grounding_chunks;
  if (!Array.isArray(chunks)) return [];
  return chunks.map((chunk) => ({ url: chunk?.web?.uri, title: chunk?.web?.title }));
}

/**
 * Claude Code's built-in WebSearch reads its results from a paired
 * `server_tool_use` (name "web_search") + `web_search_tool_result` block, so a
 * Gemini/Antigravity response carrying `groundingMetadata` must surface that pair or
 * the CLI reports zero results. Emitted at most once per message; any open text block
 * is closed first so the pair takes fresh indices (upstream #16351).
 */
function emitGroundingWebSearch(candidate, state, results) {
  if (state.groundingProcessed) return;
  const grounding = candidate.groundingMetadata || candidate.grounding_metadata;
  if (!grounding || typeof grounding !== "object") return;
  const webResults = toClaudeWebSearchResults(collectGroundingWebItems(grounding));
  if (webResults.length === 0) return;

  if (state.openTextBlockIdx !== null) {
    results.push({ type: "content_block_stop", index: state.openTextBlockIdx });
    state.openTextBlockIdx = null;
  }

  const queries = grounding.webSearchQueries || grounding.web_search_queries;
  const query = Array.isArray(queries) && typeof queries[0] === "string" ? queries[0] : "";

  const { events, nextIndex } = buildClaudeWebSearchBlockEvents({
    query,
    results: webResults,
    startIndex: state.contentBlockIndex,
  });
  results.push(...events);
  state.contentBlockIndex = nextIndex;
  state.groundingProcessed = true;
}

/**
 * Direct Gemini → Claude response translator.
 * Converts Gemini streaming chunks directly to Claude Messages API
 * streaming events, skipping the OpenAI hub intermediate step.
 *
 * Fix (issue #253): Keep the text content_block open across streaming chunks
 * instead of opening+closing it on every chunk. This prevents Claude Code
 * from rendering each delta on a separate line.
 */
export function geminiToClaudeResponse(chunk, state) {
  if (!chunk) return null;

  // Handle Antigravity wrapper
  const response = chunk.response || chunk;
  if (!response || !response.candidates?.[0]) return null;

  const results = [];
  const candidate = response.candidates[0];
  const content = candidate.content;

  // ── Initialize: emit message_start ─────────────────────────────
  if (!state.messageId) {
    state.messageId = response.responseId || `msg_${Date.now()}`;
    state.model = response.modelVersion || "gemini";
    state.contentBlockIndex = 0;
    // Track open text block so we can keep it open across chunks
    state.openTextBlockIdx = null;

    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  // ── Process parts ──────────────────────────────────────────────
  if (content?.parts) {
    for (const part of content.parts) {
      const hasThoughtSig = part.thoughtSignature || part.thought_signature;
      const isThought = part.thought === true;

      // Thinking content → thinking block (always open+close per chunk)
      if (isThought && part.text) {
        // Close any open text block first
        if (state.openTextBlockIdx !== null) {
          results.push({ type: "content_block_stop", index: state.openTextBlockIdx });
          state.openTextBlockIdx = null;
        }
        const idx = state.contentBlockIndex++;
        results.push({
          type: "content_block_start",
          index: idx,
          content_block: { type: "thinking", thinking: "" },
        });
        results.push({
          type: "content_block_delta",
          index: idx,
          delta: { type: "thinking_delta", thinking: part.text },
        });
        results.push({ type: "content_block_stop", index: idx });
        continue;
      }

      // Function call → tool_use block
      if (part.functionCall) {
        // Close any open text block first
        if (state.openTextBlockIdx !== null) {
          results.push({ type: "content_block_stop", index: state.openTextBlockIdx });
          state.openTextBlockIdx = null;
        }
        const fc = part.functionCall;
        const rawToolName = fc.name;
        // Gemini may echo a declared tool in another casing (`read` for Claude
        // Code's `Read`, which it then rejects); hand back the client's spelling.
        const restoredToolName = restoreDeclaredToolName(
          typeof rawToolName === "string" ? rawToolName : "",
          state.toolNameMap,
          state.clientTools
        );
        const idx = state.contentBlockIndex++;
        const toolId = fc.id || `toolu_${Date.now()}_${idx}`;

        results.push({
          type: "content_block_start",
          index: idx,
          content_block: {
            type: "tool_use",
            id: toolId,
            name: restoredToolName,
            input: {},
          },
        });

        const argsStr = JSON.stringify(fc.args || {});
        results.push({
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: argsStr },
        });
        results.push({ type: "content_block_stop", index: idx });

        if (!state.hasToolUse) state.hasToolUse = true;
        continue;
      }

      // Regular text content → keep text block open across streaming chunks
      const isRegularText = part.text !== undefined && part.text !== "" && !hasThoughtSig;
      const isTextAfterThinking =
        hasThoughtSig &&
        part.text !== undefined &&
        part.text !== "" &&
        !isThought &&
        !part.functionCall;

      if (isRegularText || isTextAfterThinking) {
        // Open a new text block only if none is open yet
        if (state.openTextBlockIdx === null) {
          const idx = state.contentBlockIndex++;
          state.openTextBlockIdx = idx;
          results.push({
            type: "content_block_start",
            index: idx,
            content_block: { type: "text", text: "" },
          });
        }
        // Always emit delta into the SAME open block (no open+close per chunk)
        results.push({
          type: "content_block_delta",
          index: state.openTextBlockIdx,
          delta: { type: "text_delta", text: part.text },
        });
      }
    }
  }

  // ── Usage metadata ─────────────────────────────────────────────
  const usageMeta = response.usageMetadata || chunk.usageMetadata;
  if (usageMeta && typeof usageMeta === "object") {
    const inputTokens =
      typeof usageMeta.promptTokenCount === "number" ? usageMeta.promptTokenCount : 0;
    const candidatesTokens =
      typeof usageMeta.candidatesTokenCount === "number" ? usageMeta.candidatesTokenCount : 0;
    const thoughtsTokens =
      typeof usageMeta.thoughtsTokenCount === "number" ? usageMeta.thoughtsTokenCount : 0;
    const cachedTokens =
      typeof usageMeta.cachedContentTokenCount === "number" ? usageMeta.cachedContentTokenCount : 0;

    state.usage = {
      input_tokens: inputTokens,
      output_tokens: candidatesTokens + thoughtsTokens,
    };
    if (cachedTokens > 0) {
      state.usage.cache_read_input_tokens = cachedTokens;
    }
  }

  // ── Google Search grounding → server_tool_use + web_search_tool_result ──
  // Gemini attaches groundingMetadata to the last chunk (sometimes an earlier one);
  // emit the pair once, before the finish blocks.
  emitGroundingWebSearch(candidate, state, results);

  // ── Finish reason → close open blocks + message_delta + message_stop ──
  if (candidate.finishReason) {
    // Close any still-open text block before finishing
    if (state.openTextBlockIdx !== null) {
      results.push({ type: "content_block_stop", index: state.openTextBlockIdx });
      state.openTextBlockIdx = null;
    }

    let stopReason;
    const reason = candidate.finishReason.toLowerCase();
    if (state.hasToolUse || reason === "tool_calls") {
      stopReason = "tool_use";
    } else if (reason === "max_tokens" || reason === "length") {
      stopReason = "max_tokens";
    } else if (reason === "safety" || reason === "recitation" || reason === "blocklist") {
      // Content blocked by Gemini safety. Any text streamed before this finish
      // reason has already been emitted to the client — this is unavoidable in
      // SSE streaming. Map to end_turn (Claude has no "content blocked" reason).
      stopReason = "end_turn";
    } else if (isAbortFinishReason(reason)) {
      // Aborted/malformed tool call (e.g. MALFORMED_FUNCTION_CALL,
      // UNEXPECTED_TOOL_CALL). Surface as tool_use rather than a clean end_turn
      // so the client sees the turn did not complete normally. Same fix as the
      // hub path (openai-to-claude.ts) — this direct Gemini→Claude translator is
      // the one Claude Code hits through an antigravity/Gemini-routed model.
      // Port of decolua/9router#2462 by @anhdiepmmk.
      stopReason = "tool_use";
    } else {
      stopReason = "end_turn";
    }

    results.push({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: state.usage || { input_tokens: 0, output_tokens: 0 },
    });

    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

// Register as direct path: Gemini → Claude
register(FORMATS.GEMINI, FORMATS.CLAUDE, null, geminiToClaudeResponse);
register(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, null, geminiToClaudeResponse);
