import React, { useMemo, useState } from "react";
import { Metric } from "../Metric";
import { ProgressStat } from "../ProgressStat";
import { formatTokenCount, formatTokenRate, usd } from "../../lib/ui";
import type { ExposedModel, TraceStats } from "../../types";

type Props = {
  stats: { total: number; enabled: number; blocked: number };
  usageStats: { primaryAvg: number; secondaryAvg: number; primaryCount: number; secondaryCount: number };
  traceStats: TraceStats;
  models: ExposedModel[];
  openModelInDocs: (modelId: string) => void;
};

export function OverviewTab({
  stats,
  usageStats,
  traceStats,
  models,
  openModelInDocs,
}: Props) {
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

  return (
    <>
      <section className="grid cards4">
        <Metric title="Accounts" value={`${stats.total}`} detail="Configured provider accounts" />
        <Metric title="Enabled" value={`${stats.enabled}`} detail="Ready to receive traffic" tone="success" />
        <Metric
          title="Blocked"
          value={`${stats.blocked}`}
          detail="Temporarily excluded from routing"
          tone={stats.blocked > 0 ? "warning" : "default"}
        />
        <Metric title="Models exposed" value={`${models.length}`} detail="Discovered from provider inventory" />
      </section>

      <section className="grid cards6">
        <Metric title="Requests" value={`${traceStats.totals.requests}`} detail="For the selected trace range" />
        <Metric title="Input tokens" value={formatTokenCount(traceStats.totals.tokensInput)} detail="Prompt tokens sent to providers" />
        <Metric title="Output tokens" value={formatTokenCount(traceStats.totals.tokensOutput)} detail="Generated tokens returned by providers" />
        <Metric title="Inference speed" value={formatTokenRate(traceStats.totals.inferenceTokensPerSecond)} detail={`${traceStats.totals.inferenceRequests} measurable requests`} />
        <Metric title="Estimated cost" value={usd(traceStats.totals.costUsd)} detail={`No-cache estimate: ${usd(traceStats.totals.costUsdWithoutCache)}`} />
        <Metric title="Avg latency" value={`${Math.round(traceStats.totals.latencyAvgMs)}ms`} detail="Mean response time across traced calls" />
      </section>

        <section className="panel">
          <div className="section-split-header">
            <h2>Aggregated usage</h2>
            <span className="badge">{usageStats.primaryCount + usageStats.secondaryCount} windows</span>
          </div>
          <ProgressStat label="5h average" value={usageStats.primaryAvg} count={usageStats.primaryCount} />
          <ProgressStat label="Weekly average" value={usageStats.secondaryAvg} count={usageStats.secondaryCount} />
        </section>

      <section className="panel">
        <div className="section-split-header">
          <div>
            <h2>Models exposed</h2>
            <small>Select a model to open a prefilled live request.</small>
          </div>
          <div className="inline wrap">
            <button className={providerTab === "all" ? "tab active" : "tab"} onClick={() => setProviderTab("all")}>All</button>
            <button className={providerTab === "openai" ? "tab active" : "tab"} onClick={() => setProviderTab("openai")}>OpenAI</button>
            <button className={providerTab === "openai-compatible" ? "tab active" : "tab"} onClick={() => setProviderTab("openai-compatible")}>OpenAI-compatible</button>
            <button className={providerTab === "opencode" ? "tab active" : "tab"} onClick={() => setProviderTab("opencode")}>OpenCode</button>
            <button className={providerTab === "mistral" ? "tab active" : "tab"} onClick={() => setProviderTab("mistral")}>Mistral</button>
            <button className={providerTab === "zai" ? "tab active" : "tab"} onClick={() => setProviderTab("zai")}>z.ai</button>
            <button className={providerTab === "xai" ? "tab active" : "tab"} onClick={() => setProviderTab("xai")}>Grok Build</button>
          </div>
        </div>
        <div className="chips">
          {filteredModels.map((m) => (
            <button
              key={m.id}
              className="chip mono model-docs-link"
              onClick={() => openModelInDocs(m.id)}
              aria-label={`Test ${m.id} in API reference`}
              title="Open a prefilled request in API reference"
            >
              <span>{m.id}</span>
              <span className="model-docs-link-icon" aria-hidden="true">→</span>
            </button>
          ))}
          {!filteredModels.length && <span className="muted">No models exposed.</span>}
        </div>
      </section>
    </>
  );
}
