import React from "react";

type Props = {
  chatPrompt: string;
  setChatPrompt: (v: string) => void;
  runChatTest: () => Promise<void>;
  chatOut: string;
};

export function PlaygroundTab({ chatPrompt, setChatPrompt, runChatTest, chatOut }: Props) {
  return (
    <section className="panel">
      <h2>Chat test</h2>
      <div className="inline wrap">
        <input value={chatPrompt} onChange={(e) => setChatPrompt(e.target.value)} placeholder="Type a prompt" />
        <button className="btn" onClick={() => void runChatTest()}>Run</button>
      </div>
      <pre className="mono pre">{chatOut || "No output yet."}</pre>
    </section>
  );
}
