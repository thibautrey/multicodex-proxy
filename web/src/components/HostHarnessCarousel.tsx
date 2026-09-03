import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { HostHarness } from "../types";

type Props = {
  onApiKeysChanged?: () => void | Promise<void>;
  variant?: "default" | "onboarding";
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // The API can also return a plain-text error.
  }
  return message;
}

function detectionLabel(harness: HostHarness): string {
  const command = harness.detectedBy.find((entry) => entry.startsWith("command:"));
  if (command) return `Command ${command.slice("command:".length)} found`;
  const location = harness.detectedBy.find((entry) => entry.startsWith("path:"));
  return location ? `Installation found in ${location.slice("path:".length)}` : "Installation found";
}

const HARNESS_LOGO_DOMAINS: Record<string, string> = {
  "claude-code": "claude.ai",
  "openai-codex": "openai.com",
  opencode: "opencode.ai",
  openclaw: "openclaw.ai",
  "hermes-agent": "nousresearch.com",
  pi: "pi.dev",
  goose: "block.github.io",
  openhands: "openhands.dev",
  cline: "cline.bot",
  aider: "aider.chat",
  "qwen-code": "qwenlm.github.io",
  "gemini-cli": "gemini.google.com",
  antigravity: "antigravity.google",
  "github-copilot-cli": "github.com",
  "kiro-cli": "kiro.dev",
  "warp-agent": "warp.dev",
  amp: "ampcode.com",
  crush: "charm.land",
  "kilo-code": "kilocode.ai",
  "roo-code": "roocode.com",
  continue: "continue.dev",
  "open-interpreter": "openinterpreter.com",
  "swe-agent": "swe-agent.com",
  autocoderover: "autocoderover.dev",
  mentat: "mentat.ai",
  "gpt-pilot": "gpt-pilot.ai",
  plandex: "plandex.ai",
  "cursor-agent": "cursor.com",
  "windsurf-cascade": "windsurf.com",
  devin: "devin.ai",
  pythagora: "pythagora.ai",
  "agent-zero": "agent-zero.ai",
  openmanus: "openmanus.dev",
  manus: "manus.im",
  autogen: "microsoft.github.io",
  crewai: "crewai.com",
  langgraph: "langchain.com",
  smolagents: "huggingface.co",
  letta: "letta.com",
  autogpt: "agpt.co",
  babyagi: "babyagi.org",
  metagpt: "deepwisdom.ai",
  superagi: "superagi.com",
  agentgpt: "agentgpt.reworkd.ai",
  camel: "camel-ai.org",
  pydanticai: "ai.pydantic.dev",
  mastra: "mastra.ai",
  agno: "agno.com",
  "semantic-kernel": "microsoft.com",
  "llamaindex-agents": "llamaindex.ai",
  "langchain-agents": "langchain.com",
  "deepseek-harness": "deepseek.com",
};

function HarnessLogo({ harness }: { harness: HostHarness }) {
  const domain = HARNESS_LOGO_DOMAINS[harness.id];
  const initials = harness.name.split(/[\s/-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const [failed, setFailed] = useState(false);
  return (
    <span className="host-harness-logo" aria-hidden="true">
      {domain && !failed
        ? <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        : <span>{initials}</span>}
    </span>
  );
}

export function HostHarnessCards({ onApiKeysChanged, variant = "default" }: Props) {
  const [harnesses, setHarnesses] = useState<HostHarness[]>([]);
  const [hostApplication, setHostApplication] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const result = await api("/admin/host-harnesses");
    const next = (result.harnesses ?? []) as HostHarness[];
    setHostApplication(Boolean(result.hostApplication));
    setHarnesses(next.filter((entry) => entry.detected));
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load().catch(() => {
      setHostApplication(false);
      setHarnesses([]);
      setLoaded(true);
    });
  }, [load]);

  if (variant === "default" && (!hostApplication || harnesses.length === 0)) return null;

  const updateHarness = (next: HostHarness) => {
    setHarnesses((current) => current.map((entry) => entry.id === next.id ? next : entry));
  };

  const connect = async (harness: HostHarness) => {
    setBusyId(harness.id);
    setMessage("");
    setError("");
    try {
      const result = await api(`/admin/host-harnesses/${encodeURIComponent(harness.id)}/install`, { method: "POST" });
      updateHarness(result.harness as HostHarness);
      setMessage(`${harness.name} is connected to MultiVibe.`);
      await onApiKeysChanged?.();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (harness: HostHarness) => {
    setBusyId(harness.id);
    setMessage("");
    setError("");
    try {
      const result = await api(`/admin/host-harnesses/${encodeURIComponent(harness.id)}/install`, { method: "DELETE" });
      updateHarness(result.harness as HostHarness);
      setMessage(`${harness.name} was restored to its previous configuration.`);
      await onApiKeysChanged?.();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      className={`panel host-harness-browser host-harness-${variant}`}
      aria-label={variant === "onboarding" ? "Detected coding tools" : undefined}
      aria-labelledby={variant === "default" ? "host-harness-title" : undefined}
    >
      {variant === "default" && <div className="section-split-header host-harness-header">
        <div>
          <h2 id="host-harness-title">Connect your coding agents</h2>
        </div>
        <span className="badge">{harnesses.length} detected</span>
      </div>}

      {loaded && harnesses.length === 0 && variant === "onboarding" && (
        <div className="compact-empty-state">
          <strong>No supported harness detected</strong>
          <span>You can continue and connect one later.</span>
        </div>
      )}
      {!loaded && variant === "onboarding" && <p className="muted">Looking for coding tools…</p>}
      {harnesses.length > 0 && <div className="host-harness-rail" aria-label="Detected harnesses" aria-live="polite">
        {harnesses.map((harness) => {
          const connected = harness.configured || harness.managed;
          return <article className="host-harness-card" key={harness.id}>
            <div className="host-harness-card-copy">
              <div className="host-harness-identity">
                <HarnessLogo harness={harness} />
                <div>
                  <h3>{harness.name}</h3>
                  <p className="muted">{detectionLabel(harness)}</p>
                </div>
              </div>
              <div className="inline wrap host-harness-badges">
                <span className="badge">{harness.category}</span>
                {connected && !harness.drifted && <span className="badge badge-live">Connected</span>}
                {harness.drifted && <span className="badge badge-warn">Configuration changed</span>}
              </div>
              {harness.configPath && <code className="host-harness-path">{harness.configPath}</code>}
              {!harness.canInstall && !connected && harness.unavailableReason && <p className="host-harness-note">{harness.unavailableReason}</p>}
              {harness.drifted && <p className="host-harness-note">MultiVibe will not overwrite this file. Restore the installed version or remove the integration manually.</p>}
            </div>
            <div className="host-harness-actions">
              {!connected && harness.canInstall && <button className="btn" type="button" disabled={busyId === harness.id} onClick={() => void connect(harness)}>{busyId === harness.id ? "Connecting…" : "Connect automatically"}</button>}
              {harness.managed && <button className="btn secondary" type="button" disabled={busyId === harness.id || !harness.canUninstall} onClick={() => void disconnect(harness)}>{busyId === harness.id ? "Restoring…" : "Disconnect and restore"}</button>}
              {connected && !harness.managed && <span className="muted">Already configured outside MultiVibe.</span>}
              {!harness.canInstall && !connected && <span className="muted">Manual setup required</span>}
            </div>
          </article>;
        })}
      </div>}
      {message && <p className="host-harness-feedback success" role="status">{message}</p>}
      {error && <p className="host-harness-feedback error" role="alert">{error}</p>}
    </section>
  );
}
