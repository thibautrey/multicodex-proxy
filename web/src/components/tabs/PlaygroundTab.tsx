import React from "react";

type Props = {
  chatPrompt: string;
  setChatPrompt: (v: string) => void;
  runChatTest: () => Promise<void>;
  chatOut: string;
};

export function PlaygroundTab({ chatPrompt, setChatPrompt, runChatTest, chatOut }: Props) {
  return (
    <>
      <section className="section-header">
        <div>
          <div className="eyebrow">Live request</div>
          <h2>Quick proxy smoke test</h2>
          <p className="muted">
            The playground should prove the proxy is alive without sending you to `curl`
            or another client. Keep it fast and obvious.
          </p>
        </div>
      </section>

      <section className="grid cards2">
        <section className="panel">
          <div className="section-split-header">
            <div>
              <div className="eyebrow">Input</div>
              <h2>Prompt</h2>
            </div>
            <button className="btn" onClick={() => void runChatTest()}>Run</button>
          </div>
          <p className="muted section-copy">Sends a simple request to `/v1/chat/completions` using the first exposed model.</p>
          <textarea
            value={chatPrompt}
            onChange={(e) => setChatPrompt(e.target.value)}
            placeholder="Type a prompt"
            rows={10}
          />
        </section>

        <section className="panel">
          <div className="section-split-header">
            <div>
              <div className="eyebrow">Output</div>
              <h2>Response</h2>
            </div>
            <span className="badge">Live result</span>
          </div>
          <pre className="mono pre">{chatOut || "No output yet."}</pre>
        </section>
      </section>
    </>
  );
}
