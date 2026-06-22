import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { locateTranscript, readTranscript } from "../src/session-transcript.js";

describe("locateTranscript", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finds a Claude Code transcript by session-id filename across project dirs", async () => {
    const projectsDir = path.join(tmpDir, "projects");
    const projDir = path.join(projectsDir, "-Users-me-some-repo");
    await fs.mkdir(projDir, { recursive: true });
    const id = "a6821330-8bfe-48e9-be0f-96cda782ac26";
    const file = path.join(projDir, `${id}.jsonl`);
    await fs.writeFile(file, '{"type":"user"}\n');

    expect(locateTranscript(id, { projectsDir })).toEqual({
      path: file,
      host: "claude-code",
    });
  });

  it("finds a Codex rollout transcript by trailing uuid under the date tree", async () => {
    const codexDir = path.join(tmpDir, "sessions");
    const dayDir = path.join(codexDir, "2026", "06", "11");
    await fs.mkdir(dayDir, { recursive: true });
    const id = "019eb4da-6149-7392-89a2-4401106d9b06";
    const file = path.join(dayDir, `rollout-2026-06-11T09-34-31-${id}.jsonl`);
    await fs.writeFile(file, '{"type":"session_meta"}\n');

    expect(
      locateTranscript(id, {
        projectsDir: path.join(tmpDir, "none"),
        codexSessionsDir: codexDir,
      }),
    ).toEqual({ path: file, host: "codex" });
  });

  it("returns null when no transcript matches the session id", () => {
    expect(
      locateTranscript("missing-id", {
        projectsDir: path.join(tmpDir, "projects"),
        codexSessionsDir: path.join(tmpDir, "sessions"),
      }),
    ).toBeNull();
  });

  it("returns null for an empty session id", () => {
    expect(locateTranscript("")).toBeNull();
  });
});

describe("readTranscript", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-read-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads the whole file when under the cap", async () => {
    const file = path.join(tmpDir, "t.jsonl");
    await fs.writeFile(file, "AAAA\nBBBB\n");
    const read = readTranscript(file, 1000);
    expect(read).toMatchObject({
      text: "AAAA\nBBBB\n",
      truncated: false,
      totalBytes: 10,
    });
  });

  it("keeps the tail and drops the partial leading line when oversize", async () => {
    const file = path.join(tmpDir, "t.jsonl");
    await fs.writeFile(file, "AAAA\nBBBB\nCCCC\nDDDD\n"); // 20 bytes
    const read = readTranscript(file, 8);
    expect(read.truncated).toBe(true);
    expect(read.totalBytes).toBe(20);
    expect(read.text).toBe("DDDD\n");
  });
});
