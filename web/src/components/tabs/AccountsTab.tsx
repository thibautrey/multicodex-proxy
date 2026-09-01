import type { Account, StoreSettings, TraceStats } from "../../types";
import React, { useEffect, useRef, useState } from "react";
import { fmt, maskEmail, maskId } from "../../lib/ui";

import { Metric } from "../Metric";
import { createPortal } from "react-dom";

type Props = {
  traceStats: TraceStats;
  accounts: Account[];
  usageCacheTtlMs: number;
  settings: StoreSettings;
  sanitized: boolean;
  patch: (id: string, body: any) => Promise<void>;
  del: (id: string) => Promise<void>;
  unblock: (id: string) => Promise<void>;
  refreshUsage: (id: string) => Promise<void>;
  consumeRateLimitResetCredit: (id: string) => Promise<void>;
  scheduleRateLimitResetCredit: (id: string) => Promise<void>;
  cancelScheduledRateLimitResetCredit: (id: string) => Promise<void>;
  createAccount: (body: any) => Promise<void>;
  importGrokAuth: () => Promise<any>;
  patchSettings: (body: Partial<StoreSettings>) => Promise<void>;
  startOAuth: (
    email: string,
    accountId?: string,
    method?: OAuthMethod,
    provider?: "openai" | "opencode" | "xai",
  ) => Promise<any>;
  pollDeviceOAuth: (flowId: string) => Promise<any>;
  completeOAuth: (flowId: string, input: string) => Promise<any>;
  oauthRedirectUri: string;
};

type AccountProvider =
  | "openai"
  | "openai-compatible"
  | "opencode"
  | "mistral"
  | "zai"
  | "xai";
type OAuthMethod = "browser" | "device";

type EditAccountState = {
  id: string;
  provider: AccountProvider;
  upstreamMode: "" | "responses" | "chat/completions";
  email: string;
  accessToken: string;
  refreshToken: string;
  chatgptAccountId: string;
  baseUrl: string;
  priority: string;
  enabled: boolean;
  location: "local" | "cloud";
  maxConcurrent: string;
  prefillTokensPerSecond: string;
  decodeTokensPerSecond: string;
  contextWindow: string;
  healthUrl: string;
  metricsUrl: string;
};

type OAuthDialogState = {
  flowId: string;
  email: string;
  authorizeUrl: string;
  expectedRedirectUri: string;
  method: OAuthMethod;
  userCode?: string;
  verificationUrl?: string;
  intervalSeconds?: number;
  expiresAt?: number;
  callbackInput: string;
  isSubmitting: boolean;
  mode: "create" | "reauth";
  accountId?: string;
  pendingPriority?: number;
  pendingEnabled?: boolean;
  provider: "openai" | "opencode" | "xai";
};

function isOAuthProvider(provider: AccountProvider) {
  return provider === "openai" || provider === "xai";
}

function isManualTokenProvider(provider: AccountProvider) {
  return provider === "mistral" || provider === "openai-compatible" || provider === "opencode" || provider === "zai";
}

function providerFavicon(provider?: string) {
  if (provider === "mistral") return "https://mistral.ai/favicon.ico";
  if (provider === "opencode") return "https://opencode.ai/favicon-v3.svg";
  if (provider === "zai") return "https://z.ai/favicon.png";
  if (provider === "xai") return "https://grok.com/favicon.ico";
  return "https://openai.com/favicon.ico";
}

function providerLabel(provider?: string) {
  if (provider === "mistral") return "Mistral";
  if (provider === "opencode") return "OpenCode";
  if (provider === "openai-compatible") return "OpenAI-compatible";
  if (provider === "zai") return "z.ai";
  if (provider === "xai") return "Grok Build";
  return "OpenAI";
}

function oauthProviderLabel(provider: "openai" | "opencode" | "xai") {
  if (provider === "opencode") return "OpenCode";
  if (provider === "xai") return "Grok Build";
  return "OpenAI";
}

function isOpenAiAccount(account: Account) {
  // OpenAI was the only provider before provider was persisted, so legacy
  // account records correctly default to OpenAI on the server as well.
  return (account.provider ?? "openai") === "openai";
}

function activeModelBlocks(account: Account) {
  return Object.entries(account.state?.modelBlocks ?? {}).filter(
    ([, block]) => block.until > Date.now(),
  );
}

function usageAgeLabel(fetchedAt?: number) {
  if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) {
    return "Usage not checked";
  }
  const ageMs = Math.max(0, Date.now() - fetchedAt);
  if (ageMs < 60_000) return "Checked less than a minute ago";
  const ageMinutes = Math.floor(ageMs / 60_000);
  if (ageMinutes < 60) return `Checked ${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  return `Checked ${ageHours}h ago`;
}

function usageStatusLabel(account: Account, usageCacheTtlMs: number) {
  if (!account.usage) return "Usage not checked";
  if (account.usage.quotaStatus === "unsupported") return "Usage not exposed";
  if (
    typeof account.usage.fetchedAt === "number" &&
    Date.now() - account.usage.fetchedAt >= usageCacheTtlMs
  ) {
    return "Refresh pending";
  }
  const primary = account.usage.primary?.usedPercent;
  const secondary = account.usage.secondary?.usedPercent;
  if (primary === 0 && secondary === 0) return "No usage reported";
  return "Usage checked";
}

export function AccountsTab(props: Props) {
  const {
    traceStats,
    accounts,
    usageCacheTtlMs,
    settings,
    sanitized,
    patch,
    del,
    unblock,
    refreshUsage,
    consumeRateLimitResetCredit,
    scheduleRateLimitResetCredit,
    cancelScheduledRateLimitResetCredit,
    createAccount,
    importGrokAuth,
    patchSettings,
    startOAuth,
    pollDeviceOAuth,
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
  const [manualUpstreamMode, setManualUpstreamMode] = useState<
    "" | "responses" | "chat/completions"
  >("");
  const [manualOAuthMethod, setManualOAuthMethod] =
    useState<OAuthMethod>("browser");
  const [editOAuthMethod, setEditOAuthMethod] =
    useState<OAuthMethod>("browser");
  const [manualPriority, setManualPriority] = useState("0");
  const [manualEnabled, setManualEnabled] = useState(true);
  const [manualLocation, setManualLocation] = useState<"" | "local" | "cloud">("");
  const [manualMaxConcurrent, setManualMaxConcurrent] = useState("");
  const [manualPrefill, setManualPrefill] = useState("");
  const [manualDecode, setManualDecode] = useState("");
  const [manualContext, setManualContext] = useState("");
  const [manualHealthUrl, setManualHealthUrl] = useState("");
  const [manualMetricsUrl, setManualMetricsUrl] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EditAccountState | null>(
    null,
  );
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);
  const [oauthDialog, setOauthDialog] = useState<OAuthDialogState | null>(null);
  const devicePollInFlight = useRef(false);
  const [openMenu, setOpenMenu] = useState<{
    accountId: string;
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    const closeMenu = () => setOpenMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        closeMenu();
        return;
      }
      if (target.closest(".icon-menu-btn")) return;
      if (target.closest(".account-action-menu")) return;
      closeMenu();
    };
    const onScroll = () => closeMenu();
    const onResize = () => closeMenu();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    if (!oauthDialog) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if ((data as { type?: string }).type !== "multivibe-oauth-callback")
        return;
      const callbackUrl = (data as { callbackUrl?: string }).callbackUrl;
      if (typeof callbackUrl !== "string" || !callbackUrl.trim()) return;

      try {
        const received = new URL(callbackUrl);
        const expected = new URL(oauthDialog.expectedRedirectUri);
        if (
          received.origin !== expected.origin ||
          received.pathname !== expected.pathname
        ) {
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

  useEffect(() => {
    if (!oauthDialog || oauthDialog.method !== "device") return;

    let cancelled = false;
    const delayMs = Math.max(1, oauthDialog.intervalSeconds ?? 5) * 1000;
    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      if (devicePollInFlight.current) return;
      devicePollInFlight.current = true;
      try {
        console.log("[oauth-device] polling approval", {
          flowId: oauthDialog.flowId,
          intervalSeconds: oauthDialog.intervalSeconds ?? 5,
        });
        const result = await pollDeviceOAuth(oauthDialog.flowId);
        console.log("[oauth-device] poll result", {
          flowId: oauthDialog.flowId,
          status: result?.status,
          hasAccount: Boolean(result?.account),
        });
        if (cancelled) return;
        if (result?.status === "success") {
          const accountId = String(
            result?.account?.id ?? oauthDialog.accountId ?? "",
          ).trim();
          if (
            oauthDialog.mode === "create" &&
            accountId &&
            (oauthDialog.pendingPriority !== 0 ||
              oauthDialog.pendingEnabled === false)
          ) {
            await patch(accountId, {
              priority: oauthDialog.pendingPriority ?? 0,
              enabled: oauthDialog.pendingEnabled ?? true,
            });
          }
          closeOauthDialog();
          closeModal();
        } else {
          setOauthDialog((current) =>
            current
              ? {
                  ...current,
                  isSubmitting: false,
                  intervalSeconds:
                    Number(result?.intervalSeconds) ||
                    current.intervalSeconds ||
                    5,
                }
              : current,
          );
        }
      } catch (err) {
        console.error("[oauth-device] poll failed", {
          flowId: oauthDialog.flowId,
          error: err,
        });
        if (!cancelled) {
          setOauthDialog((current) =>
            current ? { ...current, isSubmitting: false } : current,
          );
        }
      } finally {
        devicePollInFlight.current = false;
      }
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [oauthDialog, pollDeviceOAuth, patch]);

  const closeModal = () => {
    setShowAddAccount(false);
    setProvider("openai");
    setManualEmail("");
    setManualAccessToken("");
    setManualRefreshToken("");
    setManualChatgptAccountId("");
    setManualBaseUrl("");
    setManualUpstreamMode("");
    setManualOAuthMethod("browser");
    setManualPriority("0");
    setManualEnabled(true);
    setManualLocation("");
    setManualMaxConcurrent("");
    setManualPrefill("");
    setManualDecode("");
    setManualContext("");
    setManualHealthUrl("");
    setManualMetricsUrl("");
    setIsSubmitting(false);
    sessionStorage.removeItem("multivibe-oauth-pending");
  };

  const closeEditModal = () => {
    setEditingAccount(null);
    setEditOAuthMethod("browser");
    setIsSavingEdit(false);
  };

  const closeOauthDialog = () => {
    setOauthDialog(null);
    sessionStorage.removeItem("multivibe-oauth-pending");
  };

  const openOAuthDialog = async (options: {
    email: string;
    method: OAuthMethod;
    provider: "openai" | "opencode" | "xai";
    mode: "create" | "reauth";
    accountId?: string;
    pendingPriority?: number;
    pendingEnabled?: boolean;
  }) => {
    const result = await startOAuth(
      options.email,
      options.accountId,
      options.method,
      options.provider,
    );
    const flowId = result?.flowId as string | undefined;
    if (!flowId) throw new Error("Missing OAuth flow details from start response");

    const authorizeUrl = String(result?.authorizeUrl ?? "");
    const expectedRedirectUri =
      (result?.expectedRedirectUri as string | undefined) || oauthRedirectUri;
    const verificationUrl = String(result?.verificationUrl ?? "");
    const userCode = String(result?.userCode ?? "");

    if (options.method === "browser" && !authorizeUrl) {
      throw new Error("Missing browser OAuth authorize URL from start response");
    }
    if (options.method === "device" && (!verificationUrl || !userCode)) {
      throw new Error("Missing device code details from start response");
    }

    setOauthDialog({
      flowId,
      email: options.email,
      authorizeUrl,
      expectedRedirectUri,
      method: options.method,
      userCode,
      verificationUrl,
      intervalSeconds: Number(result?.intervalSeconds) || 5,
      expiresAt: Number(result?.expiresAt) || undefined,
      callbackInput: "",
      isSubmitting: false,
      mode: options.mode,
      accountId: options.accountId,
      pendingPriority: options.pendingPriority,
      pendingEnabled: options.pendingEnabled,
      provider: options.provider,
    });
    sessionStorage.setItem(
      "multivibe-oauth-pending",
      JSON.stringify({
        flowId,
        mode: options.mode,
        method: options.method,
        accountId: options.accountId,
        pendingPriority: options.pendingPriority,
        pendingEnabled: options.pendingEnabled,
        provider: options.provider,
        timestamp: Date.now(),
      }),
    );
    if (options.method === "browser") {
      window.open(authorizeUrl, "_blank", "noreferrer");
    } else {
      window.open(verificationUrl, "_blank", "noreferrer");
    }
  };

  const submitManualAccount = async () => {
    if (isOAuthProvider(provider)) {
      if (provider === "openai" && !manualEmail.trim()) return;
      setIsSubmitting(true);
      try {
        await openOAuthDialog({
          email: manualEmail.trim(),
          method: provider === "xai" ? "device" : manualOAuthMethod,
          provider,
          mode: "create",
          pendingPriority: Number(manualPriority) || 0,
          pendingEnabled: manualEnabled,
        });
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
        baseUrl:
          provider === "openai-compatible" ? manualBaseUrl.trim() : undefined,
        upstreamMode: manualUpstreamMode || undefined,
        priority: Number(manualPriority) || 0,
        enabled: manualEnabled,
        location: manualLocation || undefined,
        capacityProfile: {
          maxConcurrent: manualMaxConcurrent ? Number(manualMaxConcurrent) : undefined,
          prefillTokensPerSecond: manualPrefill ? Number(manualPrefill) : undefined,
          decodeTokensPerSecond: manualDecode ? Number(manualDecode) : undefined,
          contextWindow: manualContext ? Number(manualContext) : undefined,
          healthUrl: manualHealthUrl.trim() || undefined,
          metricsUrl: manualMetricsUrl.trim() || undefined,
        },
      });
      closeModal();
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditModal = (account: Account) => {
    setOpenMenu(null);
    const nextProvider: AccountProvider =
      account.provider === "mistral"
        ? "mistral"
        : account.provider === "zai"
          ? "zai"
        : account.provider === "opencode"
          ? "opencode"
        : account.provider === "xai"
          ? "xai"
        : account.provider === "openai-compatible"
          ? "openai-compatible"
          : "openai";
    setEditingAccount({
      id: account.id,
      provider: nextProvider,
      upstreamMode: account.upstreamMode ?? "",
      email: account.email ?? "",
      accessToken: account.accessToken ?? "",
      refreshToken: account.refreshToken ?? "",
      chatgptAccountId: account.chatgptAccountId ?? "",
      baseUrl: account.baseUrl ?? "",
      priority: String(account.priority ?? 0),
      enabled: account.enabled,
      location: account.location ?? "cloud",
      maxConcurrent: String(account.capacityProfile?.maxConcurrent ?? ""),
      prefillTokensPerSecond: String(account.capacityProfile?.prefillTokensPerSecond ?? ""),
      decodeTokensPerSecond: String(account.capacityProfile?.decodeTokensPerSecond ?? ""),
      contextWindow: String(account.capacityProfile?.contextWindow ?? ""),
      healthUrl: account.capacityProfile?.healthUrl ?? "",
      metricsUrl: account.capacityProfile?.metricsUrl ?? "",
    });
    setEditOAuthMethod(nextProvider === "xai" ? "device" : "browser");
  };

  const saveEditedAccount = async () => {
    if (!editingAccount) return;
    if (isOAuthProvider(editingAccount.provider)) {
      if (
        editingAccount.provider === "openai" &&
        !editingAccount.email.trim()
      ) {
        return;
      }
      setIsSavingEdit(true);
      try {
        closeEditModal();
        await openOAuthDialog({
          email: editingAccount.email.trim(),
          method:
            editingAccount.provider === "xai" ? "device" : editOAuthMethod,
          provider: editingAccount.provider,
          mode: "reauth",
          accountId: editingAccount.id,
        });
      } finally {
        setIsSavingEdit(false);
      }
      return;
    }

    if (!editingAccount.accessToken.trim()) return;
    if (
      editingAccount.provider === "openai-compatible" &&
      !editingAccount.baseUrl.trim()
    )
      return;
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
        upstreamMode: editingAccount.upstreamMode || undefined,
        priority: Number(editingAccount.priority) || 0,
        enabled: editingAccount.enabled,
        location: editingAccount.location,
        capacityProfile: {
          maxConcurrent: editingAccount.maxConcurrent ? Number(editingAccount.maxConcurrent) : undefined,
          prefillTokensPerSecond: editingAccount.prefillTokensPerSecond ? Number(editingAccount.prefillTokensPerSecond) : undefined,
          decodeTokensPerSecond: editingAccount.decodeTokensPerSecond ? Number(editingAccount.decodeTokensPerSecond) : undefined,
          contextWindow: editingAccount.contextWindow ? Number(editingAccount.contextWindow) : undefined,
          healthUrl: editingAccount.healthUrl.trim() || undefined,
          metricsUrl: editingAccount.metricsUrl.trim() || undefined,
        },
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
      const accountId = String(
        result?.account?.id ?? oauthDialog.accountId ?? "",
      ).trim();
      if (
        oauthDialog.mode === "create" &&
        accountId &&
        (oauthDialog.pendingPriority !== 0 ||
          oauthDialog.pendingEnabled === false)
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
    setOpenMenu(null);
    if ((account.provider ?? "openai") !== "openai") return;
    if (!account.email?.trim()) {
      window.alert(
        "This OpenAI account has no email, so reauth cannot be started.",
      );
      return;
    }
    setOauthBusyId(account.id);
    try {
        await openOAuthDialog({
          email: account.email.trim(),
          method: "browser",
          provider: "openai",
        mode: "reauth",
        accountId: account.id,
      });
    } finally {
      setOauthBusyId(null);
    }
  };

  const reauthAccountWithDeviceCode = async (account: Account) => {
    setOpenMenu(null);
    if ((account.provider ?? "openai") !== "openai") return;
    if (!account.email?.trim()) {
      window.alert(
        "This OpenAI account has no email, so reauth cannot be started.",
      );
      return;
    }
    setOauthBusyId(account.id);
    try {
        await openOAuthDialog({
          email: account.email.trim(),
          method: "device",
          provider: "openai",
        mode: "reauth",
        accountId: account.id,
      });
    } finally {
      setOauthBusyId(null);
    }
  };

  const reauthOpenCodeAccount = async (account: Account) => {
    setOpenMenu(null);
    if (account.provider !== "opencode") return;
    setOauthBusyId(account.id);
    try {
      await openOAuthDialog({
        email: account.email?.trim() ?? "",
        method: "device",
        provider: "opencode",
        mode: "reauth",
        accountId: account.id,
      });
    } finally {
      setOauthBusyId(null);
    }
  };

  const openAiCount = accounts.filter(
    (account) => (account.provider ?? "openai") === "openai",
  ).length;
  const passthroughAccounts = accounts.filter(
    (account) => (account.provider ?? "openai") === "openai" && account.enabled,
  );
  const selectedPassthroughAccount = accounts.find(
    (account) => account.id === settings.defaultPassthroughAccountId,
  );
  const openAiCompatibleCount = accounts.filter(
    (account) => account.provider === "openai-compatible",
  ).length;
  const openCodeCount = accounts.filter(
    (account) => account.provider === "opencode",
  ).length;
  const mistralCount = accounts.filter(
    (account) => account.provider === "mistral",
  ).length;
  const zaiCount = accounts.filter(
    (account) => account.provider === "zai",
  ).length;
  const xaiCount = accounts.filter(
    (account) => account.provider === "xai",
  ).length;
  const blockedCount = accounts.filter(
    (account) => activeModelBlocks(account).length > 0,
  ).length;
  const enabledCount = accounts.filter((account) => account.enabled).length;
  const usageCheckedCount = accounts.filter((account) => Boolean(account.usage)).length;
  const usageUnsupportedCount = accounts.filter(
    (account) => account.usage?.quotaStatus === "unsupported",
  ).length;
  const usageRefreshPendingCount = accounts.filter(
    (account) =>
      account.usage?.quotaStatus !== "unsupported" &&
      typeof account.usage?.fetchedAt === "number" &&
      Date.now() - account.usage.fetchedAt >= usageCacheTtlMs,
  ).length;

  const renderUsageCell = (
    value?: number,
    resetAt?: number,
    unsupported = false,
  ) => {
    const safeValue =
      typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
    return (
      <div className="usage-cell">
        <div className="usage-value-row">
          <strong>
            {unsupported
              ? "N/A"
              : typeof value === "number"
                ? `${Math.round(value)}%`
                : "?"}
          </strong>
          <small>{unsupported ? "Not exposed" : fmt(resetAt)}</small>
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
        <Metric
          title="Accounts"
          value={`${accounts.length}`}
          detail="Total configured providers"
        />
        <Metric
          title="Enabled"
          value={`${enabledCount}`}
          detail="Available for routing"
          tone="success"
        />
        <Metric
          title="Blocked"
          value={`${blockedCount}`}
          detail="Need manual review or quota reset"
          tone={blockedCount > 0 ? "warning" : "default"}
        />
        <Metric
          title="Top model"
          value={traceStats.models[0]?.model ?? "-"}
          detail="Highest volume in the selected range"
        />
      </section>

      <section className="panel">
        <div className="section-split-header">
          <div>
            <h2>Default passthrough</h2>
            <p className="muted">
              Non-completions API routes are forwarded through this OpenAI account.
            </p>
          </div>
          <label className="compact-field">
            Account
            <select
              value={settings.defaultPassthroughAccountId ?? ""}
              disabled={!passthroughAccounts.length}
              onChange={(e) =>
                void patchSettings({
                  defaultPassthroughAccountId: e.target.value || undefined,
                })
              }
            >
              <option value="">
                {passthroughAccounts.length
                  ? "No default selected"
                  : "No enabled OpenAI account"}
              </option>
              {passthroughAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {sanitized
                    ? maskEmail(account.email)
                    : (account.email ?? account.id)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="state-stack">
          {settings.defaultPassthroughAccountId ? (
            selectedPassthroughAccount &&
            (selectedPassthroughAccount.provider ?? "openai") === "openai" &&
            selectedPassthroughAccount.enabled ? (
              <span className="badge badge-live">
                Active: {sanitized
                  ? maskEmail(selectedPassthroughAccount.email)
                  : (selectedPassthroughAccount.email ?? selectedPassthroughAccount.id)}
              </span>
            ) : (
              <span className="badge badge-warn">
                Selected passthrough account is unavailable
              </span>
            )
          ) : (
            <span className="badge badge-warn">No default account selected</span>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="section-split-header">
          <h2>Accounts</h2>
          <div className="inline wrap">
            <span className="badge">{openAiCount} OpenAI</span>
            <span className="badge">
              {openAiCompatibleCount} OpenAI-compatible
            </span>
            <span className="badge">{openCodeCount} OpenCode</span>
            <span className="badge">{mistralCount} Mistral</span>
            <span className="badge">{zaiCount} z.ai</span>
            <span className="badge">{xaiCount} Grok Build</span>
            <span className="badge">
              {usageCheckedCount}/{accounts.length} usage checked
            </span>
            {usageUnsupportedCount > 0 && (
              <span className="badge">
                {usageUnsupportedCount} usage not exposed
              </span>
            )}
            {usageRefreshPendingCount > 0 && (
              <span className="badge badge-warn">
                {usageRefreshPendingCount} refresh pending
              </span>
            )}
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
                <th>Monthly quota</th>
                <th>Routing state</th>
                <th>Last error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const modelBlocks = activeModelBlocks(a);
                return (
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
                      <strong>
                        {sanitized
                          ? maskEmail(a.email)
                          : (a.email ?? "No email set")}
                      </strong>
                      {a.baseUrl && (
                        <span className="mono muted">{a.baseUrl}</span>
                      )}
                      {a.upstreamMode && (
                        <span className="mono muted">
                          upstream: {a.upstreamMode}
                        </span>
                      )}
                      {a.provider === "opencode" && a.opencodeOrgName && (
                        <span className="mono muted">
                          organization: {a.opencodeOrgName}
                        </span>
                      )}
                      <span className={a.location === "local" ? "badge badge-live" : "badge"}>
                        {a.location ?? "cloud"}
                      </span>
                      <span className="mono muted">
                        {usageStatusLabel(a, usageCacheTtlMs)} · {usageAgeLabel(a.usage?.fetchedAt)}
                      </span>
                      {a.capacityProfile && (
                        <span className="mono muted">
                          capacity: {a.capacityProfile.maxConcurrent ?? "?"} slots · {a.capacityProfile.prefillTokensPerSecond ?? "?"} prefill tok/s · {a.capacityProfile.decodeTokensPerSecond ?? "?"} decode tok/s · {a.capacityProfile.contextWindow ?? "?"} ctx
                        </span>
                      )}
                      {isOpenAiAccount(a) && (
                        <div className="reset-quota-actions">
                          <button
                            className="btn secondary reset-quota-btn"
                            onClick={() =>
                              void consumeRateLimitResetCredit(a.id)
                            }
                          >
                            Reset quota now
                          </button>
                          {a.state?.scheduledWeeklyReset ? (
                            <>
                              <span className="badge badge-live">
                                Auto-reset scheduled at 0.5% remaining
                              </span>
                              {a.state.scheduledWeeklyReset.lastError && (
                                <small className="reset-quota-error">
                                  Last attempt failed:{" "}
                                  {a.state.scheduledWeeklyReset.lastError}
                                </small>
                              )}
                              <button
                                className="btn secondary reset-quota-btn"
                                onClick={() =>
                                  void cancelScheduledRateLimitResetCredit(a.id)
                                }
                              >
                                Cancel auto-reset
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn secondary reset-quota-btn"
                              onClick={() =>
                                void scheduleRateLimitResetCredit(a.id)
                              }
                            >
                              Auto-reset at 0.5% remaining
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                  <td>
                    {renderUsageCell(
                      a.usage?.primary?.usedPercent,
                      a.usage?.primary?.resetAt,
                      a.usage?.quotaStatus === "unsupported",
                    )}
                  </td>
                  <td>
                    {renderUsageCell(
                      a.usage?.secondary?.usedPercent,
                      a.usage?.secondary?.resetAt,
                      a.usage?.quotaStatus === "unsupported",
                    )}
                  </td>
                  <td>
                    {renderUsageCell(
                      a.usage?.monthly?.usedPercent,
                      a.usage?.monthly?.resetAt,
                      a.usage?.quotaStatus === "unsupported",
                    )}
                  </td>
                  <td>
                    <div className="state-stack">
                      <span
                        className={
                          a.enabled ? "badge badge-live" : "badge badge-warn"
                        }
                      >
                        {a.enabled ? "Enabled" : "Disabled"}
                      </span>
                      {modelBlocks.map(([model, block]) => (
                        <span className="badge badge-warn" key={model}>
                          {`${model} blocked until ${fmt(block.until)}`}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="mono">
                    {a.state?.lastError?.slice(0, 80) ?? "-"}
                  </td>
                  <td>
                    <div className="account-actions-cell">
                      <button
                        className="icon-menu-btn"
                        aria-label={`Open actions for ${a.email ?? a.id}`}
                        aria-expanded={openMenu?.accountId === a.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          setOpenMenu((current) =>
                            current?.accountId === a.id
                              ? null
                              : {
                                  accountId: a.id,
                                  top: rect.bottom + 8,
                                  left: rect.right - 220,
                                },
                          );
                        }}
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 18 18"
                          aria-hidden="true"
                        >
                          <circle cx="9" cy="3.5" r="1.5" />
                          <circle cx="9" cy="9" r="1.5" />
                          <circle cx="9" cy="14.5" r="1.5" />
                        </svg>
                      </button>
                      {openMenu?.accountId === a.id &&
                        createPortal(
                          <div
                            className="account-action-menu"
                            style={{ top: openMenu.top, left: openMenu.left }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              className="account-action-item"
                              onClick={() => openEditModal(a)}
                            >
                              Modify parameters
                            </button>
                            <button
                              className="account-action-item"
                              onClick={() => {
                                setOpenMenu(null);
                                void patch(a.id, { enabled: !a.enabled });
                              }}
                            >
                              {a.enabled ? "Disable" : "Enable"}
                            </button>
                            <button
                              className="account-action-item"
                              onClick={() => {
                                setOpenMenu(null);
                                void unblock(a.id);
                              }}
                            >
                              Unblock
                            </button>
                            <button
                              className="account-action-item"
                              onClick={() => {
                                setOpenMenu(null);
                                void refreshUsage(a.id);
                              }}
                            >
                              Refresh usage
                            </button>
                            {isOpenAiAccount(a) && (
                              <button
                                className="account-action-item"
                                onClick={() => {
                                  setOpenMenu(null);
                                  void consumeRateLimitResetCredit(a.id);
                                }}
                              >
                                Use rate-limit reset credit
                              </button>
                            )}
                            {isOpenAiAccount(a) ? (
                              <>
                                <button
                                  className="account-action-item"
                                  disabled={oauthBusyId === a.id}
                                  onClick={() => void reauthAccount(a)}
                                >
                                  {oauthBusyId === a.id
                                    ? "Opening..."
                                    : "Reauth"}
                                </button>
                                <button
                                  className="account-action-item"
                                  disabled={oauthBusyId === a.id}
                                  onClick={() =>
                                    void reauthAccountWithDeviceCode(a)
                                  }
                                >
                                  Device-code reauth
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  className="account-action-item"
                                  onClick={() => openEditModal(a)}
                                >
                                  Change key
                                </button>
                                {a.provider === "opencode" && (
                                  <button
                                    className="account-action-item"
                                    disabled={oauthBusyId === a.id}
                                    onClick={() => void reauthOpenCodeAccount(a)}
                                  >
                                    {oauthBusyId === a.id
                                      ? "Opening..."
                                      : "OpenCode device reauth"}
                                  </button>
                                )}
                              </>
                            )}
                            <button
                              className="account-action-item account-action-item-danger"
                              onClick={() => {
                                setOpenMenu(null);
                                void del(a.id);
                              }}
                            >
                              Delete
                            </button>
                          </div>,
                          document.body,
                        )}
                    </div>
                  </td>
                </tr>
                );
              })}
              {!accounts.length && (
                <tr>
                  <td colSpan={8} className="muted empty-row">
                    No accounts configured yet. Add an OpenAI,
                    OpenAI-compatible, OpenCode, Mistral, z.ai, or Grok Build account to expose models and
                    enable routing.
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
                  onChange={(e) => {
                    const next = e.target.value as AccountProvider;
                    setProvider(next);
                    if (next === "xai") setManualOAuthMethod("device");
                  }}
                >
                  <option value="openai">OpenAI</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                  <option value="opencode">OpenCode Zen / Go</option>
                  <option value="mistral">Mistral</option>
                  <option value="zai">z.ai</option>
                  <option value="xai">Grok Build (subscription)</option>
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
              {isOAuthProvider(provider) && (
                <label>
                  {provider === "xai"
                    ? "Grok Build login method"
                    : "OpenAI login method"}
                  <select
                    value={manualOAuthMethod}
                    disabled={provider === "xai"}
                    onChange={(e) =>
                      setManualOAuthMethod(e.target.value as OAuthMethod)
                    }
                  >
                    {provider === "openai" && (
                      <option value="browser">Browser callback</option>
                    )}
                    <option value="device">Device code</option>
                  </select>
                </label>
              )}
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
              <label>
                Upstream mode (optional)
                <select
                  value={manualUpstreamMode}
                  onChange={(e) =>
                    setManualUpstreamMode(
                      e.target.value as "" | "responses" | "chat/completions",
                    )
                  }
                >
                  <option value="">Automatic</option>
                  <option value="responses">Force `/v1/responses`</option>
                  <option value="chat/completions">
                    Force `/v1/chat/completions`
                  </option>
                </select>
              </label>
              {isManualTokenProvider(provider) && (
                <>
                  <label>Execution location<select value={manualLocation} onChange={(e) => setManualLocation(e.target.value as "" | "local" | "cloud")}><option value="">Infer from URL/provider</option><option value="local">Local</option><option value="cloud">Cloud</option></select></label>
                  <label>Concurrent slots<input type="number" min="1" value={manualMaxConcurrent} onChange={(e) => setManualMaxConcurrent(e.target.value)} placeholder="1 local / 8 cloud" /></label>
                  <label>Prefill tokens/s<input type="number" min="0" value={manualPrefill} onChange={(e) => setManualPrefill(e.target.value)} /></label>
                  <label>Decode tokens/s<input type="number" min="0" value={manualDecode} onChange={(e) => setManualDecode(e.target.value)} /></label>
                  <label>Context window<input type="number" min="1" value={manualContext} onChange={(e) => setManualContext(e.target.value)} placeholder="262144" /></label>
                  <label>Health URL<input type="url" value={manualHealthUrl} onChange={(e) => setManualHealthUrl(e.target.value)} placeholder="http://mac.local:8000/health" /></label>
                  <label>Metrics URL<input type="url" value={manualMetricsUrl} onChange={(e) => setManualMetricsUrl(e.target.value)} placeholder="Optional JSON metrics" /></label>
                </>
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
                  {provider === "xai"
                    ? "Grok Build uses xAI device OAuth and the SuperGrok / X Premium+ subscription quota."
                    : "OpenAI onboarding uses OAuth. Browser callback opens the login page and asks for the callback URL. Device code shows a one-time code and completes automatically after approval."}
                </div>
              )}
              {provider === "opencode" && (
                <div className="muted">
                  Enter an OpenCode API key, or use the device-login button below to connect an OpenCode Console account. Go quotas are detected automatically.
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
                    ? provider === "openai" && !manualEmail.trim()
                    : !manualAccessToken.trim() ||
                      (provider === "openai-compatible" &&
                        !manualBaseUrl.trim()))
                }
                onClick={() => void submitManualAccount()}
              >
                {isSubmitting
                  ? isOAuthProvider(provider)
                    ? "Starting OAuth..."
                    : "Creating..."
                  : isOAuthProvider(provider)
                    ? provider === "xai"
                      ? "Start Grok device login"
                      : "Start OAuth"
                    : "Create account"}
              </button>
              {provider === "xai" && (
                <button
                  className="btn ghost"
                  disabled={isSubmitting}
                  onClick={() => {
                    setIsSubmitting(true);
                    void importGrokAuth()
                      .then(() => closeModal())
                      .catch((error) => {
                        window.alert(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );
                      })
                      .finally(() => setIsSubmitting(false));
                  }}
                >
                  Import configured auth.json
                </button>
              )}
              {provider === "opencode" && (
                <button
                  className="btn ghost"
                  disabled={isSubmitting}
                  onClick={() => {
                    setIsSubmitting(true);
                    void openOAuthDialog({
                      email: manualEmail.trim(),
                      method: "device",
                      provider: "opencode",
                      mode: "create",
                      pendingPriority: Number(manualPriority) || 0,
                      pendingEnabled: manualEnabled,
                    }).finally(() => setIsSubmitting(false));
                  }}
                >
                  Connect OpenCode account
                </button>
              )}
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
              {isOAuthProvider(editingAccount.provider) && (
                <label>
                  {editingAccount.provider === "xai"
                    ? "Grok Build reauth method"
                    : "OpenAI reauth method"}
                  <select
                    value={editOAuthMethod}
                    disabled={editingAccount.provider === "xai"}
                    onChange={(e) =>
                      setEditOAuthMethod(e.target.value as OAuthMethod)
                    }
                  >
                    {editingAccount.provider === "openai" && (
                      <option value="browser">Browser callback</option>
                    )}
                    <option value="device">Device code</option>
                  </select>
                </label>
              )}
              {editingAccount.provider === "openai-compatible" && (
                <label>
                  Base URL
                  <input
                    value={editingAccount.baseUrl}
                    onChange={(e) =>
                      setEditingAccount((current) =>
                        current
                          ? { ...current, baseUrl: e.target.value }
                          : current,
                      )
                    }
                    placeholder="https://your-api.example.com"
                  />
                </label>
              )}
              <label>
                Upstream mode (optional)
                <select
                  value={editingAccount.upstreamMode}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current
                        ? {
                            ...current,
                            upstreamMode: e.target.value as
                              | ""
                              | "responses"
                              | "chat/completions",
                          }
                        : current,
                    )
                  }
                >
                  <option value="">Automatic</option>
                  <option value="responses">Force `/v1/responses`</option>
                  <option value="chat/completions">
                    Force `/v1/chat/completions`
                  </option>
                </select>
              </label>
              <label>Execution location<select value={editingAccount.location} onChange={(e) => setEditingAccount((current) => current ? { ...current, location: e.target.value as "local" | "cloud" } : current)}><option value="local">Local</option><option value="cloud">Cloud</option></select></label>
              <label>Concurrent slots<input type="number" min="1" value={editingAccount.maxConcurrent} onChange={(e) => setEditingAccount((current) => current ? { ...current, maxConcurrent: e.target.value } : current)} /></label>
              <label>Prefill tokens/s<input type="number" min="0" value={editingAccount.prefillTokensPerSecond} onChange={(e) => setEditingAccount((current) => current ? { ...current, prefillTokensPerSecond: e.target.value } : current)} /></label>
              <label>Decode tokens/s<input type="number" min="0" value={editingAccount.decodeTokensPerSecond} onChange={(e) => setEditingAccount((current) => current ? { ...current, decodeTokensPerSecond: e.target.value } : current)} /></label>
              <label>Context window<input type="number" min="1" value={editingAccount.contextWindow} onChange={(e) => setEditingAccount((current) => current ? { ...current, contextWindow: e.target.value } : current)} /></label>
              <label>Health URL<input type="url" value={editingAccount.healthUrl} onChange={(e) => setEditingAccount((current) => current ? { ...current, healthUrl: e.target.value } : current)} /></label>
              <label>Metrics URL<input type="url" value={editingAccount.metricsUrl} onChange={(e) => setEditingAccount((current) => current ? { ...current, metricsUrl: e.target.value } : current)} /></label>
              {isManualTokenProvider(editingAccount.provider) ? (
                <>
                  <label>
                    API key
                    <input
                      value={editingAccount.accessToken}
                      onChange={(e) =>
                        setEditingAccount((current) =>
                          current
                            ? { ...current, accessToken: e.target.value }
                            : current,
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
                          current
                            ? { ...current, refreshToken: e.target.value }
                            : current,
                        )
                      }
                      placeholder="Optional"
                    />
                  </label>
                </>
              ) : (
                <div className="muted">
                  {editingAccount.provider === "xai"
                    ? "Grok Build reauth uses xAI device OAuth. Save changes, then approve the one-time code."
                    : "OpenAI reauth uses OAuth. Save changes to open the login flow, then paste the full callback URL instead of editing tokens manually."}
                </div>
              )}
              <label>
                Priority
                <input
                  value={editingAccount.priority}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current
                        ? { ...current, priority: e.target.value }
                        : current,
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
                      current
                        ? { ...current, enabled: e.target.checked }
                        : current,
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
                    ? editingAccount.provider === "openai" &&
                      !editingAccount.email.trim()
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
                    ? editingAccount.provider === "xai"
                      ? "Start Grok reauth"
                      : "Start reauth"
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
              <h2>
                {oauthDialog.mode === "create"
                  ? `Complete ${oauthProviderLabel(oauthDialog.provider)} OAuth`
                  : `Complete ${oauthProviderLabel(oauthDialog.provider)} reauth`}
              </h2>
              <button className="btn ghost" onClick={closeOauthDialog}>
                Close
              </button>
            </div>
            <div className="grid modal-grid">
              <label>
                Email {oauthDialog.provider !== "openai" ? "(from provider after approval)" : ""}
                <input value={oauthDialog.email} disabled />
              </label>
              {oauthDialog.method === "device" ? (
                <>
                  <label>
                    Verification URL
                    <input value={oauthDialog.verificationUrl ?? ""} disabled />
                  </label>
                  <label>
                    Device code
                    <input
                      className="mono"
                      value={oauthDialog.userCode ?? ""}
                      disabled
                    />
                  </label>
                </>
              ) : (
                <>
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
                          current
                            ? { ...current, callbackInput: e.target.value }
                            : current,
                        )
                      }
                      placeholder="Paste the full URL after the browser reaches the callback page"
                      rows={5}
                    />
                  </label>
                </>
              )}
            </div>
            <div className="muted">
              {oauthDialog.method === "device"
                ? `Open the verification URL, enter the one-time code, and approve the ${
                    oauthDialog.provider === "xai"
                      ? "xAI"
                      : oauthDialog.provider === "opencode"
                        ? "OpenCode"
                        : "OpenAI"
                  } login. This dialog will complete automatically after approval. Do not share this code.`
                : "Complete the OpenAI login in the opened browser tab. When the browser reaches the callback page, copy the full URL and paste it here. Do not paste access or refresh tokens."}
            </div>
            <div className="inline wrap">
              <button
                className="btn"
                onClick={() =>
                  window.open(
                    oauthDialog.method === "device"
                      ? oauthDialog.verificationUrl
                      : oauthDialog.authorizeUrl,
                    "_blank",
                    "noreferrer",
                  )
                }
              >
                {oauthDialog.method === "device"
                  ? "Open verification page"
                  : "Open login page"}
              </button>
              {oauthDialog.method === "browser" ? (
                <button
                  className="btn"
                  disabled={
                    oauthDialog.isSubmitting ||
                    !oauthDialog.callbackInput.trim()
                  }
                  onClick={() => void submitOauthCallback()}
                >
                  {oauthDialog.isSubmitting
                    ? "Completing..."
                    : "Complete OAuth"}
                </button>
              ) : (
                <button className="btn" disabled>
                  {oauthDialog.isSubmitting
                    ? "Checking..."
                    : "Waiting for approval"}
                </button>
              )}
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
