export type Account = {
  id: string;
  provider?: "openai" | "openai-compatible" | "opencode" | "mistral" | "zai" | "xai";
  upstreamMode?: "responses" | "chat/completions";
  compatibilityMode?: "auto" | "responses" | "chat-completions-bridge";
  email?: string;
  enabled: boolean;
  accessToken?: string;
  refreshToken?: string;
  chatgptAccountId?: string;
  opencodeAccountId?: string;
  opencodeOrgId?: string;
  opencodeOrgName?: string;
  opencodeConsoleUrl?: string;
  xaiUserId?: string;
  xaiAuthScope?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  baseUrl?: string;
  priority?: number;
  location?: "local" | "cloud";
  capacityProfile?: {
    maxConcurrent?: number;
    prefillTokensPerSecond?: number;
    decodeTokensPerSecond?: number;
    contextWindow?: number;
    healthUrl?: string;
    metricsUrl?: string;
  };
  usage?: any;
  state?: {
    modelBlocks?: Record<string, { until: number; reason: string }>;
    lastError?: string;
    lastSelectedAt?: number;
    recentErrors?: Array<{ at: number; message: string }>;
    recentEmptyResponses?: Array<{ at: number; message: string }>;
    needsTokenRefresh?: boolean;
    authBlockedUntil?: number;
    lastUsageRefreshAt?: number;
    scheduledWeeklyReset?: {
      scheduledAt: number;
      idempotencyKey: string;
      thresholdRemainingPercent: number;
      lastAttemptAt?: number;
      lastError?: string;
    };
  };
};

export type Trace = {
  id: string;
  at: number;
  route: string;
  clientRequestId?: string;
  traceKind?: "client-request" | "upstream-attempt" | "diagnostic";
  upstreamAttempt?: number;
  providerAttempts?: number;
  recoveredRetry?: boolean;
  application?: string;
  projectId?: string;
  projectName?: string;
  projectRemote?: string;
  projectRoot?: string;
  projectHost?: string;
  accountId?: string;
  accountEmail?: string;
  provider?: "openai" | "openai-compatible" | "opencode" | "mistral" | "zai" | "xai";
  accountSelection?: {
    reason: "sticky" | "policy-preferred" | "quota-headroom";
    provider: "openai" | "openai-compatible" | "opencode" | "mistral" | "zai" | "xai";
    candidateCount: number;
    eligibleCount: number;
    nearLimitCount: number;
    rotated: boolean;
    selectedHeadroomPercent?: number;
    selectedWeeklyRemainingPercent?: number;
    selectedFiveHourRemainingPercent?: number;
  };
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  status: number;
  isError: boolean;
  stream: boolean;
  latencyMs: number;
  ttftMs?: number;
  lifecycleState?: "started" | "completed" | "interrupted";
  startedAt?: number;
  completedAt?: number;
  tokensInput?: number;
  tokensInputCached?: number;
  tokensInputCacheWrite?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  costUsd?: number;
  pricingVersion?: string;
  usageStatus?: "measured" | "missing";
  costStatus?: "estimated" | "unpriced" | "unknown";
  usage?: any;
  error?: string;
  requestBody?: any;
  requestHeaders?: Record<string, string>;
  hasRequestBody?: boolean;
  hasRequestHeaders?: boolean;
};

export type TraceStats = {
  totals: {
    requests: number;
    upstreamAttempts: number;
    retriedRequests: number;
    recoveredRequests: number;
    requestsWithUsage: number;
    requestsWithCost: number;
    unpricedRequests: number;
    errors: number;
    errorRate: number;
    tokensInput: number;
    tokensInputCached: number;
    tokensOutput: number;
    tokensTotal: number;
    inferenceTokensPerSecond: number;
    inferenceRequests: number;
    costUsd: number;
    costUsdWithoutCache: number;
    latencyAvgMs: number;
  };
  models: Array<{
    model: string;
    count: number;
    okCount: number;
    tokensInput: number;
    tokensInputCached: number;
    tokensOutput: number;
    tokensTotal: number;
    costUsd: number;
  }>;
  timeseries: Array<{
    at: number;
    requests: number;
    upstreamAttempts: number;
    retriedRequests: number;
    recoveredRequests: number;
    errors: number;
    tokensInput: number;
    tokensInputCached: number;
    tokensOutput: number;
    tokensTotal: number;
    inferenceTokensPerSecond: number;
    inferenceRequests: number;
    costUsd: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
  }>;
  ttftByProviderModel: Array<{
    provider: "openai" | "openai-compatible" | "opencode" | "mistral" | "zai" | "xai";
    model: string;
    inputTokenBucket:
      | "lt1k"
      | "1k-8k"
      | "8k-32k"
      | "32k-64k"
      | "64k-128k"
      | "128k-plus"
      | "unknown";
    samples: number;
    ttftP50Ms: number;
    ttftP95Ms: number;
    medianInputTokens?: number;
    cachedInputRatio?: number;
    confidence: "low" | "sufficient";
    rank?: number;
  }>;
  accountSelection: {
    attempts: number;
    rotations: number;
    maxNearLimit: number;
    averageHeadroom?: number;
    reasonCounts: {
      sticky: number;
      "policy-preferred": number;
      "quota-headroom": number;
    };
  };
};

export type TracePagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
};

export type ProjectUsageStats = {
  byProject: Array<{
    projectId: string;
    projectName?: string;
    projectRemote?: string;
    requests: number;
    ok: number;
    errors: number;
    stream: number;
    successRate: number;
    streamingRate: number;
    requestsWithUsage: number;
    requestsWithCost: number;
    unpricedRequests: number;
    costUsd: number;
    avgLatencyMs: number;
    latencyMsTotal: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
    tokens: {
      prompt: number;
      completion: number;
      input: number;
      cachedInput: number;
      output: number;
      total: number;
    };
    models: Array<{
      model: string;
      requests: number;
      ok: number;
      errors: number;
      stream: number;
      successRate: number;
      streamingRate: number;
      requestsWithUsage: number;
      requestsWithCost: number;
      unpricedRequests: number;
      costUsd: number;
      avgLatencyMs: number;
      latencyMsTotal: number;
      latencyP50Ms: number;
      latencyP95Ms: number;
      tokens: {
        prompt: number;
        completion: number;
        input: number;
        cachedInput: number;
        output: number;
        total: number;
      };
    }>;
    firstAt?: number;
    lastAt?: number;
  }>;
};

export type TraceRangePreset = "24h" | "7d" | "30d" | "all";

export type Tab =
  | "overview"
  | "accounts"
  | "aliases"
  | "api-keys"
  | "plugins"
  | "updates"
  | "tracing"
  | "docs";

export type HostUpdateStatus = {
  schema_version: "multivibe-host-updater-state-v1";
  mode: "automatic" | "download" | "notify";
  channel: "stable" | "beta";
  current_version: string;
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "current" | "deferred" | "failed";
  last_checked_at: string | null;
  next_check_at: string | null;
  available_version: string | null;
  available_critical: boolean;
  rollout_eligible: boolean;
  downloaded: boolean;
  download_requested: boolean;
  install_requested: boolean;
  last_installed_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
  container_managed: boolean;
};

export type ExposedModel = {
  id: string;
  owned_by?: string;
  metadata?: {
    provider?: "openai" | "openai-compatible" | "opencode" | "mistral" | "zai" | "xai";
    provider_candidates?: Array<
      "openai" | "openai-compatible" | "opencode" | "mistral" | "zai" | "xai"
    >;
    is_alias?: boolean;
    alias_targets?: string[];
  };
};

export type ModelAlias = {
  schemaVersion: 2;
  id: string;
  rules: RoutingRule[];
  enabled: boolean;
  description?: string;
  defaults?: {
    priority?: PriorityClass;
    executionMode?: "sync" | "auto" | "defer";
  };
};

export type PriorityClass = "critical" | "interactive" | "standard" | "batch";

export type RoutingCandidate = {
  model: string;
  provider?: "openai" | "openai-compatible" | "opencode" | "mistral" | "zai" | "xai";
  accountIds?: string[];
  location?: "local" | "cloud";
  quality?: number;
  inputCostPerMillionUsd?: number;
  outputCostPerMillionUsd?: number;
  capacityProfile?: {
    maxConcurrent?: number;
    prefillTokensPerSecond?: number;
    decodeTokensPerSecond?: number;
    contextWindow?: number;
    healthUrl?: string;
    metricsUrl?: string;
  };
};

export type RoutingRule = {
  id: string;
  enabled?: boolean;
  match?: {
    applications?: string[];
    priorities?: PriorityClass[];
    efforts?: string[];
    modalities?: Array<"text" | "image" | "audio" | "video">;
    requiresTools?: boolean;
    executionModes?: Array<"sync" | "auto" | "defer">;
    minInputTokens?: number;
    maxInputTokens?: number;
    timeWindows?: Array<{ days?: number[]; start: string; end: string; timezone?: string }>;
  };
  constraints?: {
    allowedLocations?: Array<"local" | "cloud">;
    maxPredictedWaitMs?: number;
    minContextWindow?: number;
    minQuality?: number;
  };
  objectives?: { latency: number; cost: number; quality: number; locality: number };
  candidates: RoutingCandidate[];
  onNoCapacity?: "next-rule" | "queue" | "reject";
  cloudBudget?: { amountUsd: number; period: "hour" | "day" | "month" };
};

export type StoreSettings = {
  defaultPassthroughAccountId?: string;
  imageRequestModelOverride?: string;
  anonymousUsageSharingEnabled?: boolean;
  anonymousUsageSharingEnabledAt?: string;
};

export type ModuleView = {
  id: string;
  origin: string;
  commit: string;
  enabled: boolean;
  source: "external" | "bundled";
  restartRequired?: boolean;
  loaded: boolean;
  healthy: boolean;
  error?: string;
  removable: boolean;
  settings: Record<string, unknown>;
  manifest?: {
    name: string;
    version: string;
    description: string;
    hooks: string[];
    categories?: string[];
    tags?: string[];
    author?: string;
    homepage?: string;
    settingsSchema?: Record<string, unknown>;
  };
};

export type MarketplaceModule = {
  id: string;
  origin: string;
  commit: string;
  submittedAt: string;
  manifest: NonNullable<ModuleView["manifest"]>;
};

export type ProxyApiKey = {
  id: string;
  application: string;
  keyPreview: string;
  createdAt?: number;
  source: "dashboard" | "environment";
};

export type CreatedProxyApiKey = ProxyApiKey & {
  key: string;
};

export type HostHarness = {
  id: string;
  name: string;
  category: "cli" | "editor" | "agent" | "framework" | "service";
  detected: boolean;
  detectedBy: string[];
  configured: boolean;
  managed: boolean;
  drifted: boolean;
  canInstall: boolean;
  repairable: boolean;
  canUninstall: boolean;
  configPath?: string;
  unavailableReason?: string;
  configurationIssue?: string;
  effectiveProvider?: string;
  effectiveBaseUrl?: string;
};

export type ApplicationWebhook = {
  id: string;
  url: string;
  enabled: boolean;
  createdAt: number;
  secret?: string;
};

export type ApplicationPolicy = {
  application: string;
  fairnessWeight: number;
  webhooks: ApplicationWebhook[];
};
