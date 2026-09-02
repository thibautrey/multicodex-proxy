import { useState } from "react";
import type { ModuleView } from "../../types";
import { api } from "../../lib/api";
import "./PluginsTab.css";

const PLUGINS_DOCUMENTATION_URL = "https://github.com/thibautrey/multicodex-proxy/blob/main/docs/plugins.md";

export function PluginsTab({ modules, reload }: { modules: ModuleView[]; reload: () => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const action = async (name: string, operation: () => Promise<unknown>) => {
    setBusy(name);
    setError("");
    try { await operation(); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };

  return <div className="plugins-workspace">
    <section className="panel plugins-install">
      <div>
        <span className="eyebrow">GitHub modules</span>
        <h2>Install a plugin</h2>
        <p className="muted">Plugins run as fully trusted code with the same process access as MultiVibe. Install only repositories you have reviewed.</p>
        <a className="plugins-documentation-link" href={PLUGINS_DOCUMENTATION_URL} target="_blank" rel="noreferrer">Read the complete plugins guide <span aria-hidden="true">↗</span></a>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void action("install", async () => { await api("/admin/modules/install", { method: "POST", body: JSON.stringify({ url }) }); setUrl(""); }); }}>
        <label className="control-field"><span className="control-label">Public GitHub HTTPS URL</span><input type="url" required pattern="https://github\.com/.+/.+" placeholder="https://github.com/owner/repository" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
        <button className="btn" disabled={Boolean(busy)}>{busy === "install" ? "Downloading…" : "Install and pin"}</button>
      </form>
      {error && <div className="error">{error}</div>}
    </section>

    <section className="plugins-grid" aria-label="Installed plugins">
      {modules.map((module) => <article className="panel plugin-card" key={module.id}>
        <header><div><span className="eyebrow">{module.source === "bundled" ? "Bundled" : "GitHub"}</span><h3>{module.manifest?.name ?? module.id}</h3></div><span className={`badge ${module.healthy ? "badge-live" : ""}`}>{module.restartRequired ? "Restart required" : module.loaded ? "Loaded" : module.enabled ? "Unavailable" : "Disabled"}</span></header>
        <p>{module.manifest?.description ?? "Manifest will be loaded after restart."}</p>
        <dl><div><dt>Origin</dt><dd>{module.origin}</dd></div><div><dt>Commit</dt><dd className="mono">{module.commit.slice(0, 12)}</dd></div><div><dt>Version</dt><dd>{module.manifest?.version ?? "—"}</dd></div></dl>
        {module.manifest?.hooks?.length ? <div className="plugin-hooks">{module.manifest.hooks.map((hook) => <code key={hook}>{hook}</code>)}</div> : null}
        {module.error && <div className="error">{module.error}</div>}
        <footer>
          <button className={`btn ${module.enabled ? "secondary" : ""}`} disabled={Boolean(busy)} onClick={() => void action(`toggle-${module.id}`, () => api(`/admin/modules/${encodeURIComponent(module.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !module.enabled }) }))}>{module.enabled ? "Disable" : "Enable"}</button>
          <button className="btn ghost" disabled={Boolean(busy)} onClick={() => void action(`update-${module.id}`, () => api(`/admin/modules/${encodeURIComponent(module.id)}/update`, { method: "POST" }))}>Update</button>
          {module.removable && <button className="btn danger" disabled={Boolean(busy) || module.enabled} title={module.enabled ? "Disable before removing" : undefined} onClick={() => void action(`remove-${module.id}`, () => api(`/admin/modules/${encodeURIComponent(module.id)}`, { method: "DELETE" }))}>Remove</button>}
        </footer>
      </article>)}
      {!modules.length && <section className="panel"><p className="muted">No plugins were discovered.</p></section>}
    </section>
  </div>;
}
