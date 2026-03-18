import React, { useEffect, useState } from "react";
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
  startOAuth: (email: string, accountId?: string) => Promise<any>;
  completeOAuth: (flowId: string, input: string) => Promise<any>;
  oauthRedirectUri: string;
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

type OAuthDialogState = {
  flowId: string;
  email: string;
  authorizeUrl: string;
  expectedRedirectUri: string;
  callbackInput: string;
  isSubmitting: boolean;
  mode: "create" | "reauth";
  accountId?: string;
  pendingPriority?: number;
  pendingEnabled?: boolean;
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
    completeOAuth,
    oauthRedirectUri,
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
  const [oauthDialog, setOauthDialog] = useState<OAuthDialogState | null>(null);

  useEffect(() => {
    if (!oauthDialog) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if ((data as { type?: string }).type !== "multivibe-oauth-callback") return;
      const callbackUrl = (data as { callbackUrl?: string }).callbackUrl;
      if (typeof callbackUrl !== "string" || !callbackUrl.trim()) return;

      try {
        const received = new URL(callbackUrl);
        const expected = new URL(oauthDialog.expectedRedirectUri);
        if (received.origin !== expected.origin || received.pathname !== expected.pathname) {
          return;
        }
      } catch {
        return;
      }

      setOauthDialog((current) =>
        current ? { ...current, callbackInput: callbackUrl.trim() } : current,
      );
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [oauthDialog]);

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

  const closeOauthDialog = () => {
    setOauthDialog(null);
  };

  const submitManualAccount = async () => {
    if (provider === "openai") {
      if (!manualEmail.trim()) return;
      setIsSubmitting(true);
      try {
        const result = await startOAuth(manualEmail.trim());
        const authorizeUrl = result?.authorizeUrl as string | undefined;
        const flowId = result?.flowId as string | undefined;
        const expectedRedirectUri =
          (result?.expectedRedirectUri as string | undefined) || oauthRedirectUri;
        if (!authorizeUrl || !flowId) {
          throw new Error("Missing OAuth flow details from start response");
        }
        setOauthDialog({
          flowId,
          email: manualEmail.trim(),
          authorizeUrl,
          expectedRedirectUri,
          callbackInput: "",
          isSubmitting: false,
          mode: "create",
          pendingPriority: Number(manualPriority) || 0,
          pendingEnabled: manualEnabled,
        });
        window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!manualAccessToken.trim()) return;
    setIsSubmitting(true);
    try {
      await createAccount({
        provider,
        email: manualEmail.trim() || undefined,
        accessToken: manualAccessToken.trim(),
        refreshToken: manualRefreshToken.trim() || undefined,
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
    if (!editingAccount) return;
    if (editingAccount.provider === "openai") {
      if (!editingAccount.email.trim()) return;
      setIsSavingEdit(true);
      try {
        const result = await startOAuth(editingAccount.email.trim(), editingAccount.id);
        const authorizeUrl = result?.authorizeUrl as string | undefined;
        const flowId = result?.flowId as string | undefined;
        const expectedRedirectUri =
          (result?.expectedRedirectUri as string | undefined) || oauthRedirectUri;
        if (!authorizeUrl || !flowId) {
          throw new Error("Missing OAuth flow details from start response");
        }
        closeEditModal();
        setOauthDialog({
          flowId,
          email: editingAccount.email.trim(),
          authorizeUrl,
          expectedRedirectUri,
          callbackInput: "",
          isSubmitting: false,
          mode: "reauth",
          accountId: editingAccount.id,
        });
        window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      } finally {
        setIsSavingEdit(false);
      }
      return;
    }

    if (!editingAccount.accessToken.trim()) return;
    setIsSavingEdit(true);
    try {
      await patch(editingAccount.id, {
        email: editingAccount.email.trim() || undefined,
        accessToken: editingAccount.accessToken.trim(),
        refreshToken: editingAccount.refreshToken.trim() || undefined,
        priority: Number(editingAccount.priority) || 0,
        enabled: editingAccount.enabled,
      });
      closeEditModal();
    } finally {
      setIsSavingEdit(false);
    }
  };

  const submitOauthCallback = async () => {
    if (!oauthDialog?.callbackInput.trim()) return;
    setIsSavingEdit(true);
    try {
      setOauthDialog((current) =>
        current ? { ...current, isSubmitting: true } : current,
      );
      const result = await completeOAuth(oauthDialog.flowId, oauthDialog.callbackInput.trim());
      const accountId = String(result?.account?.id ?? oauthDialog.accountId ?? "").trim();
      if (
        oauthDialog.mode === "create" &&
        accountId &&
        (oauthDialog.pendingPriority !== 0 || oauthDialog.pendingEnabled === false)
      ) {
        await patch(accountId, {
          priority: oauthDialog.pendingPriority ?? 0,
          enabled: oauthDialog.pendingEnabled ?? true,
        });
      }
      closeOauthDialog();
      closeModal();
    } finally {
      setIsSavingEdit(false);
      setOauthDialog((current) =>
        current ? { ...current, isSubmitting: false } : current,
      );
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
      const result = await startOAuth(account.email.trim(), account.id);
      const authorizeUrl = result?.authorizeUrl as string | undefined;
      const flowId = result?.flowId as string | undefined;
      const expectedRedirectUri =
        (result?.expectedRedirectUri as string | undefined) || oauthRedirectUri;
      if (!authorizeUrl || !flowId) {
        throw new Error("Missing OAuth flow details from OAuth start response");
      }
      setOauthDialog({
        flowId,
        email: account.email.trim(),
        authorizeUrl,
        expectedRedirectUri,
        callbackInput: "",
        isSubmitting: false,
        mode: "reauth",
        accountId: account.id,
      });
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
              {provider === "mistral" ? (
                <>
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
                </>
              ) : (
                <div className="muted">
                  OpenAI onboarding uses OAuth. Start the flow, complete the browser callback,
                  then paste the full callback URL here instead of entering access or refresh
                  tokens manually.
                </div>
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
                disabled={
                  isSubmitting ||
                  (provider === "openai"
                    ? !manualEmail.trim()
                    : !manualAccessToken.trim())
                }
                onClick={() => void submitManualAccount()}
              >
                {isSubmitting
                  ? provider === "openai"
                    ? "Starting OAuth..."
                    : "Creating..."
                  : provider === "openai"
                    ? "Start OAuth"
                    : "Create account"}
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
              {editingAccount.provider === "mistral" ? (
                <>
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
                </>
              ) : (
                <div className="muted">
                  OpenAI reauth uses OAuth. Save changes to open the login flow, then paste the
                  full callback URL instead of editing tokens manually.
                </div>
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
                disabled={
                  isSavingEdit ||
                  (editingAccount.provider === "openai"
                    ? !editingAccount.email.trim()
                    : !editingAccount.accessToken.trim())
                }
                onClick={() => void saveEditedAccount()}
              >
                {isSavingEdit
                  ? editingAccount.provider === "openai"
                    ? "Starting OAuth..."
                    : "Saving..."
                  : editingAccount.provider === "openai"
                    ? "Start reauth"
                    : "Save changes"}
              </button>
              <button className="btn ghost" onClick={closeEditModal}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {oauthDialog && (
        <div className="modal-backdrop" onClick={closeOauthDialog}>
          <div className="modal panel" onClick={(e) => e.stopPropagation()}>
            <div className="inline wrap row-between">
              <h2>{oauthDialog.mode === "create" ? "Complete OpenAI OAuth" : "Complete OpenAI reauth"}</h2>
              <button className="btn ghost" onClick={closeOauthDialog}>
                Close
              </button>
            </div>
            <div className="grid modal-grid">
              <label>
                Email
                <input value={oauthDialog.email} disabled />
              </label>
              <label>
                Redirect URI
                <input value={oauthDialog.expectedRedirectUri} disabled />
              </label>
              <label>
                Callback URL
                <textarea
                  value={oauthDialog.callbackInput}
                  onChange={(e) =>
                    setOauthDialog((current) =>
                      current ? { ...current, callbackInput: e.target.value } : current,
                    )
                  }
                  placeholder="Paste the full URL after the browser reaches the callback page"
                  rows={5}
                />
              </label>
            </div>
            <div className="muted">
              Complete the OpenAI login in the opened browser tab. When the browser reaches
              the callback page, the full URL should autofill here. If it does not, copy the
              full URL and paste it here. Do not paste access or refresh tokens.
            </div>
            <div className="inline wrap">
              <button
                className="btn"
                onClick={() => window.open(oauthDialog.authorizeUrl, "_blank", "noopener,noreferrer")}
              >
                Open login page
              </button>
              <button
                className="btn"
                disabled={oauthDialog.isSubmitting || !oauthDialog.callbackInput.trim()}
                onClick={() => void submitOauthCallback()}
              >
                {oauthDialog.isSubmitting ? "Completing..." : "Complete OAuth"}
              </button>
              <button className="btn ghost" onClick={closeOauthDialog}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
