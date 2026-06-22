// Locating and reading the HOST's session transcript from local disk.
//
// The plugin is a local stdio process; the host writes the full session
// transcript (the user's prompts + EVERY tool/MCP server's calls, not just
// Glean's) to a per-session file named by the session id. resolveSessionId()
// already yields that id (GLEAN_SESSION_ID), so we can find the file:
//   Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
//   Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl
// Cursor exposes no session-id env var and stores chats in an opaque SQLite
// blob, so it is not addressable here — locateTranscript returns null and the
// caller skips capture gracefully.

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export type TranscriptHost = "claude-code" | "codex";

export interface TranscriptLocation {
  path: string;
  host: TranscriptHost;
}

export interface TranscriptRead {
  text: string;
  bytes: number; // bytes returned (after any truncation)
  totalBytes: number; // original file size on disk
  truncated: boolean;
}

interface LocateOptions {
  projectsDir?: string; // default ~/.claude/projects
  codexSessionsDir?: string; // default ~/.codex/sessions
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export function locateTranscript(
  sessionId: string,
  opts: LocateOptions = {},
): TranscriptLocation | null {
  if (!sessionId) return null;

  const projectsDir =
    opts.projectsDir ??
    process.env.GLEAN_CLAUDE_PROJECTS_DIR ??
    path.join(homedir(), ".claude", "projects");
  const claude = findClaudeTranscript(projectsDir, sessionId);
  if (claude) return { path: claude, host: "claude-code" };

  const codexDir =
    opts.codexSessionsDir ??
    process.env.GLEAN_CODEX_SESSIONS_DIR ??
    path.join(homedir(), ".codex", "sessions");
  const codex = findCodexTranscript(codexDir, sessionId);
  if (codex) return { path: codex, host: "codex" };

  return null;
}

// Read the transcript, capping at maxBytes. Transcripts can be large; when
// oversize we keep the TAIL because the most recent activity is the most
// relevant to the feedback being given.
export function readTranscript(
  filePath: string,
  maxBytes: number = feedbackMaxBytes(),
): TranscriptRead {
  const totalBytes = fs.statSync(filePath).size;
  if (totalBytes <= maxBytes) {
    const text = fs.readFileSync(filePath, "utf-8");
    return { text, bytes: Buffer.byteLength(text), totalBytes, truncated: false };
  }

  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, totalBytes - maxBytes);
    // Drop the leading partial line so the tail starts at a clean JSONL record.
    let text = buf.toString("utf-8");
    const nl = text.indexOf("\n");
    if (nl >= 0) text = text.slice(nl + 1);
    return { text, bytes: Buffer.byteLength(text), totalBytes, truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

export function feedbackMaxBytes(): number {
  const raw = process.env.GLEAN_FEEDBACK_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

// The UUID filename is globally unique, so scan project subdirs for it rather
// than reconstruct Claude Code's lossy cwd-encoding scheme.
function findClaudeTranscript(
  projectsDir: string,
  sessionId: string,
): string | null {
  const fileName = `${sessionId}.jsonl`;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsDir, entry.name, fileName);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

// Codex names files rollout-<ts>-<uuid>.jsonl under a YYYY/MM/DD tree; match on
// the trailing uuid segment.
function findCodexTranscript(
  sessionsDir: string,
  sessionId: string,
): string | null {
  return walkForSuffix(sessionsDir, `-${sessionId}.jsonl`, 4 /*maxDepth*/);
}

function walkForSuffix(
  dir: string,
  suffix: string,
  maxDepth: number,
): string | null {
  if (maxDepth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(suffix)) return full;
    if (entry.isDirectory()) {
      const found = walkForSuffix(full, suffix, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
