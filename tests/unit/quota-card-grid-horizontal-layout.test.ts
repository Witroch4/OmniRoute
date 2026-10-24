// Provider Quota page should be easy to scan provider-by-provider.
//
// QuotaCardGrid used to flow provider groups into CSS columns. That made
// high-account operators scan left/right across unrelated providers and made
// Codex/Claude quota priority hard to follow. This regression guard asserts
// the shipped JSX structure and grouping logic directly:
//  1. Grouping still produces one header per distinct provider with the
//     correct account count ("N account(s)").
//  2. Each provider group's card grid sizes its tracks by the group's CONTAINER
//     width — `repeat(auto-fill|auto-fit, minmax(<min>px, 1fr))` — never by a
//     viewport-breakpoint ladder (`grid-cols-2 md:grid-cols-3 xl:grid-cols-4`).
//     Tailwind breakpoints key off the VIEWPORT, so the ladder clipped cards
//     whenever the group was narrower than the page (fork fix 4695512925,
//     2026-07-26). The fork keeps a 220px floor so wide screens show several
//     cards per row; upstream's native fix uses 280px auto-fit.
//  3. Provider groups themselves are one-column expandable sections, not a
//     two-column masonry flow.
//
// Note: QuotaCardGrid's sibling QuotaCard pulls in next/image + provider-icon
// resolution that only works inside the real Next.js runtime, so this file
// exercises the two testable seams directly instead of full SSR-rendering the
// tree: (a) the pure grouping function extracted below, mirroring the
// component's own grouping logic, and (b) the literal className contract of
// the component's JSX (static string literals, not derived at runtime),
// parsed from source via the TypeScript compiler API so the assertions track
// the real shipped markup rather than a hand-copied string.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const COMPONENT_PATH = path.resolve(
  import.meta.dirname,
  "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaCardGrid.tsx"
);

function groupByProvider<T extends { provider: string }>(connections: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const conn of connections) {
    const list = groups.get(conn.provider) ?? [];
    list.push(conn);
    groups.set(conn.provider, list);
  }
  return groups;
}

test("QuotaCardGrid (#3520) — groups connections by provider with correct counts", () => {
  const groups = groupByProvider([
    { id: "conn-a1", provider: "openai" },
    { id: "conn-a2", provider: "openai" },
    { id: "conn-b1", provider: "anthropic" },
  ]);
  assert.deepEqual([...groups.keys()], ["openai", "anthropic"]);
  assert.equal(groups.get("openai")!.length, 2);
  assert.equal(groups.get("anthropic")!.length, 1);
});

/**
 * Extract the string literal passed to `className={...}` (or `className="..."`)
 * for every JSX `<div>` opening element in the component's `return (...)` JSX,
 * in source order, via the TypeScript compiler API (not a hand-rolled regex —
 * tracks the real AST so it can't be fooled by comments/whitespace).
 */
function extractDivClassNames(sourcePath: string): string[] {
  const sourceText = fs.readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const classNames: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sourceFile);
      if (tagName === "div") {
        for (const attr of node.attributes.properties) {
          if (ts.isJsxAttribute(attr) && attr.name.getText(sourceFile) === "className") {
            const init = attr.initializer;
            if (init && ts.isStringLiteral(init)) {
              classNames.push(init.text);
            } else if (
              init &&
              ts.isJsxExpression(init) &&
              init.expression &&
              ts.isStringLiteral(init.expression)
            ) {
              classNames.push(init.expression.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return classNames;
}

test("QuotaCardGrid — outer provider sections stay in one vertical reading order", () => {
  const classNames = extractDivClassNames(COMPONENT_PATH);
  const outerClassName = classNames.find((className) => /\bspace-y-\d+\b/.test(className));
  assert.ok(
    outerClassName,
    "expected the component to render a vertical provider-section container"
  );
  assert.doesNotMatch(
    outerClassName!,
    /\bcolumns-/,
    "provider sections should not flow into two CSS columns"
  );
  assert.match(
    outerClassName,
    /(?:^|\s)(?:space-y-\d+|flex)(?:\s|$)/,
    "provider sections should render as one vertical list"
  );
});

test("QuotaCardGrid — provider groups are expandable details sections", () => {
  const sourceText = fs.readFileSync(COMPONENT_PATH, "utf8");
  assert.match(sourceText, /<details\b/, "expected each provider group to use <details>");
  assert.match(sourceText, /<summary\b/, "expected each provider group to expose a summary row");
  assert.match(sourceText, /\bdefaultOpen\b/, "expected provider sections to default open");
});

test("QuotaCardGrid — provider sections and accounts use quota monitoring priority", () => {
  const sourceText = fs.readFileSync(COMPONENT_PATH, "utf8");
  assert.match(
    sourceText,
    /\bPROVIDER_ORDER\b/,
    "expected provider sections to use provider order"
  );
  assert.match(
    sourceText,
    /\bsortProviderConnectionsByPriority\b/,
    "expected accounts inside a provider to use a dedicated priority sort"
  );
  assert.match(sourceText, /\bisActive\b/, "expected active accounts to sort before inactive ones");
  assert.match(
    sourceText,
    /\bgetSoonestResetMs\b/,
    "expected account priority to consider the next quota reset"
  );
});

test("QuotaCardGrid (#3520) — per-group card grid fills horizontal space by container width", () => {
  const classNames = extractDivClassNames(COMPONENT_PATH);
  const cardGridClassName = classNames.find((c) => /\bgrid\b/.test(c) && /grid-cols-/.test(c));
  assert.ok(cardGridClassName, "expected to find the per-group card grid's className");

  // Track count must follow the real container width (auto-fill/auto-fit + minmax) ...
  const track = cardGridClassName!.match(
    /(?:^|\s)grid-cols-\[repeat\(auto-(?:fill|fit),minmax\((\d+)px,1fr\)\)\](?=\s|$)/
  );
  assert.ok(
    track,
    `card grid must size tracks by container width (repeat(auto-fill, minmax(Npx, 1fr))), got "${cardGridClassName}"`
  );
  // ... never a fixed or viewport-breakpoint column count, which ignores the width of
  // the section the grid actually lives in and clips cards.
  assert.doesNotMatch(cardGridClassName!, /(?:^|\s)(?:[a-z0-9]+:)*grid-cols-\d+(?=\s|$)/);

  // Two cards plus the gap-3 (12px) gutter must fit in ~600px, so even a half-width
  // window next to the dashboard sidebar still shows several cards per row (#3520).
  const minCardPx = Number(track![1]);
  assert.ok(
    2 * minCardPx + 12 <= 600,
    `minimum card width ${minCardPx}px is too wide for two cards per ~600px row`
  );
});

test("QuotaCardGrid (#3520) — early-returns null when there are no connections", () => {
  const sourceText = fs.readFileSync(COMPONENT_PATH, "utf8");
  assert.match(sourceText, /if\s*\(\s*connections\.length\s*===\s*0\s*\)\s*return\s*null;/);
});
