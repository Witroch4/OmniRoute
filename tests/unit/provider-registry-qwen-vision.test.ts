/**
 * Issue #2822 — qwen3.7-max (opencode-go) retorna 500 em inputs com imagem.
 *
 * qwen3.7-max, qwen3.6-plus e qwen3.5-plus nos providers opencode-go e
 * opencode-zen não possuíam supportsVision: false. Isso fazia com que
 * blocos de imagem chegassem ao upstream (que não suporta visão),
 * gerando 500s que esgotavam todo o orçamento de retentativas.
 *
 * Este teste garante que todos os modelos afetados tenham
 * supportsVision !== true (i.e. false ou não definido como true).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");

type ModelEntry = {
  id: string;
  supportsVision?: boolean;
  [key: string]: unknown;
};

type ProviderEntry = {
  models?: ModelEntry[];
  [key: string]: unknown;
};

function getModel(providerId: string, modelId: string): ModelEntry | undefined {
  const provider = (REGISTRY as Record<string, ProviderEntry>)[providerId];
  if (!provider) return undefined;
  return provider.models?.find((m) => m.id === modelId);
}

// ── opencode-go ─────────────────────────────────────────────────────────────

// The text-only Qwen models of #2822 (qwen3.7-max, qwen3.6-plus, qwen3.5-plus) are no longer served by
// OpenCode Go. Their successors accept images per OpenCode's models.dev catalog (2026-10-24), the same
// metadata the official CLI uses to decide whether to attach an image.
test("#2822 opencode-go no longer lists the text-only Qwen models", () => {
  for (const retired of ["qwen3.7-max", "qwen3.6-plus", "qwen3.5-plus"]) {
    assert.equal(getModel("opencode-go", retired), undefined, `${retired} is retired on Go`);
  }
});

test("opencode-go Qwen successors declare vision explicitly, as the catalog states", () => {
  for (const id of ["qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus"]) {
    const model = getModel("opencode-go", id);
    assert.ok(model, `${id} deve estar registrado em opencode-go`);
    assert.strictEqual(model.supportsVision, true);
  }
});

// #3328 — o oposto do #2822: MiniMax M3 (opencode) É multimodal (verificado
// empiricamente: descreve imagens base64 via o upstream opencode). Deve ter
// supportsVision: true para não ser barrado/strippado em requests com imagem.
test("#3328 opencode/minimax-m3-free deve ter supportsVision: true", () => {
  const model = getModel("opencode", "minimax-m3-free");
  assert.ok(model, "minimax-m3-free deve estar registrado em opencode");
  assert.strictEqual(
    model.supportsVision,
    true,
    "opencode/minimax-m3-free é multimodal — supportsVision deve ser true"
  );
});

// ── opencode-zen ─────────────────────────────────────────────────────────────

test("#2822 opencode-zen/qwen3.5-plus deve ter supportsVision !== true", () => {
  const model = getModel("opencode-zen", "qwen3.5-plus");
  assert.ok(model, "qwen3.5-plus deve estar registrado em opencode-zen");
  assert.notEqual(
    model.supportsVision,
    true,
    "opencode-zen/qwen3.5-plus não suporta visão — supportsVision deve ser false ou ausente"
  );
  assert.strictEqual(
    model.supportsVision,
    false,
    "opencode-zen/qwen3.5-plus deve ter supportsVision: false explícito para bloquear seleção em combo com imagens"
  );
});

test("#2822 opencode-zen/qwen3.6-plus deve ter supportsVision !== true", () => {
  const model = getModel("opencode-zen", "qwen3.6-plus");
  assert.ok(model, "qwen3.6-plus deve estar registrado em opencode-zen");
  assert.notEqual(
    model.supportsVision,
    true,
    "opencode-zen/qwen3.6-plus não suporta visão — supportsVision deve ser false ou ausente"
  );
  assert.strictEqual(
    model.supportsVision,
    false,
    "opencode-zen/qwen3.6-plus deve ter supportsVision: false explícito para bloquear seleção em combo com imagens"
  );
});
