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
      <section className="section-header">
        <div>
          <div className="eyebrow">Health snapshot</div>
          <h2>Routing posture at a glance</h2>
          <p className="muted">
            The overview should answer three things quickly: how much capacity is online,
            whether request traffic is healthy, and which models are actually exposed.
          </p>
        </div>
      </section>

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

      <section className="grid cards4">
        <Metric title="Requests" value={`${traceStats.totals.requests}`} detail="For the selected trace range" />
        <Metric title="Total tokens" value={formatTokenCount(traceStats.totals.tokensTotal)} detail="Input and output combined" />
        <Metric title="Estimated cost" value={usd(traceStats.totals.costUsd)} detail="Derived from model pricing" />
        <Metric title="Avg latency" value={`${Math.round(traceStats.totals.latencyAvgMs)}ms`} detail="Mean response time across traced calls" />
      </section>

      <section className="grid cards2">
        <section className="panel">
          <div className="section-split-header">
            <div>
              <div className="eyebrow">Capacity</div>
              <h2>Aggregated usage</h2>
            </div>
            <span className="badge">{usageStats.primaryCount + usageStats.secondaryCount} windows tracked</span>
          </div>
          <p className="muted section-copy">
            These averages tell you whether the router still has room before quota-driven
            failover becomes the normal path.
          </p>
          <ProgressStat label="5h average" value={usageStats.primaryAvg} count={usageStats.primaryCount} />
          <ProgressStat label="Weekly average" value={usageStats.secondaryAvg} count={usageStats.secondaryCount} />
        </section>

        <section className="panel">
          <div className="section-split-header">
            <div>
              <div className="eyebrow">Storage</div>
              <h2>Persistence footprint</h2>
            </div>
            {storageInfo && (
              <span className={storageInfo.persistenceLikelyEnabled ? "badge badge-live" : "badge badge-warn"}>
                {storageInfo.persistenceLikelyEnabled ? "Persistence detected" : "Mount not guaranteed"}
              </span>
            )}
          </div>
          <p className="muted section-copy">
            Accounts, OAuth state, and traces are file-backed. If this section looks wrong,
            your dashboard may be healthy while your restart story is not.
          </p>
          {storageInfo && (
            <ul className="clean-list">
              <li className="mono">accounts: {storageInfo.accountsPath}</li>
              <li className="mono">oauth: {storageInfo.oauthStatePath}</li>
              <li className="mono">trace: {storageInfo.tracePath}</li>
            </ul>
          )}
        </section>
      </section>

      <section className="panel">
          <div className="section-split-header">
            <div>
              <div className="eyebrow">Inventory</div>
              <h2>Models exposed</h2>
            </div>
            <div className="inline wrap">
              <button className={providerTab === "all" ? "tab active" : "tab"} onClick={() => setProviderTab("all")}>All</button>
              <button className={providerTab === "openai" ? "tab active" : "tab"} onClick={() => setProviderTab("openai")}>OpenAI</button>
              <button className={providerTab === "mistral" ? "tab active" : "tab"} onClick={() => setProviderTab("mistral")}>Mistral</button>
            </div>
          </div>
          <p className="muted section-copy">
            The router only looks as good as the inventory it can advertise. Check this list
            when aliases appear healthy but clients still cannot resolve a target model.
          </p>
          <div className="chips">
            {filteredModels.map((m) => (
              <span key={m.id} className="chip mono">{m.id}</span>
            ))}
            {!filteredModels.length && <span className="muted">No models exposed for this provider.</span>}
          </div>
      </section>
    </>
  );
}
