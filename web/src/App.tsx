import { useEffect, useMemo, useState } from "react";
import "./styles.css";

type Account = {
  id: string;
  email?: string;
  enabled: boolean;
  usage?: { primary?: { usedPercent?: number; resetAt?: number }; secondary?: { usedPercent?: number; resetAt?: number } };
  state?: { blockedUntil?: number; lastError?: string };
};

type Trace = {
  at: number;
  route: string;
  accountId?: string;
  accountEmail?: string;
  status: number;
  stream: boolean;
  latencyMs: number;
  usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number };
  error?: string;
};

const tokenDefault = localStorage.getItem("adminToken") ?? "change-me";
const fmt = (ts?: number) => (!ts ? "-" : new Date(ts).toLocaleString());
const pct = (v?: number) => (typeof v === "number" ? `${Math.round(v)}%` : "?");

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-token": localStorage.getItem("adminToken") ?? tokenDefault,
      ...(init?.headers ?? {}),
    },
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(txt || `HTTP ${res.status}`);
  return txt ? JSON.parse(txt) : {};
}

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [email, setEmail] = useState("");
  const [flowId, setFlowId] = useState("");
  const [redirectInput, setRedirectInput] = useState("");
  const [expectedRedirect, setExpectedRedirect] = useState("http://localhost:1455/auth/callback");
  const [adminToken, setAdminToken] = useState(localStorage.getItem("adminToken") ?? tokenDefault);
  const [storageInfo, setStorageInfo] = useState<any>(null);
  const [error, setError] = useState("");

  const stats = useMemo(() => ({
    total: accounts.length,
    enabled: accounts.filter((a) => a.enabled).length,
    blocked: accounts.filter((a) => a.state?.blockedUntil && a.state.blockedUntil > Date.now()).length,
  }), [accounts]);

  const load = async () => {
    try {
      setError("");
      const [acc, cfg, tr] = await Promise.all([
        api("/admin/accounts"),
        api("/admin/config"),
        api("/admin/traces?limit=40"),
      ]);
      setAccounts(acc.accounts ?? []);
      setExpectedRedirect(cfg.oauthRedirectUri ?? expectedRedirect);
      setStorageInfo(cfg.storage ?? null);
      setTraces((tr.traces ?? []).reverse());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  useEffect(() => { load(); }, []);

  const startOAuth = async () => {
    if (!email.trim()) return;
    const d = await api("/admin/oauth/start", { method: "POST", body: JSON.stringify({ email }) });
    setFlowId(d.flowId);
    setExpectedRedirect(d.expectedRedirectUri ?? expectedRedirect);
    window.open(d.authorizeUrl, "_blank", "noopener,noreferrer");
  };

  const completeOAuth = async () => {
    await api("/admin/oauth/complete", { method: "POST", body: JSON.stringify({ flowId, input: redirectInput }) });
    setRedirectInput("");
    await load();
  };

  const patch = async (id: string, body: any) => { await api(`/admin/accounts/${id}`, { method: "PATCH", body: JSON.stringify(body) }); await load(); };
  const del = async (id: string) => { if (confirm("Delete account?")) { await api(`/admin/accounts/${id}`, { method: "DELETE" }); await load(); } };

  return (
    <div className="page">
      <div className="shell">
        <header className="header card">
          <div>
            <h1>MultiCodex Proxy</h1>
            <p>Quota-aware multi-account proxy with OAuth and request tracing.</p>
          </div>
          <div className="inline">
            <input value={adminToken} onChange={(e) => setAdminToken(e.target.value)} onBlur={() => localStorage.setItem("adminToken", adminToken)} placeholder="Admin token" />
            <button onClick={load}>Refresh</button>
          </div>
        </header>

        <section className="grid cards3">
          <Metric title="Accounts" value={`${stats.total}`} />
          <Metric title="Enabled" value={`${stats.enabled}`} />
          <Metric title="Blocked" value={`${stats.blocked}`} />
        </section>

        <section className="card">
          <h2>Persistence</h2>
          <p className="muted">Accounts are persisted on disk and survive container restarts.</p>
          {storageInfo && (
            <ul>
              <li className="mono">accounts: {storageInfo.accountsPath}</li>
              <li className="mono">oauth: {storageInfo.oauthStatePath}</li>
              <li className="mono">trace: {storageInfo.tracePath}</li>
              <li>{storageInfo.persistenceLikelyEnabled ? "✅ Persistence mount detected" : "⚠️ Persistence not guaranteed"}</li>
            </ul>
          )}
        </section>

        <section className="card">
          <h2>OAuth onboarding</h2>
          <div className="inline wrap">
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="account@email.com" />
            <button onClick={startOAuth}>Start OAuth</button>
          </div>
          <p className="muted">Expected redirect: <span className="mono">{expectedRedirect}</span></p>
          <div className="inline wrap">
            <input value={flowId} onChange={(e) => setFlowId(e.target.value)} placeholder="flowId" />
            <input value={redirectInput} onChange={(e) => setRedirectInput(e.target.value)} placeholder="Paste full redirect URL/code" />
            <button onClick={completeOAuth}>Complete OAuth</button>
          </div>
        </section>

        <section className="card">
          <h2>Accounts</h2>
          <table><thead><tr><th>Email</th><th>ID</th><th>5h</th><th>Week</th><th>Blocked</th><th>Error</th><th /></tr></thead><tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.email ?? "-"}</td>
                <td className="mono">{a.id}</td>
                <td>{pct(a.usage?.primary?.usedPercent)}<small>{fmt(a.usage?.primary?.resetAt)}</small></td>
                <td>{pct(a.usage?.secondary?.usedPercent)}<small>{fmt(a.usage?.secondary?.resetAt)}</small></td>
                <td>{fmt(a.state?.blockedUntil)}</td>
                <td className="mono">{a.state?.lastError?.slice(0, 90) ?? "-"}</td>
                <td className="inline wrap">
                  <button onClick={() => patch(a.id, { enabled: !a.enabled })}>{a.enabled ? "Disable" : "Enable"}</button>
                  <button onClick={() => api(`/admin/accounts/${a.id}/unblock`, { method: "POST" }).then(load)}>Unblock</button>
                  <button onClick={() => api(`/admin/accounts/${a.id}/refresh-usage`, { method: "POST" }).then(load)}>Refresh</button>
                  <button className="danger" onClick={() => del(a.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody></table>
        </section>

        <section className="card">
          <h2>Request tracing</h2>
          <p className="muted">Shows account used, latency, status and token usage when returned by upstream.</p>
          <table><thead><tr><th>Time</th><th>Route</th><th>Account</th><th>Status</th><th>Latency</th><th>Tokens</th><th>Error</th></tr></thead><tbody>
            {traces.map((t, i) => (
              <tr key={i}>
                <td>{fmt(t.at)}</td>
                <td className="mono">{t.route}{t.stream ? " (stream)" : ""}</td>
                <td className="mono">{t.accountEmail ?? t.accountId ?? "-"}</td>
                <td>{t.status}</td>
                <td>{t.latencyMs}ms</td>
                <td>{t.usage?.total_tokens ?? "-"}</td>
                <td className="mono">{t.error?.slice(0, 60) ?? "-"}</td>
              </tr>
            ))}
          </tbody></table>
        </section>

        {error && <div className="card error">{error}</div>}
      </div>
    </div>
  );
}

function Metric({ title, value }: { title: string; value: string }) {
  return <div className="card metric"><div className="muted">{title}</div><div className="value">{value}</div></div>;
}
