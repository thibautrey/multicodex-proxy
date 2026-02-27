import { useEffect, useMemo, useState } from "react";
import "./styles.css";

type Account = { id: string; email?: string; enabled: boolean; usage?: any; state?: any };
type Trace = { at: number; route: string; accountId?: string; accountEmail?: string; status: number; latencyMs: number; usage?: any; error?: string };
type Tab = "overview" | "accounts" | "tracing" | "playground" | "docs";

const tokenDefault = localStorage.getItem("adminToken") ?? "change-me";
const fmt = (ts?: number) => (!ts ? "-" : new Date(ts).toLocaleString());
const pct = (v?: number) => (typeof v === "number" ? `${Math.round(v)}%` : "?");

const q = new URLSearchParams(window.location.search);
const initialTab = (q.get("tab") as Tab) || "overview";
const initialSanitized = q.get("sanitized") === "1" || q.get("safe") === "1";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", "x-admin-token": localStorage.getItem("adminToken") ?? tokenDefault, ...(init?.headers ?? {}) },
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(txt || `HTTP ${res.status}`);
  return txt ? JSON.parse(txt) : {};
}

function maskEmail(v?: string) {
  if (!v) return "hidden@email";
  const [a, d] = v.split("@");
  return `${a.slice(0, 2)}***@${d || "hidden"}`;
}
function maskId(v?: string) {
  if (!v) return "acc-xxxx";
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [sanitized, setSanitized] = useState(initialSanitized);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [flowId, setFlowId] = useState("");
  const [redirectInput, setRedirectInput] = useState("");
  const [expectedRedirect, setExpectedRedirect] = useState("http://localhost:1455/auth/callback");
  const [adminToken, setAdminToken] = useState(localStorage.getItem("adminToken") ?? tokenDefault);
  const [storageInfo, setStorageInfo] = useState<any>(null);
  const [chatPrompt, setChatPrompt] = useState("Give me a one-line hello");
  const [chatOut, setChatOut] = useState("");
  const [error, setError] = useState("");

  const stats = useMemo(() => ({
    total: accounts.length,
    enabled: accounts.filter((a) => a.enabled).length,
    blocked: accounts.filter((a) => a.state?.blockedUntil && a.state.blockedUntil > Date.now()).length,
  }), [accounts]);

  useEffect(() => {
    const u = new URL(window.location.href);
    u.searchParams.set("tab", tab);
    if (sanitized) u.searchParams.set("sanitized", "1"); else u.searchParams.delete("sanitized");
    window.history.replaceState({}, "", u.toString());
  }, [tab, sanitized]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setSanitized((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const load = async () => {
    try {
      setError("");
      const [acc, cfg, tr, mdl] = await Promise.all([
        api("/admin/accounts"),
        api("/admin/config"),
        api("/admin/traces?limit=50"),
        fetch("/v1/models").then((r) => r.json()),
      ]);
      setAccounts(acc.accounts ?? []);
      setExpectedRedirect(cfg.oauthRedirectUri ?? expectedRedirect);
      setStorageInfo(cfg.storage ?? null);
      setTraces((tr.traces ?? []).reverse());
      setModels((mdl.data ?? []).map((x: any) => x.id));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  useEffect(() => { load(); }, []);

  const startOAuth = async () => {
    const d = await api("/admin/oauth/start", { method: "POST", body: JSON.stringify({ email }) });
    setFlowId(d.flowId); setExpectedRedirect(d.expectedRedirectUri ?? expectedRedirect); window.open(d.authorizeUrl, "_blank", "noopener,noreferrer");
  };
  const completeOAuth = async () => { await api("/admin/oauth/complete", { method: "POST", body: JSON.stringify({ flowId, input: redirectInput }) }); setRedirectInput(""); await load(); };
  const patch = async (id: string, body: any) => { await api(`/admin/accounts/${id}`, { method: "PATCH", body: JSON.stringify(body) }); await load(); };
  const del = async (id: string) => { if (confirm("Delete account?")) { await api(`/admin/accounts/${id}`, { method: "DELETE" }); await load(); } };

  const runChatTest = async () => {
    setChatOut("Running...");
    const r = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: models[0] || "gpt-5.3-codex", messages: [{ role: "user", content: chatPrompt }] }),
    });
    const j = await r.json();
    setChatOut(j?.choices?.[0]?.message?.content || JSON.stringify(j, null, 2));
  };

  return <div className="page"><div className="shell">
    <header className="header card">
      <div><h1>MultiCodex Proxy</h1><p>Quota-aware multi-account proxy with OAuth and request tracing.</p></div>
      <div className="inline"><input value={adminToken} onChange={(e) => setAdminToken(e.target.value)} onBlur={() => localStorage.setItem("adminToken", adminToken)} placeholder="Admin token"/><button onClick={load}>Refresh</button></div>
    </header>

    <nav className="tabs card">
      {(["overview","accounts","tracing","playground","docs"] as Tab[]).map((t)=><button key={t} className={tab===t?"tab active":"tab"} onClick={()=>setTab(t)}>{t}</button>)}
      <button className={sanitized?"tab active":"tab"} onClick={()=>setSanitized(v=>!v)} title="Shortcut: Ctrl/Cmd+Shift+S">sanitized</button>
    </nav>

    {tab==="overview" && <>
      <section className="grid cards3"><Metric title="Accounts" value={`${stats.total}`}/><Metric title="Enabled" value={`${stats.enabled}`}/><Metric title="Blocked" value={`${stats.blocked}`}/></section>
      <section className="card"><h2>Persistence</h2>{storageInfo && <ul><li className="mono">accounts: {storageInfo.accountsPath}</li><li className="mono">oauth: {storageInfo.oauthStatePath}</li><li className="mono">trace: {storageInfo.tracePath}</li><li>{storageInfo.persistenceLikelyEnabled ? "✅ Persistence mount detected" : "⚠️ Persistence not guaranteed"}</li></ul>}</section>
      <section className="card"><h2>Models exposed</h2><div className="chips">{models.map((m)=><span key={m} className="chip mono">{m}</span>)}</div></section>
    </>}

    {tab==="accounts" && <>
      <section className="card"><h2>OAuth onboarding</h2><div className="inline wrap"><input value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="account@email.com"/><button onClick={startOAuth}>Start OAuth</button></div><p className="muted">Expected redirect: <span className="mono">{expectedRedirect}</span></p><div className="inline wrap"><input value={flowId} onChange={(e)=>setFlowId(e.target.value)} placeholder="flowId"/><input value={redirectInput} onChange={(e)=>setRedirectInput(e.target.value)} placeholder="Paste full redirect URL/code"/><button onClick={completeOAuth}>Complete OAuth</button></div></section>
      <section className="card"><h2>Accounts</h2><table><thead><tr><th>Email</th><th>ID</th><th>5h</th><th>Week</th><th>Blocked</th><th>Error</th><th/></tr></thead><tbody>{accounts.map((a)=><tr key={a.id}><td>{sanitized?maskEmail(a.email):a.email??"-"}</td><td className="mono">{sanitized?maskId(a.id):a.id}</td><td>{pct(a.usage?.primary?.usedPercent)}<small>{fmt(a.usage?.primary?.resetAt)}</small></td><td>{pct(a.usage?.secondary?.usedPercent)}<small>{fmt(a.usage?.secondary?.resetAt)}</small></td><td>{fmt(a.state?.blockedUntil)}</td><td className="mono">{a.state?.lastError?.slice(0,80)??"-"}</td><td className="inline wrap"><button onClick={()=>patch(a.id,{enabled:!a.enabled})}>{a.enabled?"Disable":"Enable"}</button><button onClick={()=>api(`/admin/accounts/${a.id}/unblock`,{method:"POST"}).then(load)}>Unblock</button><button onClick={()=>api(`/admin/accounts/${a.id}/refresh-usage`,{method:"POST"}).then(load)}>Refresh</button><button className="danger" onClick={()=>del(a.id)}>Delete</button></td></tr>)}</tbody></table></section>
    </>}

    {tab==="tracing" && <section className="card"><h2>Request tracing</h2><table><thead><tr><th>Time</th><th>Route</th><th>Account</th><th>Status</th><th>Latency</th><th>Tokens</th><th>Error</th></tr></thead><tbody>{traces.map((t,i)=><tr key={i}><td>{fmt(t.at)}</td><td className="mono">{t.route}</td><td className="mono">{sanitized?maskEmail(t.accountEmail)||maskId(t.accountId):t.accountEmail??t.accountId??"-"}</td><td>{t.status}</td><td>{t.latencyMs}ms</td><td>{t.usage?.total_tokens??"-"}</td><td className="mono">{t.error?.slice(0,60)??"-"}</td></tr>)}</tbody></table></section>}

    {tab==="playground" && <section className="card"><h2>Chat test</h2><div className="inline wrap"><input value={chatPrompt} onChange={(e)=>setChatPrompt(e.target.value)} placeholder="Type a prompt"/><button onClick={runChatTest}>Run</button></div><pre className="mono pre">{chatOut || "No output yet."}</pre></section>}

    {tab==="docs" && <section className="card"><h2>API reference</h2><ul><li className="mono">GET /v1/models</li><li className="mono">GET /v1/models/:id</li><li className="mono">POST /v1/chat/completions</li><li className="mono">POST /v1/responses</li><li className="mono">GET /admin/accounts</li><li className="mono">GET /admin/traces?limit=50</li><li className="mono">POST /admin/oauth/start</li><li className="mono">POST /admin/oauth/complete</li></ul><p className="muted">Admin endpoints require <span className="mono">x-admin-token</span>.</p><p className="muted">Sanitized mode: use URL flag <span className="mono">?sanitized=1</span> or shortcut <span className="mono">Ctrl/Cmd + Shift + S</span>.</p></section>}

    {error && <div className="card error">{error}</div>}
  </div></div>;
}

function Metric({ title, value }: { title: string; value: string }) { return <div className="card metric"><div className="muted">{title}</div><div className="value">{value}</div></div>; }
