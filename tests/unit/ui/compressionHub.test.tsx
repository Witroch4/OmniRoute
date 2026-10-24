// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Helpers ───────────────────────────────────────────────────────────────

const containers: HTMLElement[] = [];
const roots: Array<{ unmount: () => void }> = [];

function mountInContainer(ui: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(ui);
  });
  return container;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => {
    while (roots.length > 0) {
      roots.pop()?.unmount();
    }
  });
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  while (containers.length > 0) {
    containers.pop()?.remove();
  }
  document.body.innerHTML = "";
});

// ── Mock fetch ────────────────────────────────────────────────────────────

const ENGINES = [
  { id: "session-dedup", name: "Session Dedup", stackPriority: 3, stable: true },
  { id: "rtk", name: "RTK", stackPriority: 10, stable: true },
  { id: "caveman", name: "Caveman", stackPriority: 20, stable: true },
  { id: "llmlingua", name: "LLMLingua-2", stackPriority: 35, stable: false },
];

function enginePayload() {
  return {
    engines: ENGINES.map((e) => ({
      id: e.id,
      name: e.name,
      description: `${e.name} description`,
      icon: "compress",
      stackable: true,
      stackPriority: e.stackPriority,
      metadata: { stable: e.stable },
      configSchema: [],
    })),
  };
}

function setupFetchMock(opts: {
  enabled?: boolean;
  mode?: string;
  pipeline?: Array<{ engine: string }>;
}) {
  const { enabled = true, mode = "stacked", pipeline = [{ engine: "rtk" }] } = opts;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/api/settings/compression")) {
      return json({ enabled, defaultMode: mode });
    }
    if (url.includes("/api/compression/engines")) {
      return json(enginePayload());
    }
    if (url.includes("/api/context/combos/default")) {
      return json({ id: "default-caveman", name: "Standard Savings", pipeline });
    }
    if (url.includes("/api/context/combos")) {
      return json({ combos: [] });
    }
    if (url.includes("/api/combos")) {
      return json({ combos: [] });
    }
    if (url.includes("/api/compression/language-packs")) {
      return json({ packs: [] });
    }
    return json({}, 404);
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("CompressionHub", () => {
  // Phase 2 (v3.8.33) turned the Hub into a thin overview: the master switch, mode
  // selector and per-layer pipeline moved to /dashboard/context/settings and the
  // named-combo editor. What the Hub owns now is the active-profile selector and a
  // read-only preview of what the active profile runs.
  it("renders the active-profile selector and previews the active combo's pipeline", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("/api/settings/compression")) {
        return json({ enabled: true, defaultMode: "stacked", activeComboId: "combo-alpha" });
      }
      if (url.includes("/api/context/combos")) {
        return json({
          combos: [
            {
              id: "combo-alpha",
              name: "Alpha",
              pipeline: [{ engine: "rtk" }, { engine: "caveman" }],
            },
          ],
        });
      }
      return json({});
    });
    const { default: CompressionHub } =
      await import("../../../src/app/(dashboard)/dashboard/context/combos/CompressionHub");

    let container!: HTMLElement;
    await act(async () => {
      container = mountInContainer(<CompressionHub />);
    });
    await flush();

    expect(container.textContent).toContain("Compression Hub");
    const select = container.querySelector(
      '[data-testid="active-profile-select"]'
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((o) => o.text)).toEqual([
      "Default (from panel)",
      "Alpha",
    ]);
    expect(select!.value).toBe("combo-alpha");
    expect(
      container.querySelector('[data-testid="active-profile-preview"]')?.textContent
    ).toContain("rtk → caveman");
  });

  it(
    "INVARIANT #1: no per-layer control issues a PUT/POST to /api/context/combos/default",
    { timeout: 20000 },
    async () => {
      const comboWrites: { method: string }[] = [];
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          if (url.includes("/api/context/combos/default")) {
            if (init?.method === "PUT" || init?.method === "POST") {
              comboWrites.push({ method: init.method });
            }
            return json({ id: "default", name: "Default", pipeline: [{ engine: "rtk" }] });
          }
          if (url.includes("/api/settings/compression")) {
            return json({ enabled: true, defaultMode: "stacked" });
          }
          if (url.includes("/api/compression/engines")) {
            return json(enginePayload());
          }
          if (url.includes("/api/context/combos") || url.includes("/api/combos")) {
            return json({ combos: [] });
          }
          if (url.includes("/api/compression/language-packs")) {
            return json({ packs: [] });
          }
          return json({}, 404);
        }
      );

      const { default: CompressionHub } =
        await import("../../../src/app/(dashboard)/dashboard/context/combos/CompressionHub");

      let container!: HTMLElement;
      await act(async () => {
        container = mountInContainer(<CompressionHub />);
      });
      await flush();

      // Click every on/off switch in the Hub (master + any layer controls that remain).
      const switches = Array.from(container.querySelectorAll('[role="switch"]'));
      for (const sw of switches) {
        await act(async () => {
          (sw as HTMLElement).click();
        });
        await flush();
      }

      expect(comboWrites).toHaveLength(0);
    }
  );
});

describe("CompressionCombosPageClient", () => {
  it("renders the Hub on top and the named-combos manager below", async () => {
    setupFetchMock({ enabled: true, mode: "stacked", pipeline: [{ engine: "rtk" }] });
    const { default: CompressionCombosPageClient } =
      await import("../../../src/app/(dashboard)/dashboard/context/combos/CompressionCombosPageClient");

    let container!: HTMLElement;
    await act(async () => {
      container = mountInContainer(<CompressionCombosPageClient />);
    });
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("Compression Hub");
    expect(text).toContain("Named combos");
  });
});
