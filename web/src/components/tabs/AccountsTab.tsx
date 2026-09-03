import type { Account, StoreSettings, TraceStats } from "../../types";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmt, maskEmail, maskId } from "../../lib/ui";
import { ApiError, api } from "../../lib/api";
import {
  observeFloatingViewportChanges,
  placeFloatingMenu,
  type FloatingMenuAnchor,
  type FloatingMenuPlacement,
  type FloatingMenuViewport,
} from "../../lib/floatingMenu";

import { Metric } from "../Metric";
import { createPortal } from "react-dom";

type Props = {
  traceStats: TraceStats;
  accounts: Account[];
  localWorker: LocalWorkerProvider | null;
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
  providerSetupRequest?: number;
  onboardingProviderSetup?: boolean;
  onProviderSetupClosed?: () => void;
  onSkipOnboarding?: () => void;
};

export type LocalWorkerProvider = {
  id: "multivibe-worker-local";
  kind: "system-local-worker";
  name: "MultiVibe Worker";
  location: "local";
  configuration_state: "unconfigured" | "submitted";
  agent_state: "detected" | "selected" | "submitted";
  removable: false;
  routing_eligible: false;
  compensation_eligible: false;
  capability: {
    profile: "apple-silicon" | "linux-nvidia";
    accelerator: "metal" | "cuda";
    hardware: string;
    accelerator_memory_bytes: number;
  };
  estimated_monthly_earnings: {
    currency: "USD";
    period: "month";
    amount: string;
    basis: "same_chip" | "fleet_median" | "no_observations" | "catalog_unavailable";
    sample_count: number;
    as_of_date?: string;
    disclaimer: string;
  };
  connect_url: string;
};

type AccountProvider =
  | "openai"
  | "openai-compatible"
  | "opencode"
  | "mistral"
  | "zai"
  | "xai";
type OAuthMethod = "browser" | "device";

type OpenAccountMenu = {
  accountId: string;
  anchor: FloatingMenuAnchor;
  placement: FloatingMenuPlacement;
};

function currentFloatingViewport(): FloatingMenuViewport {
  const viewport = window.visualViewport;
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

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

type ProviderAgentSelection = {
  schema_version: "provider-selection-v1";
  revision: number;
  state: "detected" | "selected";
  selected_models: string[];
};

type ProviderAgentDetectedModels = {
  schema_version: "provider-detected-models-v1";
  runtimes: Array<{ adapter_id: string; models: string[] }>;
};

type ProviderAgentAdapterRegistry = {
  schema_version: "provider-runtime-registry-v2";
  adapters: Array<{
    id: string;
    display_name: string;
    authentication: "none" | "optional-bearer" | "required-bearer";
    automatic_loopback_candidates: Array<{ endpoint: string }>;
  }>;
};

type ProviderAgentRuntimeEndpoints = {
  schema_version: "provider-runtime-endpoints-v1";
  revision: number;
  endpoints: Array<{
    adapter_id: string;
    endpoint: string;
    authentication: "none" | "bearer";
  }>;
};

type ProviderRuntimeEndpointDraft = {
  adapterId: string;
  endpoint: string;
  bearerToken: string;
  existingAuthentication: "none" | "bearer";
  clearBearer: boolean;
};

type ProviderCapacityPolicyState = {
  schema_version: "provider-capacity-policy-state-v1";
  revision: number;
  paused: boolean;
  automatic_downloads: boolean;
  allow_cloud_workloads: boolean;
  policy: {
    schema_version: "provider-capacity-policy-v1";
    gpu_utilization_percent: number;
    gpu_vram_percent: number;
    max_disk_bytes: number;
    model_storage_path: string;
    max_download_bytes_per_day: number;
    minimum_model_residency_seconds: number;
    max_model_changes_per_day: number;
    reserve_free_disk_bytes: number;
  };
};

type ProviderCapacityPolicyDraft = {
  paused: boolean;
  automaticDownloads: boolean;
  allowCloudWorkloads: boolean;
  gpuUtilizationPercent: string;
  gpuVramPercent: string;
  maxDiskGiB: string;
  modelStoragePath: string;
  maxDownloadGiBPerDay: string;
  minimumModelResidencySeconds: string;
  maxModelChangesPerDay: string;
  reserveFreeDiskGiB: string;
};

type ProviderPreviewStatus =
  | "idle"
  | "loading"
  | "ready"
  | "saving"
  | "unavailable"
  | "error";

type ProviderCapacityStatus =
  | "idle"
  | "loading"
  | "ready"
  | "saving"
  | "unavailable"
  | "error";

const BYTES_PER_GIB = 1024 ** 3;

function emptyProviderCapacityPolicyDraft(): ProviderCapacityPolicyDraft {
  return {
    paused: true,
    automaticDownloads: false,
    allowCloudWorkloads: false,
    gpuUtilizationPercent: "",
    gpuVramPercent: "",
    maxDiskGiB: "",
    modelStoragePath: "",
    maxDownloadGiBPerDay: "",
    minimumModelResidencySeconds: "",
    maxModelChangesPerDay: "",
    reserveFreeDiskGiB: "",
  };
}

function capacityPolicyDraftFromState(
  state: ProviderCapacityPolicyState,
): ProviderCapacityPolicyDraft {
  return {
    paused: state.paused,
    automaticDownloads: state.automatic_downloads,
    allowCloudWorkloads: state.allow_cloud_workloads,
    gpuUtilizationPercent: String(state.policy.gpu_utilization_percent),
    gpuVramPercent: String(state.policy.gpu_vram_percent),
    maxDiskGiB: String(state.policy.max_disk_bytes / BYTES_PER_GIB),
    modelStoragePath: state.policy.model_storage_path,
    maxDownloadGiBPerDay: String(
      state.policy.max_download_bytes_per_day / BYTES_PER_GIB,
    ),
    minimumModelResidencySeconds: String(
      state.policy.minimum_model_residency_seconds,
    ),
    maxModelChangesPerDay: String(state.policy.max_model_changes_per_day),
    reserveFreeDiskGiB: String(
      state.policy.reserve_free_disk_bytes / BYTES_PER_GIB,
    ),
  };
}

function boundedIntegerInput(
  input: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const value = Number(input);
  return /^\d+$/.test(input.trim()) && Number.isSafeInteger(value) &&
    value >= minimum && value <= maximum
    ? value
    : null;
}

function gibInputToBytes(input: string, minimum: number) {
  const gib = Number(input);
  if (input.trim() === "" || !Number.isFinite(gib) || gib < 0) return null;
  const bytes = Math.round(gib * BYTES_PER_GIB);
  return Number.isSafeInteger(bytes) && bytes >= minimum ? bytes : null;
}

function capacityPolicyStateFromDraft(
  draft: ProviderCapacityPolicyDraft,
  revision: number,
): ProviderCapacityPolicyState | null {
  const gpuUtilizationPercent = boundedIntegerInput(
    draft.gpuUtilizationPercent,
    1,
    100,
  );
  const gpuVramPercent = boundedIntegerInput(draft.gpuVramPercent, 1, 100);
  const maxDiskBytes = gibInputToBytes(draft.maxDiskGiB, 1);
  const maxDownloadBytesPerDay = gibInputToBytes(
    draft.maxDownloadGiBPerDay,
    0,
  );
  const minimumModelResidencySeconds = boundedIntegerInput(
    draft.minimumModelResidencySeconds,
    1,
  );
  const maxModelChangesPerDay = boundedIntegerInput(
    draft.maxModelChangesPerDay,
    0,
    4_294_967_295,
  );
  const reserveFreeDiskBytes = gibInputToBytes(draft.reserveFreeDiskGiB, 1);
  const modelStoragePath = draft.modelStoragePath.trim();
  if (
    gpuUtilizationPercent === null ||
    gpuVramPercent === null ||
    maxDiskBytes === null ||
    maxDownloadBytesPerDay === null ||
    minimumModelResidencySeconds === null ||
    maxModelChangesPerDay === null ||
    reserveFreeDiskBytes === null ||
    !modelStoragePath.startsWith("/") ||
    modelStoragePath === "/" ||
    /[\0\r\n]/u.test(modelStoragePath)
  ) {
    return null;
  }
  return {
    schema_version: "provider-capacity-policy-state-v1",
    revision,
    paused: draft.paused,
    automatic_downloads: draft.automaticDownloads,
    allow_cloud_workloads: draft.allowCloudWorkloads,
    policy: {
      schema_version: "provider-capacity-policy-v1",
      gpu_utilization_percent: gpuUtilizationPercent,
      gpu_vram_percent: gpuVramPercent,
      max_disk_bytes: maxDiskBytes,
      model_storage_path: modelStoragePath,
      max_download_bytes_per_day: maxDownloadBytesPerDay,
      minimum_model_residency_seconds: minimumModelResidencySeconds,
      max_model_changes_per_day: maxModelChangesPerDay,
      reserve_free_disk_bytes: reserveFreeDiskBytes,
    },
  };
}

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

const dialogFocusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

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

function localWorkerEstimateLabel(worker: LocalWorkerProvider): string {
  const amount = Number(worker.estimated_monthly_earnings.amount);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(amount)
    : "$0.00";
}

function localWorkerEstimateBasis(worker: LocalWorkerProvider): string {
  const estimate = worker.estimated_monthly_earnings;
  if (estimate.basis === "same_chip") return `Median for the same chip · ${estimate.sample_count} qualifying hosts`;
  if (estimate.basis === "fleet_median") return `Fleet median fallback · ${estimate.sample_count} qualifying hosts`;
  if (estimate.basis === "catalog_unavailable") return "Estimate catalog temporarily unavailable";
  return "No qualifying observations yet · conservative fallback";
}

export function AccountsTab(props: Props) {
  const {
    traceStats,
    accounts,
    localWorker,
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
    providerSetupRequest,
    onboardingProviderSetup = false,
    onProviderSetupClosed,
    onSkipOnboarding,
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
  const [openMenu, setOpenMenu] = useState<OpenAccountMenu | null>(null);
  const accountActionMenuRef = useRef<HTMLDivElement | null>(null);
  const accountActionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [makeMoneyPreviewAccount, setMakeMoneyPreviewAccount] =
    useState<Account | null>(null);
  const [providerPreviewStatus, setProviderPreviewStatus] =
    useState<ProviderPreviewStatus>("idle");
  const [providerSelection, setProviderSelection] =
    useState<ProviderAgentSelection | null>(null);
  const [providerSelectionDraft, setProviderSelectionDraft] = useState<string[]>([]);
  const [providerDetectedModels, setProviderDetectedModels] =
    useState<ProviderAgentDetectedModels | null>(null);
  const [providerAdapterRegistry, setProviderAdapterRegistry] =
    useState<ProviderAgentAdapterRegistry | null>(null);
  const [providerRuntimeEndpoints, setProviderRuntimeEndpoints] =
    useState<ProviderAgentRuntimeEndpoints | null>(null);
  const [providerRuntimeDrafts, setProviderRuntimeDrafts] =
    useState<ProviderRuntimeEndpointDraft[]>([]);
  const [providerRuntimeAdapterToAdd, setProviderRuntimeAdapterToAdd] = useState("");
  const [providerRuntimeSaving, setProviderRuntimeSaving] = useState(false);
  const [providerRuntimeMessage, setProviderRuntimeMessage] = useState("");
  const [providerPreviewMessage, setProviderPreviewMessage] = useState("");
  const [providerCapacityPolicy, setProviderCapacityPolicy] =
    useState<ProviderCapacityPolicyState | null>(null);
  const [providerCapacityDraft, setProviderCapacityDraft] =
    useState<ProviderCapacityPolicyDraft>(emptyProviderCapacityPolicyDraft);
  const [providerCapacityStatus, setProviderCapacityStatus] =
    useState<ProviderCapacityStatus>("idle");
  const [providerCapacityMessage, setProviderCapacityMessage] = useState("");
  const makeMoneyDialogRef = useRef<HTMLDivElement | null>(null);
  const makeMoneyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const makeMoneyCloseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (providerSetupRequest) setShowAddAccount(true);
  }, [providerSetupRequest]);

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
    const onScroll = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".account-action-menu")
      ) {
        return;
      }
      closeMenu();
    };
    const onResize = () => closeMenu();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    const stopObservingVisualViewport = observeFloatingViewportChanges(
      window.visualViewport,
      closeMenu,
    );
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      stopObservingVisualViewport();
    };
  }, []);

  useLayoutEffect(() => {
    const menu = accountActionMenuRef.current;
    if (!openMenu || !menu) return;

    const placement = placeFloatingMenu(
      openMenu.anchor,
      { width: menu.offsetWidth, height: menu.scrollHeight },
      currentFloatingViewport(),
    );
    setOpenMenu((current) => {
      if (!current || current.accountId !== openMenu.accountId) return current;
      const previous = current.placement;
      if (
        previous.top === placement.top &&
        previous.left === placement.left &&
        previous.maxHeight === placement.maxHeight &&
        previous.maxWidth === placement.maxWidth &&
        previous.side === placement.side
      ) {
        return current;
      }
      return { ...current, placement };
    });
  }, [
    openMenu?.accountId,
    openMenu?.anchor.top,
    openMenu?.anchor.bottom,
    openMenu?.anchor.right,
  ]);

  useEffect(() => {
    if (!openMenu) return;
    const focusFrame = window.requestAnimationFrame(() => {
      accountActionMenuRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpenMenu(null);
      accountActionTriggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu?.accountId]);

  useEffect(() => {
    if (!makeMoneyPreviewAccount) return;

    let cancelled = false;
    setProviderPreviewStatus("loading");
    setProviderPreviewMessage("");
    setProviderSelection(null);
    setProviderDetectedModels(null);
    setProviderAdapterRegistry(null);
    setProviderRuntimeEndpoints(null);
    setProviderRuntimeDrafts([]);
    setProviderRuntimeMessage("");
    setProviderCapacityPolicy(null);
    setProviderCapacityDraft(emptyProviderCapacityPolicyDraft());
    setProviderCapacityStatus("loading");
    setProviderCapacityMessage("");

    void Promise.all([
      api("/admin/provider-agent/selection"),
      api("/admin/provider-agent/detected-models"),
      api("/admin/provider-agent/adapters"),
      api("/admin/provider-agent/runtime-endpoints"),
    ]).then(([selection, detected, adapters, runtimeEndpoints]) => {
      if (cancelled) return;
      const nextSelection = selection as ProviderAgentSelection;
      const nextRuntimeEndpoints = runtimeEndpoints as ProviderAgentRuntimeEndpoints;
      setProviderSelection(nextSelection);
      setProviderSelectionDraft([...nextSelection.selected_models].sort());
      setProviderDetectedModels(detected as ProviderAgentDetectedModels);
      setProviderAdapterRegistry(adapters as ProviderAgentAdapterRegistry);
      setProviderRuntimeEndpoints(nextRuntimeEndpoints);
      setProviderRuntimeDrafts(nextRuntimeEndpoints.endpoints.map((endpoint) => ({
        adapterId: endpoint.adapter_id,
        endpoint: endpoint.endpoint,
        bearerToken: "",
        existingAuthentication: endpoint.authentication,
        clearBearer: false,
      })));
      setProviderPreviewStatus("ready");
    }).catch((error: unknown) => {
      if (cancelled) return;
      setProviderPreviewStatus(error instanceof ApiError && error.status === 503 ? "unavailable" : "error");
      setProviderPreviewMessage(
        error instanceof ApiError && error.status === 503
          ? "The embedded provider agent is not available in this Core installation."
          : "The bounded local inventory could not be loaded.",
      );
    });

    void api("/admin/provider-agent/capacity-policy").then((policy) => {
      if (cancelled) return;
      const nextPolicy = policy as ProviderCapacityPolicyState;
      setProviderCapacityPolicy(nextPolicy);
      setProviderCapacityDraft(capacityPolicyDraftFromState(nextPolicy));
      setProviderCapacityStatus("ready");
    }).catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof ApiError && error.status === 404) {
        setProviderCapacityPolicy(null);
        setProviderCapacityDraft(emptyProviderCapacityPolicyDraft());
        setProviderCapacityStatus("ready");
        setProviderCapacityMessage(
          "No capacity policy is stored yet. Fill every limit below; the first save will create revision 1 from revision 0.",
        );
        return;
      }
      setProviderCapacityStatus(
        error instanceof ApiError && error.status === 503
          ? "unavailable"
          : "error",
      );
      setProviderCapacityMessage(
        error instanceof ApiError && error.status === 503
          ? "The local capacity policy service is unavailable."
          : "The local capacity policy could not be loaded.",
      );
    });

    return () => {
      cancelled = true;
    };
  }, [makeMoneyPreviewAccount]);

  useEffect(() => {
    if (!makeMoneyPreviewAccount) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      makeMoneyCloseRef.current?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMakeMoneyPreviewAccount(null);
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = makeMoneyDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector),
      );
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      window.requestAnimationFrame(() => {
        const focusTarget = makeMoneyTriggerRef.current ?? previouslyFocused;
        if (focusTarget?.isConnected) focusTarget.focus();
      });
    };
  }, [makeMoneyPreviewAccount]);

  const toggleProviderSelection = (model: string) => {
    setProviderSelectionDraft((current) =>
      current.includes(model)
        ? current.filter((value) => value !== model)
        : [...current, model].sort(),
    );
    setProviderPreviewMessage("");
  };

  const updateProviderCapacityDraft = <
    Key extends keyof ProviderCapacityPolicyDraft,
  >(
    key: Key,
    value: ProviderCapacityPolicyDraft[Key],
  ) => {
    setProviderCapacityDraft((current) => ({ ...current, [key]: value }));
    setProviderCapacityMessage("");
  };

  const saveProviderSelection = async () => {
    if (!providerSelection || providerPreviewStatus === "saving") return;
    setProviderPreviewStatus("saving");
    setProviderPreviewMessage("");
    try {
      const next = await api("/admin/provider-agent/selection", {
        method: "PUT",
        body: JSON.stringify({
          revision: providerSelection.revision,
          selected_models: providerSelectionDraft,
        }),
      }) as ProviderAgentSelection;
      setProviderSelection(next);
      setProviderSelectionDraft([...next.selected_models].sort());
      setProviderPreviewStatus("ready");
      setProviderPreviewMessage(
        next.selected_models.length
          ? "Local selection saved. Nothing was submitted to MultiVibe Cloud."
          : "Local selection cleared. Nothing was submitted to MultiVibe Cloud.",
      );
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await api("/admin/provider-agent/selection") as ProviderAgentSelection;
          setProviderSelection(latest);
          setProviderSelectionDraft([...latest.selected_models].sort());
          setProviderPreviewStatus("ready");
          setProviderPreviewMessage("The selection changed in another session. The latest local revision is shown; review it before saving again.");
          return;
        } catch {
          // Fall through to the bounded unavailable state below.
        }
      }
      setProviderPreviewStatus(error instanceof ApiError && error.status === 503 ? "unavailable" : "error");
      setProviderPreviewMessage(
        error instanceof ApiError && error.status === 400
          ? "The local selection contains an invalid model identifier."
          : "The local selection could not be saved.",
      );
    }
  };

  const saveProviderRuntimeEndpoints = async () => {
    if (!providerRuntimeEndpoints || providerRuntimeSaving) return;
    setProviderRuntimeSaving(true);
    setProviderRuntimeMessage("");
    try {
      const next = await api("/admin/provider-agent/runtime-endpoints", {
        method: "PUT",
        body: JSON.stringify({
          revision: providerRuntimeEndpoints.revision,
          endpoints: providerRuntimeDrafts.map((draft) => ({
            adapter_id: draft.adapterId,
            endpoint: draft.endpoint,
            ...(draft.clearBearer
              ? { bearer_token: "" }
              : draft.bearerToken
                ? { bearer_token: draft.bearerToken }
                : {}),
          })),
        }),
      }) as ProviderAgentRuntimeEndpoints;
      const detected = await api("/admin/provider-agent/detected-models") as ProviderAgentDetectedModels;
      setProviderRuntimeEndpoints(next);
      setProviderRuntimeDrafts(next.endpoints.map((endpoint) => ({
        adapterId: endpoint.adapter_id,
        endpoint: endpoint.endpoint,
        bearerToken: "",
        existingAuthentication: endpoint.authentication,
        clearBearer: false,
      })));
      setProviderDetectedModels(detected);
      setProviderRuntimeMessage(
        "Local runtime endpoints saved and detection refreshed. Nothing was submitted to MultiVibe Cloud.",
      );
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await api("/admin/provider-agent/runtime-endpoints") as ProviderAgentRuntimeEndpoints;
          setProviderRuntimeEndpoints(latest);
          setProviderRuntimeDrafts(latest.endpoints.map((endpoint) => ({
            adapterId: endpoint.adapter_id,
            endpoint: endpoint.endpoint,
            bearerToken: "",
            existingAuthentication: endpoint.authentication,
            clearBearer: false,
          })));
          setProviderRuntimeMessage(
            "Runtime endpoints changed in another session. The latest local revision is shown; review it before saving again.",
          );
          return;
        } catch {
          // Fall through to the local error state below.
        }
      }
      setProviderRuntimeMessage(
        error instanceof ApiError && error.status === 400
          ? "Use one unique adapter per entry and a literal http://127.0.0.1:port or http://[::1]:port endpoint."
          : "The local runtime endpoints could not be saved.",
      );
    } finally {
      setProviderRuntimeSaving(false);
    }
  };

  const saveProviderCapacityPolicy = async () => {
    if (providerCapacityStatus === "saving") return;
    const input = capacityPolicyStateFromDraft(
      providerCapacityDraft,
      providerCapacityPolicy?.revision ?? 0,
    );
    if (!input) {
      setProviderCapacityMessage(
        "Complete every limit with a valid value and choose an absolute model storage path before saving.",
      );
      return;
    }

    setProviderCapacityStatus("saving");
    setProviderCapacityMessage("");
    try {
      const next = await api("/admin/provider-agent/capacity-policy", {
        method: "PUT",
        body: JSON.stringify(input),
      }) as ProviderCapacityPolicyState;
      setProviderCapacityPolicy(next);
      setProviderCapacityDraft(capacityPolicyDraftFromState(next));
      setProviderCapacityStatus("ready");
      setProviderCapacityMessage(
        next.paused
          ? "Capacity limits saved locally. Manual pause is active and overrides downloads and Cloud workload consent. No workload, route or payment was activated."
          : next.allow_cloud_workloads
            ? "Capacity limits and explicit Cloud consent saved locally. This records permission only; it does not enroll the host, route traffic or activate payments."
            : "Capacity limits saved locally. Cloud workloads remain disabled; no traffic or payment was activated.",
      );
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await api(
            "/admin/provider-agent/capacity-policy",
          ) as ProviderCapacityPolicyState;
          setProviderCapacityPolicy(latest);
          setProviderCapacityDraft(capacityPolicyDraftFromState(latest));
          setProviderCapacityStatus("ready");
          setProviderCapacityMessage(
            "The capacity policy changed in another session. The latest local revision is shown; review every value before saving again.",
          );
          return;
        } catch {
          // Fall through to the local unavailable state below.
        }
      }
      setProviderCapacityStatus(
        error instanceof ApiError && error.status === 400
          ? "ready"
          : error instanceof ApiError && error.status === 503
            ? "unavailable"
            : "error",
      );
      setProviderCapacityMessage(
        error instanceof ApiError && error.status === 400
          ? "The agent rejected this policy. Check the percentages, integer limits and absolute storage path."
          : "The local capacity policy could not be saved.",
      );
    }
  };

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
    onProviderSetupClosed?.();
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

  const reauthOAuthAccount = async (account: Account) => {
    const provider = account.provider ?? "openai";
    if (provider === "openai") {
      await reauthAccount(account);
      return;
    }
    if (provider === "opencode") {
      await reauthOpenCodeAccount(account);
      return;
    }
    if (provider !== "xai") return;

    setOpenMenu(null);
    setOauthBusyId(account.id);
    try {
      await openOAuthDialog({
        email: account.email?.trim() ?? "",
        method: "device",
        provider: "xai",
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
  const hasAnyProvider = accounts.length > 0 || localWorker !== null;

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

  const detectedProviderModelIds = new Set(
    providerDetectedModels?.runtimes.flatMap((runtime) => runtime.models) ?? [],
  );
  const selectedButNotDetected = providerSelectionDraft.filter(
    (model) => !detectedProviderModelIds.has(model),
  );
  const providerSelectionChanged = Boolean(
    providerSelection &&
    (providerSelection.selected_models.length !== providerSelectionDraft.length ||
      providerSelection.selected_models.some((model, index) => model !== providerSelectionDraft[index])),
  );
  const manuallyConfigurableProviderAdapters =
    providerAdapterRegistry?.adapters.filter(
      (adapter) => adapter.automatic_loopback_candidates.length === 0,
    ) ?? [];
  const availableProviderRuntimeAdapters = manuallyConfigurableProviderAdapters.filter(
    (adapter) => !providerRuntimeDrafts.some((draft) => draft.adapterId === adapter.id),
  );
  const providerRuntimeChanged = Boolean(
    providerRuntimeEndpoints && (
      providerRuntimeEndpoints.endpoints.length !== providerRuntimeDrafts.length ||
      providerRuntimeDrafts.some((draft) => {
        const current = providerRuntimeEndpoints.endpoints.find(
          (endpoint) => endpoint.adapter_id === draft.adapterId,
        );
        return !current || current.endpoint !== draft.endpoint || draft.bearerToken !== "" || draft.clearBearer;
      })
    ),
  );
  const providerCapacityInput = capacityPolicyStateFromDraft(
    providerCapacityDraft,
    providerCapacityPolicy?.revision ?? 0,
  );
  const providerCapacityChanged = Boolean(
    providerCapacityInput &&
    (!providerCapacityPolicy ||
      JSON.stringify(providerCapacityInput) !==
        JSON.stringify(providerCapacityPolicy)),
  );

  return (
    <>
      {hasAnyProvider && (
        <>
      <section className="grid cards4">
        <Metric
          title="Providers"
          value={`${accounts.length + (localWorker ? 1 : 0)}`}
          detail={localWorker ? "Configured accounts and local Host worker" : "Total configured providers"}
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
        </>
      )}

      {accounts.length > 0 && <section className="panel">
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
      </section>}

      <section className={hasAnyProvider ? "panel" : "panel providers-empty-state"}>
        <div className="section-split-header">
          <h2>{accounts.length ? "Connected providers" : "Providers"}</h2>
          <div className="inline wrap">
            {openAiCount > 0 && (
              <span className="badge">{openAiCount} OpenAI</span>
            )}
            {openAiCompatibleCount > 0 && (
              <span className="badge">
                {openAiCompatibleCount} OpenAI-compatible
              </span>
            )}
            {openCodeCount > 0 && (
              <span className="badge">{openCodeCount} OpenCode</span>
            )}
            {mistralCount > 0 && (
              <span className="badge">{mistralCount} Mistral</span>
            )}
            {zaiCount > 0 && (
              <span className="badge">{zaiCount} z.ai</span>
            )}
            {xaiCount > 0 && (
              <span className="badge">{xaiCount} Grok Build</span>
            )}
            {localWorker && <span className="badge">1 MultiVibe Worker</span>}
            {accounts.length > 0 && <span className="badge">{usageCheckedCount}/{accounts.length} usage checked</span>}
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
            {hasAnyProvider && <button className="btn" onClick={() => setShowAddAccount(true)}>Add provider</button>}
          </div>
        </div>
        {localWorker && (
          <article className="local-worker-provider" aria-labelledby="local-worker-provider-title">
            <div className="local-worker-provider-identity">
              <img
                className="local-worker-provider-icon"
                src="/assets/brand/multivibe-app-icon.svg"
                alt=""
              />
              <div>
                <div className="inline wrap">
                  <h3 id="local-worker-provider-title">{localWorker.name}</h3>
                  <span className="badge badge-warn">
                    {localWorker.configuration_state === "submitted" ? "Submitted" : "Unconfigured"}
                  </span>
                  <span className="badge">Local · managed by MultiVibe Host</span>
                </div>
                <p className="muted">
                  {localWorker.capability.hardware} · {localWorker.capability.accelerator.toUpperCase()} · {Math.round(localWorker.capability.accelerator_memory_bytes / (1024 ** 3))} GiB usable capacity
                </p>
                
              </div>
            </div>
            <div className="local-worker-provider-estimate">
              <span>Estimated monthly earnings</span>
              <strong>{localWorkerEstimateLabel(localWorker)}<small>/month</small></strong>
              <small>{localWorkerEstimateBasis(localWorker)}</small>
              {localWorker.estimated_monthly_earnings.as_of_date && (
                <small>Data through {localWorker.estimated_monthly_earnings.as_of_date}</small>
              )}
              <p>{localWorker.estimated_monthly_earnings.disclaimer}</p>
            </div>
            <div className="local-worker-provider-actions">
              <a className="btn" href={localWorker.connect_url} target="_blank" rel="noreferrer">
                Connect Multivibe Cloud and start earning
              </a>
            </div>
          </article>
        )}
        {!accounts.length && !localWorker ? (
          <div className="empty-state-content">
            <span className="empty-state-icon" aria-hidden="true">+</span>
            <h3>Connect your first provider</h3>
            <p className="muted">Add a hosted account or a local OpenAI-compatible endpoint. MultiVibe will discover its models and make them ready for routing.</p>
            <button className="btn" onClick={() => setShowAddAccount(true)}>Add a provider</button>
          </div>
        ) : accounts.length > 0 ? (
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
                const needsReauthentication =
                  a.state?.needsTokenRefresh === true &&
                  ["openai", "opencode", "xai"].includes(
                    a.provider ?? "openai",
                  );
                return (
                <tr
                  key={a.id}
                  className={
                    needsReauthentication ? "account-row-needs-reauth" : undefined
                  }
                >
                  <td>
                    {needsReauthentication && (
                      <div
                        className="account-reauth-overlay"
                        role="status"
                        aria-label="This account needs to be reconnected"
                      >
                        <span>This account needs to be reconnected</span>
                        <button
                          type="button"
                          className="btn account-reauth-button"
                          disabled={oauthBusyId === a.id}
                          onClick={() => void reauthOAuthAccount(a)}
                        >
                          {oauthBusyId === a.id
                            ? "Opening..."
                            : "Reauth this account"}
                        </button>
                      </div>
                    )}
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
                      {a.location === "local" && (
                        <button
                          type="button"
                          className="btn secondary make-money-preview-trigger"
                          aria-haspopup="dialog"
                          aria-controls="make-money-preview-dialog"
                          onClick={(event) => {
                            makeMoneyTriggerRef.current = event.currentTarget;
                            setOpenMenu(null);
                            setMakeMoneyPreviewAccount(a);
                          }}
                        >
                          Share models · Preview
                        </button>
                      )}
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
                          accountActionTriggerRef.current = e.currentTarget;
                          setOpenMenu((current) =>
                            current?.accountId === a.id
                              ? null
                              : {
                                  accountId: a.id,
                                  anchor: {
                                    top: rect.top,
                                    bottom: rect.bottom,
                                    right: rect.right,
                                  },
                                  placement: placeFloatingMenu(
                                    {
                                      top: rect.top,
                                      bottom: rect.bottom,
                                      right: rect.right,
                                    },
                                    { width: 220, height: 0 },
                                    currentFloatingViewport(),
                                  ),
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
                            ref={accountActionMenuRef}
                            className="account-action-menu"
                            data-placement={openMenu.placement.side}
                            style={{
                              top: openMenu.placement.top,
                              left: openMenu.placement.left,
                              maxHeight: openMenu.placement.maxHeight,
                              maxWidth: openMenu.placement.maxWidth,
                            }}
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
            </tbody>
          </table>
        </div>
        ) : null}
      </section>

      {makeMoneyPreviewAccount &&
        createPortal(
          <div
          className="modal-backdrop make-money-preview-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setMakeMoneyPreviewAccount(null);
            }
          }}
        >
          <div
            id="make-money-preview-dialog"
            ref={makeMoneyDialogRef}
            className="modal panel make-money-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="make-money-preview-title"
            aria-describedby="make-money-preview-summary make-money-preview-status"
            tabIndex={-1}
          >
            <div className="modal-title-row make-money-preview-header">
              <div>
                <span className="badge badge-warn">
                  {providerLabel(makeMoneyPreviewAccount.provider)} local · Preview
                </span>
                <h2 id="make-money-preview-title">Share capacity on your terms</h2>
                <p id="make-money-preview-summary" className="muted">
                  MultiVibe Cloud is a separate, optional service built on top of
                  the public MultiVibe Core. This local provider keeps working
                  without a Cloud account.
                </p>
              </div>
              <button
                ref={makeMoneyCloseRef}
                type="button"
                className="btn ghost modal-close-button"
                aria-label="Close Make money preview"
                onClick={() => setMakeMoneyPreviewAccount(null)}
              >
                Close
              </button>
            </div>

            <div id="make-money-preview-status" className="make-money-preview-status">
              <strong>Preview only.</strong> Provider enrollment, customer
              workloads, earnings, payouts and Cloud credits are not active yet.
              Opening this window reads protected local provider settings and
              performs only the agent&apos;s reviewed loopback catalog probes. It
              does not scan the LAN, inspect processes or files, install
              anything, or share the result.
            </div>

            <section className="provider-selection-panel provider-capacity-panel" aria-labelledby="provider-capacity-title">
              <div className="provider-selection-heading">
                <div>
                  <span className="eyebrow">Local capacity policy</span>
                  <h3 id="provider-capacity-title">Set hard host limits</h3>
                  <p>
                    Every value is an explicit local choice. Saving this policy
                    does not enroll the host, send workloads, enable payments or
                    make the machine reachable from MultiVibe Cloud.
                  </p>
                </div>
                {(providerCapacityStatus === "ready" || providerCapacityStatus === "saving") && (
                  <span className={providerCapacityDraft.paused ? "badge badge-warn" : "badge"}>
                    {providerCapacityPolicy
                      ? `${providerCapacityDraft.paused ? "Paused" : "Limits set"} · revision ${providerCapacityPolicy.revision}`
                      : "Not configured · revision 0"}
                  </span>
                )}
              </div>

              {providerCapacityStatus === "loading" && (
                <div className="provider-selection-empty" role="status">
                  Loading the protected local capacity policy…
                </div>
              )}

              {(providerCapacityStatus === "unavailable" || providerCapacityStatus === "error") && (
                <div className="provider-selection-empty provider-selection-error" role="status">
                  <strong>{providerCapacityMessage}</strong>
                  <span>No local policy was changed.</span>
                </div>
              )}

              {(providerCapacityStatus === "ready" || providerCapacityStatus === "saving") && (
                <>
                  <div className={providerCapacityDraft.paused
                    ? "provider-capacity-priority provider-capacity-paused"
                    : "provider-capacity-priority"}
                  >
                    <strong>
                      {providerCapacityDraft.paused
                        ? "Manual pause is selected"
                        : "Manual pause is off"}
                    </strong>
                    <span>
                      Manual pause is the highest-priority local choice. It
                      keeps this policy fail-closed even when automatic downloads
                      or Cloud consent are selected.
                    </span>
                  </div>

                  <div className="provider-capacity-grid">
                    <label>
                      Host state
                      <select
                        value={providerCapacityDraft.paused ? "paused" : "available"}
                        disabled={providerCapacityStatus === "saving"}
                        onChange={(event) => updateProviderCapacityDraft(
                          "paused",
                          event.target.value === "paused",
                        )}
                      >
                        <option value="paused">Paused — safest default</option>
                        <option value="available">Not paused — saved limits still apply</option>
                      </select>
                      <small>Pause overrides every other choice below.</small>
                    </label>

                    <label>
                      Maximum GPU utilization (%)
                      <input
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        inputMode="numeric"
                        value={providerCapacityDraft.gpuUtilizationPercent}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="80"
                        onChange={(event) => updateProviderCapacityDraft(
                          "gpuUtilizationPercent",
                          event.target.value,
                        )}
                      />
                      <small>Whole number from 1 to 100.</small>
                    </label>

                    <label>
                      Maximum GPU memory use (%)
                      <input
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        inputMode="numeric"
                        value={providerCapacityDraft.gpuVramPercent}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="75"
                        onChange={(event) => updateProviderCapacityDraft(
                          "gpuVramPercent",
                          event.target.value,
                        )}
                      />
                      <small>Whole number from 1 to 100.</small>
                    </label>

                    <label className="provider-capacity-wide">
                      Model storage path
                      <input
                        type="text"
                        value={providerCapacityDraft.modelStoragePath}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="/var/lib/multivibe/models"
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(event) => updateProviderCapacityDraft(
                          "modelStoragePath",
                          event.target.value,
                        )}
                      />
                      <small>Choose an absolute folder other than the filesystem root.</small>
                    </label>

                    <label>
                      Maximum model storage (GiB)
                      <input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        value={providerCapacityDraft.maxDiskGiB}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="30"
                        onChange={(event) => updateProviderCapacityDraft(
                          "maxDiskGiB",
                          event.target.value,
                        )}
                      />
                      <small>Must be greater than 0 GiB.</small>
                    </label>

                    <label>
                      Free disk reserve (GiB)
                      <input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        value={providerCapacityDraft.reserveFreeDiskGiB}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="5"
                        onChange={(event) => updateProviderCapacityDraft(
                          "reserveFreeDiskGiB",
                          event.target.value,
                        )}
                      />
                      <small>Disk space the agent must leave untouched.</small>
                    </label>

                    <label>
                      Daily download cap (GiB)
                      <input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        value={providerCapacityDraft.maxDownloadGiBPerDay}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="20"
                        onChange={(event) => updateProviderCapacityDraft(
                          "maxDownloadGiBPerDay",
                          event.target.value,
                        )}
                      />
                      <small>0 explicitly disables model downloads.</small>
                    </label>

                    <label>
                      Minimum model residency (seconds)
                      <input
                        type="number"
                        min="1"
                        step="1"
                        inputMode="numeric"
                        value={providerCapacityDraft.minimumModelResidencySeconds}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="21600"
                        onChange={(event) => updateProviderCapacityDraft(
                          "minimumModelResidencySeconds",
                          event.target.value,
                        )}
                      />
                      <small>For example, 21600 is 6 hours.</small>
                    </label>

                    <label>
                      Maximum model changes per day
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        value={providerCapacityDraft.maxModelChangesPerDay}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="4"
                        onChange={(event) => updateProviderCapacityDraft(
                          "maxModelChangesPerDay",
                          event.target.value,
                        )}
                      />
                      <small>0 freezes the managed model set.</small>
                    </label>

                    <label className="provider-capacity-toggle provider-capacity-wide">
                      <input
                        type="checkbox"
                        checked={providerCapacityDraft.automaticDownloads}
                        disabled={providerCapacityStatus === "saving"}
                        onChange={(event) => updateProviderCapacityDraft(
                          "automaticDownloads",
                          event.target.checked,
                        )}
                      />
                      <span>
                        <strong>Allow automatic model downloads</strong>
                        <small>
                          This permission remains bounded by the storage,
                          reserve, daily download and model-change limits.
                        </small>
                      </span>
                    </label>
                  </div>

                  <label className="provider-capacity-consent">
                    <input
                      type="checkbox"
                      checked={providerCapacityDraft.allowCloudWorkloads}
                      disabled={providerCapacityStatus === "saving"}
                      onChange={(event) => updateProviderCapacityDraft(
                        "allowCloudWorkloads",
                        event.target.checked,
                      )}
                    />
                    <span>
                      <strong>Allow MultiVibe Cloud workloads</strong>
                      <small>
                        Separate explicit consent, off by default. Saving it only
                        records local permission; it does not enroll this host,
                        open a route, deliver traffic or activate payments.
                      </small>
                    </span>
                  </label>

                  {!providerCapacityInput && (
                    <p className="provider-capacity-validation">
                      Complete both percentages, all numeric limits and an
                      absolute storage path. GiB values are converted to whole
                      bytes when saved.
                    </p>
                  )}

                  {providerCapacityMessage && (
                    <p className="provider-selection-message" role="status">
                      {providerCapacityMessage}
                    </p>
                  )}

                  <div className="provider-selection-actions">
                    <span className="muted">
                      {!providerCapacityPolicy
                        ? "No local policy saved · next write expects revision 0"
                        : providerCapacityChanged
                          ? "Unsaved local capacity changes"
                          : "Local capacity policy is up to date"}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      disabled={
                        !providerCapacityInput ||
                        !providerCapacityChanged ||
                        providerCapacityStatus === "saving"
                      }
                      onClick={() => void saveProviderCapacityPolicy()}
                    >
                      {providerCapacityStatus === "saving"
                        ? "Saving locally…"
                        : providerCapacityPolicy
                          ? "Save local capacity policy"
                          : "Create local capacity policy"}
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="provider-selection-panel" aria-labelledby="provider-runtime-endpoints-title">
              <div className="provider-selection-heading">
                <div>
                  <span className="eyebrow">Manual loopback runtimes</span>
                  <h3 id="provider-runtime-endpoints-title">Connect a supported local server</h3>
                  <p>
                    Only literal <span className="mono">127.0.0.1</span> or <span className="mono">::1</span> HTTP endpoints with an explicit port are accepted.
                    Bearers are stored only in Core&apos;s protected local file and are never returned by the API.
                  </p>
                </div>
                {providerRuntimeEndpoints && (
                  <span className="badge">
                    {providerRuntimeDrafts.length} configured · revision {providerRuntimeEndpoints.revision}
                  </span>
                )}
              </div>

              {(providerPreviewStatus === "ready" || providerPreviewStatus === "saving") && providerAdapterRegistry && (
                <>
                  <div className="provider-runtime-editor-list">
                    {providerRuntimeDrafts.map((draft, index) => {
                      const adapter = manuallyConfigurableProviderAdapters.find(
                        (candidate) => candidate.id === draft.adapterId,
                      );
                      return (
                        <fieldset className="provider-runtime-editor" key={draft.adapterId}>
                          <legend>{adapter?.display_name ?? draft.adapterId}</legend>
                          <label>
                            Loopback endpoint
                            <input
                              type="url"
                              value={draft.endpoint}
                              disabled={providerRuntimeSaving}
                              placeholder="http://127.0.0.1:8000"
                              spellCheck={false}
                              onChange={(event) => setProviderRuntimeDrafts((current) => current.map(
                                (entry, entryIndex) => entryIndex === index
                                  ? { ...entry, endpoint: event.target.value }
                                  : entry,
                              ))}
                            />
                          </label>
                          {adapter?.authentication !== "none" && (
                            <label>
                              Optional local bearer
                              <input
                                type="password"
                                value={draft.bearerToken}
                                disabled={providerRuntimeSaving || draft.clearBearer}
                                placeholder={draft.existingAuthentication === "bearer"
                                  ? "Stored locally — leave blank to keep"
                                  : "Leave blank when authentication is disabled"}
                                autoComplete="new-password"
                                onChange={(event) => setProviderRuntimeDrafts((current) => current.map(
                                  (entry, entryIndex) => entryIndex === index
                                    ? { ...entry, bearerToken: event.target.value, clearBearer: false }
                                    : entry,
                                ))}
                              />
                            </label>
                          )}
                          <div className="provider-runtime-editor-actions">
                            {draft.existingAuthentication === "bearer" && adapter?.authentication !== "none" && (
                              <label className="provider-model-choice">
                                <input
                                  type="checkbox"
                                  checked={draft.clearBearer}
                                  disabled={providerRuntimeSaving}
                                  onChange={(event) => setProviderRuntimeDrafts((current) => current.map(
                                    (entry, entryIndex) => entryIndex === index
                                      ? { ...entry, clearBearer: event.target.checked, bearerToken: "" }
                                      : entry,
                                  ))}
                                />
                                <span>Remove stored bearer</span>
                              </label>
                            )}
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={providerRuntimeSaving}
                              onClick={() => setProviderRuntimeDrafts((current) => current.filter(
                                (_, entryIndex) => entryIndex !== index,
                              ))}
                            >
                              Remove endpoint
                            </button>
                          </div>
                        </fieldset>
                      );
                    })}
                  </div>

                  <div className="provider-runtime-add-row">
                    <label className="compact-field">
                      Runtime adapter
                      <select
                        value={providerRuntimeAdapterToAdd}
                        disabled={providerRuntimeSaving || !availableProviderRuntimeAdapters.length}
                        onChange={(event) => setProviderRuntimeAdapterToAdd(event.target.value)}
                      >
                        <option value="">
                          {availableProviderRuntimeAdapters.length ? "Choose a manual adapter" : "All manual adapters are configured"}
                        </option>
                        {availableProviderRuntimeAdapters.map((adapter) => (
                          <option key={adapter.id} value={adapter.id}>{adapter.display_name}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={!providerRuntimeAdapterToAdd || providerRuntimeSaving}
                      onClick={() => {
                        const adapterId = providerRuntimeAdapterToAdd;
                        if (!adapterId) return;
                        setProviderRuntimeDrafts((current) => [...current, {
                          adapterId,
                          endpoint: "http://127.0.0.1:8000",
                          bearerToken: "",
                          existingAuthentication: "none",
                          clearBearer: false,
                        }]);
                        setProviderRuntimeAdapterToAdd("");
                        setProviderRuntimeMessage("");
                      }}
                    >
                      Add local endpoint
                    </button>
                  </div>

                  {providerRuntimeMessage && (
                    <p className="provider-selection-message" role="status">{providerRuntimeMessage}</p>
                  )}
                  <div className="provider-selection-actions">
                    <span className="muted">
                      Saving changes only the protected local runtime file and reruns bounded loopback detection.
                    </span>
                    <button
                      type="button"
                      className="btn"
                      disabled={!providerRuntimeChanged || providerRuntimeSaving}
                      onClick={() => void saveProviderRuntimeEndpoints()}
                    >
                      {providerRuntimeSaving ? "Saving locally…" : "Save endpoints locally"}
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="provider-selection-panel" aria-labelledby="provider-selection-title">
              <div className="provider-selection-heading">
                <div>
                  <span className="eyebrow">Local consent manifest</span>
                  <h3 id="provider-selection-title">Choose models you may want to share</h3>
                  <p>
                    Detection and selection stay on this machine. Saving only
                    updates Core&apos;s protected local selection file; it does not
                    submit, approve, publish or activate any model.
                  </p>
                </div>
                {providerSelection && (
                  <span className={providerSelectionDraft.length ? "badge badge-live" : "badge"}>
                    {providerSelectionDraft.length} selected · revision {providerSelection.revision}
                  </span>
                )}
              </div>

              {providerPreviewStatus === "loading" && (
                <div className="provider-selection-empty" role="status">
                  Checking reviewed local runtime endpoints…
                </div>
              )}

              {(providerPreviewStatus === "unavailable" || providerPreviewStatus === "error") && (
                <div className="provider-selection-empty provider-selection-error" role="status">
                  <strong>{providerPreviewMessage}</strong>
                  {providerPreviewStatus === "unavailable" && (
                    <span>Enable the packaged embedded agent to use local detection and selection.</span>
                  )}
                </div>
              )}

              {(providerPreviewStatus === "ready" || providerPreviewStatus === "saving") && providerDetectedModels && (
                <div className="provider-runtime-list">
                  {providerDetectedModels.runtimes.map((runtime) => (
                    <fieldset className="provider-runtime-group" key={runtime.adapter_id}>
                      <legend>{runtime.adapter_id}</legend>
                      {runtime.models.map((model) => (
                        <label className="provider-model-choice" key={`${runtime.adapter_id}:${model}`}>
                          <input
                            type="checkbox"
                            checked={providerSelectionDraft.includes(model)}
                            disabled={providerPreviewStatus === "saving"}
                            onChange={() => toggleProviderSelection(model)}
                          />
                          <span className="mono">{model}</span>
                        </label>
                      ))}
                    </fieldset>
                  ))}

                  {selectedButNotDetected.length > 0 && (
                    <fieldset className="provider-runtime-group provider-runtime-offline">
                      <legend>Selected but not currently detected</legend>
                      {selectedButNotDetected.map((model) => (
                        <label className="provider-model-choice" key={`offline:${model}`}>
                          <input
                            type="checkbox"
                            checked
                            disabled={providerPreviewStatus === "saving"}
                            onChange={() => toggleProviderSelection(model)}
                          />
                          <span className="mono">{model}</span>
                        </label>
                      ))}
                    </fieldset>
                  )}

                  {!providerDetectedModels.runtimes.length && !selectedButNotDetected.length && (
                    <div className="provider-selection-empty">
                      No model was returned by the reviewed loopback candidates.
                      Start a supported local runtime, then reopen this preview.
                    </div>
                  )}
                </div>
              )}

              {providerPreviewMessage && providerPreviewStatus === "ready" && (
                <p className="provider-selection-message" role="status">{providerPreviewMessage}</p>
              )}

              {(providerPreviewStatus === "ready" || providerPreviewStatus === "saving") && (
                <div className="provider-selection-actions">
                  <span className="muted">
                    {providerSelectionChanged
                      ? "Unsaved local changes"
                      : "Local selection is up to date"}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    disabled={!providerSelectionChanged || providerPreviewStatus === "saving"}
                    onClick={() => void saveProviderSelection()}
                  >
                    {providerPreviewStatus === "saving" ? "Saving locally…" : "Save local selection"}
                  </button>
                </div>
              )}
            </section>

            <div className="make-money-preview-grid">
              <section className="make-money-preview-card" aria-labelledby="make-money-route-title">
                <h3 id="make-money-route-title">A compartmentalized route</h3>
                <p>
                  No customer or other provider connects directly to your
                  machine. In the planned design, only MultiVibe&apos;s authenticated
                  relay can reach a dedicated agent, and each bounded request is
                  forwarded only to an allowlisted local inference endpoint.
                </p>
              </section>

              <section className="make-money-preview-card" aria-labelledby="make-money-boundary-title">
                <h3 id="make-money-boundary-title">No general machine access</h3>
                <p>
                  The dedicated agent exposes no shell, filesystem, arbitrary URL
                  or general network access. This is a security target that must
                  pass independent review, negative authorization tests and
                  containment exercises before activation. A local runtime may
                  still have its own logging behavior, which must be disclosed.
                </p>
              </section>

              <section className="make-money-preview-card" aria-labelledby="make-money-control-title">
                <h3 id="make-money-control-title">You stay in control</h3>
                <p>
                  The local policy above records hard limits, a highest-priority
                  manual pause and a separate Cloud workload opt-in. It is also
                  separate from anonymous model-demand sharing in Tracing.
                  Saving these choices does not enroll the host or activate
                  customer traffic; recurring availability windows and
                  idle-aware sharing remain planned controls.
                </p>
              </section>

              <section className="make-money-preview-card" aria-labelledby="make-money-earnings-title">
                <h3 id="make-money-earnings-title">Verified earnings, not promises</h3>
                <p>
                  If every marketplace gate passes, eligible cleared earnings are
                  planned with 85% for the host operator and a 15% MultiVibe
                  service fee, before applicable taxes, reserves, disputes and
                  reversals. The separate 5% fee applies only to customer
                  purchases or top-ups, not to the host operator&apos;s 85% share.
                  Cleared balances are planned for monthly Stripe Connect payouts
                  in real money, or an optional conversion to eligible Cloud
                  credits. Earnings are never guaranteed: accepted work or
                  estimated usage is not payable.
                </p>
              </section>
            </div>

            <p className="make-money-preview-fineprint">
              Identity, capacity rights, tax, verified usage, ledger, dispute and
              authoritative settlement checks must all pass before compensation.
              This preview creates no Cloud request, provider enrollment, route,
              workload, payable, payout or Cloud credit, and it does not change
              this account.
            </p>

            <div className="modal-actions make-money-preview-actions">
              <span className="muted">
                Local preview only · no Cloud connection or collection
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => setMakeMoneyPreviewAccount(null)}
              >
                Got it
              </button>
            </div>
          </div>
          </div>,
          document.body,
        )}

      {showAddAccount && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className={`modal panel${onboardingProviderSetup ? " onboarding-provider-modal" : ""}`} onClick={(e) => e.stopPropagation()}>
            <div className="inline wrap row-between">
              <h2>Add account</h2>
              <div className="inline wrap">
                {onboardingProviderSetup && (
                  <button className="btn ghost" onClick={() => {
                    closeModal();
                    onSkipOnboarding?.();
                  }}>
                    Skip setup
                  </button>
                )}
                <button className="btn ghost" onClick={closeModal}>
                  {onboardingProviderSetup ? "Back" : "Close"}
                </button>
              </div>
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
              {!onboardingProviderSetup && <label>
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
              </label>}
              {!onboardingProviderSetup && isManualTokenProvider(provider) && (
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
                  {!onboardingProviderSetup && <label>
                    Refresh token (optional)
                    <input
                      value={manualRefreshToken}
                      onChange={(e) => setManualRefreshToken(e.target.value)}
                      placeholder="Optional"
                    />
                  </label>}
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
              {!onboardingProviderSetup && <label>
                Priority
                <input
                  value={manualPriority}
                  onChange={(e) => setManualPriority(e.target.value)}
                  placeholder="0"
                />
              </label>}
              {!onboardingProviderSetup && <label className="inline">
                <input
                  type="checkbox"
                  checked={manualEnabled}
                  onChange={(e) => setManualEnabled(e.target.checked)}
                />
                Enabled
              </label>}
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
              <div className="inline wrap">
                {onboardingProviderSetup && (
                  <button className="btn ghost" onClick={() => {
                    closeOauthDialog();
                    closeModal();
                    onSkipOnboarding?.();
                  }}>
                    Skip setup
                  </button>
                )}
                <button className="btn ghost" onClick={closeOauthDialog}>
                  Close
                </button>
              </div>
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
