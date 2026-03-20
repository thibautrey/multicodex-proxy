import http from "node:http";

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function callbackPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MultiVibe OAuth Callback</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f5f7fb;
        color: #0f172a;
      }
      main {
        width: min(680px, calc(100vw - 32px));
        padding: 24px;
        border-radius: 18px;
        background: #ffffff;
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.12);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 24px;
      }
      p {
        margin: 0 0 14px;
        line-height: 1.5;
      }
      textarea {
        width: 100%;
        min-height: 148px;
        margin: 12px 0 16px;
        padding: 12px;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        box-sizing: border-box;
        font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        resize: vertical;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 10px 16px;
        background: #0f172a;
        color: #ffffff;
        font: inherit;
        cursor: pointer;
      }
      code {
        font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .muted {
        color: #475569;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>OAuth callback received</h1>
      <p>The full callback URL is below. It has also been sent back to the dashboard window when possible.</p>
      <textarea id="callback-url" readonly></textarea>
      <div class="row">
        <button id="copy-button" type="button">Copy callback URL</button>
        <span class="muted" id="status">You can paste this into the dashboard if it does not autofill.</span>
      </div>
      <p class="muted">Expected path: <code>/auth/callback</code></p>
    </main>
    <script>
      (function () {
        var callbackUrl = window.location.href;
        var textarea = document.getElementById("callback-url");
        var status = document.getElementById("status");
        var copyButton = document.getElementById("copy-button");
        if (textarea) textarea.value = callbackUrl;
        if (window.opener && typeof window.opener.postMessage === "function") {
          window.opener.postMessage(
            { type: "multivibe-oauth-callback", callbackUrl: callbackUrl },
            "*",
          );
          if (status) status.textContent = "Sent to the dashboard window. You can still copy it manually.";
        }
        if (copyButton) {
          copyButton.addEventListener("click", function () {
            navigator.clipboard.writeText(callbackUrl).then(
              function () {
                if (status) status.textContent = "Callback URL copied.";
              },
              function () {
                if (textarea) {
                  textarea.focus();
                  textarea.select();
                }
                if (status) status.textContent = "Clipboard access failed. Copy from the text box.";
              },
            );
          });
        }
      })();
    </script>
  </body>
</html>`;
}

export function createOAuthCallbackServer(redirectUri: string): http.Server | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname) || !url.port) {
    return null;
  }

  const expectedPath = url.pathname || "/";

  return http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method !== "GET" || requestUrl.pathname !== expectedPath) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("not found");
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(callbackPageHtml());
  });
}
