export type ProviderId = "openai" | "openai-compatible" | "mistral" | "zai";
export type UpstreamMode = "responses" | "chat/completions";
export type CompatibilityMode =
  | "auto"
  | "responses"
  | "chat-completions-bridge";

export type UsageWindow = {
  usedPercent?: number;
  resetAt?: number; // epoch ms
};

export type UsageSnapshot = {
  primary?: UsageWindow; // ~5h window
  secondary?: UsageWindow; // weekly window
  fetchedAt: number;
};

export type AccountError = {
  at: number;
  message: string;
};

export type AccountState = {
  modelBlocks?: Record<string, { until: number; reason: string }>;
  lastError?: string;
  lastSelectedAt?: number;
  recentErrors?: AccountError[];
  recentEmptyResponses?: AccountError[];
  needsTokenRefresh?: boolean;
  lastUsageRefreshAt?: number;
};

export type Account = {
  id: string;
  provider?: ProviderId;
  upstreamMode?: UpstreamMode;
  compatibilityMode?: CompatibilityMode;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  chatgptAccountId?: string;
  baseUrl?: string;
  enabled: boolean;
  priority?: number;
  usage?: UsageSnapshot;
  state?: AccountState;
};

export type ModelAlias = {
  id: string;
  targets: string[];
  enabled: boolean;
  description?: string;
};

export type StoreSettings = {
  defaultPassthroughAccountId?: string;
  imageRequestModelOverride?: string;
};

export type StoreFile = {
  accounts: Account[];
  modelAliases?: ModelAlias[];
  settings?: StoreSettings;
};

export type OAuthFlowState = {
  id: string;
  email: string;
  codeVerifier: string;
  createdAt: number;
  method?: "browser" | "device";
  targetAccountId?: string;
  status: "pending" | "success" | "error";
  error?: string;
  completedAt?: number;
  accountId?: string;
  deviceAuthId?: string;
  userCode?: string;
  verificationUrl?: string;
  intervalSeconds?: number;
  expiresAt?: number;
};

export type OAuthStateFile = {
  states: OAuthFlowState[];
};
