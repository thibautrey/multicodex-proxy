import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { HostUpdateStatus } from "../../types";

function timestamp(value: string | null) {
  if (!value) return "Not yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}

export function UpdatesTab() {
  const [status, setStatus] = useState<HostUpdateStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    const result = await api("/admin/host-update");
    setStatus(result as HostUpdateStatus);
  };

  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, []);

  const action = async (name: string, operation: () => Promise<unknown>, message?: string) => {
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await operation();
      await load();
      if (message) setNotice(message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  if (!status && error) {
    return <section className="panel"><span className="eyebrow">MultiVibe Host</span><h2>Host updates are unavailable</h2><p className="muted">This dashboard is not running from a managed native MultiVibe Host installation. Docker updates are managed by the host orchestrator.</p></section>;
  }
  if (!status) return <section className="panel"><p className="muted">Loading update status…</p></section>;

  const canDownload = status.status === "available" && status.rollout_eligible;
  const canInstall = Boolean(status.available_version && status.rollout_eligible);
  return <div className="stack">
    <section className="panel hero-panel">
      <div><span className="eyebrow">Verified updates</span><h2>MultiVibe Host {status.current_version}</h2></div>
      <span className={`badge ${status.status === "current" ? "badge-live" : ""}`}>{status.status}</span>
    </section>

    {error && <div className="panel error" role="alert">{error}</div>}
    {notice && <div className="panel" role="status">{notice}</div>}

    <section className="grid cards3">
      <article className="panel stat-card"><span>Installed</span><strong>{status.current_version}</strong><small>Current native bundle</small></article>
      <article className="panel stat-card"><span>Available</span><strong>{status.available_version ?? "—"}</strong><small>{status.available_critical ? "Required security or compatibility update" : status.rollout_eligible ? "Eligible for this installation" : "No eligible rollout"}</small></article>
      <article className="panel stat-card"><span>Next check</span><strong>{timestamp(status.next_check_at)}</strong><small>Last check: {timestamp(status.last_checked_at)}</small></article>
    </section>

    <section className="panel">
      <div className="section-heading"><div><span className="eyebrow">Policy</span><h3>Update behavior</h3></div></div>
      <div className="grid cols2">
        <label><span className="field-label">Mode</span><select value={status.mode} disabled={Boolean(busy)} onChange={(event) => {
          const mode = event.target.value as HostUpdateStatus["mode"];
          void action("policy", () => api("/admin/host-update", { method: "PATCH", body: JSON.stringify({ mode, channel: status.channel }) }));
        }}><option value="automatic">Download and install automatically</option><option value="download">Download automatically, install manually</option><option value="notify">Notify only</option></select></label>
        <label><span className="field-label">Channel</span><select value={status.channel} disabled={Boolean(busy)} onChange={(event) => {
          const channel = event.target.value as HostUpdateStatus["channel"];
          void action("policy", () => api("/admin/host-update", { method: "PATCH", body: JSON.stringify({ mode: status.mode, channel }) }));
        }}><option value="stable">Stable</option><option value="beta">Beta</option></select></label>
      </div>
      <div className="actions-row">
        <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void action("check", () => api("/admin/host-update/check", { method: "POST", body: "{}" }))}>{busy === "check" ? "Checking…" : "Check now"}</button>
        <button className="btn secondary" disabled={Boolean(busy) || !canDownload || status.download_requested} onClick={() => void action("download", () => api("/admin/host-update/download", { method: "POST", body: "{}" }), "Download queued for the background updater.")}>{busy === "download" ? "Queuing…" : status.download_requested ? "Download queued" : "Download in background"}</button>
        <button className="btn" disabled={Boolean(busy) || !canInstall || status.install_requested} onClick={() => void action("install", () => api("/admin/host-update/apply", { method: "POST", body: "{}" }), "Installation queued. The separate background updater will drain, verify and restart MultiVibe Host safely.")}>{busy === "install" ? "Queuing…" : status.install_requested ? "Installation queued" : "Install on next updater run"}</button>
      </div>
      {status.last_error && <p className="error" role="alert"><strong>{status.last_error_code ?? "update_failed"}:</strong> {status.last_error}</p>}
    </section>
  </div>;
}
