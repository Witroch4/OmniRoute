import { randomUUID } from "node:crypto";
import { FETCH_TIMEOUT_MS } from "../config/constants.ts";
import type { M365ConnectionParams } from "./copilot-m365-connection.ts";

type JsonRecord = Record<string, unknown>;
interface M365Image {
  dataUri: string;
  fileType: string;
}

export interface M365ImageAnnotation {
  id: string;
  messageAnnotationMetadata: {
    "@type": "File";
    annotationType: "File";
    fileType: string;
    fileName: string;
  };
  messageAnnotationType: "ImageFile";
}

/** Images belong to the same last-user turn as buildPrompt. Never stringify them as text. */
export function extractM365Images(body: JsonRecord | undefined): M365Image[] | { error: string } {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const user = messages.filter((message) => message?.role === "user").pop();
  if (!Array.isArray(user?.content)) return [];
  const images: M365Image[] = [];
  for (const part of user.content) {
    if (!part || part.type !== "image_url") continue;
    const url = part.image_url?.url;
    const match =
      typeof url === "string"
        ? /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url)
        : null;
    if (!match)
      return {
        error: "Microsoft 365 Copilot requires inline base64 PNG, JPEG, WebP or GIF images.",
      };
    images.push({ dataUri: url, fileType: match[1] === "jpeg" ? "jpg" : match[1] });
  }
  return images;
}

/**
 * UploadFile returns the docId consumed by message.messageAnnotations. This
 * consumer path was live-validated with the same opaque session token used by
 * the socket, including reading an unpredictable code from the uploaded PNG.
 */
export async function uploadM365Images(
  params: M365ConnectionParams,
  wsUrl: string,
  images: M365Image[],
  signal?: AbortSignal
): Promise<M365ImageAnnotation[]> {
  const conversationId = new URL(wsUrl).searchParams.get("ConversationId");
  if (!conversationId) throw new Error("Missing Microsoft 365 image conversation id");
  const annotations: M365ImageAnnotation[] = [];
  for (const [index, image] of images.entries()) {
    // proxyFetch uses vendored undici, whose FormData differs from Node's.
    // Reuse the byte multipart pattern from imageGeneration.ts (#3273).
    const boundary = `----OmniRouteM365${randomUUID().replace(/-/g, "")}`;
    const parts: Buffer[] = [];
    const append = (name: string, value: string) =>
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        )
      );
    append("scenario", "UploadImage");
    append("conversationId", conversationId);
    append("FileBase64", image.dataUri);
    for (const option of [
      "cwcgptvsan",
      "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
      "gptvnorm2048",
    ]) {
      append("optionsSets", option);
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetch("https://substrate.office.com/m365Copilot/UploadFile", {
      method: "POST",
      body: Buffer.concat(parts),
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        Authorization: `Bearer ${params.accessToken}`,
        "x-anchormailbox": `Oid:${params.chathubPath}`,
        "x-scenario": params.scenario ?? "OfficeWebPaidConsumerCopilot",
        "x-variants": "feature.EnableImageSupportInUploadFile",
        Origin: "https://m365.cloud.microsoft",
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok)
      throw new Error(`Microsoft 365 image upload failed (HTTP ${response.status})`);
    const payload: unknown = await response.json();
    const docId =
      payload && typeof payload === "object" && "docId" in payload ? payload.docId : null;
    if (typeof docId !== "string" || !docId)
      throw new Error("Microsoft 365 image upload returned no document id");
    annotations.push({
      id: docId,
      messageAnnotationMetadata: {
        "@type": "File",
        annotationType: "File",
        fileType: image.fileType,
        fileName: `image-${index + 1}.${image.fileType}`,
      },
      messageAnnotationType: "ImageFile",
    });
  }
  return annotations;
}
