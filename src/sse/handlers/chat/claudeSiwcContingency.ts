import { getCachedSettings } from "@/lib/db/readCache";
import {
  getProviderConnectionById,
  getProviderConnections,
  getProviderNodeById,
} from "@/lib/db/providers";
import { isModelBlockedByPatterns } from "@/lib/db/apiKeys";
import { checkKeyModelAccess } from "@/lib/db/apiKeyGroups";
import { constrainConnectionsToQuota, resolveQuotaKeyScope } from "@/lib/quota/quotaKey";
import {
  CLAUDE_SIWC_UPSTREAM_MODEL,
  claudeSiwcContingencySchema,
} from "@/shared/validation/claudeSiwcContingencySchema";
import { resolveProviderId } from "@/shared/constants/providers";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { resolveConnectionRestrictions } from "../../services/connectionRestrictions";
import { resolveModelOrError } from "../chatHelpers";
import { createVisibleResolvedModelGate } from "./resolvedModelPolicy";
import { withHiddenModelGate } from "./hiddenModelGate";
import { isClaudeSiwcFamily } from "./claudeSiwcAvailability";

type SourcePolicy = {
  id?: string;
  name?: string;
  allowedConnections?: string[] | null;
  allowedQuotas?: string[] | null;
  blockedModels?: string[] | null;
};
type ModelGate = (models: Iterable<string>) => Promise<Response | null>;
type Contingency = {
  provider: string;
  model: string;
  connectionId: string;
  billedProvider: string;
  billedModel: string;
  gate: ModelGate;
};

const unavailable = () =>
  errorResponse(
    503,
    "Claude SIWC contingency is enabled but its configured target is unavailable",
    {
      code: "CLAUDE_SIWC_CONTINGENCY_UNAVAILABLE",
    }
  );

/** These are the platform LiteLLM ingress and its Swarm service, never OmniRoute. */
function isPlatformLiteLlmUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["https://api.witdev.com.br/internal/llm/v1", "http://platform-litellm:4000/v1"].includes(
    value.replace(/\/$/, "")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep legacy bare Claude ids on the operator-selected provider while contingency is on. */
export async function resolveClaudeSiwcSourceModel(modelStr: string): Promise<string> {
  if (modelStr.includes("/") || !isClaudeSiwcFamily(modelStr)) return modelStr;
  const settings = await getCachedSettings();
  const config = settings.claudeSiwcContingency;
  return isRecord(config) &&
    config.enabled === true &&
    settings.preferClaudeCodeForUnprefixedClaudeModels === true
    ? `claude/${modelStr}`
    : modelStr;
}

/** Server-only exact substitution, authorized against the original Claude request first. */
export async function resolveClaudeSiwcContingency(opts: {
  provider: string;
  model: string;
  modelStr: string;
  body: unknown;
  endpoint?: string;
  apiKey: string | null | undefined;
  apiKeyInfo: SourcePolicy | null | undefined;
  contextModel?: string | null;
  comboGrantsTargets?: boolean;
  forcedConnectionId?: string | null;
  allowedConnectionIds?: string[] | null;
  isCombo: boolean;
}): Promise<{ contingency?: Contingency; rejection?: Response }> {
  if (resolveProviderId(opts.provider) !== "claude" || !isClaudeSiwcFamily(opts.model)) {
    return {};
  }
  const settings = await getCachedSettings();
  const raw = settings.claudeSiwcContingency;
  if (!raw || (isRecord(raw) && raw.enabled === false)) return {};
  const config = claudeSiwcContingencySchema.safeParse(raw);
  if (!config.success) return { rejection: unavailable() };
  if (!config.data.enabled) return {};

  if (
    (await isModelBlockedByPatterns(
      opts.apiKeyInfo?.blockedModels,
      `${opts.provider}/${opts.model}`
    )) ||
    (await isModelBlockedByPatterns(opts.apiKeyInfo?.blockedModels, opts.modelStr))
  ) {
    return {
      rejection: errorResponse(403, "Original Claude model is not allowed for this API key"),
    };
  }

  const sourceKeyId = opts.apiKeyInfo?.id;
  if (
    sourceKeyId &&
    ["claude", "cc"].some((provider) =>
      [opts.model, `${provider}/${opts.model}`].some(
        (model) => checkKeyModelAccess(sourceKeyId, model, provider).deniedBy !== null
      )
    )
  ) {
    return {
      rejection: errorResponse(403, "Original Claude model is denied by API key group policy"),
    };
  }
  const sourceGate = createVisibleResolvedModelGate({
    ...opts,
    contextModel: opts.contextModel,
    comboGrantsTargets: opts.comboGrantsTargets,
  });
  const sourceDenied = await sourceGate([`${opts.provider}/${opts.model}`]);
  if (sourceDenied) return { rejection: sourceDenied };

  // Authorization uses source pool membership, without checking source quota/health.
  // An exhausted Claude account is the reason for enabling this contingency.
  const restriction = resolveConnectionRestrictions(
    opts.apiKeyInfo,
    { connectionId: opts.forcedConnectionId, allowedConnectionIds: opts.allowedConnectionIds },
    opts.isCombo
  );
  let sourceConnections = restriction.allowedConnections;
  const sourceDeniedConnection = () => ({
    rejection: errorResponse(403, "Original Claude connection is not allowed for this API key"),
  });
  if (Array.isArray(sourceConnections) && sourceConnections.length === 0)
    return sourceDeniedConnection();
  if (!sourceConnections && opts.forcedConnectionId) sourceConnections = [opts.forcedConnectionId];
  if (opts.apiKeyInfo?.allowedQuotas?.length) {
    const quota = await resolveQuotaKeyScope(opts.apiKeyInfo.allowedQuotas);
    if (quota.connectionIds.length === 0) return sourceDeniedConnection();
    sourceConnections = constrainConnectionsToQuota(sourceConnections ?? [], quota.connectionIds);
  }
  if (
    opts.forcedConnectionId &&
    sourceConnections &&
    !sourceConnections.includes(opts.forcedConnectionId)
  ) {
    return sourceDeniedConnection();
  }
  if (sourceConnections) {
    const sourcePool = await getProviderConnections({ provider: "claude" });
    if (!sourcePool.some((connection) => sourceConnections.includes(String(connection.id)))) {
      return {
        rejection: errorResponse(403, "Original Claude connection is not allowed for this API key"),
      };
    }
  }

  const resolved = await resolveModelOrError(config.data.targetModel, opts.body, opts.endpoint);
  if (
    resolved.error ||
    resolved.model !== CLAUDE_SIWC_UPSTREAM_MODEL ||
    !resolved.provider?.startsWith("openai-compatible-")
  ) {
    return { rejection: unavailable() };
  }
  const [node, connection] = await Promise.all([
    getProviderNodeById(resolved.provider),
    getProviderConnectionById(config.data.connectionId),
  ]);
  const connectionData = connection?.providerSpecificData;
  const connectionUrl = isRecord(connectionData) ? connectionData.baseUrl : undefined;
  if (
    !node ||
    node.type !== "openai-compatible" ||
    !isPlatformLiteLlmUrl(node.baseUrl) ||
    !isPlatformLiteLlmUrl(connectionUrl) ||
    !connection ||
    connection.provider !== resolved.provider ||
    connection.isActive === false
  ) {
    return { rejection: unavailable() };
  }
  const target = `${resolved.provider}/${resolved.model}`;
  const targetAlias = config.data.targetModel.split("/")[0];
  const apiKeyId = opts.apiKeyInfo?.id;
  const targetHasGroupDeny = () =>
    apiKeyId &&
    [resolved.provider, targetAlias].some((provider) =>
      [resolved.model, `${provider}/${resolved.model}`].some(
        (model) => checkKeyModelAccess(apiKeyId, model, provider).deniedBy !== null
      )
    );
  // The operator grants this one replacement only. No API-key metadata changes,
  // combo grant fabrication, or client-controlled bypass flags are involved.
  const gate = withHiddenModelGate(async (models) => {
    for (const model of models) {
      if (
        model !== target ||
        targetHasGroupDeny() ||
        (await isModelBlockedByPatterns(opts.apiKeyInfo?.blockedModels, model)) ||
        (await isModelBlockedByPatterns(opts.apiKeyInfo?.blockedModels, config.data.targetModel))
      ) {
        return errorResponse(403, "Claude SIWC contingency target is not allowed");
      }
    }
    return null;
  });
  const denied = await gate([target]);
  if (denied) return { rejection: denied };
  return {
    contingency: {
      provider: resolved.provider,
      model: resolved.model,
      connectionId: config.data.connectionId,
      billedProvider: opts.provider,
      billedModel: opts.model,
      gate,
    },
  };
}

export function withClaudeSiwcContingencyHeader(response: Response, active: boolean): Response {
  if (active) response.headers.set("X-OmniRoute-Contingency", "claude-siwc");
  return response;
}
