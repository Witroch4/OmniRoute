/**
 * Document-input support guardrail.
 *
 * Rejects, BEFORE any upstream call, requests that attach a PDF/document to a
 * provider+model pair measured to mishandle it. Two pairs are covered, both
 * measured live on 2026-09-27 with the same one-page PDF:
 *
 * - `github` (Copilot) + Claude: Copilot does not read the `file` part as a
 *   document for Claude — the base64 lands in the prompt as TEXT and is billed
 *   token by token. Seven jury calls with one PDF page each cost ~996k input
 *   tokens apiece (5.96M total, 1,172 premium credits, US$11.73) and exhausted
 *   the account's monthly Copilot quota (402 for EVERY model afterwards). The
 *   model never saw the page: it approved every planted defect.
 * - `agy`/`antigravity` + Claude: the Antigravity Claude backend rejects PDF
 *   input (`claude-sonnet-5` 404 "not_found", `claude-sonnet-4-6` and
 *   `claude-opus-4-6-thinking` 500) while text and images work. The misleading
 *   404 arms OM's per-model lockout (5s -> 320s), so one PDF request took the
 *   model down for every caller ("No active credentials for provider: agy").
 *
 * A rejection here is a plain 400 with the reason and the alternatives; it never
 * reaches credential selection, so it cannot burn quota or arm a lockout.
 * Images are unaffected. Other models on the same providers are unaffected
 * (Gemini on agy/antigravity reads the same PDF correctly).
 */
import { parseModel } from "@omniroute/open-sse/services/model.ts";
import { BaseGuardrail, type GuardrailContext, type GuardrailResult } from "./base";

type DocumentInputRule = {
  providers: readonly string[];
  modelPattern: RegExp;
  reason: string;
};

const DOCUMENT_INPUT_RULES: readonly DocumentInputRule[] = [
  {
    providers: ["github"],
    modelPattern: /claude/i,
    reason:
      "GitHub Copilot sends the file to Claude as plain base64 text: the model cannot read it and every character is billed as input tokens (~1M tokens per PDF page)",
  },
  {
    providers: ["agy", "antigravity"],
    modelPattern: /claude/i,
    reason: "the Antigravity Claude backend rejects PDF/document input (upstream 404/500)",
  },
];

const DOCUMENT_PART_TYPES = new Set(["file", "document", "input_file", "file_url"]);

// Wrappers that prefix a routable model string without being a provider.
const MODEL_WRAPPER_PREFIXES = ["no-think/"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dataUriMime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^data:([^;,]+)[;,]/i.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * The declared MIME type of a document-like part, or null when it declares
 * none. OpenAI chat (`file.file_data`), Responses (`input_file.file_data`),
 * Anthropic (`document.source.media_type`) and plain `mime_type` fields.
 */
function partMime(part: Record<string, unknown>): string | null {
  const file = asRecord(part.file) ?? asRecord(part.file_url) ?? asRecord(part.document);
  const source = asRecord(part.source);
  const candidates = [
    dataUriMime(file?.file_data),
    dataUriMime(file?.data),
    dataUriMime(file?.url),
    dataUriMime(part.file_data),
    dataUriMime(part.file_url),
    typeof source?.media_type === "string" ? source.media_type.toLowerCase() : null,
    typeof part.mime_type === "string" ? part.mime_type.toLowerCase() : null,
    typeof file?.mime_type === "string" ? (file.mime_type as string).toLowerCase() : null,
  ];
  return candidates.find((mime) => typeof mime === "string" && mime.length > 0) ?? null;
}

/**
 * True when the part attaches a BINARY document (a PDF or any non-image,
 * non-text file). Text attachments (`file.content`/`file.text`, `text/*`) are
 * left alone — OM already flattens those to a text part, which is cheap and
 * correct — and so are images, which every covered route reads.
 */
export function isDocumentPart(part: unknown): boolean {
  const record = asRecord(part);
  if (!record || typeof record.type !== "string" || !DOCUMENT_PART_TYPES.has(record.type)) {
    return false;
  }
  const file = asRecord(record.file) ?? asRecord(record.file_url) ?? asRecord(record.document);
  const source = asRecord(record.source);
  const carriesBinary = [
    file?.file_data,
    file?.data,
    file?.url,
    file?.file_id,
    record.file_data,
    record.file_url,
    record.file_id,
    source?.data,
    source?.url,
    source?.file_id,
  ].some((value) => typeof value === "string" && value.length > 0);
  if (!carriesBinary) return false;

  const mime = partMime(record);
  return !(mime && (mime.startsWith("image/") || mime.startsWith("text/")));
}

function contentHasDocument(content: unknown): boolean {
  return Array.isArray(content) && content.some(isDocumentPart);
}

/** Whether any message / Responses input item carries a document attachment. */
export function payloadHasDocumentInput(payload: unknown): boolean {
  const body = asRecord(payload);
  if (!body) return false;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of [...messages, ...input]) {
    if (isDocumentPart(item)) return true;
    if (contentHasDocument(asRecord(item)?.content)) return true;
  }
  return false;
}

function stripModelWrappers(model: string): string {
  let current = model.trim();
  for (const prefix of MODEL_WRAPPER_PREFIXES) {
    if (current.toLowerCase().startsWith(prefix)) current = current.slice(prefix.length);
  }
  return current;
}

/** The rule that forbids documents for this model string, if any. */
export function findDocumentInputRule(modelStr: unknown): DocumentInputRule | null {
  if (typeof modelStr !== "string" || !modelStr.trim()) return null;
  const parsed = parseModel(stripModelWrappers(modelStr));
  if (!parsed.provider || !parsed.model) return null;
  const provider = parsed.provider.toLowerCase();
  return (
    DOCUMENT_INPUT_RULES.find(
      (rule) => rule.providers.includes(provider) && rule.modelPattern.test(parsed.model as string)
    ) ?? null
  );
}

export class DocumentInputSupportGuardrail extends BaseGuardrail {
  constructor(options: { enabled?: boolean; priority?: number } = {}) {
    // After the Vision Bridge (5), which may reroute body.model.
    super("document-input-support", { enabled: options.enabled, priority: options.priority ?? 6 });
  }

  async preCall(payload: unknown, context: GuardrailContext): Promise<GuardrailResult<unknown>> {
    const body = asRecord(payload);
    const modelStr = typeof body?.model === "string" ? body.model : context.model;
    const rule = findDocumentInputRule(modelStr);
    if (!rule || !payloadHasDocumentInput(payload)) return { block: false };

    return {
      block: true,
      message:
        `Model "${modelStr}" cannot take PDF/document attachments: ${rule.reason}. ` +
        "Send the pages as images (image_url), or use a route that reads PDFs " +
        "(verified: agy/gemini-*, cx/gpt-*).",
      meta: { model: modelStr, providers: rule.providers },
    };
  }
}
