import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { callRemoteTool } from "../remote-client.js";
import {
  discoverTools,
  writeCoreTools,
  type HeadTool,
  type ToolMeta,
} from "../skill-tools.js";
import { invokeTool, requestToolApproval } from "./run-tool.js";

// ---------------------------------------------------------------------------
// Limits (env-overridable, mirroring GLEAN_FILE_ARG_MAX_BYTES).
// ---------------------------------------------------------------------------
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const TIMEOUT_MS = () => envInt("GLEAN_PTC_TIMEOUT_MS", 60_000);
const MAX_CALLS = () => envInt("GLEAN_PTC_MAX_CALLS", 200);
// Above this many chars, a return value / stdout is written to a file and the
// model gets a {shape, path} pointer instead of the data inline.
const MAX_INLINE_CHARS = () => envInt("GLEAN_PTC_MAX_INLINE_CHARS", 5_000);

const SHAPE_MAX_DEPTH = 6;
const SHAPE_MAX_KEYS = 40;
const ARRAY_SAMPLE = 5; // how many array elements to merge when inferring shape

let resultFileCounter = 0;

// ---------------------------------------------------------------------------
// Per-process persistent session. Intentionally simple: ONE vm context that
// lives for the lifetime of the plugin process. Only a BARE assignment
// (no var/let/const) attaches to the context global and persists across
// run_code calls — var/let/const are all function-local to the wrapping async
// IIFE and do NOT persist. Persists until the process exits or
// run_code({reset:true}). No TTL / LRU / heap eviction — host owns lifecycle.
// ---------------------------------------------------------------------------
let ctx: vm.Context | undefined;
let ctxFresh = false;
const sessionApproved = new Set<string>();

// Excerpt cap for a failed tool's error text in the thrown message.
const TOOL_ERROR_MAX = 300;

interface CallState {
  remoteClient: Client;
  mcpServer: Server;
  skillsBaseDir: string;
  toolsByName: Map<string, ToolMeta>;
  approved: Set<string>;
  stdout: string[];
  calls: number;
  deadline: number;
  aborted: boolean;
}

// The active call's state. Host functions injected into the vm read this; a
// module-level mutex guarantees only one run_code executes at a time, so a
// single slot is safe.
let current: CallState | undefined;

// Simple FIFO mutex so the shared context + `current` are never raced.
let lockTail: Promise<void> = Promise.resolve();
function acquireLock(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((res) => (release = res));
  const prev = lockTail;
  lockTail = lockTail.then(() => next);
  return prev.then(() => release);
}

// ---------------------------------------------------------------------------
// Host-side value summarizer (runs in this realm over vm values; Array.isArray
// and Object.keys both work cross-realm in the same process).
// ---------------------------------------------------------------------------
function shapeOf(v: unknown, depth: number, seen: WeakSet<object>): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "undefined") return "undefined";
  if (t === "bigint") return "bigint";
  if (t === "symbol") return "symbol";
  if (t === "function") return "function";
  const obj = v as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);
  if (Array.isArray(v)) {
    if (v.length === 0) return "Array<unknown>[0]";
    return `Array<${arrayElemShape(v, depth, seen)}>[${v.length}]`;
  }
  if (depth >= SHAPE_MAX_DEPTH) return "{…}";
  const keys = Object.keys(obj);
  const shown = keys.slice(0, SHAPE_MAX_KEYS);
  const parts = shown.map(
    (k) => `${k}: ${shapeOf((obj as Record<string, unknown>)[k], depth + 1, seen)}`,
  );
  const more = keys.length > shown.length ? ", …" : "";
  return `{ ${parts.join(", ")}${more} }`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Infer an array's element shape by MERGING the first ARRAY_SAMPLE elements,
// not just sampling element 0. For arrays of objects this unions keys across
// the sample and marks a key optional ("?") when it's absent from some
// elements — so e.g. calendar events show BOTH `start.date` (all-day) and
// `start.dateTime` (timed), instead of whichever the first row happened to be.
function arrayElemShape(
  arr: unknown[],
  depth: number,
  seen: WeakSet<object>,
): string {
  const sample = arr.slice(0, ARRAY_SAMPLE);
  const objs = sample.filter(isPlainObject);
  if (objs.length === sample.length && objs.length > 0) {
    if (depth + 1 >= SHAPE_MAX_DEPTH) return "{…}";
    const keyInfo = new Map<string, { shapes: Set<string>; count: number }>();
    for (const o of objs) {
      for (const k of Object.keys(o)) {
        const e = keyInfo.get(k) ?? { shapes: new Set<string>(), count: 0 };
        e.shapes.add(shapeOf(o[k], depth + 2, seen));
        e.count++;
        keyInfo.set(k, e);
      }
    }
    const keys = [...keyInfo.keys()].slice(0, SHAPE_MAX_KEYS);
    const parts = keys.map((k) => {
      const e = keyInfo.get(k)!;
      const optional = e.count < objs.length ? "?" : "";
      return `${k}${optional}: ${[...e.shapes].join(" | ")}`;
    });
    const more = keyInfo.size > keys.length ? ", …" : "";
    return `{ ${parts.join(", ")}${more} }`;
  }
  // Mixed or scalar elements: union of distinct element shapes.
  const uniq = [...new Set(sample.map((e) => shapeOf(e, depth + 1, seen)))];
  return uniq.join(" | ") || "unknown";
}

function shapeStr(v: unknown): string {
  return shapeOf(normalizeForSummary(v), 0, new WeakSet());
}

function serialize(v: unknown): string {
  try {
    const s = JSON.stringify(v, (_k, val) =>
      typeof val === "bigint" ? `${val}n` : val,
    );
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

function extractText(res: CallToolResult): string {
  if (!Array.isArray(res.content)) return "";
  return res.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// If the model returns a ToolResult directly, operate on the underlying data
// (parsed JSON, else raw text) rather than the wrapper's internal fields.
function normalizeForSummary(v: unknown): unknown {
  if (
    v &&
    typeof v === "object" &&
    (v as { __isToolResult?: boolean }).__isToolResult
  ) {
    const tr = v as { text?: string; __structured?: unknown };
    if (tr.__structured !== undefined && tr.__structured !== null) {
      return tr.__structured;
    }
    try {
      if (tr.text) return JSON.parse(tr.text);
    } catch {
      /* not JSON */
    }
    return tr.text ?? null;
  }
  return v;
}

// Overflow valve: write a too-large value/stdout to a file the model can Read
// (with offset/limit/grep). Lives in a sibling of the skills cache so it's in
// the host's workspace for sandboxed hosts. Best-effort; throws are caught by
// the caller. Date.now() is fine here (plugin runtime, not a workflow script).
function resultsDir(skillsBaseDir: string): string {
  return path.resolve(skillsBaseDir, "..", "glean-run-code-results");
}

async function writeOverflowFile(
  skillsBaseDir: string,
  kind: string,
  ext: string,
  content: string,
): Promise<string> {
  const dir = resultsDir(skillsBaseDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${Date.now()}-${resultFileCounter++}.${ext}`);
  await fs.writeFile(file, content, "utf-8");
  return file;
}

// ---------------------------------------------------------------------------
// vm preamble: ToolResult + helpers, defined once per fresh context.
// ---------------------------------------------------------------------------
const PREAMBLE = `
class ToolResult {
  constructor(raw) {
    this.__isToolResult = true;
    // A failed tool call throws before a ToolResult is ever constructed, so if
    // you are holding an \`r\`, the call succeeded.
    this.content = (raw && raw.content) || [];
    this.text = (raw && typeof raw.text === "string") ? raw.text : "";
    this.__structured = raw ? raw.structured : undefined;
    this.__parsed = false;
    this.__json = undefined;
  }
  json() {
    // Prefer the tool's structuredContent; fall back to parsing .text as JSON
    // (undefined if it isn't JSON — use .text then).
    if (this.__structured !== undefined && this.__structured !== null) {
      return this.__structured;
    }
    if (!this.__parsed) {
      this.__parsed = true;
      try { this.__json = JSON.parse(this.text); } catch { this.__json = undefined; }
    }
    return this.__json;
  }
  get(p, fallback) {
    let cur = this.json();
    if (cur === undefined) return fallback;
    for (const part of String(p).split(".")) {
      if (cur == null) return fallback;
      cur = cur[part];
    }
    return cur === undefined ? fallback : cur;
  }
  // "json" if .json() yields data, "empty" if there's no text, else "text"
  // (the output is prose/non-JSON — work with .text). Branch on this instead
  // of if(r.json()), which is the truthiness trap.
  get format() {
    const j = this.json();
    if (j !== undefined && j !== null) return "json";
    return (this.text || "").length > 0 ? "text" : "empty";
  }
}
globalThis.ToolResult = ToolResult;
globalThis.__mkResult = (raw) => new ToolResult(raw);
// inspect(x): return (and print) the STRUCTURE/shape of any value — never the
// data itself. For a ToolResult, say plainly whether it's JSON (and its shape)
// or non-JSON text, so the model isn't left guessing from a bare "string".
globalThis.inspect = (x) => {
  let out;
  if (x && x.__isToolResult) {
    const j = x.json();
    if (j !== undefined && j !== null) {
      out = __ptcShape(j);
    } else if ((x.text || "").length === 0) {
      out = "ToolResult: empty (no content)";
    } else {
      out =
        "ToolResult: non-JSON text (~" + (x.text || "").length +
        " chars) — .json() is undefined; use .text and parse it";
    }
  } else {
    out = __ptcShape(x);
  }
  __ptcPrint(out);
  return out;
};
globalThis.print = (...a) => __ptcPrint(a.map(String).join(" "));
`;

function ensureContext(reset: boolean): void {
  if (reset || !ctx) {
    ctx = vm.createContext({
      // Host bridges — stable closures reading module-level `current`.
      __ptcDispatch: ptcDispatch,
      __ptcShape: (v: unknown) => shapeStr(v),
      __ptcPrint: (s: string) => {
        if (current) current.stdout.push(s);
      },
    });
    vm.runInContext(PREAMBLE, ctx, { filename: "ptc-preamble.js" });
    sessionApproved.clear();
    ctxFresh = true;
  } else {
    ctxFresh = false;
  }
}

// The bridge each PTC_ binding calls. Enforces the runtime allowlist
// (just-in-time approval for any tool not bulk-approved), the call budget, and
// the wall-clock deadline. A failed tool call THROWS (`PTC_<tool> failed: …`)
// so the cell is self-contained: it either resolves to a ToolResult or throws.
async function ptcDispatch(
  toolName: string,
  args: unknown,
): Promise<{ content: unknown; text: string; structured?: unknown }> {
  const st = current;
  if (!st) throw new Error("PTC runtime is not active");
  if (st.aborted || Date.now() > st.deadline) {
    st.aborted = true;
    throw new Error("run_code wall-clock timeout exceeded");
  }
  const meta = st.toolsByName.get(toolName);
  if (!meta) {
    throw new Error(
      `Unknown tool PTC_${toolName} — not found in discovered skills. ` +
        `Call find_skills first, or check the name.`,
    );
  }
  if (st.calls >= MAX_CALLS()) {
    throw new Error(`run_code tool-call budget exceeded (${MAX_CALLS()} calls)`);
  }

  // Runtime allowlist backstop: anything not bulk-approved prompts now.
  if (meta.requiresApproval && !st.approved.has(toolName)) {
    const outcome = await requestToolApproval(
      st.mcpServer,
      st.skillsBaseDir,
      toolName,
      meta.serverId,
      {
        failClosed: true,
        // Pass what we already know so requestToolApproval doesn't re-scan the
        // whole skills tree from disk just to recheck requires_approval.
        requiresApproval: meta.requiresApproval,
        description: meta.description,
        message:
          `**${toolName}** (not pre-approved) is about to run.\n` +
          (meta.description ? `${meta.description}\n` : "") +
          `\nAccept to run it, or decline to stop.`,
      },
    );
    if (outcome.kind === "declined") {
      throw new Error(`Approval declined for PTC_${toolName}.`);
    }
    st.approved.add(toolName);
    sessionApproved.add(toolName);
  }

  st.calls++;

  let res;
  try {
    // Head/first-class tools dispatch directly by name; skill tools go through
    // the run_tool gateway (invokeTool handles file_args + server_id shaping).
    res = meta.direct
      ? await callRemoteTool(
          st.remoteClient,
          toolName,
          (args ?? {}) as Record<string, unknown>,
        )
      : await invokeTool(st.remoteClient, {
          serverId: meta.serverId,
          toolName,
          arguments: args ?? {},
        });
  } catch (err) {
    // Transport-level failure (network/timeout/lost response). Surface it as a
    // PTC_ failure so the cell sees a consistent error shape.
    const m = (err instanceof Error ? err.message : String(err)).slice(0, TOOL_ERROR_MAX);
    throw new Error(`PTC_${toolName} failed: ${m}`);
  }

  const text = extractText(res);
  const structured = (res as { structuredContent?: unknown }).structuredContent;
  if (res.isError) {
    // The tool ran but reported an error. Throw with the reason so the failure
    // is never silent — the model handles it with try/catch or lets it abort.
    throw new Error(
      `PTC_${toolName} failed: ${text.slice(0, TOOL_ERROR_MAX) || "(tool reported an error)"}`,
    );
  }
  return { content: res.content, text, structured };
}

// Static pre-scan: every tool call the model writes is `PTC_<NAME>(`.
function scanReferencedTools(code: string): string[] {
  const re = /\bPTC_([A-Za-z0-9_]+)\s*\(/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) found.add(m[1]);
  return [...found];
}

// Bindings are emitted on a SINGLE line (no internal newlines) so the user's
// code starts at a fixed, known line offset in ptc-cell.js. Each binding
// captures a cell-realm Error at the call site (`__site`) and stamps its stack
// onto any thrown error as `__ptcSite`. A PTC_ failure is thrown from the HOST
// realm (ptcDispatch), whose stack has no ptc-cell.js frame; `__ptcSite` is the
// only stack that carries the user's `await PTC_X(...)` line, so error.location
// can still be resolved for tool/transport/decline failures.
function bindingsSource(toolNames: string[]): string {
  return toolNames
    .map(
      (n) =>
        `globalThis.PTC_${n} = async (args) => { const __site = new Error(); try { return __mkResult(await __ptcDispatch(${JSON.stringify(n)}, args)); } catch (e) { try { if (e && typeof e === "object" && !e.__ptcSite) e.__ptcSite = __site.stack; } catch {} throw e; } };`,
    )
    .join("");
}

interface OverflowPointer {
  __overflow: true;
  shape: string;
  bytes: number;
  path: string;
}

// Every field except `ok` is optional and omitted when empty, so the common
// success envelope is tiny and failure info appears only when relevant.
interface RunCodeEnvelope {
  ok: boolean;
  value?: unknown; // verbatim when small; OverflowPointer when over the cap; omitted on error
  stdout?: string; // only when non-empty
  stdout_path?: string; // only when stdout overflowed to a file
  session?: { fresh: boolean }; // only when fresh
  hints?: string[];
  error?: { message: string; location?: string };
}

function makeEnvelope(content: string, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text: content }],
    ...(isError ? { isError: true } : {}),
  };
}

// Canonical error envelope for the early-return paths (empty code, approval
// declined, approval channel broke) so the LLM always sees a consistent shape.
function envelopeError(
  message: string,
  opts: { hints?: string[]; isError?: boolean } = {},
): CallToolResult {
  const env: RunCodeEnvelope = { ok: false, error: { message } };
  if (opts.hints?.length) env.hints = opts.hints;
  return makeEnvelope(JSON.stringify(env), opts.isError ?? false);
}

export async function handleRunCode(
  remoteClient: Client,
  mcpServer: Server,
  skillsBaseDir: string,
  args: Record<string, unknown>,
  headTools: HeadTool[] = [],
): Promise<CallToolResult> {
  const code = args.code;
  if (typeof code !== "string" || code.trim() === "") {
    return envelopeError("`code` must be a non-empty string.", { isError: true });
  }

  const reset = args.reset === true;

  const release = await acquireLock();
  const hints: string[] = [];
  try {
    ensureContext(reset);
    if (reset) hints.push("Session was reset — all prior variables were cleared.");

    // Materialize head/first-class tools so discoverTools binds them too.
    await writeCoreTools(skillsBaseDir, headTools);

    const allTools = await discoverTools(skillsBaseDir);
    const toolsByName = new Map<string, ToolMeta>();
    const collisions: string[] = [];
    // Bind direct (head) tools FIRST so they own the bare PTC_<name>; the
    // search/read_document overlap with skill-internal tools is expected and
    // not flagged. Only flag genuine skill-vs-skill (different server) clashes.
    const ordered = [
      ...allTools.filter((t) => t.direct),
      ...allTools.filter((t) => !t.direct),
    ];
    for (const t of ordered) {
      const existing = toolsByName.get(t.toolName);
      if (existing) {
        if (
          !existing.direct &&
          !t.direct &&
          existing.serverId !== t.serverId &&
          !collisions.includes(t.toolName)
        ) {
          collisions.push(t.toolName);
        }
        continue; // deterministic first-wins
      }
      toolsByName.set(t.toolName, t);
    }
    if (collisions.length) {
      hints.push(
        `Tool name collision across skills (used first match): ${collisions.join(", ")}.`,
      );
    }

    const referenced = scanReferencedTools(code);
    const unknown = referenced.filter((n) => !toolsByName.has(n));
    if (unknown.length) {
      hints.push(
        `Referenced unknown tools (will throw if called): ${unknown.map((n) => "PTC_" + n).join(", ")}.`,
      );
    }

    // ---- Bulk pre-scan approval -------------------------------------------
    const hitl = process.env.ENABLE_HITL === "true";
    const canElicit = !!mcpServer.getClientCapabilities()?.elicitation;
    const approved = new Set<string>(sessionApproved);
    const needApproval = referenced
      .map((n) => toolsByName.get(n))
      .filter((m): m is ToolMeta => !!m && m.requiresApproval && !approved.has(m.toolName));

    if (needApproval.length && hitl && canElicit) {
      const list = needApproval
        .map((m) => `• PTC_${m.toolName} — ${m.description?.split("\n")[0] || m.serverId}`)
        .join("\n");
      const message =
        `This code will run the following approval-required tools:\n\n${list}\n\n` +
        `Some may run inside loops — exact counts depend on data fetched at runtime.\n` +
        `Accept to approve all of them for this session, or decline to run nothing.`;
      try {
        const result = await mcpServer.elicitInput({
          message,
          requestedSchema: { type: "object", properties: {} } as never,
        });
        if (result.action !== "accept") {
          return envelopeError("Bulk approval declined; nothing ran.", {
            hints,
            isError: true,
          });
        }
        for (const m of needApproval) {
          approved.add(m.toolName);
          sessionApproved.add(m.toolName);
        }
      } catch {
        // Elicitation channel broke — fail closed for code mode.
        return envelopeError(
          "Approval channel unavailable; refusing to run approval-required tools.",
          { hints, isError: true },
        );
      }
    } else if (needApproval.length) {
      // No HITL configured (parity with run_tool): run without prompting.
      for (const m of needApproval) approved.add(m.toolName);
    }

    const state: CallState = {
      remoteClient,
      mcpServer,
      skillsBaseDir,
      toolsByName,
      approved,
      stdout: [],
      calls: 0,
      deadline: Date.now() + TIMEOUT_MS(),
      aborted: false,
    };
    current = state;

    // Refresh bindings (tool set may have changed) + run the user cell wrapped
    // in an async IIFE so top-level await and `return` work. Non-strict so a
    // bare assignment (`x = ...`) attaches to the persistent context global.
    // Bind every known tool plus any referenced-but-unknown name, so an
    // unknown PTC_ call yields a clear "Unknown tool" error from the bridge
    // rather than a raw ReferenceError.
    const bindNames = [...new Set([...toolsByName.keys(), ...referenced])];
    // Bindings on line 1, the async wrapper on line 2, so user code starts on
    // line 3. Bare assignment inside the async arrow attaches to the context
    // global (persists); top-level await + `return` work.
    const prefix = bindingsSource(bindNames) + "\n__ptcCell = (async () => {\n";
    const userLineOffset = prefix.split("\n").length - 1; // lines before user line 1
    const script = prefix + code + "\n})();\n";

    let value: unknown;
    let errorMessage: string | undefined;
    let errorStack: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      // The `timeout` option only bounds the SYNCHRONOUS portion (guards an
      // infinite sync loop before the first await); the real wall-clock guard
      // for async tool calls is the Promise.race below + the ptcDispatch deadline.
      vm.runInContext(script, ctx as vm.Context, {
        filename: "ptc-cell.js",
        timeout: TIMEOUT_MS(),
      });
      const cellPromise = (ctx as unknown as Record<string, unknown>)
        .__ptcCell as Promise<unknown>;
      const timeoutPromise = new Promise<never>((_res, rej) => {
        timer = setTimeout(() => {
          state.aborted = true;
          rej(new Error("run_code wall-clock timeout exceeded"));
        }, TIMEOUT_MS());
      });
      value = await Promise.race([cellPromise, timeoutPromise]);
    } catch (err) {
      // The error may originate in the vm realm, so `instanceof Error` is false
      // — read .message/.stack as properties (works cross-realm). For a PTC_
      // failure (thrown from the host realm), the binding stamps the cell-side
      // call stack onto `__ptcSite`; prefer it since the error's own stack has
      // no ptc-cell.js frame.
      const e = err as { message?: unknown; stack?: unknown; __ptcSite?: unknown };
      errorMessage = typeof e?.message === "string" ? e.message : String(err);
      errorStack =
        typeof e?.__ptcSite === "string"
          ? e.__ptcSite
          : typeof e?.stack === "string"
            ? e.stack
            : undefined;
    } finally {
      if (timer) clearTimeout(timer);
      state.aborted = true;
    }

    const cap = MAX_INLINE_CHARS();

    // ---- stdout: inline if small, else overflow to a file --------------------
    let stdout = state.stdout.join("\n");
    let stdoutPath: string | undefined;
    let stdoutOverflow = false;
    if (stdout.length > cap) {
      try {
        stdoutPath = await writeOverflowFile(skillsBaseDir, "stdout", "txt", stdout);
        stdout =
          stdout.slice(0, cap) +
          `\n…[stdout exceeded ${cap} chars — full output written to a file; see stdout_path]`;
      } catch {
        stdout = stdout.slice(0, cap) + "\n…[stdout truncated; could not write overflow file]";
      }
      stdoutOverflow = true;
    }

    // ---- value: VERBATIM if small, else write to a file + return a pointer ---
    let valueField: unknown;
    let valueOverflow = false;
    if (!errorMessage) {
      const norm = normalizeForSummary(value);
      const serialized = serialize(norm);
      if (serialized.length <= cap) {
        valueField = norm; // verbatim — no summarize, no truncation
      } else {
        const shape = shapeOf(norm, 0, new WeakSet());
        let p: string | undefined;
        try {
          p = await writeOverflowFile(skillsBaseDir, "value", "json", serialized);
        } catch {
          /* fall back to shape-only pointer below */
        }
        valueField = {
          __overflow: true,
          shape,
          bytes: serialized.length,
          path: p ?? "(file write failed)",
        } satisfies OverflowPointer;
        valueOverflow = true;
      }
    }

    // ---- outcome -----------------------------------------------------------
    // The cell is self-contained: it either returned a value or threw. A failed
    // tool call throws (`PTC_<tool> failed: …`), so `ok` is simply "didn't throw".
    const ok = !errorMessage;

    let errorLocation: string | undefined;
    if (errorMessage) {
      if (errorStack) {
        // Scan ALL ptc-cell.js frames and take the first that maps to a real
        // user line (ln >= 1). This skips the line-1 binding-definition frame
        // present in `__ptcSite`, leaving the user's `await PTC_X(...)` line; for
        // a plain cell-body error the first frame is already the user line.
        for (const m of errorStack.matchAll(/ptc-cell\.js:(\d+):/g)) {
          const ln = Number(m[1]) - userLineOffset;
          if (ln >= 1) {
            errorLocation = `cell line ${ln}`;
            break;
          }
        }
      }
      hints.push(
        "Cell threw (a failed PTC_ call throws too) — bare-assigned variables set " +
          "before the throw persist; any writes already made were NOT rolled back. " +
          "Wrap calls in try/catch to handle failures or continue a batch.",
      );
    }
    if (valueOverflow || stdoutOverflow) {
      hints.push(
        "Large output written to a file (value.path / stdout_path) — Read it for specifics; do NOT re-run tools.",
      );
    }

    const envelope: RunCodeEnvelope = { ok };
    if (valueField !== undefined) envelope.value = valueField;
    if (stdout) envelope.stdout = stdout;
    if (stdoutPath) envelope.stdout_path = stdoutPath;
    if (ctxFresh) envelope.session = { fresh: true };
    if (hints.length) envelope.hints = hints;
    if (errorMessage) {
      envelope.error = {
        message: errorMessage,
        ...(typeof errorLocation === "string" ? { location: errorLocation } : {}),
      };
    }

    return makeEnvelope(JSON.stringify(envelope), !ok);
  } finally {
    current = undefined;
    release();
  }
}
