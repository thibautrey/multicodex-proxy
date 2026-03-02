import React, { useMemo, useState } from "react";
import { Metric } from "../Metric";
import { ProgressStat } from "../ProgressStat";
import { formatTokenCount, usd } from "../../lib/ui";
import type { ExposedModel, TraceStats } from "../../types";

type Props = {
  stats: { total: number; enabled: number; blocked: number };
  usageStats: { primaryAvg: number; secondaryAvg: number; primaryCount: number; secondaryCount: number };
  traceStats: TraceStats;
  storageInfo: any;
  models: ExposedModel[];
};

export function OverviewTab({ stats, usageStats, traceStats, storageInfo, models }: Props) {
  const [providerTab, setProviderTab] = useState<"all" | "openai" | "mistral">("all");

  const filteredModels = useMemo(() => {
    if (providerTab === "all") return models;
    return models.filter((m) => (m.metadata?.provider ?? "openai") === providerTab);
  }, [models, providerTab]);

  return (
    <>
      <section className="grid cards3">
        <Metric title="Accounts" value={`${stats.total}`} />
        <Metric title="Enabled" value={`${stats.enabled}`} />
        <Metric title="Blocked" value={`${stats.blocked}`} />
      </section>

      <section className="grid cards3">
        <Metric title="Requests (selected range)" value={`${traceStats.totals.requests}`} />
        <Metric title="Tokens (selected range)" value={formatTokenCount(traceStats.totals.tokensTotal)} />
        <Metric title="Estimated cost (selected range)" value={usd(traceStats.totals.costUsd)} />
      </section>

      <section className="panel">
        <h2>Aggregated usage</h2>
        <ProgressStat label="5h average" value={usageStats.primaryAvg} count={usageStats.primaryCount} />
        <ProgressStat label="Weekly average" value={usageStats.secondaryAvg} count={usageStats.secondaryCount} />
      </section>

      <section className="grid cards2">
        <section className="panel">
          <h2>Persistence</h2>
          {storageInfo && (
            <ul className="clean-list">
              <li className="mono">accounts: {storageInfo.accountsPath}</li>
              <li className="mono">oauth: {storageInfo.oauthStatePath}</li>
              <li className="mono">trace: {storageInfo.tracePath}</li>
              <li>{storageInfo.persistenceLikelyEnabled ? "Persistence mount detected" : "Persistence not guaranteed"}</li>
            </ul>
          )}
        </section>
        <section className="panel">
          <div className="inline wrap row-between">
            <h2>Models exposed</h2>
            <div className="inline wrap">
              <button className={providerTab === "all" ? "tab active" : "tab"} onClick={() => setProviderTab("all")}>All</button>
              <button className={providerTab === "openai" ? "tab active" : "tab"} onClick={() => setProviderTab("openai")}>OpenAI</button>
              <button className={providerTab === "mistral" ? "tab active" : "tab"} onClick={() => setProviderTab("mistral")}>Mistral</button>
            </div>
          </div>
          <div className="chips">
            {filteredModels.map((m) => (
              <span key={m.id} className="chip mono">{m.id}</span>
            ))}
          </div>
        </section>
      </section>
    </>
  );
}
