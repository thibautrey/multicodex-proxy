import type {
  Account,
  LocalRuntimeAdapterId,
  LocalRuntimeMetadata,
} from "./types.js";
import type { AccountStore } from "./store.js";

export const LOCAL_RUNTIME_DISCOVERY_TIMEOUT_MS = 1_500;
export const LOCAL_RUNTIME_MAX_RESPONSE_BYTES = 256 * 1024;
export const LM_STUDIO_ALLOWED_PORTS = [1234] as const;
export const OMLX_ALLOWED_PORTS = [8000] as const;

const LM_STUDIO_ORIGINS = [
  "http://127.0.0.1:1234",
  "http://[::1]:1234",
] as const;
const OMLX_ORIGINS = [
  "http://127.0.0.1:8000",
  "http://[::1]:8000",
] as const;
const LOCAL_RUNTIME_REQUEST_PATHS = new Set([
  "/v1/models",
  "/v1/responses",
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
]);

type AutomaticLocalRuntimeAdapterId = "lm-studio" | "omlx";

const AUTOMATIC_LOCAL_RUNTIME_BOUNDARIES = {
  "lm-studio": {
    name: "LM Studio",
    origins: LM_STUDIO_ORIGINS,
    ports: LM_STUDIO_ALLOWED_PORTS,
  },
  omlx: {
    name: "OMLX",
    origins: OMLX_ORIGINS,
    ports: OMLX_ALLOWED_PORTS,
  },
} as const;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type LocalRuntimeCandidate = {
  endpoint: string;
  modelsUrl: string;
};

export type LocalRuntimeAdapter = {
  id: LocalRuntimeAdapterId;
  displayName: string;
  protocol: "openai-compatible" | "native";
  healthPath: string;
  catalogPath: string;
  capabilities: readonly ("text" | "embeddings" | "image" | "audio" | "tools")[];
  authentication: "none" | "optional-bearer" | "required-bearer";
  measurement: readonly ("input_text_token" | "output_text_token" | "request" | "runtime_metrics")[];
  limits: { maxCatalogModels: number; maxResponseBytes: number; timeoutMs: number };
  candidates: readonly LocalRuntimeCandidate[];
};

const DEFAULT_ADAPTER_CONTRACT = {
  protocol: "openai-compatible" as const,
  healthPath: "/v1/models",
  catalogPath: "/v1/models",
  capabilities: ["text", "embeddings", "tools"] as const,
  authentication: "optional-bearer" as const,
  measurement: ["input_text_token", "output_text_token", "request"] as const,
  limits: {
    maxCatalogModels: 10_000,
    maxResponseBytes: LOCAL_RUNTIME_MAX_RESPONSE_BYTES,
    timeoutMs: LOCAL_RUNTIME_DISCOVERY_TIMEOUT_MS,
  },
};

function registeredAdapter(id: LocalRuntimeAdapterId, displayName: string): LocalRuntimeAdapter {
  return { id, displayName, ...DEFAULT_ADAPTER_CONTRACT, candidates: [] };
}
export const LOCAL_RUNTIME_ADAPTERS: readonly LocalRuntimeAdapter[] = [
  {
    id: "lm-studio",
    displayName: "LM Studio",
    ...DEFAULT_ADAPTER_CONTRACT,
    authentication: "none",
    candidates: [
      {
        endpoint: "http://127.0.0.1:1234",
        modelsUrl: "http://127.0.0.1:1234/v1/models",
      },
      {
        endpoint: "http://[::1]:1234",
        modelsUrl: "http://[::1]:1234/v1/models",
      },
    ],
  },
  registeredAdapter("ollama", "Ollama"),
  registeredAdapter("llama-cpp", "llama.cpp / llama-server / llama-cpp-python"),
  registeredAdapter("vllm", "vLLM"),
  registeredAdapter("sglang", "SGLang"),
  registeredAdapter("localai", "LocalAI"),
  registeredAdapter("huggingface-tgi", "Hugging Face TGI"),
  registeredAdapter("transformers-serve", "Transformers Serve"),
  registeredAdapter("xinference", "Xinference"),
  registeredAdapter("mlx-lm", "MLX-LM"),
  {
    id: "omlx",
    displayName: "OMLX",
    ...DEFAULT_ADAPTER_CONTRACT,
    authentication: "none",
    candidates: [
      {
        endpoint: "http://127.0.0.1:8000",
        modelsUrl: "http://127.0.0.1:8000/v1/models",
      },
      {
        endpoint: "http://[::1]:8000",
        modelsUrl: "http://[::1]:8000/v1/models",
      },
    ],
  },
  registeredAdapter("mlc-llm", "MLC LLM"),
  registeredAdapter("exo", "Exo"),
  registeredAdapter("jan", "Jan"),
  registeredAdapter("gpt4all", "GPT4All"),
  registeredAdapter("koboldcpp", "KoboldCpp"),
  registeredAdapter("text-generation-webui", "text-generation-webui"),
  registeredAdapter("aphrodite", "Aphrodite"),
  registeredAdapter("tabbyapi", "TabbyAPI"),
  registeredAdapter("llama-box", "llama-box"),
  registeredAdapter("mistral-rs", "mistral.rs"),
  registeredAdapter("nvidia-nim", "NVIDIA NIM"),
  registeredAdapter("tensorrt-llm", "TensorRT-LLM"),
  registeredAdapter("triton", "NVIDIA Triton"),
  registeredAdapter("openllm", "OpenLLM"),
  registeredAdapter("bentoml", "BentoML"),
  registeredAdapter("mtplx", "MTPLX"),
  registeredAdapter("manual-openai-compatible", "Manual OpenAI-compatible server"),
];

export type LocalRuntimeProbeSuccess = {
  status: "discovered";
  adapter: LocalRuntimeAdapterId;
  displayName: string;
  endpoint: string;
  confirmedModelIds: string[];
};

export type LocalRuntimeProbeUnavailable = {
  status: "unavailable" | "not-configured";
  adapter: LocalRuntimeAdapterId;
  displayName: string;
  attempts: number;
  error?: string;
};

export type LocalRuntimeProbeResult =
  | LocalRuntimeProbeSuccess
  | LocalRuntimeProbeUnavailable;

export type LocalRuntimeDiscoveryOptions = {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  adapters?: readonly LocalRuntimeAdapter[];
};

function automaticRuntimeBoundary(id: LocalRuntimeAdapterId) {
  return id === "lm-studio" || id === "omlx"
    ? AUTOMATIC_LOCAL_RUNTIME_BOUNDARIES[id]
    : undefined;
}

function hasExactAutomaticRuntimeOrigin(id: AutomaticLocalRuntimeAdapterId, raw: string): boolean {
  return AUTOMATIC_LOCAL_RUNTIME_BOUNDARIES[id].origins.some(
    (origin) => raw === origin || raw === `${origin}/`,
  );
}

function parseAutomaticRuntimeEndpoint(id: AutomaticLocalRuntimeAdapterId, raw: string): URL {
  const boundary = AUTOMATIC_LOCAL_RUNTIME_BOUNDARIES[id];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("local runtime endpoint must be a valid URL");
  }
  if (
    !hasExactAutomaticRuntimeOrigin(id, raw) ||
    url.protocol !== "http:" ||
    !(boundary.ports as readonly number[]).includes(Number(url.port)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      `${boundary.name} endpoint must be credential-free HTTP on 127.0.0.1 or ::1 port ${boundary.ports.join(" or ")}`,
    );
  }
  return url;
}

function parseAutomaticRuntimeRequestUrl(id: AutomaticLocalRuntimeAdapterId, raw: string): URL {
  const boundary = AUTOMATIC_LOCAL_RUNTIME_BOUNDARIES[id];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("local runtime request must use a valid URL");
  }
  const hasExactRequestUrl = boundary.origins.some((origin) =>
    LOCAL_RUNTIME_REQUEST_PATHS.has(raw.slice(origin.length)) &&
    raw === `${origin}${url.pathname}`,
  );
  if (
    !hasExactRequestUrl ||
    url.protocol !== "http:" ||
    !(boundary.ports as readonly number[]).includes(Number(url.port)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !LOCAL_RUNTIME_REQUEST_PATHS.has(url.pathname)
  ) {
    throw new Error(`request is outside the discovered ${boundary.name} API boundary`);
  }
  return url;
}

function validConfirmedModelIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 10_000 &&
    value.every(
      (id) =>
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 512 &&
        id.trim() === id &&
        !/[\u0000-\u001f\u007f]/.test(id),
    )
  );
}

export function isDiscoveredLocalRuntimeAccount(account: Account): boolean {
  if (
    account.provider !== "openai-compatible" ||
    account.location !== "local" ||
    account.accessToken !== "" ||
    account.localRuntime?.source !== "multivibe-local-discovery" ||
    account.localRuntime.authentication !== "none" ||
    !account.baseUrl ||
    !validConfirmedModelIds(account.localRuntime.confirmedModelIds)
  ) {
    return false;
  }
  const boundary = automaticRuntimeBoundary(account.localRuntime.adapter);
  if (!boundary) return false;
  try {
    const baseUrl = parseAutomaticRuntimeEndpoint(
      account.localRuntime.adapter,
      account.baseUrl,
    );
    const endpoint = parseAutomaticRuntimeEndpoint(
      account.localRuntime.adapter,
      account.localRuntime.endpoint,
    );
    return baseUrl.origin === endpoint.origin;
  } catch {
    return false;
  }
}

export function authorizationForAccountRequest(
  account: Account,
  requestUrl: string,
): string | undefined {
  if (account.accessToken) return `Bearer ${account.accessToken}`;
  if (!isDiscoveredLocalRuntimeAccount(account)) {
    throw new Error("account has no credential and is not a discovered local runtime");
  }
  const adapter = account.localRuntime!.adapter as AutomaticLocalRuntimeAdapterId;
  const request = parseAutomaticRuntimeRequestUrl(adapter, requestUrl);
  const endpoint = parseAutomaticRuntimeEndpoint(adapter, account.localRuntime!.endpoint);
  if (request.origin !== endpoint.origin) {
    throw new Error("request origin does not match the discovered local runtime");
  }
  return undefined;
}

function parseModelsPayload(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model catalog must be a JSON object");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0 || data.length > 10_000) {
    throw new Error("model catalog must contain at least one model");
  }
  const ids = data.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("model catalog entry must be an object");
    }
    const id = (entry as { id?: unknown }).id;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 512 ||
      id.trim() !== id ||
      /[\u0000-\u001f\u007f]/.test(id)
    ) {
      throw new Error("model catalog entry has an invalid id");
    }
    return id;
  });
  return Array.from(new Set(ids));
}

async function readBoundedJson(
  response: Response,
  maxResponseBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maxResponseBytes) {
      throw new Error("model catalog response is too large");
    }
  }
  if (!response.body) throw new Error("model catalog response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("model catalog response is too large");
    }
    chunks.push(value);
  }

  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("model catalog response is not valid JSON");
  }
}

export async function probeLocalRuntimeCandidate(
  adapter: LocalRuntimeAdapter,
  candidate: LocalRuntimeCandidate,
  options: LocalRuntimeDiscoveryOptions = {},
): Promise<LocalRuntimeProbeSuccess> {
  const boundary = automaticRuntimeBoundary(adapter.id);
  if (!boundary) {
    throw new Error(`automatic discovery is not configured for ${adapter.id}`);
  }
  const endpoint = parseAutomaticRuntimeEndpoint(adapter.id, candidate.endpoint);
  const modelsUrl = parseAutomaticRuntimeRequestUrl(adapter.id, candidate.modelsUrl);
  if (endpoint.origin !== modelsUrl.origin || modelsUrl.pathname !== "/v1/models") {
    throw new Error(`model catalog URL does not match the ${boundary.name} endpoint`);
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = Math.max(1, options.timeoutMs ?? LOCAL_RUNTIME_DISCOVERY_TIMEOUT_MS);
  const maxResponseBytes = Math.max(
    1,
    options.maxResponseBytes ?? LOCAL_RUNTIME_MAX_RESPONSE_BYTES,
  );
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("local runtime probe timed out"));
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      (async () => {
        const response = await fetchFn(modelsUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status !== 200) {
          throw new Error(`model catalog probe returned HTTP ${response.status}`);
        }
        const confirmedModelIds = parseModelsPayload(
          await readBoundedJson(response, maxResponseBytes),
        );
        return {
          status: "discovered" as const,
          adapter: adapter.id,
          displayName: adapter.displayName,
          endpoint: endpoint.origin,
          confirmedModelIds,
        };
      })(),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function discoverLocalRuntimes(
  options: LocalRuntimeDiscoveryOptions = {},
): Promise<LocalRuntimeProbeResult[]> {
  const adapters = options.adapters ?? LOCAL_RUNTIME_ADAPTERS;
  const results: LocalRuntimeProbeResult[] = [];

  for (const adapter of adapters) {
    if (adapter.candidates.length === 0) {
      results.push({
        status: "not-configured",
        adapter: adapter.id,
        displayName: adapter.displayName,
        attempts: 0,
      });
      continue;
    }

    let lastError: string | undefined;
    let discovered: LocalRuntimeProbeSuccess | undefined;
    let attempts = 0;
    for (const candidate of adapter.candidates) {
      attempts += 1;
      try {
        discovered = await probeLocalRuntimeCandidate(adapter, candidate, options);
        break;
      } catch (error: any) {
        lastError = error?.message ?? String(error);
      }
    }

    results.push(
      discovered ?? {
        status: "unavailable",
        adapter: adapter.id,
        displayName: adapter.displayName,
        attempts,
        error: lastError,
      },
    );
  }

  return results;
}

function discoveredAccountId(adapter: LocalRuntimeAdapterId): string {
  return `local-runtime-${adapter}`;
}

function localRuntimeMetadata(
  result: LocalRuntimeProbeSuccess,
): LocalRuntimeMetadata {
  return {
    source: "multivibe-local-discovery",
    adapter: result.adapter,
    endpoint: result.endpoint,
    confirmedModelIds: result.confirmedModelIds,
    authentication: "none",
  };
}

export async function discoverAndPersistLocalRuntimes(
  store: AccountStore,
  options: LocalRuntimeDiscoveryOptions = {},
): Promise<{ results: LocalRuntimeProbeResult[]; accounts: Account[] }> {
  const results = await discoverLocalRuntimes(options);
  const existingAccounts = await store.listAccounts();
  const accounts: Account[] = [];

  for (const result of results) {
    if (result.status !== "discovered") continue;
    const id = discoveredAccountId(result.adapter);
    const existing = existingAccounts.find((account) => account.id === id);
    if (
      existing &&
      existing.localRuntime?.source !== "multivibe-local-discovery"
    ) {
      throw new Error(`refusing to replace existing non-discovered account ${id}`);
    }
    if (existing?.accessToken) {
      throw new Error(`refusing to replace credentials on discovered account ${id}`);
    }

    const account: Account = {
      ...existing,
      id,
      provider: "openai-compatible",
      upstreamMode: "chat/completions",
      email: existing?.email ?? `${result.displayName} (local)`,
      accessToken: "",
      baseUrl: result.endpoint,
      enabled: existing?.enabled ?? true,
      priority: existing?.priority ?? 0,
      location: "local",
      localRuntime: localRuntimeMetadata(result),
    };
    await store.addOrUpdate(account);
    accounts.push(account);
  }

  return { results, accounts };
}
