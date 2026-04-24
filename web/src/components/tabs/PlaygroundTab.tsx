import React from "react";
import type { ExposedModel } from "../../types";

type Props = {
  chatPrompt: string;
  setChatPrompt: (v: string) => void;
  chatModel: string;
  setChatModel: (v: string) => void;
  models: ExposedModel[];
  runChatTest: () => Promise<void>;
  chatOut: string;
};

export function PlaygroundTab({
  chatPrompt,
  setChatPrompt,
  chatModel,
  setChatModel,
  models,
  runChatTest,
  chatOut,
}: Props) {
  const selectedModel = models.find((model) => model.id === chatModel);

  return (
    <section className="grid cards2">
      <section className="panel">
        <div className="section-split-header">
          <div>
            <h2>Request</h2>
            <small>Test the proxy with explicit playground controls.</small>
          </div>
          <button className="btn" onClick={() => void runChatTest()} disabled={!models.length}>
            Run
          </button>
        </div>

        <div className="grid">
          <label className="control-field">
            <span className="control-label">Model</span>
            <select value={chatModel} onChange={(e) => setChatModel(e.target.value)} disabled={!models.length}>
              {!models.length && <option value="">No models available</option>}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="control-field" style={{ marginTop: 14 }}>
          <span className="control-label">Prompt</span>
          <textarea
            value={chatPrompt}
            onChange={(e) => setChatPrompt(e.target.value)}
            placeholder="Type a prompt"
            rows={8}
          />
        </label>

        <div className="info-grid">
          <div className="info-tile">
            <span className="info-label">Selected model</span>
            <strong className="mono" style={{ fontSize: "1rem", letterSpacing: "-0.02em" }}>
              {chatModel || "None"}
            </strong>
          </div>
          <div className="info-tile">
            <span className="info-label">Provider</span>
            <strong style={{ fontSize: "1rem", letterSpacing: "-0.02em" }}>
              {selectedModel?.metadata?.provider ?? "Unknown"}
            </strong>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-split-header">
          <div>
            <h2>Output</h2>
            <small>Raw assistant text or fallback JSON response payload.</small>
          </div>
        </div>
        <pre className="mono pre">{chatOut || "No output yet."}</pre>
      </section>
    </section>
  );
}
