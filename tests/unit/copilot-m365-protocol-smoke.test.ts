import assert from "node:assert/strict";
import test from "node:test";
import {
  __setCopilotM365WebSocketForTesting,
  CopilotM365WebExecutor,
} from "../../open-sse/executors/copilot-m365-web.ts";
import { encodeFrame, splitFrames } from "../../open-sse/executors/copilot-m365-frames.ts";

type Listener = (...args: unknown[]) => void;
type Mode =
  | "success"
  | "rejected"
  | "empty"
  | "throttled"
  | "volume-notice"
  | "final-volume-notice"
  | "socket-429"
  | "quoted-notice"
  | "late-throttle"
  | "held";
const volumeNotice =
  "We're temporarily unable to respond to this volume of requests. Please try again later.";

// The live consumer socket rejected the legacy invocation with type:3. Keep
// that boundary in the fixture: only a correlated invocation + Metrics packet
// using the current browser contract receives a response.
class ProtocolSocket {
  static mode: Mode = "success";
  static expectedImages: string[] = [];
  static uploadedConversationId: string | null = null;
  static opened = 0;
  static closed = 0;
  static retryAfter: string | undefined;
  listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    ProtocolSocket.opened++;
    queueMicrotask(() =>
      ProtocolSocket.mode === "socket-429"
        ? this.emit(
            "unexpected-response",
            {},
            { statusCode: 429, headers: { "retry-after": ProtocolSocket.retryAfter }, resume() {} }
          )
        : this.emit("open")
    );
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
      } else if (
        ProtocolSocket.mode === "throttled" ||
        ProtocolSocket.mode === "final-volume-notice"
      ) {
        this.emit(
          "message",
          Buffer.from(
            encodeFrame({
              type: 2,
              item: {
                result:
                  ProtocolSocket.mode === "throttled"
                    ? { value: "Throttled", message: "Too many requests" }
                    : { value: "Success", message: volumeNotice },
              },
            }) + encodeFrame({ type: 3 })
          )
        );
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
                      text:
                        ProtocolSocket.mode === "volume-notice"
                          ? volumeNotice
                          : ProtocolSocket.mode === "quoted-notice"
                            ? `Microsoft said: ${volumeNotice}`
                            : ProtocolSocket.expectedImages.length
                              ? "Imagem recebida"
                              : "Olá! 👋",
                    },
                  ],
                  isLastUpdate: true,
                },
              ],
            }) +
              (ProtocolSocket.mode === "held"
                ? ""
                : ProtocolSocket.mode === "late-throttle"
                  ? encodeFrame({ type: 2, item: { result: { value: "Throttled" } } })
                  : encodeFrame({ type: 3 }))
          )
        );
      }
    });
  }

  close(): void {
    ProtocolSocket.closed++;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

async function execute(
  mode: Mode,
  stream: boolean,
  content: unknown = "Oi!",
  connectionId?: string
): Promise<Response> {
  ProtocolSocket.mode = mode;
  const restore = __setCopilotM365WebSocketForTesting(
    ProtocolSocket as unknown as typeof import("ws").default
  );
  try {
    const result = await new CopilotM365WebExecutor().execute({
      model: "copilot-m365",
      stream,
      body: { messages: [{ role: "user", content }] },
      credentials: { apiKey: "access_token=placeholder; chathubPath=user@tenant", connectionId },
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

for (const mode of ["throttled", "volume-notice", "final-volume-notice", "socket-429"] as const) {
  for (const stream of [false, true]) {
    test(`M365 ${mode} returns HTTP 429 and a local cooling period (stream=${stream})`, async () => {
      const response = await execute(mode, stream);
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "900");
      const body = await response.json();
      assert.equal(body.error.type, "rate_limit_error");
      assert.equal(body.error.code, "rate_limit_exceeded");
      assert.equal(body.choices, undefined);
    });
  }
}

test("M365 preserves an answer quoting a volume notice", async () => {
  const response = await execute("quoted-notice", false);
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).choices[0].message.content,
    `Microsoft said: ${volumeNotice}`
  );
});

test("M365 signals a throttle after streaming has started instead of finishing successfully", async () => {
  const response = await execute("late-throttle", true);
  const body = await response.text();
  assert.equal(response.status, 200); // Headers already contain real answer text.
  assert.match(body, /Olá!/);
  assert.match(body, /"status":429/);
  assert.match(body, /"retryAfterSeconds":900/);
  assert.doesNotMatch(body, /\[DONE\]/);
  assert.equal((await execute("late-throttle", false)).status, 429);
});

test("M365 cancellation closes a socket after the first content event", async () => {
  ProtocolSocket.mode = "held";
  const closed = ProtocolSocket.closed;
  const restore = __setCopilotM365WebSocketForTesting(
    ProtocolSocket as unknown as typeof import("ws").default
  );
  try {
    const result = await new CopilotM365WebExecutor().execute({
      model: "copilot-m365",
      stream: true,
      body: { messages: [{ role: "user", content: "Oi" }] },
      credentials: { apiKey: "access_token=placeholder; chathubPath=user@tenant" },
    });
    const reader = result.response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    assert.equal(ProtocolSocket.closed, closed + 1);
    reader.releaseLock();
  } finally {
    restore();
  }
});

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=";
const imageContent = [
  { type: "text", text: "Descreva esta imagem" },
  { type: "image_url", image_url: { url: pixel } },
];

test("M365 persists cooldown and blocks previously selected text/image requests before dispatch", async (t) => {
  const { createProviderConnection, updateProviderConnection } =
    await import("../../src/lib/db/providers.ts");
  const { getRateLimitedConnections } = await import("../../src/lib/db/providers/rateLimit.ts");
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  t.after(() => resetDbInstance());
  const connection = await createProviderConnection({
    provider: "copilot-m365-web",
    authType: "apikey",
    name: "M365 cooldown test",
    apiKey: "test",
    testStatus: "unavailable",
    lastError: "Expired cooldown",
    rateLimitedUntil: new Date(Date.now() - 1000).toISOString(),
  });
  const connectionId = String(connection.id);
  const started = Date.now();
  assert.equal((await execute("throttled", false, "Oi!", connectionId)).status, 429);
  const stored = getRateLimitedConnections("copilot-m365-web").find(
    (entry) => entry.id === connectionId
  );
  assert.ok(stored);
  assert.ok(stored.rateLimitedUntil >= started + 900_000);
  const { clearAccountError } = await import("../../src/sse/services/auth.ts");
  await clearAccountError(connectionId, {
    provider: "copilot-m365-web",
    testStatus: "unavailable",
    lastError: "Expired cooldown",
    rateLimitedUntil: String(connection.rateLimitedUntil),
  });
  assert.ok(
    getRateLimitedConnections("copilot-m365-web").some((entry) => entry.id === connectionId)
  );
  const opened = ProtocolSocket.opened;
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not upload during cooldown");
  });
  for (const content of ["Oi!", imageContent]) {
    const response = await execute("success", true, content, connectionId);
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
  }
  assert.equal(ProtocolSocket.opened, opened);
  // Both legacy ISO dates and epoch-ms cooldowns are persisted in OM databases.
  await updateProviderConnection(connectionId, {
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal((await execute("success", false, "Oi!", connectionId)).status, 429);
  await updateProviderConnection(connectionId, {
    rateLimitedUntil: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal((await execute("success", false, "Oi!", connectionId)).status, 200);
});

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

test("M365 image upload throttling returns 429 without opening a socket", async (t) => {
  const opened = ProtocolSocket.opened;
  t.mock.method(globalThis, "fetch", async () => new Response("throttled", { status: 429 }));
  const response = await execute("success", false, imageContent);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "900");
  assert.equal(ProtocolSocket.opened, opened);
});

test("M365 preserves an upstream Retry-After longer than the local pause", async (t) => {
  ProtocolSocket.retryAfter = "3600";
  try {
    const socketResponse = await execute("socket-429", true);
    assert.equal(socketResponse.status, 429);
    assert.equal(socketResponse.headers.get("retry-after"), "3600");
  } finally {
    ProtocolSocket.retryAfter = undefined;
  }
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("throttled", {
        status: 429,
        headers: { "Retry-After": "3600" },
      })
  );
  assert.equal((await execute("success", false, imageContent)).headers.get("retry-after"), "3600");
});

test("M365 rejects unsupported image URLs instead of putting them in the text prompt", async () => {
  const response = await execute("success", false, [
    { type: "image_url", image_url: { url: "https://example.com/image.png" } },
  ]);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /base64/i);
});
