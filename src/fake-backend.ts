// Test-only deterministic backend for end-to-end / integration tests of
// run_code (PTC) and run_tool. ACTIVE ONLY when GLEAN_PTC_FAKE_BACKEND points
// at a JSON fixture file; otherwise every export is inert and production
// behavior is byte-identical. It lets tests simulate tool success/failure
// WITHOUT a live Glean gateway or OAuth, while exercising the real plugin code
// paths (ptcDispatch throw-on-failure/overflow/envelope, find_skills, etc.).
//
// Fixture shape: { "<effectiveToolName>": Outcome | Outcome[] }
//   - effectiveToolName is the downstream tool (for the run_tool gateway it's
//     arguments.tool_name; for direct/head tools and find_skills it's the name).
//   - An array scripts per-call-index behavior (so a loop can mix outcomes);
//     the last element repeats once exhausted.
import fs from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type Outcome =
  | { mode: "ok"; json?: unknown; text?: string }
  | { mode: "isError"; text?: string }
  | { mode: "malformed"; text?: string }
  | { mode: "throw"; message?: string }
  | { mode: "timeout"; delayMs?: number }
  | { mode: "big"; bytes?: number };

type Fixture = Record<string, Outcome | Outcome[]>;

export function fakeBackendActive(): boolean {
  return !!process.env.GLEAN_PTC_FAKE_BACKEND;
}

let cached: Fixture | undefined;
const callCounts = new Map<string, number>();

// Test-only: clear the cached fixture + per-tool call counters between cases.
export function resetFakeBackend(): void {
  cached = undefined;
  callCounts.clear();
}

function loadFixture(): Fixture {
  if (cached) return cached;
  cached = JSON.parse(
    fs.readFileSync(process.env.GLEAN_PTC_FAKE_BACKEND as string, "utf-8"),
  ) as Fixture;
  return cached;
}

function nextOutcome(tool: string): Outcome | undefined {
  const entry = loadFixture()[tool];
  if (entry === undefined) return undefined;
  if (Array.isArray(entry)) {
    const i = callCounts.get(tool) ?? 0;
    callCounts.set(tool, i + 1);
    return entry[Math.min(i, entry.length - 1)];
  }
  return entry;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fakeCallTool(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const tool =
    name === "run_tool"
      ? String((args as { tool_name?: unknown }).tool_name ?? "")
      : name;
  const outcome = nextOutcome(tool);
  if (!outcome) {
    // Unspecified tool → benign success so unrelated calls don't break a test.
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, tool }) }] };
  }
  switch (outcome.mode) {
    case "throw":
      throw new Error(outcome.message ?? "fake backend network error");
    case "timeout":
      await delay(outcome.delayMs ?? 60_000);
      return { content: [{ type: "text", text: "{}" }] };
    case "isError":
      return {
        content: [{ type: "text", text: outcome.text ?? "tool reported an error" }],
        isError: true,
      };
    case "malformed":
      return {
        content: [
          { type: "text", text: outcome.text ?? "cursor: abc\ndocuments[1]:" },
        ],
      };
    case "big":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ blob: "x".repeat(outcome.bytes ?? 7000) }),
          },
        ],
      };
    case "ok":
    default:
      return {
        content: [
          {
            type: "text",
            text: outcome.text ?? JSON.stringify(outcome.json ?? { ok: true }),
          },
        ],
      };
  }
}

// A minimal Client stand-in whose callTool routes to the fixture. Returned by
// createRemoteClient when the fake backend is active, so no socket/OAuth is used.
export function makeFakeClient(): import("@modelcontextprotocol/sdk/client/index.js").Client {
  return {
    async callTool(req: { name: string; arguments?: Record<string, unknown> }) {
      return fakeCallTool(req.name, req.arguments ?? {});
    },
    async listTools() {
      return { tools: [] };
    },
    async close() {
      /* no-op */
    },
  } as unknown as import("@modelcontextprotocol/sdk/client/index.js").Client;
}
