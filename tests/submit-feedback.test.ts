import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  handleSubmitFeedback,
  submitFeedbackAnnotations,
  SUBMIT_FEEDBACK_TOOL,
} from "../src/tools/submit-feedback.js";

function makeServer(
  opts: { elicitation?: boolean; elicit?: ReturnType<typeof vi.fn> } = {},
) {
  return {
    getClientCapabilities: vi
      .fn()
      .mockReturnValue(opts.elicitation === false ? {} : { elicitation: {} }),
    getClientVersion: vi
      .fn()
      .mockReturnValue({ name: "claude-code", version: "1" }),
    elicitInput: opts.elicit ?? vi.fn().mockResolvedValue({ action: "accept" }),
  } as any;
}

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const SECRET_LINE =
  '{"type":"assistant","content":"the key is sk-abcdef0123456789ABCDEFGHIJ"}';
const OTHER_TOOL_LINE =
  '{"type":"assistant","tool":"mcp__conductor__AskUserQuestion"}';

describe("handleSubmitFeedback", () => {
  let tmpRoot: string;
  let projectsDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "submit-feedback-test-"));
    projectsDir = path.join(tmpRoot, "projects");
    dataDir = path.join(tmpRoot, "data");
    await fs.mkdir(dataDir, { recursive: true });
    const projDir = path.join(projectsDir, "-proj");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(
      path.join(projDir, `${SESSION_ID}.jsonl`),
      `${OTHER_TOOL_LINE}\n${SECRET_LINE}\n`,
    );
    vi.stubEnv("GLEAN_SESSION_ID", SESSION_ID);
    vi.stubEnv("GLEAN_CLAUDE_PROJECTS_DIR", projectsDir);
    vi.stubEnv("PLUGIN_DATA_DIR", dataDir);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function readArtifacts(): Promise<any[]> {
    const dir = path.join(dataDir, "feedback");
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: any[] = [];
    for (const n of names) {
      if (n.endsWith(".json")) {
        out.push(JSON.parse(await fs.readFile(path.join(dir, n), "utf-8")));
      }
    }
    return out;
  }

  function textOf(result: { content: unknown[] }): string {
    return (result.content[0] as { text: string }).text;
  }

  it("rejects an invalid vote", async () => {
    const result = await handleSubmitFeedback(makeServer(), { vote: "maybe" });
    expect(result.isError).toBe(true);
  });

  it("skips capture (no prompt) when the admin has not enabled it", async () => {
    vi.stubEnv("GLEAN_SESSION_CAPTURE", "false");
    const elicit = vi.fn();
    const result = await handleSubmitFeedback(
      makeServer({ elicitation: true, elicit }),
      { vote: "down" },
    );
    expect(elicit).not.toHaveBeenCalled();
    expect(await readArtifacts()).toHaveLength(0);
    expect(textOf(result)).toContain("disabled by your admin");
  });

  it("captures, redacts, and writes an artifact on consent", async () => {
    vi.stubEnv("GLEAN_SESSION_CAPTURE", "true");
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });

    const result = await handleSubmitFeedback(
      makeServer({ elicitation: true, elicit }),
      { vote: "down", comment: "bad result" },
    );

    expect(elicit).toHaveBeenCalledTimes(1);
    const artifacts = await readArtifacts();
    expect(artifacts).toHaveLength(1);
    const a = artifacts[0];
    expect(a.vote).toBe("down");
    expect(a.comment).toBe("bad result");
    expect(a.host).toBe("claude-code");
    // secret scrubbed; other tools' activity preserved (cross-tool capture proof)
    expect(a.transcript).not.toContain("sk-abcdef0123456789");
    expect(a.transcript).toContain("mcp__conductor__AskUserQuestion");
    expect(a.redactionCounts["openai-key"]).toBe(1);
    expect(textOf(result)).toContain("session captured");
  });

  it("does NOT capture when the user declines consent", async () => {
    vi.stubEnv("GLEAN_SESSION_CAPTURE", "true");
    const elicit = vi.fn().mockResolvedValue({ action: "decline" });
    const result = await handleSubmitFeedback(
      makeServer({ elicitation: true, elicit }),
      { vote: "down" },
    );
    expect(await readArtifacts()).toHaveLength(0);
    expect(textOf(result)).toContain("declined");
  });

  it("fails closed (no capture) when the consent prompt errors", async () => {
    vi.stubEnv("GLEAN_SESSION_CAPTURE", "true");
    const elicit = vi.fn().mockRejectedValue(new Error("timed out"));
    await handleSubmitFeedback(makeServer({ elicitation: true, elicit }), {
      vote: "up",
    });
    expect(await readArtifacts()).toHaveLength(0);
  });

  it("skips capture without prompting when the user has a persistent opt-out", async () => {
    vi.stubEnv("GLEAN_SESSION_CAPTURE", "true");
    fsSync.writeFileSync(path.join(dataDir, "feedback-capture-optout"), "");
    const elicit = vi.fn();
    const result = await handleSubmitFeedback(
      makeServer({ elicitation: true, elicit }),
      { vote: "down" },
    );
    expect(elicit).not.toHaveBeenCalled();
    expect(await readArtifacts()).toHaveLength(0);
    expect(textOf(result)).toContain("opted out");
  });

  it("skips capture when the client cannot show a consent prompt", async () => {
    vi.stubEnv("GLEAN_SESSION_CAPTURE", "true");
    const result = await handleSubmitFeedback(
      makeServer({ elicitation: false }),
      { vote: "down" },
    );
    expect(await readArtifacts()).toHaveLength(0);
    expect(textOf(result)).toContain("can't show a consent prompt");
  });

  it("records feedback but skips capture when no transcript is found", async () => {
    vi.stubEnv("GLEAN_SESSION_CAPTURE", "true");
    vi.stubEnv("GLEAN_SESSION_ID", "no-such-session-id");
    const elicit = vi.fn();
    const result = await handleSubmitFeedback(
      makeServer({ elicitation: true, elicit }),
      { vote: "up" },
    );
    expect(elicit).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("No local session transcript");
  });
});

describe("submitFeedbackAnnotations", () => {
  it("marks read-only when the client supports elicitation", () => {
    expect(submitFeedbackAnnotations(true)).toEqual({ readOnlyHint: true });
  });
  it("leaves annotations unset otherwise", () => {
    expect(submitFeedbackAnnotations(false)).toBeUndefined();
  });
});

describe("SUBMIT_FEEDBACK_TOOL", () => {
  it("requires a vote and offers an optional comment", () => {
    expect(SUBMIT_FEEDBACK_TOOL.name).toBe("submit_feedback");
    expect((SUBMIT_FEEDBACK_TOOL.inputSchema as any).required).toEqual(["vote"]);
  });
});
