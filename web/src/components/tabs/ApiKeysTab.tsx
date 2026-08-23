import React, { useState } from "react";
import { copyTextToClipboard } from "../../lib/clipboard";
import type { CreatedProxyApiKey, ProxyApiKey } from "../../types";

type Props = {
  apiKeys: ProxyApiKey[];
  createApiKey: (application: string) => Promise<CreatedProxyApiKey>;
  deleteApiKey: (id: string) => Promise<void>;
};

export function ApiKeysTab({ apiKeys, createApiKey, deleteApiKey }: Props) {
  const [application, setApplication] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedProxyApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = application.trim();
    if (!name) return;
    setIsCreating(true);
    try {
      const result = await createApiKey(name);
      setCreatedKey(result);
      setApplication("");
      setCopied(false);
    } finally {
      setIsCreating(false);
    }
  };

  const revoke = async (entry: ProxyApiKey) => {
    if (!confirm(`Revoke the API key for ${entry.application}? Clients using it will immediately lose access.`)) return;
    setDeletingId(entry.id);
    try {
      await deleteApiKey(entry.id);
    } finally {
      setDeletingId(null);
    }
  };

  const copyCreatedKey = async () => {
    if (!createdKey) return;
    await copyTextToClipboard(createdKey.key);
    setCopied(true);
  };

  return (
    <>
      <section className="panel api-key-intro">
        <div className="section-split-header">
          <div>
            <h2>Application API keys</h2>
            <p className="muted">
              Give each client its own credential to authenticate proxy requests and attribute traces.
            </p>
          </div>
          <span className="badge badge-live">{apiKeys.length} active</span>
        </div>
        <div className="api-key-notice">
          <strong>Keys are secrets.</strong>
          <span>New keys are shown once. Store them in your application's secret manager.</span>
        </div>
      </section>

      <section className="panel">
        <div className="section-split-header">
          <div>
            <h2>Create an API key</h2>
            <p className="muted">Use a short application name such as mobile, litellm, or staging-worker.</p>
          </div>
        </div>
        <form className="api-key-create" onSubmit={create}>
          <label className="control-field">
            <span className="control-label">Application</span>
            <input
              value={application}
              onChange={(event) => setApplication(event.target.value)}
              placeholder="staging-worker"
              pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
              maxLength={80}
              autoComplete="off"
            />
          </label>
          <button className="btn" type="submit" disabled={isCreating || !application.trim()}>
            {isCreating ? "Creating..." : "Create secret key"}
          </button>
        </form>
      </section>

      <section className="panel api-key-list-panel">
        <div className="section-split-header">
          <div>
            <h2>Active keys</h2>
            <p className="muted">Environment-managed keys are read-only and must be changed in deployment configuration.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Key</th>
                <th>Created</th>
                <th>Managed by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {apiKeys.map((entry) => (
                <tr key={entry.id}>
                  <td><strong>{entry.application}</strong></td>
                  <td className="mono">{entry.keyPreview}</td>
                  <td>{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : "—"}</td>
                  <td>
                    <span className={entry.source === "dashboard" ? "badge badge-live" : "badge"}>
                      {entry.source === "dashboard" ? "Dashboard" : "Environment"}
                    </span>
                  </td>
                  <td>
                    {entry.source === "dashboard" && (
                      <button
                        className="btn danger"
                        disabled={deletingId === entry.id}
                        onClick={() => void revoke(entry)}
                      >
                        {deletingId === entry.id ? "Revoking..." : "Revoke"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!apiKeys.length && (
                <tr><td colSpan={5} className="muted empty-row">No API keys yet. Proxy access is currently unrestricted.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {createdKey && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal panel api-key-modal" role="dialog" aria-modal="true" aria-labelledby="created-key-title">
            <div>
              <span className="badge badge-live">Key created</span>
              <h2 id="created-key-title">Copy your secret key</h2>
              <p className="muted">This is the only time the full key for <strong>{createdKey.application}</strong> will be displayed.</p>
            </div>
            <div className="api-key-secret">
              <code>{createdKey.key}</code>
              <button className="btn secondary" onClick={() => void copyCreatedKey()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="inline wrap">
              <button className="btn" onClick={() => setCreatedKey(null)}>I have saved this key</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
