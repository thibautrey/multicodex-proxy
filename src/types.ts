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
  blockedUntil?: number;
  blockedReason?: string;
  lastError?: string;
  lastSelectedAt?: number;
  recentErrors?: AccountError[];
  needsTokenRefresh?: boolean;
  lastUsageRefreshAt?: number;
};

export type Account = {
  id: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  chatgptAccountId?: string;
  enabled: boolean;
  priority?: number;
  usage?: UsageSnapshot;
  state?: AccountState;
};

export type StoreFile = {
  accounts: Account[];
};

export type OAuthFlowState = {
  id: string;
  email: string;
  codeVerifier: string;
  createdAt: number;
  status: "pending" | "success" | "error";
  error?: string;
  completedAt?: number;
  accountId?: string;
};

export type OAuthStateFile = {
  states: OAuthFlowState[];
};
