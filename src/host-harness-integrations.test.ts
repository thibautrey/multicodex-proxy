import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HOST_HARNESS_DEFINITIONS,
  HostHarnessIntegrationManager,
  type HostHarnessDefinition,
} from "./host-harness-integrations.js";

const requestedNames = [
  "Claude Code", "OpenAI Codex", "OpenCode", "OpenClaw", "Hermes Agent", "Pi", "Goose",
  "OpenHands", "Cline", "Aider", "Qwen Code", "Gemini CLI", "Google Antigravity",
  "GitHub Copilot CLI / Coding Agent", "Kiro / Kiro CLI", "Warp Agent", "Amp", "Crush",
  "Kilo Code", "Roo Code", "Continue", "Open Interpreter", "SWE-agent", "AutoCodeRover",
  "Mentat", "GPT-Pilot", "Plandex", "Cursor Agent", "Windsurf Cascade", "Devin", "Pythagora",
  "Agent Zero", "OpenManus", "Manus", "AutoGen", "CrewAI", "LangGraph", "smolagents",
  "Letta", "AutoGPT", "BabyAGI", "MetaGPT", "SuperAGI", "AgentGPT", "CAMEL", "PydanticAI",
  "Mastra", "Agno", "Semantic Kernel", "LlamaIndex Agents", "LangChain Agents", "deepseek-harness",
];

test("the host registry covers every requested harness exactly once", () => {
  assert.deepEqual(
    [...HOST_HARNESS_DEFINITIONS].map((entry) => entry.name).sort(),
    requestedNames.sort(),
  );
  assert.equal(new Set(HOST_HARNESS_DEFINITIONS.map((entry) => entry.id)).size, HOST_HARNESS_DEFINITIONS.length);
});

test("rejects a relative host home directory", () => {
  assert.throws(() => new HostHarnessIntegrationManager({
    homeDirectory: "relative-home",
    statePath: "/tmp/multivibe-harness-state.json",
    baseUrl: "http://127.0.0.1:1455",
    definitions: [],
  }), /home directory must be absolute/);
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-harness-"));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "example-agent"), "#!/bin/sh\n", { mode: 0o755 });
  const definition: HostHarnessDefinition = {
    id: "example",
    name: "Example Agent",
    category: "agent",
    executables: ["example-agent"],
    footprints: [".example"],
    configuration: {
      relativePath: ".example/settings.json",
      render(current, context) {
        const value = current ? JSON.parse(current) : {};
        value.multivibe = { baseUrl: `${context.baseUrl}/v1`, apiKey: context.apiKey };
        return `${JSON.stringify(value, null, 2)}\n`;
      },
      isConfigured(current, baseUrl) {
        return current.includes(`${baseUrl}/v1`);
      },
    },
  };
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: [definition],
    executableDirectories: [bin],
  });
  return { root, home, manager };
}

test("detects without executing, installs privately, and restores the exact previous file", async (t) => {
  const { root, home, manager } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(home, ".example", "settings.json");
  const original = '{\n  "theme": "dark"\n}\n';
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, original, { mode: 0o644 });

  const before = await manager.get("example");
  assert.equal(before.detected, true);
  assert.equal(before.canInstall, true);

  const installed = await manager.install("example", {
    apiKeyId: "key-1",
    apiKey: "mv_private-test-key",
    application: "harness-example",
  });
  assert.equal(installed.configured, true);
  assert.equal(installed.managed, true);
  assert.equal(installed.canUninstall, true);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  assert.match(await fs.readFile(configPath, "utf8"), /mv_private-test-key/);
  assert.doesNotMatch(
    await fs.readFile(path.join(home, ".multivibe", "harnesses.json"), "utf8"),
    /mv_private-test-key/,
  );

  const removed = await manager.uninstall("example");
  assert.equal(removed.apiKeyId, "key-1");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o644);
});

test("OpenCode installation synchronizes every safe model from MultiVibe", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-opencode-models-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  const configPath = path.join(home, ".config", "opencode", "opencode.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "opencode"), "binary", { mode: 0o755 });
  await fs.writeFile(configPath, `${JSON.stringify({
    model: "litellm/existing-model",
    provider: { litellm: { name: "Keep me" } },
  })}\n`);

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests += 1;
    assert.equal(String(input), "http://127.0.0.1:1455/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mv_opencode");
    assert.equal(init?.redirect, "error");
    return Response.json({
      object: "list",
      data: [
        { id: "gpt-5.6-luna" },
        { id: "gpt-5.5" },
        { id: "local/model" },
        { id: "gpt-5.5" },
        { id: "\u0000invalid" },
      ],
    });
  };

  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "opencode"),
    executableDirectories: [bin],
  });

  await manager.install("opencode", {
    apiKeyId: "key-opencode",
    apiKey: "mv_opencode",
    application: "harness-opencode",
  });

  const configured = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(configured.model, "multivibe/gpt-5.5");
  assert.deepEqual(Object.keys(configured.provider.multivibe.models), [
    "gpt-5.6-luna",
    "gpt-5.5",
    "local/model",
  ]);
  assert.equal(configured.provider.multivibe.options.baseURL, "http://127.0.0.1:1455/v1");
  assert.deepEqual(configured.provider.litellm, { name: "Keep me" });
  assert.equal(requests, 1);
});

test("all model-aware harnesses synchronize the live MultiVibe catalog", async (t) => {
  const modelIds = ["gpt-5.6-luna", "gpt-5.5", "local/model"];
  const catalogHarnesses = new Set(["openclaw", "pi", "crush", "continue"]);
  const harnessIds = [
    "openclaw", "pi", "crush", "continue", "hermes-agent", "goose", "openhands",
    "aider", "open-interpreter", "agent-zero", "autogpt",
  ];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const id of harnessIds) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `multivibe-${id}-models-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const bin = path.join(home, "bin");
    const definition = HOST_HARNESS_DEFINITIONS.find((entry) => entry.id === id)!;
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, definition.executables[0]), "binary", { mode: 0o755 });

    let requests = 0;
    globalThis.fetch = async (input, init) => {
      requests += 1;
      assert.equal(String(input), "http://127.0.0.1:1455/v1/models");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mv_all_harnesses");
      return Response.json({ object: "list", data: modelIds.map((model) => ({ id: model })) });
    };

    const manager = new HostHarnessIntegrationManager({
      homeDirectory: home,
      statePath: path.join(home, ".multivibe", "harnesses.json"),
      baseUrl: "http://127.0.0.1:1455",
      definitions: [definition],
      executableDirectories: [bin],
    });
    await manager.install(id, {
      apiKeyId: `key-${id}`,
      apiKey: "mv_all_harnesses",
      application: `harness-${id}`,
    });

    const configPath = path.join(home, definition.configuration!.relativePath);
    const configured = await fs.readFile(configPath, "utf8");
    assert.equal(requests, 1, `${id} should discover the catalog once`);
    assert.match(configured, /gpt-5\.5|gpt-5\.6-luna/);
    if (catalogHarnesses.has(id)) {
      for (const model of modelIds) assert.match(configured, new RegExp(model.replace("/", "\\/")));
    }
  }
});

test("marks old OpenCode installations for repair and refreshes their model catalog", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-opencode-repair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  const configPath = path.join(home, ".config", "opencode", "opencode.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(path.join(home, ".multivibe"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "opencode"), "binary", { mode: 0o755 });
  const oldConfig = `${JSON.stringify({
    model: "multivibe/gpt-5.5",
    provider: {
      multivibe: {
        npm: "@ai-sdk/openai-compatible",
        name: "MultiVibe Host",
        options: { baseURL: "http://127.0.0.1:1455/v1", apiKey: "mv_opencode" },
        models: { "gpt-5.5": { name: "gpt-5.5" } },
      },
    },
  })}\n`;
  await fs.writeFile(configPath, oldConfig);
  await fs.writeFile(
    path.join(home, ".multivibe", "harnesses.json"),
    `${JSON.stringify({
      schemaVersion: "multivibe-host-harness-integrations-v1",
      installations: {
        opencode: {
          configPath,
          originalContentBase64: null,
          originalMode: null,
          installedSha256: createHash("sha256").update(oldConfig).digest("hex"),
          apiKeyId: "key-opencode",
          application: "harness-opencode",
          installedAt: 1,
        },
      },
    })}\n`,
  );

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://127.0.0.1:1455/v1/models");
    return Response.json({ object: "list", data: [{ id: "gpt-5.6-luna" }, { id: "gpt-5.5" }] });
  };

  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "opencode"),
    executableDirectories: [bin],
  });
  const before = await manager.get("opencode");
  assert.equal(before.managed, true);
  assert.equal(before.drifted, true);
  assert.equal(before.repairable, true);

  await manager.repair("opencode", {
    apiKeyId: "key-opencode",
    apiKey: "mv_opencode",
    application: "harness-opencode",
  });
  const repaired = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.deepEqual(Object.keys(repaired.provider.multivibe.models), ["gpt-5.6-luna", "gpt-5.5"]);
  assert.equal((await manager.get("opencode")).drifted, false);
});

test("uninstall refuses to overwrite user changes made after installation", async (t) => {
  const { root, home, manager } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await manager.install("example", {
    apiKeyId: "key-2",
    apiKey: "mv_private-test-key",
    application: "harness-example",
  });
  const configPath = path.join(home, ".example", "settings.json");
  const changed = `${await fs.readFile(configPath, "utf8")}\n`;
  await fs.writeFile(configPath, changed);
  await assert.rejects(() => manager.uninstall("example"), /changed after MultiVibe was installed/);
  assert.equal(await fs.readFile(configPath, "utf8"), changed);
  assert.equal((await manager.get("example")).drifted, true);
});

test("Codex installation preserves unrelated TOML and restores the original provider", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-harness-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  const original = 'model_provider = "openai"\napproval_policy = "on-request"\n\n[history]\npersistence = "none"\n';
  await fs.writeFile(configPath, original);
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });

  await manager.install("openai-codex", { apiKeyId: "key-3", apiKey: "mv_codex", application: "harness-openai-codex" });
  const configured = await fs.readFile(configPath, "utf8");
  assert.match(configured, /model_provider = "multivibe"/);
  assert.match(configured, /experimental_bearer_token = "mv_codex"/);
  assert.match(configured, /approval_policy = "on-request"/);
  const firstTable = configured.search(/^\[/m);
  const rootProvider = configured.indexOf('model_provider = "multivibe"');
  assert.ok(rootProvider >= 0 && rootProvider < firstTable, "Codex provider must remain at the TOML root");
  assert.equal((configured.match(/^model_provider\s*=/gm) ?? []).length, 1);
  await manager.uninstall("openai-codex");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("Codex repair preserves a table inserted inside the legacy managed block", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-repair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, [
    "model = \"gpt-5.6-luna\"",
    "",
    "# >>> MultiVibe Host >>>",
    "model_provider = \"multivibe\"",
    "",
    "[plugins.\"sites@openai-bundled\"]",
    "enabled = true",
    "",
    "[model_providers.multivibe]",
    "name = \"MultiVibe Host\"",
    "base_url = \"http://192.168.1.149:1455/v1\"",
    "# <<< MultiVibe Host <<<",
    "",
    "[history]",
    "persistence = \"none\"",
    "",
  ].join("\n"));
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });

  await manager.install("openai-codex", { apiKeyId: "key-repair", apiKey: "mv_repair", application: "harness-openai-codex" });
  const repaired = await fs.readFile(configPath, "utf8");
  assert.match(repaired, /\[plugins\.\"sites@openai-bundled\"\]/);
  assert.match(repaired, /enabled = true/);
  assert.doesNotMatch(repaired, /192\.168\.1\.149:1455/);
  assert.equal((await manager.get("openai-codex")).configured, true);
});

test("Codex repair reconciles MultiVibe drift without removing unrelated changes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-reconcile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, "model = \"gpt-5.6-luna\"\n");
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });
  const credential = { apiKeyId: "key-reconcile", apiKey: "mv_reconcile", application: "harness-openai-codex" };
  await manager.install("openai-codex", credential);
  await fs.appendFile(configPath, "\n[plugins.\"sites@openai-bundled\"]\nenabled = true\n");
  const drifted = await manager.get("openai-codex");
  assert.equal(drifted.drifted, true);
  assert.equal(drifted.repairable, true);
  assert.equal(drifted.canUninstall, false);

  const repaired = await manager.repair("openai-codex", credential);
  assert.equal(repaired.configured, true);
  assert.equal(repaired.drifted, false);
  assert.equal(repaired.canUninstall, true);
  assert.match(await fs.readFile(configPath, "utf8"), /\[plugins\.\"sites@openai-bundled\"\]/);
});

test("Codex accepts brackets inside quoted TOML table keys", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-quoted-header-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, "model = \"gpt-5.6-luna\"\n");
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });
  const credential = { apiKeyId: "key-quoted-header", apiKey: "mv_quoted_header", application: "harness-openai-codex" };
  await manager.install("openai-codex", credential);
  await fs.appendFile(configPath, '\n[hooks.state."browser@openai-bundled:plugin.json#hooks[0]:stop:0:0"]\nenabled = true\n');

  const drifted = await manager.get("openai-codex");
  assert.equal(drifted.drifted, true);
  assert.equal(drifted.repairable, true);

  const repaired = await manager.repair("openai-codex", credential);
  assert.equal(repaired.configured, true);
  assert.equal(repaired.drifted, false);
  assert.match(await fs.readFile(configPath, "utf8"), /hooks\[0\]:stop:0:0/);
});

test("Codex reports profile overrides without hiding a correct default provider", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, "[profiles.normal]\nmodel_provider = \"litellm\"\n");
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });
  const installed = await manager.install("openai-codex", { apiKeyId: "key-profile", apiKey: "mv_profile", application: "harness-openai-codex" });
  assert.equal(installed.configured, true);
  assert.match(installed.configurationIssue ?? "", /normal=litellm/);
});
