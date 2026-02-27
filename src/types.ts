export type UsageWindow = {
  usedPercent?: number;
  resetAt?: number; // epoch ms
};

export type UsageSnapshot = {
  primary?: UsageWindow; // ~5h window
  secondary?: UsageWindow; // weekly window
  fetchedAt: number;
};

export type AccountState = {
  blockedUntil?: number;
  blockedReason?: string;
  lastError?: string;
  lastSelectedAt?: number;
};

export type Account = {
  id: string;
  email?: string;
  accessToken: string;
  chatgptAccountId?: string;
  enabled: boolean;
  priority?: number;
  usage?: UsageSnapshot;
  state?: AccountState;
};

export type StoreFile = {
  accounts: Account[];
};
