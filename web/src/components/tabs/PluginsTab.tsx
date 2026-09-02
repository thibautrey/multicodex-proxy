import { useMemo, useState } from "react";
import type { MarketplaceModule, ModuleView } from "../../types";
import { api } from "../../lib/api";
import "./PluginsTab.css";

const GUIDE_URL = "https://github.com/thibautrey/multicodex-proxy/blob/main/docs/plugins.md";
type View = "marketplace" | "installed";

export function PluginsTab({ modules, marketplace, reload }: { modules: ModuleView[]; marketplace: MarketplaceModule[]; reload: () => Promise<void> }) {
  const [view, setView] = useState<View>("marketplace");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [submissionUrl, setSubmissionUrl] = useState("");
  const [showSubmission, setShowSubmission] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const installedById = useMemo(() => new Map(modules.map((module) => [module.id, module])), [modules]);
  const categories = useMemo(() => ["All", ...Array.from(new Set(marketplace.flatMap((plugin) => plugin.manifest.categories?.length ? plugin.manifest.categories : ["Other"]))).sort()], [marketplace]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return marketplace.filter((plugin) => {
      const groups = plugin.manifest.categories?.length ? plugin.manifest.categories : ["Other"];
      const text = [plugin.manifest.name, plugin.manifest.description, plugin.manifest.author, plugin.id, ...(plugin.manifest.tags ?? []), ...groups].filter(Boolean).join(" ").toLowerCase();
      return (category === "All" || groups.includes(category)) && (!needle || text.includes(needle));
    });
  }, [marketplace, query, category]);

  const action = async (name: string, operation: () => Promise<unknown>, success?: string) => {
    setBusy(name); setError(""); setNotice("");
    try { await operation(); await reload(); if (success) setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };

  return <div className="plugins-workspace">
    <section className="panel plugins-hero"><div><span className="eyebrow">Plugin ecosystem</span><h2>Extend MultiVibe</h2><p className="muted">Discover community lifecycle plugins, install a reviewed commit, or submit your own public GitHub repository.</p></div><div className="plugins-hero-actions"><a className="btn ghost" href={GUIDE_URL} target="_blank" rel="noreferrer">Developer guide ↗</a><button className="btn" type="button" onClick={() => setShowSubmission((shown) => !shown)}>{showSubmission ? "Close submission" : "Submit a plugin"}</button></div></section>

    {showSubmission && <section className="panel plugins-submit"><div><h3>Submit to this marketplace</h3><p className="muted">We validate the repository and read categories, tags and author from <code>multivibe.module.json</code>.</p></div><form onSubmit={(event) => { event.preventDefault(); void action("submit", async () => { await api("/admin/modules/submit", { method: "POST", body: JSON.stringify({ url: submissionUrl }) }); setSubmissionUrl(""); setShowSubmission(false); }, "Plugin submitted to the marketplace."); }}><label className="control-field"><span className="control-label">Public GitHub HTTPS URL</span><input type="url" required pattern="https://github\.com/.+/.+" placeholder="https://github.com/owner/repository" value={submissionUrl} onChange={(event) => setSubmissionUrl(event.target.value)} /></label><button className="btn" disabled={Boolean(busy)}>{busy === "submit" ? "Validating…" : "Validate and submit"}</button></form></section>}
    {error && <div className="error plugins-feedback" role="alert">{error}</div>}{notice && <div className="plugins-notice" role="status">{notice}</div>}

    <div className="plugins-view-tabs" role="tablist" aria-label="Plugin views"><button className={view === "marketplace" ? "active" : ""} role="tab" aria-selected={view === "marketplace"} onClick={() => setView("marketplace")}>Marketplace <span>{marketplace.length}</span></button><button className={view === "installed" ? "active" : ""} role="tab" aria-selected={view === "installed"} onClick={() => setView("installed")}>Installed <span>{modules.length}</span></button></div>

    {view === "marketplace" ? <>
      <section className="plugins-toolbar" aria-label="Marketplace filters"><label className="plugins-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Search plugins, authors, tags…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="plugins-categories" aria-label="Categories">{categories.map((item) => <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div></section>
      <div className="plugins-results-heading"><div><h3>{category === "All" ? "All plugins" : category}</h3><p className="muted">{visible.length} result{visible.length === 1 ? "" : "s"}</p></div></div>
      <section className="marketplace-grid" aria-label="Plugin marketplace">{visible.map((plugin) => {
        const installed = installedById.get(plugin.id); const groups = plugin.manifest.categories?.length ? plugin.manifest.categories : ["Other"];
        return <article className="panel marketplace-card" key={plugin.id}><div className="marketplace-card-top"><div className="plugin-mark" aria-hidden="true">{plugin.manifest.name.slice(0, 1).toUpperCase()}</div><div className="marketplace-card-title"><h3>{plugin.manifest.name}</h3><p>{plugin.manifest.author ? `by ${plugin.manifest.author}` : plugin.id}</p></div>{installed && <span className="badge badge-live">Installed</span>}</div><p className="marketplace-description">{plugin.manifest.description}</p><div className="plugin-taxonomy">{groups.map((item) => <span key={item}>{item}</span>)}{(plugin.manifest.tags ?? []).slice(0, 3).map((tag) => <span className="tag" key={tag}>#{tag}</span>)}</div><div className="marketplace-meta"><span>v{plugin.manifest.version}</span><span className="mono">{plugin.commit.slice(0, 8)}</span></div><footer>{plugin.manifest.homepage && <a className="btn ghost" href={plugin.manifest.homepage} target="_blank" rel="noreferrer">Details</a>}<button className="btn" disabled={Boolean(busy) || Boolean(installed)} onClick={() => void action(`install-${plugin.id}`, () => api("/admin/modules/install", { method: "POST", body: JSON.stringify({ url: plugin.origin }) }), `${plugin.manifest.name} installed. Restart MultiVibe, then enable it.`)}>{busy === `install-${plugin.id}` ? "Installing…" : installed ? "Installed" : "Install"}</button></footer></article>;
      })}{!visible.length && <div className="panel plugins-empty"><div className="plugin-empty-icon">⌕</div><h3>No plugins found</h3><p className="muted">Try another search or category, or submit the first matching plugin.</p></div>}</section>
    </> : <section className="installed-list" aria-label="Installed plugins">{modules.map((module) => <article className="panel installed-card" key={module.id}><div className="plugin-mark" aria-hidden="true">{(module.manifest?.name ?? module.id).slice(0, 1).toUpperCase()}</div><div className="installed-card-copy"><div><span className="eyebrow">{module.source === "bundled" ? "Bundled" : "GitHub"}</span><h3>{module.manifest?.name ?? module.id}</h3></div><p>{module.manifest?.description ?? "Manifest will be loaded after restart."}</p><div className="marketplace-meta"><span>v{module.manifest?.version ?? "—"}</span><span className="mono">{module.commit.slice(0, 12)}</span><span>{module.manifest?.hooks?.length ?? 0} hooks</span></div>{module.error && <div className="error">{module.error}</div>}</div><div className="installed-card-actions"><span className={`badge ${module.healthy ? "badge-live" : ""}`}>{module.restartRequired ? "Restart required" : module.loaded ? "Loaded" : module.enabled ? "Unavailable" : "Disabled"}</span><div><button className={`btn ${module.enabled ? "secondary" : ""}`} disabled={Boolean(busy) || Boolean(module.restartRequired)} onClick={() => void action(`toggle-${module.id}`, () => api(`/admin/modules/${encodeURIComponent(module.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !module.enabled }) }))}>{module.enabled ? "Disable" : "Enable"}</button><button className="btn ghost" disabled={Boolean(busy)} onClick={() => void action(`update-${module.id}`, () => api(`/admin/modules/${encodeURIComponent(module.id)}/update`, { method: "POST" }), "Update pinned. Restart MultiVibe to load it.")}>Update</button>{module.removable && <button className="btn danger" disabled={Boolean(busy) || module.enabled} title={module.enabled ? "Disable before removing" : undefined} onClick={() => void action(`remove-${module.id}`, () => api(`/admin/modules/${encodeURIComponent(module.id)}`, { method: "DELETE" }))}>Remove</button>}</div></div></article>)}{!modules.length && <div className="panel plugins-empty"><h3>No installed plugins</h3><p className="muted">Browse the marketplace to get started.</p></div>}</section>}
  </div>;
}
