import React from "react";
import { Metric } from "../Metric";
import { fmt, maskEmail, maskId, usd } from "../../lib/ui";
import type { Account, TraceStats } from "../../types";

type Props = {
  traceStats: TraceStats;
  email: string;
  setEmail: (v: string) => void;
  startOAuth: () => Promise<void>;
  expectedRedirect: string;
  flowId: string;
  setFlowId: (v: string) => void;
  redirectInput: string;
  setRedirectInput: (v: string) => void;
  completeOAuth: () => Promise<void>;
  accounts: Account[];
  sanitized: boolean;
  patch: (id: string, body: any) => Promise<void>;
  del: (id: string) => Promise<void>;
  unblock: (id: string) => Promise<void>;
  refreshUsage: (id: string) => Promise<void>;
};

export function AccountsTab(props: Props) {
  const {
    traceStats,
    email,
    setEmail,
    startOAuth,
    expectedRedirect,
    flowId,
    setFlowId,
    redirectInput,
    setRedirectInput,
    completeOAuth,
    accounts,
    sanitized,
    patch,
    del,
    unblock,
    refreshUsage,
  } = props;

  return (
    <>
      <section className="grid cards3">
        <Metric title="Requests (trace window)" value={`${traceStats.totals.requests}`} />
        <Metric title="Estimated cost (trace window)" value={usd(traceStats.totals.costUsd)} />
        <Metric title="Top model by volume" value={traceStats.models[0]?.model ?? "-"} />
      </section>

      <section className="panel">
        <h2>OAuth onboarding</h2>
        <div className="inline wrap">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="account@email.com" />
          <button className="btn" onClick={() => void startOAuth()}>Start OAuth</button>
        </div>
        <p className="muted">Expected redirect: <span className="mono">{expectedRedirect}</span></p>
        <div className="inline wrap">
          <input value={flowId} onChange={(e) => setFlowId(e.target.value)} placeholder="flowId" />
          <input value={redirectInput} onChange={(e) => setRedirectInput(e.target.value)} placeholder="Paste full redirect URL/code" />
          <button className="btn" onClick={() => void completeOAuth()}>Complete OAuth</button>
        </div>
      </section>

      <section className="panel">
        <h2>Accounts</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>ID</th>
                <th>5h</th>
                <th>Week</th>
                <th>Blocked</th>
                <th>Error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{sanitized ? maskEmail(a.email) : a.email ?? "-"}</td>
                  <td className="mono">{sanitized ? maskId(a.id) : a.id}</td>
                  <td>{typeof a.usage?.primary?.usedPercent === "number" ? `${Math.round(a.usage.primary.usedPercent)}%` : "?"}<small>{fmt(a.usage?.primary?.resetAt)}</small></td>
                  <td>{typeof a.usage?.secondary?.usedPercent === "number" ? `${Math.round(a.usage.secondary.usedPercent)}%` : "?"}<small>{fmt(a.usage?.secondary?.resetAt)}</small></td>
                  <td>{fmt(a.state?.blockedUntil)}</td>
                  <td className="mono">{a.state?.lastError?.slice(0, 80) ?? "-"}</td>
                  <td className="inline wrap">
                    <button className="btn ghost" onClick={() => void patch(a.id, { enabled: !a.enabled })}>{a.enabled ? "Disable" : "Enable"}</button>
                    <button className="btn ghost" onClick={() => void unblock(a.id)}>Unblock</button>
                    <button className="btn ghost" onClick={() => void refreshUsage(a.id)}>Refresh</button>
                    <button className="btn danger" onClick={() => void del(a.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
