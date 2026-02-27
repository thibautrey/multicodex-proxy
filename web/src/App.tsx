import { useMemo, useState } from "react";
import "./styles.css";

type Account = {
  id: string;
  email?: string;
  enabled: boolean;
  usage?: {
    primary?: { usedPercent?: number; resetAt?: number };
    secondary?: { usedPercent?: number; resetAt?: number };
  };
  state?: {
    blockedUntil?: number;
    lastError?: string;
  };
};

type OAuthFlow = {
  id: string;
  email: string;
  status: "pending" | "success" | "error";
  error?: string;
};

const token = localStorage.getItem("adminToken") ?? "change-me";
const fmt = (ts?: number) => (!ts ? "-" : new Date(ts).toLocaleString());
const pct = (v?: number) => (typeof v === "number" ? `${Math.round(v)}%` : "?");

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-token": localStorage.getItem("adminToken") ?? token,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res.json();
}

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [email, setEmail] = useState("");
  const [flow, setFlow] = useState<OAuthFlow | null>(null);
  const [redirectInput, setRedirectInput] = useState("");
  const [expectedRedirect, setExpectedRedirect] = useState("http://localhost:1455/auth/callback");
  const [error, setError] = useState("");
  const [adminToken, setAdminToken] = useState(localStorage.getItem("adminToken") ?? token);

  const totals = useMemo(() => {
    const total = accounts.length;
    const enabled = accounts.filter((a) => a.enabled).length;
    const blocked = accounts.filter((a) => a.state?.blockedUntil && a.state.blockedUntil > Date.now()).length;
    return { total, enabled, blocked };
  }, [accounts]);

  const load = async () => {
    try {
      setError("");
      const [a, cfg] = await Promise.all([api("/admin/accounts"), api("/admin/config")]);
      setAccounts(a.accounts ?? []);
      setExpectedRedirect(cfg.oauthRedirectUri ?? expectedRedirect);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const startOAuth = async () => {
    if (!email.trim()) return;
    const data = await api("/admin/oauth/start", { method: "POST", body: JSON.stringify({ email }) });
    setFlow({ id: data.flowId, email, status: "pending" });
    setExpectedRedirect(data.expectedRedirectUri ?? expectedRedirect);
    window.open(data.authorizeUrl, "_blank", "noopener,noreferrer");
  };

  const completeOAuth = async () => {
    if (!flow?.id || !redirectInput.trim()) return;
    await api("/admin/oauth/complete", { method: "POST", body: JSON.stringify({ flowId: flow.id, input: redirectInput }) });
    setFlow({ ...flow, status: "success" });
    setRedirectInput("");
    await load();
  };

  const toggleEnabled = async (a: Account) => { await api(`/admin/accounts/${a.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !a.enabled }) }); await load(); };
  const unblock = async (a: Account) => { await api(`/admin/accounts/${a.id}/unblock`, { method: "POST" }); await load(); };
  const refreshUsage = async (a: Account) => { await api(`/admin/accounts/${a.id}/refresh-usage`, { method: "POST" }); await load(); };
  const remove = async (a: Account) => { if (confirm(`Delete ${a.email ?? a.id}?`)) { await api(`/admin/accounts/${a.id}`, { method: "DELETE" }); await load(); } };

  return (
    <div className="container">
      <header className="topbar">
        <h1>MultiCodex Proxy Dashboard</h1>
        <div className="token-input">
          <label>Admin token</label>
          <input value={adminToken} onChange={(e) => setAdminToken(e.target.value)} onBlur={() => localStorage.setItem("adminToken", adminToken)} />
          <button onClick={load}>Reload</button>
        </div>
      </header>

      <section className="grid3"><Card title="Accounts" value={`${totals.total}`} /><Card title="Enabled" value={`${totals.enabled}`} /><Card title="Blocked" value={`${totals.blocked}`} /></section>

      <section className="panel">
        <h2>Add account via OAuth (manual paste mode)</h2>
        <div className="row">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@domain.com" />
          <button onClick={startOAuth}>Start OAuth</button>
          <button onClick={() => api("/admin/usage/refresh", { method: "POST" }).then(load)}>Refresh all usage</button>
        </div>
        <p className="muted">Expected redirect URL: <span className="mono">{expectedRedirect}</span></p>
        {flow && <p className="muted">Flow {flow.id} • {flow.email} • <b>{flow.status}</b> {flow.error ? `(${flow.error})` : ""}</p>}
        <textarea value={redirectInput} onChange={(e) => setRedirectInput(e.target.value)} placeholder="Paste full redirect URL (or code / code#state) here" rows={3} style={{ width: "100%", marginTop: 8 }} />
        <div className="row" style={{ marginTop: 8 }}><button onClick={completeOAuth}>Complete OAuth from pasted URL</button></div>
        {error && <p className="err">{error}</p>}
      </section>

      <section className="panel">
        <h2>Accounts & usage</h2>
        <table><thead><tr><th>Email</th><th>ID</th><th>5h</th><th>Weekly</th><th>Blocked until</th><th>Last error</th><th>Actions</th></tr></thead><tbody>
          {accounts.map((a) => <tr key={a.id}><td>{a.email ?? "-"}</td><td className="mono">{a.id}</td><td>{pct(a.usage?.primary?.usedPercent)} <small>{fmt(a.usage?.primary?.resetAt)}</small></td><td>{pct(a.usage?.secondary?.usedPercent)} <small>{fmt(a.usage?.secondary?.resetAt)}</small></td><td>{fmt(a.state?.blockedUntil)}</td><td className="mono">{a.state?.lastError?.slice(0, 80) ?? "-"}</td><td><div className="actions"><button onClick={() => toggleEnabled(a)}>{a.enabled ? "Disable" : "Enable"}</button><button onClick={() => unblock(a)}>Unblock</button><button onClick={() => refreshUsage(a)}>Refresh</button><button className="danger" onClick={() => remove(a)}>Delete</button></div></td></tr>)}
        </tbody></table>
      </section>
    </div>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return <div className="card"><div className="muted">{title}</div><div className="big">{value}</div></div>;
}
