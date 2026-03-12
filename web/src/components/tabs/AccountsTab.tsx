import React, { useState } from "react";
import { Metric } from "../Metric";
import { fmt, maskEmail, maskId, usd } from "../../lib/ui";
import type { Account, TraceStats } from "../../types";

type Props = {
  traceStats: TraceStats;
  accounts: Account[];
  sanitized: boolean;
  patch: (id: string, body: any) => Promise<void>;
  del: (id: string) => Promise<void>;
  unblock: (id: string) => Promise<void>;
  refreshUsage: (id: string) => Promise<void>;
  createAccount: (body: any) => Promise<void>;
  startOAuth: (email: string) => Promise<any>;
};

type EditAccountState = {
  id: string;
  provider: "openai" | "mistral";
  email: string;
  accessToken: string;
  refreshToken: string;
  chatgptAccountId: string;
  priority: string;
  enabled: boolean;
};

export function AccountsTab(props: Props) {
  const {
    traceStats,
    accounts,
    sanitized,
    patch,
    del,
    unblock,
    refreshUsage,
    createAccount,
    startOAuth,
  } = props;
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [provider, setProvider] = useState<"openai" | "mistral">("openai");
  const [manualEmail, setManualEmail] = useState("");
  const [manualAccessToken, setManualAccessToken] = useState("");
  const [manualRefreshToken, setManualRefreshToken] = useState("");
  const [manualChatgptAccountId, setManualChatgptAccountId] = useState("");
  const [manualPriority, setManualPriority] = useState("0");
  const [manualEnabled, setManualEnabled] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EditAccountState | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);

  const closeModal = () => {
    setShowAddAccount(false);
    setProvider("openai");
    setManualEmail("");
    setManualAccessToken("");
    setManualRefreshToken("");
    setManualChatgptAccountId("");
    setManualPriority("0");
    setManualEnabled(true);
    setIsSubmitting(false);
  };

  const closeEditModal = () => {
    setEditingAccount(null);
    setIsSavingEdit(false);
  };

  const submitManualAccount = async () => {
    if (!manualAccessToken.trim()) return;
    setIsSubmitting(true);
    try {
      await createAccount({
        provider,
        email: manualEmail.trim() || undefined,
        accessToken: manualAccessToken.trim(),
        refreshToken: manualRefreshToken.trim() || undefined,
        chatgptAccountId:
          provider === "openai" && manualChatgptAccountId.trim()
            ? manualChatgptAccountId.trim()
            : undefined,
        priority: Number(manualPriority) || 0,
        enabled: manualEnabled,
      });
      closeModal();
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditModal = (account: Account) => {
    setEditingAccount({
      id: account.id,
      provider: account.provider === "mistral" ? "mistral" : "openai",
      email: account.email ?? "",
      accessToken: account.accessToken ?? "",
      refreshToken: account.refreshToken ?? "",
      chatgptAccountId: account.chatgptAccountId ?? "",
      priority: String(account.priority ?? 0),
      enabled: account.enabled,
    });
  };

  const saveEditedAccount = async () => {
    if (!editingAccount || !editingAccount.accessToken.trim()) return;
    setIsSavingEdit(true);
    try {
      await patch(editingAccount.id, {
        email: editingAccount.email.trim() || undefined,
        accessToken: editingAccount.accessToken.trim(),
        refreshToken: editingAccount.refreshToken.trim() || undefined,
        chatgptAccountId:
          editingAccount.provider === "openai" && editingAccount.chatgptAccountId.trim()
            ? editingAccount.chatgptAccountId.trim()
            : undefined,
        priority: Number(editingAccount.priority) || 0,
        enabled: editingAccount.enabled,
      });
      closeEditModal();
    } finally {
      setIsSavingEdit(false);
    }
  };

  const reauthAccount = async (account: Account) => {
    if ((account.provider ?? "openai") !== "openai") return;
    if (!account.email?.trim()) {
      window.alert("This OpenAI account has no email, so reauth cannot be started.");
      return;
    }
    setOauthBusyId(account.id);
    try {
      const result = await startOAuth(account.email.trim());
      const authorizeUrl = result?.authorizeUrl as string | undefined;
      if (!authorizeUrl) throw new Error("Missing authorizeUrl from OAuth start response");
      window.open(authorizeUrl, "_blank", "noopener,noreferrer");
    } finally {
      setOauthBusyId(null);
    }
  };

  const providerFavicon = (provider?: string) => {
    return provider === "mistral"
      ? "https://mistral.ai/favicon.ico"
      : "https://openai.com/favicon.ico";
  };

  const providerLabel = (provider?: string) => {
    return provider === "mistral" ? "Mistral" : "OpenAI";
  };

  return (
    <>
      <section className="grid cards3">
        <Metric title="Requests (selected range)" value={`${traceStats.totals.requests}`} />
        <Metric title="Estimated cost (selected range)" value={usd(traceStats.totals.costUsd)} />
        <Metric title="Top model by volume" value={traceStats.models[0]?.model ?? "-"} />
      </section>

      <section className="panel">
        <div className="inline wrap row-between">
          <h2>Accounts</h2>
          <button className="btn" onClick={() => setShowAddAccount(true)}>
            Add account
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
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
                  <td>
                    <span className="provider-badge">
                      <img
                        className="provider-icon"
                        src={providerFavicon(a.provider)}
                        alt={`${providerLabel(a.provider)} icon`}
                        loading="lazy"
                      />
                      {providerLabel(a.provider)}
                    </span>
                  </td>
                  <td>{sanitized ? maskEmail(a.email) : a.email ?? "-"}</td>
                  <td className="mono">{sanitized ? maskId(a.id) : a.id}</td>
                  <td>{typeof a.usage?.primary?.usedPercent === "number" ? `${Math.round(a.usage.primary.usedPercent)}%` : "?"}<small>{fmt(a.usage?.primary?.resetAt)}</small></td>
                  <td>{typeof a.usage?.secondary?.usedPercent === "number" ? `${Math.round(a.usage.secondary.usedPercent)}%` : "?"}<small>{fmt(a.usage?.secondary?.resetAt)}</small></td>
                  <td>{fmt(a.state?.blockedUntil)}</td>
                  <td className="mono">{a.state?.lastError?.slice(0, 80) ?? "-"}</td>
                  <td className="inline wrap">
                    <button className="btn ghost" onClick={() => openEditModal(a)}>Change key</button>
                    {a.provider !== "mistral" && (
                      <button
                        className="btn ghost"
                        disabled={oauthBusyId === a.id}
                        onClick={() => void reauthAccount(a)}
                      >
                        {oauthBusyId === a.id ? "Opening..." : "Reauth"}
                      </button>
                    )}
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

      {showAddAccount && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal panel" onClick={(e) => e.stopPropagation()}>
            <div className="inline wrap row-between">
              <h2>Add account</h2>
              <button className="btn ghost" onClick={closeModal}>
                Close
              </button>
            </div>
            <div className="grid modal-grid">
              <label>
                Provider
                <select
                  value={provider}
                  onChange={(e) =>
                    setProvider(e.target.value as "openai" | "mistral")
                  }
                >
                  <option value="openai">OpenAI</option>
                  <option value="mistral">Mistral</option>
                </select>
              </label>
              <label>
                Email (optional)
                <input
                  value={manualEmail}
                  onChange={(e) => setManualEmail(e.target.value)}
                  placeholder="account@email.com"
                />
              </label>
              <label>
                Access token
                <input
                  value={manualAccessToken}
                  onChange={(e) => setManualAccessToken(e.target.value)}
                  placeholder="Required"
                />
              </label>
              <label>
                Refresh token (optional)
                <input
                  value={manualRefreshToken}
                  onChange={(e) => setManualRefreshToken(e.target.value)}
                  placeholder="Optional"
                />
              </label>
              {provider === "openai" && (
                <label>
                  ChatGPT account id (optional)
                  <input
                    value={manualChatgptAccountId}
                    onChange={(e) => setManualChatgptAccountId(e.target.value)}
                    placeholder="Optional"
                  />
                </label>
              )}
              <label>
                Priority
                <input
                  value={manualPriority}
                  onChange={(e) => setManualPriority(e.target.value)}
                  placeholder="0"
                />
              </label>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={manualEnabled}
                  onChange={(e) => setManualEnabled(e.target.checked)}
                />
                Enabled
              </label>
            </div>
            <div className="inline wrap">
              <button
                className="btn"
                disabled={isSubmitting || !manualAccessToken.trim()}
                onClick={() => void submitManualAccount()}
              >
                {isSubmitting ? "Creating..." : "Create account"}
              </button>
              <button className="btn ghost" onClick={closeModal}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {editingAccount && (
        <div className="modal-backdrop" onClick={closeEditModal}>
          <div className="modal panel" onClick={(e) => e.stopPropagation()}>
            <div className="inline wrap row-between">
              <h2>Update account</h2>
              <button className="btn ghost" onClick={closeEditModal}>
                Close
              </button>
            </div>
            <div className="grid modal-grid">
              <label>
                Email (optional)
                <input
                  value={editingAccount.email}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current ? { ...current, email: e.target.value } : current,
                    )
                  }
                  placeholder="account@email.com"
                />
              </label>
              <label>
                Access token
                <input
                  value={editingAccount.accessToken}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current ? { ...current, accessToken: e.target.value } : current,
                    )
                  }
                  placeholder="Required"
                />
              </label>
              <label>
                Refresh token (optional)
                <input
                  value={editingAccount.refreshToken}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current ? { ...current, refreshToken: e.target.value } : current,
                    )
                  }
                  placeholder="Optional"
                />
              </label>
              {editingAccount.provider === "openai" && (
                <label>
                  ChatGPT account id (optional)
                  <input
                    value={editingAccount.chatgptAccountId}
                    onChange={(e) =>
                      setEditingAccount((current) =>
                        current ? { ...current, chatgptAccountId: e.target.value } : current,
                      )
                    }
                    placeholder="Optional"
                  />
                </label>
              )}
              <label>
                Priority
                <input
                  value={editingAccount.priority}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current ? { ...current, priority: e.target.value } : current,
                    )
                  }
                  placeholder="0"
                />
              </label>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={editingAccount.enabled}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current ? { ...current, enabled: e.target.checked } : current,
                    )
                  }
                />
                Enabled
              </label>
            </div>
            <div className="inline wrap">
              <button
                className="btn"
                disabled={isSavingEdit || !editingAccount.accessToken.trim()}
                onClick={() => void saveEditedAccount()}
              >
                {isSavingEdit ? "Saving..." : "Save changes"}
              </button>
              <button className="btn ghost" onClick={closeEditModal}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
