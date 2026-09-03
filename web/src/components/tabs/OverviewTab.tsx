import React, { useMemo, useState } from "react";
import { Metric } from "../Metric";
import { ProgressStat } from "../ProgressStat";
import { usd } from "../../lib/ui";
import type { ExposedModel, TraceStats } from "../../types";

type Props = {
  stats: { total: number; enabled: number; blocked: number };
  usageStats: { primaryAvg: number; secondaryAvg: number; primaryCount: number; secondaryCount: number };
  traceStats: TraceStats;
  models: ExposedModel[];
  openModelInDocs: (modelId: string) => void;
  navigate: (tab: "accounts" | "docs" | "tracing") => void;
};

export function OverviewTab({ stats, usageStats, traceStats, models, openModelInDocs, navigate }: Props) {
  const [providerTab, setProviderTab] = useState<
    "all" | "openai" | "openai-compatible" | "opencode" | "mistral" | "zai" | "xai"
  >("all");

  const filteredModels = useMemo(() => {
    if (providerTab === "all") return models;
    return models.filter((model) => {
      const providers = model.metadata?.provider_candidates?.length
        ? model.metadata.provider_candidates
        : model.metadata?.provider
          ? [model.metadata.provider]
          : [];
      return providers.includes(providerTab);
    });
  }, [models, providerTab]);

  const isReady = stats.enabled > 0 && models.length > 0;
  const hasTraffic = traceStats.totals.requests > 0;

  return (
    <>
      <section className="overview-summary grid cards4" aria-label="System summary">
        <Metric
          title="System"
          value={isReady ? "Ready" : "Setup"}
          detail={isReady ? "Providers and models are available" : "Connect a provider to get started"}
          tone={isReady ? "success" : "warning"}
        />
        <Metric title="Providers" value={`${stats.enabled}/${stats.total}`} detail="Enabled accounts" tone={stats.enabled > 0 ? "success" : "default"} />
        <Metric title="Requests" value={`${traceStats.totals.requests}`} detail="In the selected period" />
        <Metric title="Cost" value={usd(traceStats.totals.costUsd)} detail="Estimated provider cost" />
      </section>

      <section className="panel overview-next-step">
        <div>
          <span className="eyebrow">Next step</span>
          <h2>{!stats.total ? "Connect your first provider" : !models.length ? "Choose models to expose" : !hasTraffic ? "Send your first request" : "Everything is running"}</h2>
          <p className="muted">
            {!stats.total
              ? "Add OpenAI, Mistral, Grok Build, OpenCode, or any OpenAI-compatible endpoint."
              : !models.length
                ? "Your provider is connected. Finish its model configuration before routing traffic."
                : !hasTraffic
                  ? "Test an exposed model from the API workspace to validate the complete route."
                  : `${traceStats.totals.requests} requests processed with ${stats.blocked} providers requiring attention.`}
          </p>
        </div>
        <button className="btn overview-primary-action" onClick={() => navigate(!stats.total || !models.length ? "accounts" : !hasTraffic ? "docs" : "tracing")}>
          {!stats.total ? "Add a provider" : !models.length ? "Configure providers" : !hasTraffic ? "Test the API" : "View activity"}
        </button>
      </section>

      <section className="overview-detail-grid">
        <div className="panel overview-usage-panel">
          <div className="section-split-header">
            <div>
              <h2>Provider capacity</h2>
              <small>Average quota remaining across connected accounts.</small>
            </div>
            <span className="badge">{usageStats.primaryCount + usageStats.secondaryCount} windows</span>
          </div>
          <ProgressStat label="Next 5 hours" value={usageStats.primaryAvg} count={usageStats.primaryCount} />
          <ProgressStat label="This week" value={usageStats.secondaryAvg} count={usageStats.secondaryCount} />
        </div>

        <div className="panel overview-models-panel">
          <div className="section-split-header">
            <div>
              <h2>Available models</h2>
              <small>Choose a model to open a ready-to-run request.</small>
            </div>
            <label className="compact-field overview-provider-filter">
              Provider
              <select value={providerTab} onChange={(event) => setProviderTab(event.target.value as typeof providerTab)}>
                <option value="all">All providers</option><option value="openai">OpenAI</option>
                <option value="openai-compatible">OpenAI-compatible</option><option value="opencode">OpenCode</option>
                <option value="mistral">Mistral</option><option value="zai">z.ai</option><option value="xai">Grok Build</option>
              </select>
            </label>
          </div>
          <div className="chips overview-model-list">
            {filteredModels.map((model) => (
              <button key={model.id} className="chip mono model-docs-link" onClick={() => openModelInDocs(model.id)} aria-label={`Test ${model.id} in API reference`}>
                <span>{model.id}</span><span className="model-docs-link-icon" aria-hidden="true">→</span>
              </button>
            ))}
            {!filteredModels.length && <span className="muted">No models available for this provider.</span>}
          </div>
        </div>
      </section>
    </>
  );
}
