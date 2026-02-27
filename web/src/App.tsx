import { useEffect, useMemo, useState } from "react";
import "./styles.css";

type Account = {
  id: string;
  email?: string;
  enabled: boolean;
  priority?: number;
  expiresAt?: number;
  usage?: {
    primary?: { usedPercent?: number; resetAt?: number };
    secondary?: { usedPercent?: number; resetAt?: number };
    fetchedAt: number;
  };
  state?: {
    blockedUntil?: number;
    blockedReason?: string;
    lastError?: string;
    lastSelectedAt?: number;
    recentErrors?: { at: number; message: string }[];
  };
};

type OAuthFlow = {
  id: string;
  email: string;
  status: "pending" | "success" | "error";
  error?: string;
  completedAt?: number;
};

const token = localStorage.getItem("adminToken") ?? "change-me";

function fmt(ts?: number) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

function pct(v?: number) {
  return typeof v === "number" ? `${Math.round(v)}%` : "?";
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-token": localStorage.getItem("adminToken") ?? token,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [email, setEmail] = useState("");
  const [flow, setFlow] = useState<OAuthFlow | null>(null);
  const [error, setError] = useState<string>("");
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
      const data = await api("/admin/accounts");
      setAccounts(data.accounts ?? []);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    load();
    const int = setInterval(() => {
      if (!flow || flow.status !== "pending") return;
      api(`/admin/oauth/status/${flow.id}`)
        .then((d) => setFlow(d.flow))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(int);
  }, [flow?.id, flow?.status]);

  const startOAuth = async () => {
    if (!email.trim()) return;
    const data = await api("/admin/oauth/start", { method: "POST", body: JSON.stringify({ email }) });
    setFlow({ id: data.flowId, email, status: "pending" });
    window.open(data.authorizeUrl, "_blank", "noopener,noreferrer");
  };

  const toggleEnabled = async (a: Account) => {
    await api(`/admin/accounts/${a.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !a.enabled }) });
    await load();
  };

  const unblock = async (a: Account) => {
    await api(`/admin/accounts/${a.id}/unblock`, { method: "POST" });
    await load();
  };

  const refreshUsage = async (a: Account) => {
    await api(`/admin/accounts/${a.id}/refresh-usage`, { method: "POST" });
    await load();
  };

  const remove = async (a: Account) => {
    if (!confirm(`Delete ${a.email ?? a.id}?`)) return;
    await api(`/admin/accounts/${a.id}`, { method: "DELETE" });
    await load();
  };

  return (
    <div className="container">
      <header className="topbar">
        <h1>MultiCodex Proxy Dashboard</h1>
        <div className="token-input">
          <label>Admin token</label>
          <input
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            onBlur={() => localStorage.setItem("adminToken", adminToken)}
          />
          <button onClick={load}>Reload</button>
        </div>
      </header>

      <section className="grid3">
        <Card title="Accounts" value={String(totals.total)} />
        <Card title="Enabled" value={String(totals.enabled)} />
        <Card title="Blocked" value={String(totals.blocked)} />
      </section>

      <section className="panel">
        <h2>Add account via OAuth</h2>
        <div className="row">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@domain.com" />
          <button onClick={startOAuth}>Start OAuth</button>
          <button onClick={() => api("/admin/usage/refresh", { method: "POST" }).then(load)}>Refresh all usage</button>
        </div>
        {flow && (
          <p className="muted">
            Flow {flow.id} • {flow.email} • <b>{flow.status}</b> {flow.error ? `(${flow.error})` : ""}
          </p>
        )}
        {error && <p className="err">{error}</p>}
      </section>

      <section className="panel">
        <h2>Accounts & usage</h2>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>ID</th>
              <th>5h</th>
              <th>Weekly</th>
              <th>Blocked until</th>
              <th>Last error</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.email ?? "-"}</td>
                <td className="mono">{a.id}</td>
                <td>
                  {pct(a.usage?.primary?.usedPercent)} <small>{fmt(a.usage?.primary?.resetAt)}</small>
                </td>
                <td>
                  {pct(a.usage?.secondary?.usedPercent)} <small>{fmt(a.usage?.secondary?.resetAt)}</small>
                </td>
                <td>{fmt(a.state?.blockedUntil)}</td>
                <td className="mono">{a.state?.lastError?.slice(0, 80) ?? "-"}</td>
                <td>
                  <div className="actions">
                    <button onClick={() => toggleEnabled(a)}>{a.enabled ? "Disable" : "Enable"}</button>
                    <button onClick={() => unblock(a)}>Unblock</button>
                    <button onClick={() => refreshUsage(a)}>Refresh</button>
                    <button className="danger" onClick={() => remove(a)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="card">
      <div className="muted">{title}</div>
      <div className="big">{value}</div>
    </div>
  );
}
