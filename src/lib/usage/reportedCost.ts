type CostResolver = (
  provider: string | null | undefined,
  model: string | null | undefined,
  usage: Record<string, number | undefined> | null | undefined,
  options: { serviceTier?: string | null | undefined }
) => Promise<number>;

const EXPLICIT_USD_COST_FIELDS = ["cost_usd", "costUsd", "usd_cost", "usdCost"];
const TOP_LEVEL_COST_FIELDS = [...EXPLICIT_USD_COST_FIELDS, "cost"];
const NESTED_COST_CONTAINER_FIELDS = ["usage", "response", "metadata", "meta"];

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeReportedCostUsd(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function findCostField(record: Record<string, unknown>, fields: string[]): number | null {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const cost = normalizeReportedCostUsd(record[field]);
    if (cost !== null) return cost;
  }
  return null;
}

export function extractReportedCostUsd(...sources: unknown[]): number | null {
  for (const source of sources) {
    const record = toRecord(source);
    if (!record) continue;

    const topLevelCost = findCostField(record, TOP_LEVEL_COST_FIELDS);
    if (topLevelCost !== null) return topLevelCost;

    for (const containerField of NESTED_COST_CONTAINER_FIELDS) {
      const nested = toRecord(record[containerField]);
      if (!nested) continue;
      const nestedCost = findCostField(nested, EXPLICIT_USD_COST_FIELDS);
      if (nestedCost !== null) return nestedCost;
    }
  }

  return null;
}

export async function resolveCostUsd(args: {
  reportedCostSources?: unknown[];
  provider: string | null | undefined;
  model: string | null | undefined;
  usage: unknown;
  serviceTier?: string | null | undefined;
  calculateCost: CostResolver;
}): Promise<number> {
  const reportedCost = extractReportedCostUsd(...(args.reportedCostSources || []));
  if (reportedCost !== null) return reportedCost;

  const usage = toRecord(args.usage) as Record<string, number | undefined> | null;
  if (!usage) return 0;

  return args.calculateCost(args.provider, args.model, usage, {
    serviceTier: args.serviceTier,
  });
}
