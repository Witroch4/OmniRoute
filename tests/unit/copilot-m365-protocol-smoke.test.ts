import assert from "node:assert/strict";
import test from "node:test";
import {
  __setCopilotM365WebSocketForTesting,
  CopilotM365WebExecutor,
} from "../../open-sse/executors/copilot-m365-web.ts";
import { encodeFrame, splitFrames } from "../../open-sse/executors/copilot-m365-frames.ts";

type Listener = (...args: unknown[]) => void;
type Mode = "success" | "rejected" | "empty";

// The live consumer socket rejected the legacy invocation with type:3. Keep
// that boundary in the fixture: only a correlated invocation + Metrics packet
// using the current browser contract receives a response.
class ProtocolSocket {
  static mode: Mode = "success";
  static expectedImages: string[] = [];
  static uploadedConversationId: string | null = null;
  listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    queueMicrotask(() => this.emit("open"));
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  send(data: string): void {
    const frames = splitFrames(String(data)).frames.map(
      (raw) => JSON.parse(raw) as Record<string, unknown>
    );
    const first = frames[0];
    if (first.protocol === "json") {
      queueMicrotask(() => this.emit("message", Buffer.from(encodeFrame({}))));
      return;
    }
    if (first.type !== 4) return;
    const args = (first.arguments as Record<string, unknown>[])[0];
    const message = args.message as Record<string, unknown>;
    const client = args.clientInfo as Record<string, unknown>;
    const query = new URL(this.url).searchParams;
    const annotations = message.messageAnnotations as Array<{ id: string }> | undefined;
    const imageIds = annotations?.map((annotation) => annotation.id) ?? [];
    const valid =
      args.conversationId === query.get("ConversationId") &&
      (!ProtocolSocket.expectedImages.length ||
        args.conversationId === ProtocolSocket.uploadedConversationId) &&
      message.requestId === query.get("chatsessionid") &&
      args.sessionId === query.get("X-SessionId") &&
      args.productThreadType === "Office" &&
      client.clientPlatform === "mcmcopilot-web" &&
      args.tone === "Magic" &&
      args.disconnectBehavior === "continue" &&
      frames[1]?.target === "Metrics" &&
      frames[1]?.type === 1 &&
      JSON.stringify(imageIds) === JSON.stringify(ProtocolSocket.expectedImages);
    queueMicrotask(() => {
      if (!valid || ProtocolSocket.mode === "rejected") {
        this.emit(
          "message",
          Buffer.from(encodeFrame({ type: 3, error: "Chat invocation rejected" }))
        );
      } else if (ProtocolSocket.mode === "empty") {
        this.emit("message", Buffer.from(encodeFrame({ type: 3 })));
      } else {
        this.emit(
          "message",
          Buffer.from(
            encodeFrame({
              type: 1,
              target: "update",
              arguments: [
                {
                  messages: [
                    {
                      author: "bot",
                      text: ProtocolSocket.expectedImages.length ? "Imagem recebida" : "Olá! 👋",
                    },
                  ],
                  isLastUpdate: true,
                },
              ],
            }) + encodeFrame({ type: 3 })
          )
        );
      }
    });
  }

  close(): void {}

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

async function execute(mode: Mode, stream: boolean, content: unknown = "Oi!"): Promise<Response> {
  ProtocolSocket.mode = mode;
  const restore = __setCopilotM365WebSocketForTesting(
    ProtocolSocket as unknown as typeof import("ws").default
  );
  try {
    const result = await new CopilotM365WebExecutor().execute({
      model: "copilot-m365",
      stream,
      body: { messages: [{ role: "user", content }] },
      credentials: { apiKey: "access_token=placeholder; chathubPath=user@tenant" },
    });
    // Consume while the socket substitution is still installed.
    return new Response(await result.response.text(), {
      status: result.response.status,
      headers: result.response.headers,
    });
  } finally {
    restore();
  }
}

test("M365 consumer invocation matches the current correlated WebSocket contract", async () => {
  const response = await execute("success", false);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "Olá! 👋");
});

test("M365 consumer invocation produces text in streaming mode", async () => {
  const response = await execute("success", true);
  const body = await response.text();
  assert.match(body, /Olá! 👋/);
  assert.doesNotMatch(body, /"error"/);
});

test("M365 rejects an upstream invocation error instead of returning a successful placeholder", async () => {
  const response = await execute("rejected", false);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.error.message, /Chat invocation rejected/);
  assert.equal(body.choices, undefined);
});

test("M365 reports an empty upstream turn in both response modes", async () => {
  const response = await execute("empty", false);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /no content/i);
  const stream = await execute("empty", true);
  assert.match(await stream.text(), /"error"/);
});

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=";
const imageContent = [
  { type: "text", text: "Descreva esta imagem" },
  { type: "image_url", image_url: { url: pixel } },
];

test("M365 uploads multiple inline images under the WebSocket conversation and forwards their annotations", async (t) => {
  ProtocolSocket.expectedImages = ["image-1", "image-2"];
  let uploaded = 0;
  let conversationId = "";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://substrate.office.com/m365Copilot/UploadFile");
    assert.equal(init.method, "POST");
    const form = await new Request(url, init).formData();
    assert.equal(form.get("FileBase64"), pixel);
    assert.equal(form.get("scenario"), "UploadImage");
    const current = String(form.get("conversationId"));
    if (conversationId) assert.equal(current, conversationId);
    conversationId = current;
    ProtocolSocket.uploadedConversationId = current;
    assert.match(current, /^[\da-f-]{36}$/);
    return Response.json({ docId: `image-${++uploaded}` });
  });
  try {
    const response = await execute("success", false, [...imageContent, imageContent[1]]);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "Imagem recebida");
    assert.equal(uploaded, 2);
  } finally {
    ProtocolSocket.expectedImages = [];
    ProtocolSocket.uploadedConversationId = null;
  }
});

test("M365 surfaces upload failure without pretending that an image was received", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("expired", { status: 401 }));
  const response = await execute("success", false, imageContent);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /upload.*401/i);
});

test("M365 rejects unsupported image URLs instead of putting them in the text prompt", async () => {
  const response = await execute("success", false, [
    { type: "image_url", image_url: { url: "https://example.com/image.png" } },
  ]);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /base64/i);
});
