// The plugin-owned `submit_feedback` tool. Records a thumbs up/down + optional
// comment (the lightweight feedback), and — when the admin has enabled capture
// and the user consents — attaches this session's transcript so Glean can debug
// multi-step skill orchestrations that run inside the host.
//
// Privacy controls (per the security review):
//   admin opt-out  -> GLEAN_SESSION_CAPTURE env gate (default off)
//   user opt-out   -> per-event consent elicitation + a persistent marker file
//   credentials    -> best-effort redaction before anything is written
// This POC writes a redacted artifact to local disk; the upload to Glean is
// stubbed.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { resolveSessionId } from "../session-id.js";
import { locateTranscript, readTranscript } from "../session-transcript.js";
import { redactSecrets } from "../redact.js";

// Matches index.ts's logLine signature; kept local so this tool doesn't depend
// on a shared logging type.
type LogFn = (label: string, detail?: Record<string, unknown>) => void;

const DEFAULT_CONSENT_TIMEOUT_MS = 300_000;

const CONSENT_MESSAGE =
  "Glean would like to attach this session's logs to your feedback.\n" +
  "This includes your prompts and the activity of OTHER tools/MCP servers in " +
  "this session — not just Glean's — and would be sent to Glean to debug the " +
  "plugin. Credentials are redacted on a best-effort basis before anything is " +
  "stored.\n" +
  "Allow capturing and sending this session?";

export const SUBMIT_FEEDBACK_TOOL: Tool = {
  name: "submit_feedback",
  description:
    "Record the user's feedback (thumbs up or down, with an optional comment) on " +
    "Glean's help in this session. Call this after completing a task end-to-end, or " +
    "when the user expresses satisfaction or dissatisfaction with Glean. When the " +
    "admin has enabled session-log capture, submitting feedback will — after the " +
    "user explicitly consents — also capture this session's transcript (the user's " +
    "prompts and other tools'/MCP servers' activity) so Glean can debug multi-step " +
    "skill orchestrations that run inside the host. Secrets are redacted best-effort " +
    "before anything is stored.",
  inputSchema: {
    type: "object" as const,
    properties: {
      vote: {
        type: "string",
        enum: ["up", "down"],
        description:
          'The user\'s sentiment: "up" (helpful) or "down" (not helpful).',
      },
      comment: {
        type: "string",
        description: "Optional free-text comment explaining the rating.",
      },
    },
    required: ["vote"],
  },
};

// Mirror runToolAnnotations: when our own consent elicitation is the gate, mark
// the tool readOnly so the host doesn't also raise its native confirmation and
// double-prompt the user.
export function submitFeedbackAnnotations(
  clientSupportsElicitation: boolean,
): Tool["annotations"] {
  return clientSupportsElicitation ? { readOnlyHint: true } : undefined;
}

export async function handleSubmitFeedback(
  mcpServer: Server,
  args: Record<string, unknown>,
  log?: LogFn,
): Promise<CallToolResult> {
  const vote = args.vote;
  if (vote !== "up" && vote !== "down") {
    return textResult('vote must be "up" or "down"', true);
  }
  const comment = typeof args.comment === "string" ? args.comment : "";

  // The vote+comment is the lightweight feedback and is always acknowledged;
  // everything below governs only the optional transcript capture.
  log?.("submit_feedback.vote", { vote, hasComment: comment.length > 0 });

  // (Admin opt-out) Default off; a deployment opts in via the launcher env.
  if (process.env.GLEAN_SESSION_CAPTURE !== "true") {
    return textResult(
      "Feedback recorded. Session-log capture is disabled by your admin, so no transcript was collected.",
    );
  }

  const sessionId = resolveSessionId();
  const loc = locateTranscript(sessionId);
  if (!loc) {
    return textResult(
      "Feedback recorded. No local session transcript was found for this host, so nothing was captured.",
    );
  }

  // (User opt-out, persistent) Skip without prompting.
  if (userOptedOut()) {
    log?.("submit_feedback.user-opted-out");
    return textResult(
      "Feedback recorded. You have opted out of session-log capture, so no transcript was collected.",
    );
  }

  // (User opt-out, per-event) Consent is mandatory: with no elicitation surface
  // we cannot obtain it, so we must NOT capture.
  if (!mcpServer.getClientCapabilities()?.elicitation) {
    return textResult(
      "Feedback recorded. This client can't show a consent prompt, so the session transcript was not captured.",
    );
  }
  try {
    const result = await mcpServer.elicitInput(
      {
        message: CONSENT_MESSAGE,
        requestedSchema: { type: "object", properties: {} } as any,
      },
      { timeout: consentTimeoutMs() },
    );
    log?.("submit_feedback.consent", { action: result.action });
    if (result.action !== "accept") {
      return textResult(
        `Feedback recorded. Session capture was ${result.action === "decline" ? "declined" : "cancelled"}; no transcript was collected.`,
      );
    }
  } catch (err) {
    // Fail CLOSED — a consent prompt that errors or times out must not capture.
    const detail = err instanceof Error ? err.message : String(err);
    log?.("submit_feedback.consent-failed", { msg: detail });
    return textResult(
      `Feedback recorded. The consent prompt failed (${detail}); no transcript was captured.`,
    );
  }

  // Consent granted — capture, redact, write the local artifact.
  try {
    const read = readTranscript(loc.path);
    const { text: redacted, counts } = redactSecrets(read.text);
    const redactionTotal = Object.values(counts).reduce((a, b) => a + b, 0);
    const artifactPath = writeArtifact({
      vote,
      comment,
      sessionId,
      host: loc.host,
      sourcePath: loc.path,
      truncated: read.truncated,
      redactionCounts: counts,
      transcript: redacted,
    });
    log?.("submit_feedback.captured", {
      host: loc.host,
      bytes: Buffer.byteLength(redacted),
      truncated: read.truncated,
      redactions: redactionTotal,
    });
    // Upload to Glean is STUBBED in this POC — the artifact stays local.
    log?.("submit_feedback.upload-stubbed", { artifactPath });
    return textResult(
      `Feedback recorded and session captured (consent granted).\n` +
        `Host: ${loc.host}\n` +
        `Artifact: ${artifactPath} (${Buffer.byteLength(redacted)} bytes${read.truncated ? ", tail-truncated" : ""})\n` +
        `Credential redactions: ${redactionTotal}\n` +
        `Note: upload to Glean is stubbed in this POC — the artifact is stored locally only.`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.("submit_feedback.capture-failed", { msg: detail });
    return textResult(
      `Feedback recorded, but capturing the session transcript failed: ${detail}`,
    );
  }
}

interface FeedbackArtifact {
  vote: string;
  comment: string;
  sessionId: string;
  host: string;
  sourcePath: string;
  truncated: boolean;
  redactionCounts: Record<string, number>;
  transcript: string;
}

function writeArtifact(artifact: FeedbackArtifact): string {
  const dir = path.join(pluginDataDir(), "feedback");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${artifact.sessionId}-${ts}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ capturedAt: new Date().toISOString(), ...artifact }, null, 2),
    { mode: 0o600 },
  );
  fs.chmodSync(file, 0o600);
  return file;
}

function userOptedOut(): boolean {
  try {
    return fs
      .statSync(path.join(pluginDataDir(), "feedback-capture-optout"))
      .isFile();
  } catch {
    return false;
  }
}

function pluginDataDir(): string {
  return process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
}

function consentTimeoutMs(): number {
  const raw = process.env.HITL_TIMEOUT_MS;
  if (!raw) return DEFAULT_CONSENT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CONSENT_TIMEOUT_MS;
}

function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}
