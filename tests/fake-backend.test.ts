import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRemoteClient, callRemoteTool } from "../src/remote-client.js";
import { fakeBackendActive, resetFakeBackend } from "../src/fake-backend.js";
import { handleRunCode } from "../src/tools/run-code.js";

// Exercises the test-only fake-backend shim (the e2e failure-injection seam):
// createRemoteClient returns an in-memory client, and callRemoteTool resolves
// outcomes from a JSON fixture — no socket, no OAuth.
describe("fake backend shim", () => {
  let dir: string;
  let fixture: string;
  let prev: string | undefined;

  async function setFixture(obj: unknown) {
    fixture = path.join(dir, "fx.json");
    await fs.writeFile(fixture, JSON.stringify(obj));
    process.env.GLEAN_PTC_FAKE_BACKEND = fixture;
    resetFakeBackend();
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-backend-"));
    prev = process.env.GLEAN_PTC_FAKE_BACKEND;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.GLEAN_PTC_FAKE_BACKEND;
    else process.env.GLEAN_PTC_FAKE_BACKEND = prev;
    resetFakeBackend();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("createRemoteClient short-circuits to the fake client when active", async () => {
    await setFixture({ X: { mode: "ok", json: { hello: 1 } } });
    expect(fakeBackendActive()).toBe(true);
    const client = await createRemoteClient("https://fake.test", {});
    // gateway shape: run_tool carries the real tool under arguments.tool_name
    const res = await callRemoteTool(client, "run_tool", {
      server_id: "s",
      tool_name: "X",
      arguments: {},
    });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ hello: 1 });
  });

  it("resolves isError / throw / per-call-index outcomes", async () => {
    await setFixture({
      FAIL: { mode: "isError", text: "boom" },
      BOOM: { mode: "throw", message: "ECONNRESET" },
      SEQ: [{ mode: "ok", json: { i: 0 } }, { mode: "isError", text: "second-call-failed" }],
    });
    const client = await createRemoteClient("https://fake.test", {});

    const fail = await callRemoteTool(client, "FAIL", {});
    expect(fail.isError).toBe(true);
    expect((fail.content[0] as { text: string }).text).toBe("boom");

    await expect(callRemoteTool(client, "BOOM", {})).rejects.toThrow("ECONNRESET");

    const a = await callRemoteTool(client, "SEQ", {});
    expect(a.isError).toBeFalsy();
    const b = await callRemoteTool(client, "SEQ", {});
    expect(b.isError).toBe(true); // per-call-index: second call fails
  });

  it("drives handleRunCode through the fake client (failure surfaces in envelope)", async () => {
    // skills cache so PTC_DEMO_WRITE is discoverable
    await fs.mkdir(path.join(dir, "demo", "tools"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "demo", "tools", "DEMO_FETCH.json"),
      JSON.stringify({ server_id: "s", requires_approval: false }),
    );
    await setFixture({ DEMO_FETCH: { mode: "isError", text: "PROJ-9 not found" } });

    const client = await createRemoteClient("https://fake.test", {});
    const server = {
      getClientCapabilities: () => ({}),
      async elicitInput() {
        return { action: "accept" };
      },
    } as never;

    const result = await handleRunCode(client, server, dir, {
      reset: true,
      // a failed tool call throws → the await rejects, the cell ends with ok:false
      code: `const r = await PTC_DEMO_FETCH({}); return "unreached";`,
    });
    const env = JSON.parse((result.content[0] as { text: string }).text);
    expect(env.ok).toBe(false);
    expect(env.value).toBeUndefined();
    expect(env.error.message).toBe("PTC_DEMO_FETCH failed: PROJ-9 not found");
    expect(env.ledger).toBeUndefined();
  });
});
