export type SSEStreamTap = {
  push(chunk: Uint8Array): void;
  finish(): { unterminatedFrame: boolean };
};

/**
 * Observes complete SSE frames without rebuilding the byte stream forwarded
 * to the client. The caller can therefore write upstream chunks immediately
 * while diagnostics continue to operate on decoded frame boundaries.
 */
export function createSSEStreamTap(
  onFrame: (frame: string) => void,
): SSEStreamTap {
  const decoder = new TextDecoder();
  let buffer = "";

  const drainCompleteFrames = () => {
    let offset = 0;

    while (true) {
      const crlfBoundary = buffer.indexOf("\r\n\r\n", offset);
      const lfBoundary = buffer.indexOf("\n\n", offset);
      if (crlfBoundary === -1 && lfBoundary === -1) break;

      const useCrlf =
        crlfBoundary !== -1 &&
        (lfBoundary === -1 || crlfBoundary < lfBoundary);
      const boundary = useCrlf ? crlfBoundary : lfBoundary;
      onFrame(buffer.slice(offset, boundary));
      offset = boundary + (useCrlf ? 4 : 2);
    }

    if (offset > 0) buffer = buffer.slice(offset);
  };

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      drainCompleteFrames();
    },
    finish() {
      buffer += decoder.decode();
      drainCompleteFrames();
      const unterminatedFrame = Boolean(buffer.trim());
      if (unterminatedFrame) onFrame(buffer);
      buffer = "";
      return { unterminatedFrame };
    },
  };
}
