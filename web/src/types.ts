export type Account = {
  id: string;
  provider?: "openai" | "openai-compatible" | "mistral" | "zai";
  upstreamMode?: "responses" | "chat/completions";
  compatibilityMode?: "auto" | "responses" | "chat-completions-bridge";
  email?: string;
  enabled: boolean;
  accessToken?: string;
  refreshToken?: string;
  chatgptAccountId?: string;
  baseUrl?: string;
  priority?: number;
  usage?: any;
  state?: any;
};

export type Trace = {
  id: string;
  at: number;
  route: string;
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
    provider?: "openai" | "openai-compatible" | "mistral" | "zai";
    provider_candidates?: Array<"openai" | "openai-compatible" | "mistral" | "zai">;
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
