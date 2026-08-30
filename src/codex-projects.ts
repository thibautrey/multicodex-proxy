import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import { TRACE_HEADERS_FORWARD_HEADER } from "./trace-headers.js";

export type CodexProject = {
  id: string;
  name: string;
  remote?: string;
  root?: string;
  host?: string;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type CodexSession = {
  sessionId: string;
  projectId: string;
  cwd: string;
  projectRoot?: string;
  host?: string;
  branch?: string;
  source?: string;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type CodexProjectAttribution = {
  projectId: string;
  projectName: string;
  projectRemote?: string;
  projectRoot?: string;
  projectHost?: string;
};

type RegistryFile = {
  version: 1;
  projects: CodexProject[];
  sessions: CodexSession[];
};

export type CodexSessionRegistration = {
  sessionId: string;
  cwd: string;
  projectName?: string;
  projectRoot?: string;
  remote?: string;
  branch?: string;
  host?: string;
  source?: string;
};

const EMPTY_REGISTRY: RegistryFile = {
  version: 1,
  projects: [],
  sessions: [],
};

export const CODEX_SESSION_FORWARD_HEADER =
  "x-multicodex-codex-session-id";
/**
 * Project context supplied by the Codex model provider on every request.
 *
 * This is intentionally separate from the SessionStart hook. Codex can emit
 * internal/system requests with a new session id before (or without) running
 * the user-level hook, while the provider header remains deterministic for
 * the process' project root.
 */
export const CODEX_PROJECT_ROOT_FORWARD_HEADER =
  "x-multicodex-project-root";
export const LITELLM_KEY_ALIAS_HEADER = "x-litellm-key-alias";

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

/**
 * Normalize a project root for comparison without resolving it on the proxy
 * host. The value is an opaque client path; only harmless separator cleanup
 * is performed so `/repo` and `/repo/` address the same registered root.
 */
export function normalizeCodexProjectRoot(value: unknown): string | undefined {
  const raw = boundedString(value, 2048);
  if (!raw) return undefined;
  const normalized = raw.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return normalized || "/";
}

export function sanitizeGitRemote(value: unknown): string | undefined {
  const raw = boundedString(value, 1024);
  if (!raw) return undefined;

  const scpStyle = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scpStyle && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const repositoryPath = scpStyle[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return repositoryPath
      ? `${scpStyle[1].toLowerCase()}/${repositoryPath}`.slice(0, 512)
      : undefined;
  }

  try {
    const parsed = new URL(raw);
    const repositoryPath = parsed.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "");
    if (parsed.hostname && repositoryPath) {
      return `${parsed.hostname.toLowerCase()}/${repositoryPath}`.slice(0, 512);
    }
  } catch {
    // A remote can also be a local path. Do not expose arbitrary credentials
    // or unsupported URL-like values; the host + project root fallback remains.
  }

  if (/^[a-z0-9._-]+\/[a-z0-9._/-]+$/i.test(raw)) {
    return raw.replace(/\.git$/i, "").slice(0, 512);
  }
  return undefined;
}

function basename(value: string): string {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "unknown";
}

export function normalizeCodexSessionRegistration(
  value: unknown,
  now = Date.now(),
): {
  project: CodexProject;
  session: CodexSession;
} {
  if (!value || typeof value !== "object") {
    throw new Error("JSON registration body required");
  }
  const input = value as Record<string, unknown>;
  const sessionId = boundedString(input.sessionId, 200);
  const cwd = boundedString(input.cwd, 2048);
  if (!sessionId || !/^[a-z0-9._:-]+$/i.test(sessionId)) {
    throw new Error("valid sessionId required");
  }
  if (!cwd) throw new Error("cwd required");

  const root =
    normalizeCodexProjectRoot(input.projectRoot) ??
    normalizeCodexProjectRoot(cwd) ??
    cwd;
  const host = boundedString(input.host, 255);
  const remote = sanitizeGitRemote(input.remote);
  const name =
    boundedString(input.projectName, 160) ?? basename(remote ?? root);
  const identity = remote ? `git:${remote}` : `path:${host ?? "unknown"}:${root}`;
  const projectId = `prj_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;

  return {
    project: {
      id: projectId,
      name,
      remote,
      root,
      host,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    session: {
      sessionId,
      projectId,
      cwd,
      projectRoot: root,
      host,
      branch: boundedString(input.branch, 255),
      source: boundedString(input.source, 80),
      firstSeenAt: now,
      lastSeenAt: now,
    },
  };
}

function headerValue(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  const direct = headers[name.toLowerCase()];
  const value =
    typeof direct !== "undefined"
      ? direct
      : Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (Array.isArray(value)) return value.map(String).join(", ").trim() || undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractCodexSessionId(
  headers: http.IncomingHttpHeaders | Record<string, unknown>,
): string | undefined {
  const normalized = headers as Record<string, unknown>;
  const forwarded = headerValue(normalized, TRACE_HEADERS_FORWARD_HEADER);
  if (forwarded) {
    try {
      const candidate = extractCodexSessionId(JSON.parse(forwarded));
      if (candidate) return candidate;
    } catch {
      // Fall through to headers present on the current request.
    }
  }
  for (const name of [
    CODEX_SESSION_FORWARD_HEADER,
    "thread-id",
    "session_id",
    "session-id",
    "x-session-id",
  ]) {
    const candidate = headerValue(normalized, name);
    if (candidate && candidate.length <= 200 && /^[a-z0-9._:-]+$/i.test(candidate)) {
      return candidate;
    }
  }

  const metadata = headerValue(normalized, "x-codex-turn-metadata");
  if (!metadata) return undefined;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const candidate = boundedString(parsed.session_id ?? parsed.thread_id, 200);
    return candidate && /^[a-z0-9._:-]+$/i.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function extractCodexProjectRoot(
  headers: http.IncomingHttpHeaders | Record<string, unknown>,
): string | undefined {
  const normalized = headers as Record<string, unknown>;
  const forwarded = headerValue(normalized, TRACE_HEADERS_FORWARD_HEADER);
  if (forwarded) {
    try {
      const candidate = extractCodexProjectRoot(JSON.parse(forwarded));
      if (candidate) return candidate;
    } catch {
      // Fall through to headers present on the current request.
    }
  }

  return normalizeCodexProjectRoot(
    headerValue(normalized, CODEX_PROJECT_ROOT_FORWARD_HEADER),
  );
}

export function extractLiteLLMProjectAttribution(
  headers: http.IncomingHttpHeaders | Record<string, unknown>,
): CodexProjectAttribution | undefined {
  const normalized = headers as Record<string, unknown>;
  const forwarded = headerValue(normalized, TRACE_HEADERS_FORWARD_HEADER);
  if (forwarded) {
    try {
      const candidate = extractLiteLLMProjectAttribution(JSON.parse(forwarded));
      if (candidate) return candidate;
    } catch {
      // Fall through to headers present on the current request.
    }
  }

  const alias = boundedString(
    headerValue(normalized, LITELLM_KEY_ALIAS_HEADER),
    160,
  );
  if (!alias) return undefined;
  const projectId = `prj_${createHash("sha256")
    .update(`litellm:${alias}`)
    .digest("hex")
    .slice(0, 24)}`;
  return {
    projectId,
    projectName: alias,
  };
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
}

export class CodexProjectRegistry {
  private projects = new Map<string, CodexProject>();
  private sessions = new Map<string, CodexSession>();
  private writeQueue: Promise<void> = Promise.resolve();
  private lastWriteError: { at: number; message: string } | undefined;

  constructor(private filePath: string) {}

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<RegistryFile>;
      for (const project of Array.isArray(raw.projects) ? raw.projects : []) {
        if (project?.id) this.projects.set(project.id, project);
      }
      for (const session of Array.isArray(raw.sessions) ? raw.sessions : []) {
        if (session?.sessionId) this.sessions.set(session.sessionId, session);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      await writeJsonAtomic(this.filePath, EMPTY_REGISTRY);
    }
  }

  async register(value: unknown) {
    const { project, session } = normalizeCodexSessionRegistration(value);
    const previousProject = this.projects.get(project.id);
    const previousSession = this.sessions.get(session.sessionId);
    const storedProject: CodexProject = {
      ...previousProject,
      ...project,
      firstSeenAt: previousProject?.firstSeenAt ?? project.firstSeenAt,
    };
    const storedSession: CodexSession = {
      ...previousSession,
      ...session,
      firstSeenAt: previousSession?.firstSeenAt ?? session.firstSeenAt,
    };
    this.projects.set(storedProject.id, storedProject);
    this.sessions.set(storedSession.sessionId, storedSession);
    await this.persist();
    return { project: storedProject, session: storedSession };
  }

  private attributionFor(
    project: CodexProject,
    projectRoot?: string,
    projectHost?: string,
  ): CodexProjectAttribution {
    return {
      projectId: project.id,
      projectName: project.name,
      projectRemote: project.remote,
      projectRoot: projectRoot ?? project.root,
      projectHost: projectHost ?? project.host,
    };
  }

  /** Resolve a project only when the supplied root identifies one project. */
  resolveByProjectRoot(
    projectRoot: string | undefined,
  ): CodexProjectAttribution | undefined {
    const normalizedRoot = normalizeCodexProjectRoot(projectRoot);
    if (!normalizedRoot) return undefined;

    const projectIds = new Set<string>();
    for (const session of this.sessions.values()) {
      if (normalizeCodexProjectRoot(session.projectRoot) !== normalizedRoot) continue;
      if (this.projects.has(session.projectId)) projectIds.add(session.projectId);
    }
    for (const project of this.projects.values()) {
      if (normalizeCodexProjectRoot(project.root) === normalizedRoot) {
        projectIds.add(project.id);
      }
    }

    // A root shared by multiple registered projects is not safe to attribute.
    if (projectIds.size !== 1) return undefined;
    const projectId = projectIds.values().next().value;
    if (typeof projectId !== "string") return undefined;
    const project = this.projects.get(projectId);
    return project ? this.attributionFor(project, normalizedRoot) : undefined;
  }

  /**
   * Resolve the exact session first. The explicit project-root header is only
   * a fallback for unknown/internal session ids and never overrides a match.
   */
  resolve(
    sessionId: string | undefined,
    projectRoot?: string,
  ): CodexProjectAttribution | undefined {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        const project = this.projects.get(session.projectId);
        if (project) {
          return this.attributionFor(
            project,
            session.projectRoot ?? project.root,
            session.host ?? project.host,
          );
        }
      }
    }
    return this.resolveByProjectRoot(projectRoot);
  }

  listProjects() {
    const sessionCounts = new Map<string, number>();
    for (const session of this.sessions.values()) {
      sessionCounts.set(session.projectId, (sessionCounts.get(session.projectId) ?? 0) + 1);
    }
    return Array.from(this.projects.values())
      .map((project) => ({
        ...project,
        sessionCount: sessionCounts.get(project.id) ?? 0,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  listSessions() {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt,
    );
  }

  async persist() {
    const snapshot: RegistryFile = {
      version: 1,
      projects: Array.from(this.projects.values()),
      sessions: Array.from(this.sessions.values()),
    };
    const run = this.writeQueue.then(() => writeJsonAtomic(this.filePath, snapshot));
    this.writeQueue = run.catch(() => undefined);
    try {
      await run;
      this.lastWriteError = undefined;
    } catch (error: any) {
      this.lastWriteError = { at: Date.now(), message: error?.message ?? String(error) };
      throw error;
    }
  }

  async flushPendingWrites() {
    await this.writeQueue;
    if (this.lastWriteError) {
      throw new Error(`Codex project registry persistence failed: ${this.lastWriteError.message}`);
    }
  }

  getPersistenceStatus() {
    return { lastError: this.lastWriteError };
  }
}
