import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fetch as undiciFetch } from "undici";
import {
  extractM365Images,
  uploadM365Images,
} from "../../open-sse/executors/copilot-m365-images.ts";

test("M365 UploadFile sends real multipart through production's undici fetch", async (t) => {
  let contentType = "";
  let wireBody = "";
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      contentType = request.headers["content-type"] ?? "";
      wireBody = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ docId: "uploaded-file" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: Parameters<typeof undiciFetch>[1]) => {
      return undiciFetch(`http://127.0.0.1:${address.port}/upload`, init);
    }
  );
  const dataUri = "data:image/png;base64,iVBORw0KGgo=";
  const images = extractM365Images({
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUri } }] }],
  });
  assert.ok(!("error" in images));
  try {
    await uploadM365Images(
      { host: "substrate.office.com", chathubPath: "user@tenant", accessToken: "placeholder" },
      "wss://substrate.office.com/m365Copilot/Chathub/user@tenant?ConversationId=conversation",
      images
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.match(contentType, /multipart\/form-data; boundary=/);
  assert.match(wireBody, /name="scenario"\r\n\r\nUploadImage/);
  assert.match(wireBody, /name="conversationId"\r\n\r\nconversation/);
  assert.ok(wireBody.includes(dataUri));
  assert.equal(wireBody.split('name="optionsSets"').length - 1, 3);
});
