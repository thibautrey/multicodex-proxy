import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { HostHarness } from "../types";

type Props = {
  onApiKeysChanged?: () => void | Promise<void>;
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

export function HostHarnessCarousel({ onApiKeysChanged }: Props) {
  const [harnesses, setHarnesses] = useState<HostHarness[]>([]);
  const [hostApplication, setHostApplication] = useState(false);
  const [index, setIndex] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const result = await api("/admin/host-harnesses");
    const next = (result.harnesses ?? []) as HostHarness[];
    setHostApplication(Boolean(result.hostApplication));
    setHarnesses(next.filter((entry) => entry.detected));
    setIndex((current) => Math.min(current, Math.max(0, next.length - 1)));
  }, []);

  useEffect(() => {
    void load().catch(() => {
      setHostApplication(false);
      setHarnesses([]);
    });
  }, [load]);

  if (!hostApplication || harnesses.length === 0) return null;
  const harness = harnesses[index];

  const updateHarness = (next: HostHarness) => {
    setHarnesses((current) => current.map((entry) => entry.id === next.id ? next : entry));
  };

  const connect = async () => {
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

  const disconnect = async () => {
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

  const connected = harness.configured || harness.managed;
  return (
    <section className="panel host-harness-carousel" aria-labelledby="host-harness-title">
      <div className="section-split-header host-harness-header">
        <div>
          <span className="eyebrow">MultiVibe Host</span>
          <h2 id="host-harness-title">Connect your coding agents</h2>
          <p className="muted">Detected locally. MultiVibe creates a dedicated key and updates the selected harness in the background.</p>
        </div>
        <span className="badge">{index + 1} / {harnesses.length}</span>
      </div>

      <div className="host-harness-card" aria-live="polite">
        <div className="host-harness-card-copy">
          <div className="inline wrap">
            <span className="host-harness-icon" aria-hidden="true">⌁</span>
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
          {!harness.canInstall && !connected && harness.unavailableReason && (
            <p className="host-harness-note">{harness.unavailableReason}</p>
          )}
          {harness.drifted && (
            <p className="host-harness-note">MultiVibe will not overwrite this file. Restore the installed version or remove the integration manually.</p>
          )}
        </div>
        <div className="host-harness-actions">
          {!connected && harness.canInstall && (
            <button className="btn" type="button" disabled={busyId === harness.id} onClick={() => void connect()}>
              {busyId === harness.id ? "Connecting…" : "Connect automatically"}
            </button>
          )}
          {harness.managed && (
            <button className="btn secondary" type="button" disabled={busyId === harness.id || !harness.canUninstall} onClick={() => void disconnect()}>
              {busyId === harness.id ? "Restoring…" : "Disconnect and restore"}
            </button>
          )}
          {connected && !harness.managed && <span className="muted">Already configured outside MultiVibe.</span>}
          {!harness.canInstall && !connected && <span className="muted">Manual setup required</span>}
        </div>
      </div>

      {harnesses.length > 1 && (
        <div className="host-harness-navigation" aria-label="Detected harnesses">
          <button className="btn ghost icon-button" type="button" aria-label="Previous harness" onClick={() => { setIndex((index - 1 + harnesses.length) % harnesses.length); setError(""); setMessage(""); }}>←</button>
          <div className="host-harness-dots">
            {harnesses.map((entry, dotIndex) => (
              <button key={entry.id} type="button" className={dotIndex === index ? "active" : ""} aria-label={`Show ${entry.name}`} aria-current={dotIndex === index ? "true" : undefined} onClick={() => { setIndex(dotIndex); setError(""); setMessage(""); }} />
            ))}
          </div>
          <button className="btn ghost icon-button" type="button" aria-label="Next harness" onClick={() => { setIndex((index + 1) % harnesses.length); setError(""); setMessage(""); }}>→</button>
        </div>
      )}
      {message && <p className="host-harness-feedback success" role="status">{message}</p>}
      {error && <p className="host-harness-feedback error" role="alert">{error}</p>}
    </section>
  );
}
