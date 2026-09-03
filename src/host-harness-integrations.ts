import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_CONFIG_BYTES = 1024 * 1024;
const STATE_SCHEMA_VERSION = "multivibe-host-harness-integrations-v1";
const MANAGED_BLOCK_START = "# >>> MultiVibe Host >>>";
const MANAGED_BLOCK_END = "# <<< MultiVibe Host <<<";

export type HostHarnessCategory = "cli" | "editor" | "agent" | "framework" | "service";

export type HostHarnessView = {
  id: string;
  name: string;
  category: HostHarnessCategory;
  detected: boolean;
  detectedBy: string[];
  configured: boolean;
  managed: boolean;
  drifted: boolean;
  canInstall: boolean;
  canUninstall: boolean;
  configPath?: string;
  unavailableReason?: string;
};

export type HarnessContext = { baseUrl: string; apiKey: string };

export type HarnessConfiguration = {
  relativePath: string;
  render: (current: string | null, context: HarnessContext) => string;
  isConfigured: (current: string, baseUrl: string) => boolean;
};

export type HostHarnessDefinition = {
  id: string;
  name: string;
  category: HostHarnessCategory;
  executables: string[];
  footprints: string[];
  configuration?: HarnessConfiguration;
  unavailableReason?: string;
};

type InstallationState = {
  configPath: string;
  originalContentBase64: string | null;
  originalMode: number | null;
  installedSha256: string;
  apiKeyId: string;
  application: string;
  installedAt: number;
};

type HarnessState = {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  installations: Record<string, InstallationState>;
};

export class HostHarnessIntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "HostHarnessIntegrationError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function parseJsonObject(current: string | null, relativePath: string): Record<string, unknown> {
  if (current === null || !current.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    throw new HostHarnessIntegrationError(`~/${relativePath} does not contain valid JSON`, 409);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HostHarnessIntegrationError(`~/${relativePath} must contain a JSON object`, 409);
  }
  return parsed as Record<string, unknown>;
}

function setJsonPath(root: Record<string, unknown>, segments: string[], value: unknown) {
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
}

function jsonConfiguration(
  relativePath: string,
  patches: (context: HarnessContext) => Array<[string[], unknown]>,
): HarnessConfiguration {
  return {
    relativePath,
    render(current, context) {
      const document = parseJsonObject(current, relativePath);
      for (const [segments, value] of patches(context)) setJsonPath(document, segments, value);
      return `${JSON.stringify(document, null, 2)}\n`;
    },
    isConfigured(current, baseUrl) {
      return current.includes(baseUrl);
    },
  };
}

function managedBlockConfiguration(
  relativePath: string,
  block: (context: HarnessContext) => string,
): HarnessConfiguration {
  return {
    relativePath,
    render(current, context) {
      const withoutManaged = stripManagedBlock(current ?? "").trimEnd();
      const prefix = withoutManaged ? `${withoutManaged}\n\n` : "";
      return `${prefix}${MANAGED_BLOCK_START}\n${block(context).trim()}\n${MANAGED_BLOCK_END}\n`;
    },
    isConfigured(current, baseUrl) {
      return current.includes(baseUrl);
    },
  };
}

function stripManagedBlock(value: string): string {
  const start = value.indexOf(MANAGED_BLOCK_START);
  if (start < 0) return value;
  const end = value.indexOf(MANAGED_BLOCK_END, start);
  if (end < 0) {
    throw new HostHarnessIntegrationError("the existing MultiVibe configuration block is incomplete", 409);
  }
  return `${value.slice(0, start)}${value.slice(end + MANAGED_BLOCK_END.length)}`;
}

function renderCodexToml(current: string | null, context: HarnessContext): string {
  let value = stripManagedBlock(current ?? "");
  const lines = value.split(/\r?\n/);
  const output: string[] = [];
  let table = "";
  let skippingProvider = false;
  for (const line of lines) {
    const tableMatch = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (tableMatch) {
      table = tableMatch[1].trim();
      skippingProvider = table === "model_providers.multivibe";
      if (skippingProvider) continue;
    }
    if (skippingProvider) continue;
    if (!table && /^\s*model_provider\s*=/.test(line)) continue;
    output.push(line);
  }
  value = output.join("\n").trimEnd();
  const prefix = value ? `${value}\n\n` : "";
  return `${prefix}${MANAGED_BLOCK_START}\nmodel_provider = "multivibe"\n\n[model_providers.multivibe]\nname = "MultiVibe Host"\nbase_url = ${jsonString(`${context.baseUrl}/v1`)}\nexperimental_bearer_token = ${jsonString(context.apiKey)}\nwire_api = "responses"\n${MANAGED_BLOCK_END}\n`;
}

const codexConfiguration: HarnessConfiguration = {
  relativePath: ".codex/config.toml",
  render: renderCodexToml,
  isConfigured: (current, baseUrl) =>
    current.includes("model_provider = \"multivibe\"") && current.includes(`${baseUrl}/v1`),
};

const claudeConfiguration = jsonConfiguration(".claude/settings.json", ({ baseUrl, apiKey }) => [
  [["env", "ANTHROPIC_BASE_URL"], baseUrl],
  [["env", "ANTHROPIC_AUTH_TOKEN"], apiKey],
]);

const openCodeConfiguration = jsonConfiguration(".config/opencode/opencode.json", ({ baseUrl, apiKey }) => [
  [["model"], "multivibe/gpt-5.5"],
  [["provider", "multivibe"], {
    npm: "@ai-sdk/openai-compatible",
    name: "MultiVibe Host",
    options: { baseURL: `${baseUrl}/v1`, apiKey },
    models: { "gpt-5.5": { name: "gpt-5.5" } },
  }],
]);

const openClawConfiguration = jsonConfiguration(".openclaw/openclaw.json", ({ baseUrl, apiKey }) => [
  [["agents", "defaults", "model", "primary"], "multivibe/gpt-5.5"],
  [["models", "providers", "multivibe"], {
    baseUrl: `${baseUrl}/v1`,
    apiKey,
    api: "openai-responses",
    models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
  }],
]);

const piConfiguration = jsonConfiguration(".pi/agent/models.json", ({ baseUrl, apiKey }) => [
  [["providers", "multivibe"], {
    baseUrl: `${baseUrl}/v1`,
    apiKey,
    api: "openai-responses",
    models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
  }],
]);

const qwenConfiguration = jsonConfiguration(".qwen/settings.json", ({ baseUrl, apiKey }) => [
  [["env", "OPENAI_BASE_URL"], `${baseUrl}/v1`],
  [["env", "OPENAI_API_KEY"], apiKey],
]);

const crushConfiguration = jsonConfiguration(".config/crush/crush.json", ({ baseUrl, apiKey }) => [
  [["providers", "multivibe"], {
    type: "openai",
    base_url: `${baseUrl}/v1`,
    api_key: apiKey,
    models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
  }],
]);

const hermesConfiguration = managedBlockConfiguration(".hermes/.env", ({ baseUrl, apiKey }) => [
  "LLM_PROVIDER=openai",
  "LLM_MODEL=gpt-5.5",
  `OPENAI_BASE_URL=${baseUrl}/v1`,
  `OPENAI_API_KEY=${apiKey}`,
].join("\n"));

const gooseConfiguration = managedBlockConfiguration(".config/goose/config.yaml", ({ baseUrl, apiKey }) => [
  "GOOSE_PROVIDER: openai",
  "GOOSE_MODEL: gpt-5.5",
  `OPENAI_HOST: ${jsonString(`${baseUrl}/v1`)}`,
  `OPENAI_API_KEY: ${jsonString(apiKey)}`,
].join("\n"));

const openHandsConfiguration = managedBlockConfiguration(".openhands/config.toml", ({ baseUrl, apiKey }) => [
  "[llm]",
  'model = "openai/gpt-5.5"',
  `base_url = ${jsonString(`${baseUrl}/v1`)}`,
  `api_key = ${jsonString(apiKey)}`,
].join("\n"));

const aiderConfiguration = managedBlockConfiguration(".aider.conf.yml", ({ baseUrl, apiKey }) => [
  "model: openai/gpt-5.5",
  `openai-api-base: ${jsonString(`${baseUrl}/v1`)}`,
  `openai-api-key: ${jsonString(apiKey)}`,
].join("\n"));

const continueConfiguration = managedBlockConfiguration(".continue/config.yaml", ({ baseUrl, apiKey }) => [
  "models:",
  "  - name: MultiVibe Host",
  "    provider: openai",
  "    model: gpt-5.5",
  `    apiBase: ${jsonString(`${baseUrl}/v1`)}`,
  `    apiKey: ${jsonString(apiKey)}`,
].join("\n"));

const interpreterConfiguration = managedBlockConfiguration(".config/open-interpreter/config.yaml", ({ baseUrl, apiKey }) => [
  "llm:",
  "  model: openai/gpt-5.5",
  `  api_base: ${jsonString(`${baseUrl}/v1`)}`,
  `  api_key: ${jsonString(apiKey)}`,
].join("\n"));

const agentZeroConfiguration = managedBlockConfiguration(".agent-zero/.env", ({ baseUrl, apiKey }) => [
  "API_PROVIDER=openai",
  "CHAT_MODEL=gpt-5.5",
  `OPENAI_BASE_URL=${baseUrl}/v1`,
  `OPENAI_API_KEY=${apiKey}`,
].join("\n"));

const autoGptConfiguration = managedBlockConfiguration(".autogpt/.env", ({ baseUrl, apiKey }) => [
  `OPENAI_API_BASE_URL=${baseUrl}/v1`,
  `OPENAI_API_KEY=${apiKey}`,
  "SMART_LLM=gpt-5.5",
  "FAST_LLM=gpt-5.5",
].join("\n"));

const manualReason = "This harness does not expose a stable, safe per-user OpenAI-compatible configuration file that MultiVibe Host can edit automatically.";
const projectReason = "This framework is configured per project. MultiVibe Host detected it but will not rewrite arbitrary project files.";

function definition(
  id: string,
  name: string,
  category: HostHarnessCategory,
  executables: string[],
  footprints: string[],
  configuration?: HarnessConfiguration,
  unavailableReason?: string,
): HostHarnessDefinition {
  return { id, name, category, executables, footprints, configuration, unavailableReason };
}

export const HOST_HARNESS_DEFINITIONS: readonly HostHarnessDefinition[] = [
  definition("claude-code", "Claude Code", "cli", ["claude"], [".claude"], claudeConfiguration),
  definition("openai-codex", "OpenAI Codex", "cli", ["codex"], [".codex"], codexConfiguration),
  definition("opencode", "OpenCode", "cli", ["opencode"], [".config/opencode"], openCodeConfiguration),
  definition("openclaw", "OpenClaw", "agent", ["openclaw"], [".openclaw"], openClawConfiguration),
  definition("hermes-agent", "Hermes Agent", "agent", ["hermes"], [".hermes"], hermesConfiguration),
  definition("pi", "Pi", "cli", ["pi"], [".pi/agent"], piConfiguration),
  definition("goose", "Goose", "agent", ["goose"], [".config/goose"], gooseConfiguration),
  definition("openhands", "OpenHands", "agent", ["openhands"], [".openhands"], openHandsConfiguration),
  definition("cline", "Cline", "editor", ["cline"], [".vscode/extensions/saoudrizwan.claude-dev-*", "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev", ".config/Code/User/globalStorage/saoudrizwan.claude-dev"], undefined, manualReason),
  definition("aider", "Aider", "cli", ["aider"], [".aider.conf.yml"], aiderConfiguration),
  definition("qwen-code", "Qwen Code", "cli", ["qwen"], [".qwen"], qwenConfiguration),
  definition("gemini-cli", "Gemini CLI", "cli", ["gemini"], [".gemini"], undefined, manualReason),
  definition("antigravity", "Google Antigravity", "editor", ["antigravity"], ["Library/Application Support/Antigravity", ".config/Antigravity"], undefined, manualReason),
  definition("github-copilot-cli", "GitHub Copilot CLI / Coding Agent", "cli", ["copilot", "github-copilot"], [".config/github-copilot"], undefined, manualReason),
  definition("kiro-cli", "Kiro / Kiro CLI", "cli", ["kiro", "kiro-cli"], [".kiro", "Library/Application Support/Kiro"], undefined, manualReason),
  definition("warp-agent", "Warp Agent", "editor", ["warp"], ["Library/Application Support/dev.warp.Warp-Stable", ".config/warp-terminal"], undefined, manualReason),
  definition("amp", "Amp", "cli", ["amp"], [".config/amp"], undefined, manualReason),
  definition("crush", "Crush", "cli", ["crush"], [".config/crush"], crushConfiguration),
  definition("kilo-code", "Kilo Code", "editor", ["kilo"], [".vscode/extensions/kilocode.kilo-code-*", "Library/Application Support/Code/User/globalStorage/kilocode.kilo-code", ".config/Code/User/globalStorage/kilocode.kilo-code"], undefined, manualReason),
  definition("roo-code", "Roo Code", "editor", ["roo"], [".vscode/extensions/rooveterinaryinc.roo-cline-*", "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline", ".config/Code/User/globalStorage/rooveterinaryinc.roo-cline"], undefined, manualReason),
  definition("continue", "Continue", "editor", ["cn", "continue"], [".continue", ".vscode/extensions/continue.continue-*"], continueConfiguration),
  definition("open-interpreter", "Open Interpreter", "cli", ["interpreter"], [".config/open-interpreter"], interpreterConfiguration),
  definition("swe-agent", "SWE-agent", "agent", ["sweagent", "swe-agent"], [".config/swe-agent"], undefined, projectReason),
  definition("autocoderover", "AutoCodeRover", "agent", ["autocoderover", "acr"], [".autocoderover"], undefined, projectReason),
  definition("mentat", "Mentat", "cli", ["mentat"], [".mentat"], undefined, projectReason),
  definition("gpt-pilot", "GPT-Pilot", "agent", ["gpt-pilot"], [".gpt-pilot"], undefined, projectReason),
  definition("plandex", "Plandex", "cli", ["plandex"], [".plandex"], undefined, manualReason),
  definition("cursor-agent", "Cursor Agent", "editor", ["cursor-agent", "cursor"], [".cursor", "Library/Application Support/Cursor"], undefined, manualReason),
  definition("windsurf-cascade", "Windsurf Cascade", "editor", ["windsurf"], [".codeium/windsurf", "Library/Application Support/Windsurf"], undefined, manualReason),
  definition("devin", "Devin", "service", ["devin"], [".config/devin"], undefined, manualReason),
  definition("pythagora", "Pythagora", "agent", ["pythagora"], [".pythagora"], undefined, projectReason),
  definition("agent-zero", "Agent Zero", "agent", ["agent-zero"], [".agent-zero"], agentZeroConfiguration),
  definition("openmanus", "OpenManus", "agent", ["openmanus"], [".openmanus"], undefined, projectReason),
  definition("manus", "Manus", "service", ["manus"], [".config/manus"], undefined, manualReason),
  definition("autogen", "AutoGen", "framework", ["autogenstudio", "autogen"], [".autogenstudio"], undefined, projectReason),
  definition("crewai", "CrewAI", "framework", ["crewai"], [".config/crewai"], undefined, projectReason),
  definition("langgraph", "LangGraph", "framework", ["langgraph"], [".config/langgraph"], undefined, projectReason),
  definition("smolagents", "smolagents", "framework", ["smolagents"], [".cache/huggingface/modules/transformers_modules"], undefined, projectReason),
  definition("letta", "Letta", "framework", ["letta"], [".letta"], undefined, projectReason),
  definition("autogpt", "AutoGPT", "agent", ["autogpt"], [".autogpt"], autoGptConfiguration),
  definition("babyagi", "BabyAGI", "agent", ["babyagi"], [".babyagi"], undefined, projectReason),
  definition("metagpt", "MetaGPT", "framework", ["metagpt"], [".metagpt"], undefined, projectReason),
  definition("superagi", "SuperAGI", "agent", ["superagi"], [".superagi"], undefined, projectReason),
  definition("agentgpt", "AgentGPT", "agent", ["agentgpt"], [".agentgpt"], undefined, projectReason),
  definition("camel", "CAMEL", "framework", ["camel-ai"], [".camel"], undefined, projectReason),
  definition("pydanticai", "PydanticAI", "framework", ["pydantic-ai"], [".config/pydantic-ai"], undefined, projectReason),
  definition("mastra", "Mastra", "framework", ["mastra"], [".mastra"], undefined, projectReason),
  definition("agno", "Agno", "framework", ["agno"], [".config/agno"], undefined, projectReason),
  definition("semantic-kernel", "Semantic Kernel", "framework", ["semantic-kernel"], [".config/semantic-kernel"], undefined, projectReason),
  definition("llamaindex-agents", "LlamaIndex Agents", "framework", ["llamaindex-cli"], [".config/llamaindex"], undefined, projectReason),
  definition("langchain-agents", "LangChain Agents", "framework", ["langchain"], [".config/langchain"], undefined, projectReason),
  definition("deepseek-harness", "deepseek-harness", "agent", ["deepseek-harness"], [".deepseek-harness"], undefined, projectReason),
];

const DEFAULT_EXECUTABLE_DIRECTORIES = [
  ".local/bin",
  ".npm-global/bin",
  ".bun/bin",
  ".cargo/bin",
  ".deno/bin",
  "Library/pnpm",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readBounded(filePath: string): Promise<{ content: string; mode: number } | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new HostHarnessIntegrationError(`${filePath} is a symbolic link`, 409);
    if (!stat.isFile()) throw new HostHarnessIntegrationError(`${filePath} is not a regular file`, 409);
    if (stat.size > MAX_CONFIG_BYTES) throw new HostHarnessIntegrationError(`${filePath} is too large to edit safely`, 409);
    return { content: await fs.readFile(filePath, "utf8"), mode: stat.mode & 0o777 };
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(filePath: string, content: string, mode = 0o600) {
  if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) {
    throw new HostHarnessIntegrationError(`${filePath} would exceed the safe configuration size`, 409);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.multivibe-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, mode);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function footprintExists(homeDirectory: string, footprint: string): Promise<boolean> {
  const absolute = footprint.startsWith("/") ? footprint : path.join(homeDirectory, footprint);
  const basename = path.basename(absolute);
  if (!basename.includes("*")) {
    return fs.lstat(absolute).then(() => true, () => false);
  }
  const expression = new RegExp(`^${basename.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return fs.readdir(path.dirname(absolute)).then(
    (entries) => entries.some((entry) => expression.test(entry)),
    () => false,
  );
}

export type HostHarnessManagerOptions = {
  homeDirectory: string;
  statePath: string;
  baseUrl: string;
  definitions?: readonly HostHarnessDefinition[];
  executableDirectories?: string[];
};

export class HostHarnessIntegrationManager {
  private readonly homeDirectory: string;
  private readonly statePath: string;
  private readonly baseUrl: string;
  private readonly definitions: readonly HostHarnessDefinition[];
  private readonly executableDirectories: string[];
  private operation = Promise.resolve();

  constructor(options: HostHarnessManagerOptions) {
    if (!path.isAbsolute(options.homeDirectory)) {
      throw new Error("Host harness home directory must be absolute");
    }
    this.homeDirectory = path.resolve(options.homeDirectory);
    this.statePath = path.resolve(options.statePath);
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.definitions = options.definitions ?? HOST_HARNESS_DEFINITIONS;
    this.executableDirectories = options.executableDirectories ?? DEFAULT_EXECUTABLE_DIRECTORIES;
    const parsed = new URL(this.baseUrl);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== "/") {
      throw new Error("Host harness integrations require a credential-free loopback HTTP base URL");
    }
  }

  async list(): Promise<HostHarnessView[]> {
    const state = await this.readState();
    return Promise.all(this.definitions.map((entry) => this.view(entry, state)));
  }

  async get(id: string): Promise<HostHarnessView> {
    const definition = this.definition(id);
    return this.view(definition, await this.readState());
  }

  async install(id: string, credential: { apiKeyId: string; apiKey: string; application: string }): Promise<HostHarnessView> {
    return this.serial(async () => {
      const definition = this.definition(id);
      if (!definition.configuration) {
        throw new HostHarnessIntegrationError(definition.unavailableReason ?? manualReason, 409);
      }
      const state = await this.readState();
      const before = await this.view(definition, state);
      if (!before.detected) throw new HostHarnessIntegrationError(`${definition.name} is not installed on this host`, 409);
      if (before.managed || before.configured) return before;

      const configPath = await this.safeConfigPath(definition.configuration.relativePath);
      const original = await readBounded(configPath);
      const installed = definition.configuration.render(original?.content ?? null, {
        baseUrl: this.baseUrl,
        apiKey: credential.apiKey,
      });
      await writeAtomic(configPath, installed, 0o600);
      state.installations[id] = {
        configPath,
        originalContentBase64: original ? Buffer.from(original.content).toString("base64") : null,
        originalMode: original?.mode ?? null,
        installedSha256: sha256(installed),
        apiKeyId: credential.apiKeyId,
        application: credential.application,
        installedAt: Date.now(),
      };
      try {
        await this.writeState(state);
      } catch (error) {
        if (original) await writeAtomic(configPath, original.content, original.mode);
        else await fs.unlink(configPath).catch(() => undefined);
        throw error;
      }
      return this.view(definition, state);
    });
  }

  async uninstall(id: string): Promise<{ view: HostHarnessView; apiKeyId: string | null }> {
    return this.serial(async () => {
      const definition = this.definition(id);
      const state = await this.readState();
      const installation = state.installations[id];
      if (!installation) {
        return { view: await this.view(definition, state), apiKeyId: null };
      }
      const configPath = await this.safeConfigPath(definition.configuration?.relativePath ?? "");
      if (configPath !== installation.configPath) {
        throw new HostHarnessIntegrationError("the saved harness configuration path is invalid", 409);
      }
      const current = await readBounded(configPath);
      if (!current || sha256(current.content) !== installation.installedSha256) {
        throw new HostHarnessIntegrationError(`~/${definition.configuration!.relativePath} changed after MultiVibe was installed; it was left untouched`, 409);
      }
      if (installation.originalContentBase64 === null) {
        await fs.unlink(configPath);
      } else {
        const original = Buffer.from(installation.originalContentBase64, "base64").toString("utf8");
        await writeAtomic(configPath, original, installation.originalMode ?? 0o600);
      }
      delete state.installations[id];
      await this.writeState(state);
      return { view: await this.view(definition, state), apiKeyId: installation.apiKeyId };
    });
  }

  private definition(id: string): HostHarnessDefinition {
    const found = this.definitions.find((entry) => entry.id === id);
    if (!found) throw new HostHarnessIntegrationError("unknown harness", 404);
    return found;
  }

  private async view(definition: HostHarnessDefinition, state: HarnessState): Promise<HostHarnessView> {
    const detectedBy: string[] = [];
    for (const executable of definition.executables) {
      for (const rawDirectory of this.executableDirectories) {
        const directory = rawDirectory.startsWith("/") ? rawDirectory : path.join(this.homeDirectory, rawDirectory);
        if (await footprintExists(this.homeDirectory, path.join(directory, executable))) {
          detectedBy.push(`command:${executable}`);
          break;
        }
      }
    }
    for (const footprint of definition.footprints) {
      if (await footprintExists(this.homeDirectory, footprint)) detectedBy.push(`path:~/${footprint}`);
    }
    const installation = state.installations[definition.id];
    const detected = detectedBy.length > 0 || Boolean(installation);
    let configured = false;
    let drifted = false;
    let configurationError: string | undefined;
    if (definition.configuration) {
      try {
        const configPath = await this.safeConfigPath(definition.configuration.relativePath);
        const current = await readBounded(configPath);
        configured = current ? definition.configuration.isConfigured(current.content, this.baseUrl) : false;
        drifted = Boolean(installation && (!current || sha256(current.content) !== installation.installedSha256));
      } catch (error: any) {
        configurationError = error?.message ?? "The harness configuration cannot be edited safely.";
        drifted = Boolean(installation);
      }
    }
    return {
      id: definition.id,
      name: definition.name,
      category: definition.category,
      detected,
      detectedBy: Array.from(new Set(detectedBy)),
      configured,
      managed: Boolean(installation),
      drifted,
      canInstall: detected && Boolean(definition.configuration) && !configured && !installation && !configurationError,
      canUninstall: Boolean(installation) && !drifted,
      ...(definition.configuration ? { configPath: `~/${definition.configuration.relativePath}` } : {}),
      ...(!definition.configuration || configurationError
        ? { unavailableReason: configurationError ?? definition.unavailableReason ?? manualReason }
        : {}),
    };
  }

  private async safeConfigPath(relativePath: string): Promise<string> {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
      throw new HostHarnessIntegrationError("unsafe harness configuration path", 409);
    }
    const candidate = path.resolve(this.homeDirectory, relativePath);
    if (!isInside(this.homeDirectory, candidate)) {
      throw new HostHarnessIntegrationError("harness configuration escapes the user's home directory", 409);
    }
    let ancestor = path.dirname(candidate);
    while (ancestor !== this.homeDirectory) {
      try {
        const resolved = await fs.realpath(ancestor);
        const home = await fs.realpath(this.homeDirectory);
        if (!isInside(home, resolved)) throw new HostHarnessIntegrationError("harness configuration parent escapes the user's home directory", 409);
        break;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        ancestor = path.dirname(ancestor);
      }
    }
    return candidate;
  }

  private async readState(): Promise<HarnessState> {
    const file = await readBounded(this.statePath);
    if (!file) return { schemaVersion: STATE_SCHEMA_VERSION, installations: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch {
      throw new HostHarnessIntegrationError("the harness integration state is invalid", 500);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HostHarnessIntegrationError("the harness integration state is invalid", 500);
    }
    const state = parsed as HarnessState;
    if (state.schemaVersion !== STATE_SCHEMA_VERSION || !state.installations || typeof state.installations !== "object" || Array.isArray(state.installations)) {
      throw new HostHarnessIntegrationError("the harness integration state has an unsupported schema", 500);
    }
    return state;
  }

  private async writeState(state: HarnessState) {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operation.then(operation, operation);
    this.operation = run.then(() => undefined, () => undefined);
    return run;
  }
}
