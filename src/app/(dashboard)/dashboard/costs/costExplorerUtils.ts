export type CostExplorerGroupBy = "provider" | "model" | "apiKey" | "account" | "serviceTier";
/**
 * Which figure the explorer treats as "the" cost for sorting/share/avg purposes.
 * `real` (default) = what actually ran (the served model's rates) — unchanged
 * behavior from before this mode existed. `billed` = what the client is charged
 * (the requested model's rates; identical to `real` for any row a model-budget
 * rule never touched). Both figures are always present on every row regardless
 * of basis — this only changes which one drives `avgCostPerRequest`/`sharePct`
 * and the caller's default sort key/column emphasis.
 */
export type CostExplorerCostBasis = "real" | "billed";
export type CostExplorerSortKey =
  | "name"
  | "cost"
  | "normalizedCostUsd"
  | "requests"
  | "totalTokens"
  | "sharePct"
  | "avgCostPerRequest";
export type CostExplorerSortDirection = "asc" | "desc";

export interface CostExplorerUsageSummary {
  totalCost: number;
  totalRequests: number;
}

export interface CostExplorerBreakdownRow {
  provider?: string;
  model?: string;
  rawModel?: string;
  apiKey?: string;
  apiKeyId?: string | null;
  apiKeyName?: string;
  account?: string;
  serviceTier?: string;
  label?: string;
  requests: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
  cost: number;
  /**
   * Cost priced at the model the client asked for (`billed_provider`/
   * `billed_model` when a budget rule redirected the request, the real pair
   * otherwise) — the same figure the API key USD quota and `@@om-usage`
   * report. Optional because older cached payloads may not carry it yet;
   * `buildCostExplorerRows` falls back to `cost` in that case.
   */
  normalizedCost?: number;
  savings?: number;
  usageSavingsTokens?: number;
}

export interface CostExplorerAnalyticsPayload {
  summary: CostExplorerUsageSummary;
  byProvider?: CostExplorerBreakdownRow[];
  byModel?: CostExplorerBreakdownRow[];
  byApiKey?: CostExplorerBreakdownRow[];
  byAccount?: CostExplorerBreakdownRow[];
  byServiceTier?: CostExplorerBreakdownRow[];
}

export interface CostExplorerRow {
  id: string;
  name: string;
  detail: string;
  groupBy: CostExplorerGroupBy;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  /**
   * Priced at the model the client asked for. Differs from `cost` only when a
   * model budget rule rerouted the request — see `CostExplorerBreakdownRow`.
   */
  normalizedCostUsd: number;
  /**
   * `cost` and `normalizedCostUsd` render as the same number for this row (see
   * `costsMatchAtDisplayPrecision`). The Cost Explorer table uses this to print
   * "—" in the secondary cost column instead of repeating the number — never to
   * change sorting/filtering, which always use the real underlying `cost`/
   * `normalizedCostUsd` values regardless of this flag.
   */
  costsMatchDisplay: boolean;
  avgCostPerRequest: number;
  sharePct: number;
}

const GROUP_LABEL_FIELDS: Record<CostExplorerGroupBy, Array<keyof CostExplorerBreakdownRow>> = {
  provider: ["provider"],
  model: ["model", "rawModel"],
  apiKey: ["apiKeyName", "apiKey", "apiKeyId"],
  account: ["account"],
  serviceTier: ["label", "serviceTier"],
};

function toFiniteNumber(value: unknown): number {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

/**
 * Fraction digits the Cost Explorer's currency formatter (`formatCurrencyCost` in
 * `CostOverviewTab.tsx`) uses to display a given USD value. Exported so both the
 * display formatter and the duplicate-value suppression below round at the exact
 * same precision — a value that would render identically to another must be
 * *treated* as identical, not just usually agree by coincidence.
 */
export function resolveCostDisplayFractionDigits(value: number): number {
  const absValue = Math.abs(value);
  if (absValue < 0.01) return 6;
  if (absValue < 1) return 4;
  return 2;
}

/**
 * Formats a USD cost value the way the Cost Explorer displays it — variable
 * fraction digits by magnitude (see `resolveCostDisplayFractionDigits`), with a
 * fixed 2-digit `$0.00` for exactly zero. Moved here (out of `CostOverviewTab.tsx`,
 * where it originated) so `costsMatchAtDisplayPrecision` below can call the EXACT
 * function the table cells render through, not a re-derivation of its rounding
 * rule — see that function's doc for why that distinction matters.
 */
export function formatCurrencyCost(locale: string, value: number): string {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue) || numericValue === 0) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0);
  }

  const fractionDigits = resolveCostDisplayFractionDigits(numericValue);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(numericValue);
}

// Locale used ONLY for the `costsMatchAtDisplayPrecision` equality check below —
// not for anything actually shown to a user. `Intl.NumberFormat` rounding (which
// is what determines whether two values format to the same digits) does not vary
// by locale; only grouping/decimal separators and currency symbol placement do,
// and those are identical on both sides of the comparison regardless of which
// locale is picked. Any fixed locale works; this one is arbitrary.
const DISPLAY_EQUALITY_LOCALE = "en-US";

/**
 * Whether `cost` (real) and `normalizedCostUsd` (billed) would render as the
 * identical STRING in the Cost Explorer table — i.e. whether showing both is
 * pointless duplication rather than a genuine real-vs-billed divergence. This is
 * what a "—" in the secondary cost column means: not "no data", but "identical to
 * the other column at the precision shown."
 *
 * Round 1 of this fix rounded both values to a single shared fraction-digit
 * count derived from `cost` alone, then compared the rounded numbers. That was
 * wrong: the actual cell renderer (`formatCurrencyCost`) picks fraction digits
 * PER VALUE, independently, from each value's own magnitude — so anchoring on
 * `cost` produced false positives whenever `cost` landed in a coarser tier than
 * `normalizedCostUsd` (e.g. `cost=1.00` → 2 digits → "$1.00"; `normalizedCostUsd
 * =0.995` → 4 digits on its own → "$0.9950"; anchoring on cost's 2-digit tier
 * rounded 0.995 to 1.00 and wrongly reported them as matching, hiding a visibly
 * different pair of numbers and mislabeling the muted cell "Same as Cost"). The
 * bug was asymmetric — anchoring on the OTHER argument gave the opposite wrong
 * answer for the mirrored input — which is itself the tell that anchoring on
 * either single argument can never be correct in general.
 *
 * Fixed by comparing the RENDERED STRINGS directly — `formatCurrencyCost(a) ===
 * formatCurrencyCost(b)` is true, by construction, exactly when a user reading
 * the table would see the same thing in both cells. This removes the entire
 * class of tier-boundary mismatches (there is no "which argument to anchor on"
 * question anymore) rather than fixing the one direction that got reported.
 * Comparing rendered output is inherently symmetric, i.e.
 * `costsMatchAtDisplayPrecision(a, b) === costsMatchAtDisplayPrecision(b, a)`
 * always — round 1's anchor-on-first-argument version was not.
 *
 * One consequence, by design: a pair that sits exactly on a tier boundary and is
 * numerically near-identical but independently renders with a different digit
 * COUNT (e.g. `0.0100` at 4 digits vs `0.010000` at 6 digits for a value a
 * fraction below the $0.01 threshold) is now correctly treated as NOT matching —
 * the two strings really do differ, even though the gap is only trailing-zero
 * padding. Showing both numbers in that rare case is the safe failure mode;
 * silently hiding a real difference (the bug being fixed here) is not.
 */
export function costsMatchAtDisplayPrecision(cost: number, normalizedCostUsd: number): boolean {
  return (
    formatCurrencyCost(DISPLAY_EQUALITY_LOCALE, cost) ===
    formatCurrencyCost(DISPLAY_EQUALITY_LOCALE, normalizedCostUsd)
  );
}

function getRowLabel(row: CostExplorerBreakdownRow, groupBy: CostExplorerGroupBy): string {
  for (const field of GROUP_LABEL_FIELDS[groupBy]) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Unknown";
}

function getRowDetail(row: CostExplorerBreakdownRow, groupBy: CostExplorerGroupBy): string {
  if (groupBy === "model") return row.provider || row.rawModel || "";
  if (groupBy === "apiKey") return row.apiKeyId || row.apiKey || "";
  if (groupBy === "provider") return row.model || "";
  if (groupBy === "serviceTier") return row.serviceTier || "";
  return "";
}

function getGroupRows(
  analytics: CostExplorerAnalyticsPayload,
  groupBy: CostExplorerGroupBy
): CostExplorerBreakdownRow[] {
  switch (groupBy) {
    case "provider":
      return analytics.byProvider || [];
    case "model":
      return analytics.byModel || [];
    case "apiKey":
      return analytics.byApiKey || [];
    case "account":
      return analytics.byAccount || [];
    case "serviceTier":
      return analytics.byServiceTier || [];
    default:
      return [];
  }
}

function getSortValue(row: CostExplorerRow, sortKey: CostExplorerSortKey): string | number {
  return sortKey === "name" ? row.name.toLowerCase() : row[sortKey];
}

export function buildCostExplorerRows({
  analytics,
  groupBy,
  costBasis = "real",
  searchQuery = "",
  sortKey = "cost",
  sortDirection = "desc",
}: {
  analytics: CostExplorerAnalyticsPayload | null | undefined;
  groupBy: CostExplorerGroupBy;
  costBasis?: CostExplorerCostBasis;
  searchQuery?: string;
  sortKey?: CostExplorerSortKey;
  sortDirection?: CostExplorerSortDirection;
}): CostExplorerRow[] {
  if (!analytics) return [];

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const sourceRows = getGroupRows(analytics, groupBy);
  const totalRealCost = toFiniteNumber(analytics.summary?.totalCost);
  const totalRequests = toFiniteNumber(analytics.summary?.totalRequests);
  // Sum of normalizedCost across every row in this dimension. Unlike
  // `totalRealCost` (a server-computed summary figure), there is no
  // server-side "total normalized" summary today, but the sum is dimension-
  // invariant — it's the same underlying usage_history rows regrouped, so
  // summing here is equivalent to summing at the source. Only meaningful in
  // "billed" basis; unused (and untested against a server figure) otherwise.
  const totalNormalizedCost = sourceRows.reduce((sum, row) => {
    const cost = toFiniteNumber(row.cost);
    const normalizedCost =
      row.normalizedCost === undefined ? cost : toFiniteNumber(row.normalizedCost);
    return sum + normalizedCost;
  }, 0);
  const totalCost = costBasis === "billed" ? totalNormalizedCost : totalRealCost;

  return sourceRows
    .map((row, index) => {
      const name = getRowLabel(row, groupBy);
      const detail = getRowDetail(row, groupBy);
      const requests = toFiniteNumber(row.requests);
      const cost = toFiniteNumber(row.cost);
      // Fall back to `cost` when the payload predates normalizedCost (older
      // cache entry) — for unredirected traffic the two are equal anyway.
      const normalizedCostUsd =
        row.normalizedCost === undefined ? cost : toFiniteNumber(row.normalizedCost);
      const totalTokens = toFiniteNumber(row.totalTokens);
      const primaryCost = costBasis === "billed" ? normalizedCostUsd : cost;
      const useCostForShare = totalCost > 0;
      const shareBase = useCostForShare ? totalCost : totalRequests;
      const shareValue = useCostForShare ? primaryCost : requests;

      return {
        id: `${groupBy}:${name}:${detail}:${index}`,
        name,
        detail,
        groupBy,
        requests,
        promptTokens: toFiniteNumber(row.promptTokens),
        completionTokens: toFiniteNumber(row.completionTokens),
        totalTokens,
        cost,
        normalizedCostUsd,
        costsMatchDisplay: costsMatchAtDisplayPrecision(cost, normalizedCostUsd),
        avgCostPerRequest: requests > 0 ? primaryCost / requests : 0,
        sharePct: shareBase > 0 ? (shareValue / shareBase) * 100 : 0,
      };
    })
    .filter((row) => {
      if (!normalizedSearch) return true;
      return `${row.name} ${row.detail}`.toLowerCase().includes(normalizedSearch);
    })
    .sort((left, right) => {
      const leftValue = getSortValue(left, sortKey);
      const rightValue = getSortValue(right, sortKey);
      let result = 0;

      if (typeof leftValue === "string" || typeof rightValue === "string") {
        result = String(leftValue).localeCompare(String(rightValue));
      } else {
        result = leftValue - rightValue;
      }

      if (result === 0) result = left.name.localeCompare(right.name);
      return sortDirection === "asc" ? result : -result;
    });
}
