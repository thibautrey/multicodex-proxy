import React, { useState } from "react";
import { HostHarnessCards } from "../HostHarnessCarousel";
import { copyTextToClipboard } from "../../lib/clipboard";
import type {
  ApplicationPolicy,
  ApplicationWebhook,
  CreatedProxyApiKey,
  ProxyApiKey,
} from "../../types";

type Props = {
  apiKeys: ProxyApiKey[];
  policies: ApplicationPolicy[];
  createApiKey: (application: string) => Promise<CreatedProxyApiKey>;
  deleteApiKey: (id: string) => Promise<void>;
  setApplicationWeight: (application: string, weight: number) => Promise<void>;
  createWebhook: (application: string, url: string) => Promise<ApplicationWebhook>;
  deleteWebhook: (application: string, id: string) => Promise<void>;
  onHarnessesChanged: () => Promise<void>;
};

export function ApiKeysTab({
  apiKeys,
  policies,
  createApiKey,
  deleteApiKey,
  setApplicationWeight,
  createWebhook,
  deleteWebhook,
  onHarnessesChanged,
}: Props) {
  const [application, setApplication] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedProxyApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [webhookApplication, setWebhookApplication] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [createdWebhook, setCreatedWebhook] = useState<ApplicationWebhook | null>(null);

  const policyFor = (application: string) =>
    policies.find((policy) => policy.application === application) ?? {
      application,
      fairnessWeight: 1,
      webhooks: [],
    };

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
      <HostHarnessCards onApiKeysChanged={onHarnessesChanged} />
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
          </div>
        </div>
        {!apiKeys.length ? (
          <div className="compact-empty-state">
            <strong>No application keys yet</strong>
            <span>Proxy access is unrestricted until you create the first key.</span>
          </div>
        ) : <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Key</th>
                <th>Created</th>
                <th>Managed by</th>
                <th>Fairness weight</th>
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
                    <input
                      type="number"
                      min="0.1"
                      max="100"
                      step="0.1"
                      defaultValue={policyFor(entry.application).fairnessWeight}
                      aria-label={`Fairness weight for ${entry.application}`}
                      onBlur={(event) =>
                        void setApplicationWeight(
                          entry.application,
                          Number(event.target.value) || 1,
                        )
                      }
                      style={{ width: 88 }}
                    />
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
            </tbody>
          </table>
        </div>}
      </section>

      <details className="panel advanced-disclosure">
        <summary>
          <span><strong>Advanced: signed result webhooks</strong><small>Register destinations for deferred results.</small></span>
          <span className="advanced-disclosure-toggle">Show</span>
        </summary>
        <div className="advanced-disclosure-content">
        <form
          className="api-key-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (!webhookApplication || !webhookUrl) return;
            void createWebhook(webhookApplication, webhookUrl).then((webhook) => {
              setCreatedWebhook(webhook);
              setWebhookUrl("");
            });
          }}
        >
          <label className="control-field"><span className="control-label">Application</span>
            <select value={webhookApplication} onChange={(event) => setWebhookApplication(event.target.value)}>
              <option value="">Select application</option>
              {Array.from(new Set(apiKeys.map((entry) => entry.application))).map((name) => <option key={name}>{name}</option>)}
            </select>
          </label>
          <label className="control-field"><span className="control-label">HTTPS endpoint</span><input type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://worker.example.com/multivibe" /></label>
          <button className="btn" type="submit" disabled={!webhookApplication || !webhookUrl}>Register webhook</button>
        </form>
        {policies.some((policy) => policy.webhooks.length) && <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Application</th><th>ID</th><th>URL</th><th>Status</th><th /></tr></thead>
            <tbody>
              {policies.flatMap((policy) => policy.webhooks.map((webhook) => (
                <tr key={webhook.id}><td>{policy.application}</td><td className="mono">{webhook.id}</td><td className="mono">{webhook.url}</td><td><span className="badge badge-live">{webhook.enabled ? "Enabled" : "Disabled"}</span></td><td><button className="btn danger" onClick={() => void deleteWebhook(policy.application, webhook.id)}>Delete</button></td></tr>
              )))}
            </tbody>
          </table>
        </div>}
        </div>
      </details>

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

      {createdWebhook?.secret && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal panel api-key-modal" role="dialog" aria-modal="true">
            <span className="badge badge-live">Webhook registered</span>
            <h2>Copy the HMAC secret</h2>
            <p className="muted">This secret is shown once. Verify x-multivibe-signature before accepting an event.</p>
            <div className="api-key-secret"><code>{createdWebhook.secret}</code><button className="btn secondary" onClick={() => void copyTextToClipboard(createdWebhook.secret!)}>Copy</button></div>
            <button className="btn" onClick={() => setCreatedWebhook(null)}>I have saved this secret</button>
          </div>
        </div>
      )}
    </>
  );
}
