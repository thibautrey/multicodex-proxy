import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";

export type ProviderAgentSelection = {
  schema_version: "provider-selection-v1";
  revision: number;
  state: "detected" | "selected";
  selected_models: string[];
};

export type ProviderAgentDetectedModels = {
  schema_version: "provider-detected-models-v1";
  runtimes: Array<{ adapter_id: string; models: string[] }>;
};

export type ProviderAgentRuntimeEndpointInput = {
  adapter_id: string;
  endpoint: string;
  bearer_token?: string;
};

export type ProviderAgentRuntimeEndpoints = {
  schema_version: "provider-runtime-endpoints-v1";
  revision: number;
  endpoints: Array<{
    adapter_id: string;
    endpoint: string;
    authentication: "none" | "bearer";
  }>;
};

export type ProviderAgentAdapterRegistry = {
  schema_version: "provider-runtime-registry-v2";
  adapters: Array<{
    id: string;
    display_name: string;
    protocol: "openai-compatible" | "native";
    authentication: "none" | "optional-bearer" | "required-bearer";
    automatic_loopback_candidates: Array<{ endpoint: string }>;
  }>;
};

export type ProviderAgentControl = {
  enabled: boolean;
  getSelection(): Promise<ProviderAgentSelection>;
  replaceSelection(revision: number, selectedModels: string[]): Promise<{ conflict: boolean; selection: ProviderAgentSelection }>;
  getAdapters(): Promise<ProviderAgentAdapterRegistry>;
  getRuntimeEndpoints(): Promise<ProviderAgentRuntimeEndpoints>;
  replaceRuntimeEndpoints(revision: number, endpoints: ProviderAgentRuntimeEndpointInput[]): Promise<{ conflict: boolean; endpoints: ProviderAgentRuntimeEndpoints }>;
  detectModels(): Promise<ProviderAgentDetectedModels>;
};

export type ProviderAgentSupervisor = ProviderAgentControl & { stop(): Promise<void> };

export class ProviderAgentControlRequestError extends Error {
  constructor(readonly status: number) {
    super("provider agent control request was rejected");
  }
}

const PROVIDER_AGENT_ENVIRONMENT_KEYS = [
  "MULTIVIBE_CORE_LOOPBACK_URL",
  "MULTIVIBE_PROVIDER_AGENT_LISTEN",
  "MULTIVIBE_PROVIDER_SELECTED_MODELS",
] as const;

export function providerAgentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PROVIDER_AGENT_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function providerAgentChildEnvironment(
  source: NodeJS.ProcessEnv,
  statePath: string | undefined,
  controlToken: string,
  runtimeStatePath?: string,
): NodeJS.ProcessEnv {
  return {
    ...providerAgentEnvironment(source),
    ...(statePath ? { MULTIVIBE_PROVIDER_STATE_PATH: statePath } : {}),
    ...(runtimeStatePath ? { MULTIVIBE_PROVIDER_RUNTIME_STATE_PATH: runtimeStatePath } : {}),
    MULTIVIBE_PROVIDER_CONTROL_TOKEN: controlToken,
  };
}

export function isValidProviderSelectedModelId(model: unknown): model is string {
  if (typeof model !== "string" || model.length === 0 || Buffer.byteLength(model) > 200
    || model.trim() !== model || model.includes("\\")
    || /[A-Za-z][A-Za-z0-9+.-]*:\//.test(model) || model.startsWith("/")
    || /^[A-Za-z]:\//.test(model) || /\p{Cc}/u.test(model)) return false;
  return model.split("/").every((segment) => {
    if (segment === "." || segment === ".." || isIP(segment) !== 0) return false;
    if (segment.startsWith("[") && segment.endsWith("]") && isIP(segment.slice(1, -1)) !== 0) return false;
    return true;
  });
}

export function isValidProviderRuntimeEndpointInput(
  value: unknown,
): value is ProviderAgentRuntimeEndpointInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !["adapter_id", "endpoint", "bearer_token"].includes(key))) return false;
  if (typeof input.adapter_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.adapter_id)) return false;
  if (typeof input.endpoint !== "string" || input.endpoint.length > 256 || input.endpoint.trim() !== input.endpoint) return false;
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    return false;
  }
  if (endpoint.protocol !== "http:" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "")
    || !endpoint.port || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)) return false;
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  if (input.bearer_token !== undefined) {
    if (typeof input.bearer_token !== "string" || Buffer.byteLength(input.bearer_token) > 4096
      || /\p{Cc}/u.test(input.bearer_token)) return false;
  }
  return true;
}

export function startEmbeddedProviderAgent(options: {
  enabled: boolean;
  binaryPath: string;
  environment?: NodeJS.ProcessEnv;
  statePath?: string;
  runtimeStatePath?: string;
  restartLimit?: number;
}): ProviderAgentSupervisor {
  const unavailable = async (): Promise<never> => { throw new Error("provider agent is not enabled"); };
  if (!options.enabled) return {
    enabled: false,
    stop: async () => undefined,
    getSelection: unavailable,
    replaceSelection: unavailable,
    getAdapters: unavailable,
    getRuntimeEndpoints: unavailable,
    replaceRuntimeEndpoints: unavailable,
    detectModels: unavailable,
  };
  if (!path.isAbsolute(options.binaryPath)) throw new Error("provider agent binary path must be absolute");
  if (options.statePath && (!path.isAbsolute(options.statePath) || path.normalize(options.statePath) !== options.statePath)) {
    throw new Error("provider agent state path must be a clean absolute path");
  }
  if (options.runtimeStatePath && (!path.isAbsolute(options.runtimeStatePath)
    || path.normalize(options.runtimeStatePath) !== options.runtimeStatePath)) {
    throw new Error("provider agent runtime state path must be a clean absolute path");
  }
  const sourceEnvironment = options.environment ?? process.env;
  const controlToken = randomBytes(32).toString("base64url");
  const listenAddress = sourceEnvironment.MULTIVIBE_PROVIDER_AGENT_LISTEN ?? "127.0.0.1:1460";
  if (listenAddress !== "127.0.0.1:1460" && listenAddress !== "[::1]:1460") {
    throw new Error("provider agent listen address must use literal loopback port 1460");
  }
  const baseUrl = listenAddress === "[::1]:1460" ? "http://[::1]:1460" : "http://127.0.0.1:1460";
  const request = async <T>(route: string, init: RequestInit = {}): Promise<{ response: Response; value: T }> => {
    const response = await fetch(`${baseUrl}${route}`, {
      ...init,
      headers: { authorization: `Bearer ${controlToken}`, ...(init.headers ?? {}) },
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status === 400) throw new ProviderAgentControlRequestError(400);
    if (response.status !== 200 && response.status !== 409) throw new Error("provider agent control request failed");
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > 64 * 1024) throw new Error("provider agent control response is too large");
    const text = await response.text();
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("provider agent control response is too large");
    return { response, value: JSON.parse(text) as T };
  };
  let child: ChildProcess | undefined;
  let stopped = false;
  let restarts = 0;
  const restartLimit = options.restartLimit ?? 5;
  const launch = () => {
    if (stopped) return;
    child = spawn(options.binaryPath, [], {
      env: providerAgentChildEnvironment(sourceEnvironment, options.statePath, controlToken, options.runtimeStatePath),
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("exit", () => {
      child = undefined;
      if (!stopped && restarts < restartLimit) {
        restarts += 1;
        setTimeout(launch, Math.min(1_000 * restarts, 5_000)).unref();
      }
    });
  };
  launch();
  return {
    enabled: true,
    getSelection: async () => (await request<ProviderAgentSelection>("/v1/selection")).value,
    replaceSelection: async (revision, selectedModels) => {
      const result = await request<ProviderAgentSelection>("/v1/selection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, selected_models: selectedModels }),
      });
      return { conflict: result.response.status === 409, selection: result.value };
    },
    getAdapters: async () => (await request<ProviderAgentAdapterRegistry>("/v1/adapters")).value,
    getRuntimeEndpoints: async () => (await request<ProviderAgentRuntimeEndpoints>("/v1/runtime-endpoints")).value,
    replaceRuntimeEndpoints: async (revision, endpoints) => {
      const result = await request<ProviderAgentRuntimeEndpoints>("/v1/runtime-endpoints", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, endpoints }),
      });
      return { conflict: result.response.status === 409, endpoints: result.value };
    },
    detectModels: async () => (await request<ProviderAgentDetectedModels>("/v1/detected-models")).value,
    stop: async () => {
      stopped = true;
      const running = child;
      if (!running || running.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { running.kill("SIGKILL"); resolve(); }, 5_000);
        timeout.unref();
        running.once("exit", () => { clearTimeout(timeout); resolve(); });
        running.kill("SIGTERM");
      });
    },
  };
}
