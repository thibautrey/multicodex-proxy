import React from "react";
import { Metric } from "../Metric";
import { ProgressStat } from "../ProgressStat";
import { formatTokenCount, usd } from "../../lib/ui";
import type { TraceStats } from "../../types";

type Props = {
  stats: { total: number; enabled: number; blocked: number };
  usageStats: { primaryAvg: number; secondaryAvg: number; primaryCount: number; secondaryCount: number };
  traceStats: TraceStats;
  storageInfo: any;
  models: string[];
};

export function OverviewTab({ stats, usageStats, traceStats, storageInfo, models }: Props) {
  return (
    <>
      <section className="grid cards3">
        <Metric title="Accounts" value={`${stats.total}`} />
        <Metric title="Enabled" value={`${stats.enabled}`} />
        <Metric title="Blocked" value={`${stats.blocked}`} />
      </section>

      <section className="grid cards3">
        <Metric title="Requests (trace window)" value={`${traceStats.totals.requests}`} />
        <Metric title="Tokens (trace window)" value={formatTokenCount(traceStats.totals.tokensTotal)} />
        <Metric title="Estimated cost (trace window)" value={usd(traceStats.totals.costUsd)} />
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
          <h2>Models exposed</h2>
          <div className="chips">{models.map((m) => <span key={m} className="chip mono">{m}</span>)}</div>
        </section>
      </section>
    </>
  );
}
