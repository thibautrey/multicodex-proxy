export type Account = {
  id: string;
  provider?: "openai" | "mistral";
  email?: string;
  enabled: boolean;
  accessToken?: string;
  refreshToken?: string;
  chatgptAccountId?: string;
  priority?: number;
  usage?: any;
  state?: any;
};

export type Trace = {
  id: string;
  at: number;
  route: string;
  sessionId?: string;
  accountId?: string;
  accountEmail?: string;
  model?: string;
  status: number;
  isError: boolean;
  stream: boolean;
  latencyMs: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  costUsd?: number;
  usage?: any;
  error?: string;
  requestBody?: any;
  hasRequestBody?: boolean;
};

export type UsageSummary = {
  requests: number;
  ok: number;
  errors: number;
  successRate: number;
  stream: number;
  streamingRate: number;
  latencyMsTotal: number;
  avgLatencyMs: number;
  requestsWithUsage: number;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  costUsd: number;
  statusCounts: Record<string, number>;
  firstAt?: number;
  lastAt?: number;
};

export type TraceUsageStats = {
  filters: {
    accountId?: string;
    route?: string;
    sinceMs?: number;
    untilMs?: number;
  };
  totals: UsageSummary;
  byAccount: Array<
    UsageSummary & {
      accountId: string;
      account: {
        id: string;
        provider?: "openai" | "mistral";
        email?: string;
        enabled?: boolean;
      };
    }
  >;
  byRoute: Array<UsageSummary & { route: string }>;
  bySession: Array<UsageSummary & { sessionId: string }>;
  tracesEvaluated: number;
  tracesMatched: number;
};

export type TraceStats = {
  totals: {
    requests: number;
    errors: number;
    errorRate: number;
    tokensInput: number;
    tokensOutput: number;
    tokensTotal: number;
    costUsd: number;
    latencyAvgMs: number;
  };
  models: Array<{
    model: string;
    count: number;
    okCount: number;
    tokensInput: number;
    tokensOutput: number;
    tokensTotal: number;
    costUsd: number;
  }>;
  timeseries: Array<{
    at: number;
    requests: number;
    errors: number;
    tokensInput: number;
    tokensOutput: number;
    tokensTotal: number;
    costUsd: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
  }>;
};

export type TracePagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
};

export type TraceRangePreset = "24h" | "7d" | "30d" | "all";

export type Tab =
  | "overview"
  | "accounts"
  | "aliases"
  | "tracing"
  | "playground"
  | "docs";

export type ExposedModel = {
  id: string;
  owned_by?: string;
  metadata?: {
    provider?: "openai" | "mistral";
    is_alias?: boolean;
    alias_targets?: string[];
  };
};

export type ModelAlias = {
  id: string;
  targets: string[];
  enabled: boolean;
  description?: string;
};
