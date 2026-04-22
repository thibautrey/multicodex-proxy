import React, { useEffect, useState } from "react";
import { Metric } from "../Metric";
import { fmt, maskEmail, maskId } from "../../lib/ui";
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

type AccountProvider = "openai" | "openai-compatible" | "mistral";

type EditAccountState = {
  id: string;
  provider: AccountProvider;
  email: string;
  accessToken: string;
  refreshToken: string;
  chatgptAccountId: string;
  baseUrl: string;
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

function isOAuthProvider(provider: AccountProvider) {
  return provider === "openai";
}

function isManualTokenProvider(provider: AccountProvider) {
  return provider === "mistral" || provider === "openai-compatible";
}

function providerFavicon(provider?: string) {
  if (provider === "mistral") return "https://mistral.ai/favicon.ico";
  if (provider === "zai") return "https://z.ai/favicon.ico";
  return "https://openai.com/favicon.ico";
}

function providerLabel(provider?: string) {
  if (provider === "mistral") return "Mistral";
  if (provider === "openai-compatible") return "OpenAI-compatible";
  if (provider === "zai") return "z.ai";
  return "OpenAI";
}

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
  const [provider, setProvider] = useState<AccountProvider>("openai");
  const [manualEmail, setManualEmail] = useState("");
  const [manualAccessToken, setManualAccessToken] = useState("");
  const [manualRefreshToken, setManualRefreshToken] = useState("");
  const [manualChatgptAccountId, setManualChatgptAccountId] = useState("");
  const [manualBaseUrl, setManualBaseUrl] = useState("");
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
      void submitOauthCallback(callbackUrl.trim());
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
    setManualBaseUrl("");
    setManualPriority("0");
    setManualEnabled(true);
    setIsSubmitting(false);
    sessionStorage.removeItem("multivibe-oauth-pending");
  };

  const closeEditModal = () => {
    setEditingAccount(null);
    setIsSavingEdit(false);
  };

  const closeOauthDialog = () => {
    setOauthDialog(null);
    sessionStorage.removeItem("multivibe-oauth-pending");
  };

  const submitManualAccount = async () => {
    if (isOAuthProvider(provider)) {
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
        sessionStorage.setItem(
          "multivibe-oauth-pending",
          JSON.stringify({
            flowId,
            mode: "create",
            pendingPriority: Number(manualPriority) || 0,
            pendingEnabled: manualEnabled,
            timestamp: Date.now(),
          }),
        );
        window.open(authorizeUrl, "_blank", "noreferrer");
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!manualAccessToken.trim()) return;
    if (provider === "openai-compatible" && !manualBaseUrl.trim()) return;
    setIsSubmitting(true);
    try {
      await createAccount({
        provider,
        email: manualEmail.trim() || undefined,
        accessToken: manualAccessToken.trim(),
        refreshToken: manualRefreshToken.trim() || undefined,
        baseUrl: provider === "openai-compatible" ? manualBaseUrl.trim() : undefined,
        priority: Number(manualPriority) || 0,
        enabled: manualEnabled,
      });
      closeModal();
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditModal = (account: Account) => {
    const nextProvider: AccountProvider =
      account.provider === "mistral"
        ? "mistral"
        : account.provider === "openai-compatible"
          ? "openai-compatible"
          : "openai";
    setEditingAccount({
      id: account.id,
      provider: nextProvider,
      email: account.email ?? "",
      accessToken: account.accessToken ?? "",
      refreshToken: account.refreshToken ?? "",
      chatgptAccountId: account.chatgptAccountId ?? "",
      baseUrl: account.baseUrl ?? "",
      priority: String(account.priority ?? 0),
      enabled: account.enabled,
    });
  };

  const saveEditedAccount = async () => {
    if (!editingAccount) return;
    if (isOAuthProvider(editingAccount.provider)) {
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
        sessionStorage.setItem(
          "multivibe-oauth-pending",
          JSON.stringify({
            flowId,
            mode: "reauth",
            accountId: editingAccount.id,
            timestamp: Date.now(),
          }),
        );
        window.open(authorizeUrl, "_blank", "noreferrer");
      } finally {
        setIsSavingEdit(false);
      }
      return;
    }

    if (!editingAccount.accessToken.trim()) return;
    if (editingAccount.provider === "openai-compatible" && !editingAccount.baseUrl.trim()) return;
    setIsSavingEdit(true);
    try {
      await patch(editingAccount.id, {
        email: editingAccount.email.trim() || undefined,
        accessToken: editingAccount.accessToken.trim(),
        refreshToken: editingAccount.refreshToken.trim() || undefined,
        baseUrl:
          editingAccount.provider === "openai-compatible"
            ? editingAccount.baseUrl.trim()
            : undefined,
        priority: Number(editingAccount.priority) || 0,
        enabled: editingAccount.enabled,
      });
      closeEditModal();
    } finally {
      setIsSavingEdit(false);
    }
  };

  const submitOauthCallback = async (overrideUrl?: string) => {
    const input = overrideUrl?.trim() || oauthDialog?.callbackInput.trim();
    if (!input || !oauthDialog) return;
    setIsSavingEdit(true);
    try {
      setOauthDialog((current) =>
        current ? { ...current, isSubmitting: true } : current,
      );
      const result = await completeOAuth(oauthDialog.flowId, input);
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
      sessionStorage.setItem(
        "multivibe-oauth-pending",
        JSON.stringify({
          flowId,
          mode: "reauth",
          accountId: account.id,
          timestamp: Date.now(),
        }),
      );
      window.open(authorizeUrl, "_blank", "noreferrer");
    } finally {
      setOauthBusyId(null);
    }
  };

  const openAiCount = accounts.filter((account) => (account.provider ?? "openai") === "openai").length;
  const openAiCompatibleCount = accounts.filter((account) => account.provider === "openai-compatible").length;
  const mistralCount = accounts.filter((account) => account.provider === "mistral").length;
  const blockedCount = accounts.filter((account) => account.state?.blockedUntil && account.state.blockedUntil > Date.now()).length;
  const enabledCount = accounts.filter((account) => account.enabled).length;

  const renderUsageCell = (value?: number, resetAt?: number) => {
    const safeValue = typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
    return (
      <div className="usage-cell">
        <div className="usage-value-row">
          <strong>{typeof value === "number" ? `${Math.round(value)}%` : "?"}</strong>
          <small>{fmt(resetAt)}</small>
        </div>
        <div className="mini-progress">
          <span style={{ width: `${safeValue}%` }} />
        </div>
      </div>
    );
  };

  return (
    <>
      <section className="grid cards4">
        <Metric title="Accounts" value={`${accounts.length}`} detail="Total configured providers" />
        <Metric title="Enabled" value={`${enabledCount}`} detail="Available for routing" tone="success" />
        <Metric title="Blocked" value={`${blockedCount}`} detail="Need manual review or quota reset" tone={blockedCount > 0 ? "warning" : "default"} />
        <Metric title="Top model" value={traceStats.models[0]?.model ?? "-"} detail="Highest volume in the selected range" />
      </section>

      <section className="panel">
        <div className="section-split-header">
          <h2>Accounts</h2>
          <div className="inline wrap">
            <span className="badge">{openAiCount} OpenAI</span>
            <span className="badge">{openAiCompatibleCount} OpenAI-compatible</span>
            <span className="badge">{mistralCount} Mistral</span>
            <button className="btn" onClick={() => setShowAddAccount(true)}>
              Add account
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Account</th>
                <th>5h quota</th>
                <th>Weekly quota</th>
                <th>Routing state</th>
                <th>Last error</th>
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
                  <td>
                    <div className="account-cell">
                      <strong>{sanitized ? maskEmail(a.email) : a.email ?? "No email set"}</strong>
                      <span className="mono muted">{sanitized ? maskId(a.id) : a.id}</span>
                      {a.baseUrl && (
                        <span className="mono muted">{a.baseUrl}</span>
                      )}
                    </div>
                  </td>
                  <td>{renderUsageCell(a.usage?.primary?.usedPercent, a.usage?.primary?.resetAt)}</td>
                  <td>{renderUsageCell(a.usage?.secondary?.usedPercent, a.usage?.secondary?.resetAt)}</td>
                  <td>
                    <div className="state-stack">
                      <span className={a.enabled ? "badge badge-live" : "badge badge-warn"}>
                        {a.enabled ? "Enabled" : "Disabled"}
                      </span>
                      <span className={a.state?.blockedUntil && a.state.blockedUntil > Date.now() ? "badge badge-warn" : "badge"}>
                        {a.state?.blockedUntil && a.state.blockedUntil > Date.now() ? `Blocked until ${fmt(a.state?.blockedUntil)}` : "Not blocked"}
                      </span>
                    </div>
                  </td>
                  <td className="mono">{a.state?.lastError?.slice(0, 80) ?? "-"}</td>
                  <td className="inline wrap">
                    <button className="btn ghost" onClick={() => openEditModal(a)}>
                      {a.provider === "openai" ? "Reauth settings" : "Change key"}
                    </button>
                    {a.provider === "openai" && (
                      <button
                        className="btn ghost"
                        disabled={oauthBusyId === a.id}
                        onClick={() => void reauthAccount(a)}
                      >
                        {oauthBusyId === a.id ? "Opening..." : "Reauth"}
                      </button>
                    )}
                    <button className="btn ghost" onClick={() => void patch(a.id, { enabled: !a.enabled })}>
                      {a.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="btn ghost" onClick={() => void unblock(a.id)}>Unblock</button>
                    <button className="btn ghost" onClick={() => void refreshUsage(a.id)}>Refresh</button>
                    <button className="btn danger" onClick={() => void del(a.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {!accounts.length && (
                <tr>
                  <td colSpan={7} className="muted empty-row">
                    No accounts configured yet. Add an OpenAI, OpenAI-compatible, or Mistral account to expose models and enable routing.
                  </td>
                </tr>
              )}
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
                  onChange={(e) => setProvider(e.target.value as AccountProvider)}
                >
                  <option value="openai">OpenAI</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
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
              {provider === "openai-compatible" && (
                <label>
                  Base URL
                  <input
                    value={manualBaseUrl}
                    onChange={(e) => setManualBaseUrl(e.target.value)}
                    placeholder="https://your-api.example.com"
                  />
                </label>
              )}
              {isManualTokenProvider(provider) ? (
                <>
                  <label>
                    API key
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
                  (isOAuthProvider(provider)
                    ? !manualEmail.trim()
                    : !manualAccessToken.trim() ||
                      (provider === "openai-compatible" && !manualBaseUrl.trim()))
                }
                onClick={() => void submitManualAccount()}
              >
                {isSubmitting
                  ? isOAuthProvider(provider)
                    ? "Starting OAuth..."
                    : "Creating..."
                  : isOAuthProvider(provider)
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
              {editingAccount.provider === "openai-compatible" && (
                <label>
                  Base URL
                  <input
                    value={editingAccount.baseUrl}
                    onChange={(e) =>
                      setEditingAccount((current) =>
                        current ? { ...current, baseUrl: e.target.value } : current,
                      )
                    }
                    placeholder="https://your-api.example.com"
                  />
                </label>
              )}
              {isManualTokenProvider(editingAccount.provider) ? (
                <>
                  <label>
                    API key
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
                  (isOAuthProvider(editingAccount.provider)
                    ? !editingAccount.email.trim()
                    : !editingAccount.accessToken.trim() ||
                      (editingAccount.provider === "openai-compatible" &&
                        !editingAccount.baseUrl.trim()))
                }
                onClick={() => void saveEditedAccount()}
              >
                {isSavingEdit
                  ? isOAuthProvider(editingAccount.provider)
                    ? "Starting OAuth..."
                    : "Saving..."
                  : isOAuthProvider(editingAccount.provider)
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
              the callback page, copy the full URL and paste it here. Do not paste access or
              refresh tokens.
            </div>
            <div className="inline wrap">
              <button
                className="btn"
                onClick={() => window.open(oauthDialog.authorizeUrl, "_blank", "noreferrer")}
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
