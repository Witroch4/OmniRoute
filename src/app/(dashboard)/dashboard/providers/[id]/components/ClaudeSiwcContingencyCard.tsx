"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Card, Icon, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { providerText } from "../providerCredentialText";

type Contingency = { enabled: boolean; targetModel: string; connectionId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readContingency(payload: unknown): Contingency {
  if (!isRecord(payload)) throw new Error("Invalid settings response");
  const value = payload.claudeSiwcContingency;
  if (!isRecord(value)) {
    return { enabled: false, targetModel: "", connectionId: "" };
  }
  return {
    enabled: value.enabled === true,
    targetModel: typeof value.targetModel === "string" ? value.targetModel : "",
    connectionId: typeof value.connectionId === "string" ? value.connectionId : "",
  };
}

async function fetchContingency(
  signal?: AbortSignal
): Promise<{ ok: true; config: Contingency; revision: string | null } | { ok: false }> {
  try {
    const response = await fetch("/api/settings", { cache: "no-store", signal });
    if (!response.ok) return { ok: false };
    return {
      ok: true,
      config: readContingency(await response.json()),
      revision: response.headers.get("ETag"),
    };
  } catch {
    return { ok: false };
  }
}

export default function ClaudeSiwcContingencyCard() {
  const t = useTranslations("providers");
  const notify = useNotificationStore();
  const [config, setConfig] = useState<Contingency | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const revision = useRef<string | null>(null);
  const saveInFlight = useRef(false);
  const text = (key: string, fallback: string) =>
    providerText(t, `siwcContingency.${key}`, fallback);

  const load = useCallback(async (signal?: AbortSignal) => {
    const outcome = await fetchContingency(signal);
    if (signal?.aborted) return;
    if (outcome.ok) {
      revision.current = outcome.revision;
      setConfig(outcome.config);
      setError(false);
    } else {
      setError(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchContingency(controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      if (outcome.ok) {
        revision.current = outcome.revision;
        setConfig(outcome.config);
        setError(false);
      } else {
        setError(true);
      }
    });
    return () => controller.abort();
  }, []);

  async function toggle(enabled: boolean) {
    if (!config || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(revision.current ? { "If-Match": revision.current } : {}),
        },
        body: JSON.stringify({ claudeSiwcContingency: { ...config, enabled } }),
      });
      if (!response.ok) {
        await load();
        throw new Error(`Settings HTTP ${response.status}`);
      }
      const next = readContingency(await response.json());
      revision.current = response.headers.get("ETag");
      setConfig(next);
      setError(false);
      notify.success(
        next.enabled
          ? text(
              "enabled",
              "SIWC contingency enabled: Opus, Sonnet and Haiku now use Terra latest."
            )
          : text("disabled", "SIWC contingency disabled: Claude Code routing restored.")
      );
    } catch {
      notify.error(text("saveError", "Could not update the contingency. Reload and try again."));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  const configured = Boolean(config?.targetModel.trim() && config?.connectionId.trim());
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Icon name="alt_route" size={18} className="text-primary" />
            {text("title", "SIWC contingency · Terra latest")}
          </h2>
          <p className="mt-2 text-sm text-text-muted">
            {text(
              "description",
              "Send Opus, Sonnet and Haiku requests to the latest available Terra using Witdev Platform's ChatGPT plan. Your applications keep executing their tools."
            )}
          </p>
          {!error && config && !configured && (
            <p className="mt-2 text-sm text-text-muted">
              {text("notConfigured", "Configure the SIWC connection before enabling contingency.")}
            </p>
          )}
          {error && (
            <div
              className="mt-2 flex flex-wrap items-center gap-2 text-sm text-text-muted"
              role="alert"
            >
              <span>{text("loadError", "Could not load the current contingency setting.")}</span>
              <Button variant="ghost" size="sm" onClick={() => void load()} disabled={saving}>
                {text("retry", "Reload")}
              </Button>
            </div>
          )}
        </div>
        <Toggle
          checked={config?.enabled === true}
          disabled={!config || error || saving || (!configured && !config.enabled)}
          onChange={(enabled) => void toggle(enabled)}
          ariaLabel={text("title", "SIWC contingency · Terra latest")}
        />
      </div>
    </Card>
  );
}
