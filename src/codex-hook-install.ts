const INSTALLER_PATH = "/install-codex-project-hook.sh";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function normalizeInstallBaseUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("baseUrl is required");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("baseUrl must not contain credentials");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function buildCodexHookInstallCommand(baseUrl: unknown, token: string): string {
  const normalizedBaseUrl = normalizeInstallBaseUrl(baseUrl);
  if (!token) throw new Error("Codex project registration is disabled");

  const installerUrl = `${normalizedBaseUrl}${INSTALLER_PATH}`;
  return [
    `(multicodex_installer="$(curl -fsSL ${shellQuote(installerUrl)})"`,
    `&& printf '%s\\n' "$multicodex_installer"`,
    `| MULTICODEX_URL=${shellQuote(normalizedBaseUrl)}`,
    `MULTICODEX_PROJECT_TOKEN=${shellQuote(token)} sh)`,
  ].join(" ");
}

