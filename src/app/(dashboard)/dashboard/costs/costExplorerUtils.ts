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

function roundToFractionDigits(value: number, fractionDigits: number): number {
  const factor = 10 ** fractionDigits;
  return Math.round(value * factor) / factor;
}

/**
 * Whether `cost` (real) and `normalizedCostUsd` (billed) would render as the
 * identical number in the Cost Explorer table — i.e. whether showing both is
 * pointless duplication rather than a genuine real-vs-billed divergence. This is
 * what a "—" in the secondary cost column means: not "no data", but "identical to
 * the other column at the precision shown."
 *
 * Both values are rounded to the SAME fraction-digit count — derived from `cost`
 * only, never independently per value — before comparing. Deriving fraction
 * digits independently per value would let two numbers that sit on opposite
 * sides of a fraction-digit threshold (0.01 or 1.00) get rounded at different
 * precisions and spuriously compare unequal even though a human reading the
 * rendered strings would see the same number; deriving both from one reference
 * also means a sub-cent floating-point gap between two pricing-resolution passes
 * (e.g. 0.0105000000000001 vs 0.0104999999999999) rounds to the same value on
 * both sides and does not defeat the suppression.
 */
export function costsMatchAtDisplayPrecision(cost: number, normalizedCostUsd: number): boolean {
  const fractionDigits = resolveCostDisplayFractionDigits(cost);
  return (
    roundToFractionDigits(cost, fractionDigits) ===
    roundToFractionDigits(normalizedCostUsd, fractionDigits)
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
