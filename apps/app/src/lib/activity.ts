import type { LimitInfo, RunEvent, RunStatus } from "@brevi/shared";

/**
 * Reduces a run's event stream into the activity feed the dashboard draws:
 * agent prose, thinking spells, file edits with real diffs, commands with
 * their output, and one compact row per remaining tool call. Handles Claude
 * Code's stream-json (assistant/user messages with tool_use and tool_result
 * parts) and both Codex stream formats, and never throws on unknown shapes.
 */

export type DiffLine = {
  /** "+" added, "-" removed, " " context, "@" hunk header. */
  sign: "+" | "-" | " " | "@";
  text: string;
};

export interface FileChange {
  path: string;
  verb: "edit" | "write" | "delete" | "rename";
  diff: DiffLine[];
  additions: number;
  deletions: number;
}

export interface TodoItem {
  text: string;
  state: "pending" | "in_progress" | "completed";
}

export type ActivityItem =
  | { kind: "message"; ts: string; text: string }
  | {
      kind: "thought";
      ts: string;
      durationMs: number;
      pending: boolean;
      pendingSince: number;
    }
  | { kind: "edit"; ts: string; changes: FileChange[]; ok?: boolean; error?: string }
  | {
      kind: "command";
      ts: string;
      command: string;
      description?: string;
      output?: string;
      ok?: boolean;
      /** Still awaiting its result while the run is live. */
      running: boolean;
    }
  | {
      kind: "action";
      ts: string;
      label: string;
      target: string;
      detail?: string;
      result?: string;
      ok?: boolean;
    }
  | { kind: "todos"; ts: string; todos: TodoItem[] }
  | { kind: "status"; ts: string; status: RunStatus }
  | { kind: "attempt"; ts: string; number: number }
  | { kind: "limit"; ts: string; limit: LimitInfo }
  | { kind: "artifact"; ts: string; name: string; type: string }
  | { kind: "outcome"; ts: string; ok: boolean; text: string; detail: string };

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Cap pathological payloads so a huge tool result cannot stall the feed. */
const MAX_OUTPUT = 20_000;
const clip = (text: string): string =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more characters)` : text;

// ---------------------------------------------------------------------------
// Line diffs

const count = (diff: DiffLine[]) => ({
  additions: diff.filter((l) => l.sign === "+").length,
  deletions: diff.filter((l) => l.sign === "-").length,
});

/**
 * Line-level LCS diff of two small strings (Edit's old_string/new_string are
 * already just the changed region). Falls back to remove-all/add-all when the
 * inputs are too large for the quadratic table.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text): DiffLine => ({ sign: "-", text })),
      ...b.map((text): DiffLine => ({ sign: "+", text })),
    ];
  }
  // lcs[i][j] = LCS length of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ sign: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ sign: "-", text: a[i]! });
      i++;
    } else {
      out.push({ sign: "+", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ sign: "-", text: a[i++]! });
  while (j < b.length) out.push({ sign: "+", text: b[j++]! });
  return out;
}

/** Parse a unified diff body (Codex or GitHub patches) into display lines. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) continue;
    if (line.startsWith("@@")) out.push({ sign: "@", text: line });
    else if (line.startsWith("+")) out.push({ sign: "+", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ sign: "-", text: line.slice(1) });
    else out.push({ sign: " ", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  // Trim the trailing blank a final newline leaves behind.
  while (out.length > 0 && out[out.length - 1]!.sign === " " && out[out.length - 1]!.text === "")
    out.pop();
  return out;
}

const allAdded = (content: string): DiffLine[] =>
  content.split("\n").map((text): DiffLine => ({ sign: "+", text }));

// ---------------------------------------------------------------------------
// Claude Code tool calls

/** The single most useful argument of a tool call, e.g. the file it touches. */
const TARGET_KEYS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "url",
  "query",
  "prompt",
  "description",
  "notebook_path",
];

function toolTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (!isDict(input)) return "";
  for (const key of TARGET_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return trimWorkspace(v.trim().replace(/\s+/g, " "));
  }
  return "";
}

/**
 * Absolute sandbox paths carry the whole workspace prefix
 * (~/.brevi/workspaces/<run>/workspace/...); the repo-relative tail is the
 * part worth reading.
 */
const trimWorkspace = (path: string): string => path.replace(/^\S*\/workspace\//, "");

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Human verb for a tool row, so the feed reads as a story rather than an API log. */
const TOOL_LABELS: Record<string, string> = {
  Read: "Read",
  Grep: "Searched",
  Glob: "Listed",
  LS: "Listed",
  WebFetch: "Fetched",
  WebSearch: "Searched the web",
  Task: "Ran a subagent",
  Agent: "Ran a subagent",
  ExitPlanMode: "Proposed a plan",
  AskUserQuestion: "Asked",
};

function claudeToolItem(ts: string, name: string, input: unknown): ActivityItem {
  const args = isDict(input) ? input : {};

  if (name === "Edit" && typeof args.old_string === "string" && typeof args.new_string === "string") {
    const diff = diffLines(args.old_string, args.new_string);
    return {
      kind: "edit",
      ts,
      changes: [{ path: trimWorkspace(str(args.file_path) ?? ""), verb: "edit", diff, ...count(diff) }],
    };
  }

  if (name === "MultiEdit" && Array.isArray(args.edits)) {
    const path = trimWorkspace(str(args.file_path) ?? "");
    const changes: FileChange[] = [];
    for (const edit of args.edits) {
      if (!isDict(edit)) continue;
      const before = str(edit.old_string) ?? "";
      const after = str(edit.new_string) ?? "";
      const diff = diffLines(before, after);
      changes.push({ path, verb: "edit", diff, ...count(diff) });
    }
    if (changes.length > 0) return { kind: "edit", ts, changes };
  }

  if (name === "Write" && typeof args.content === "string") {
    const diff = allAdded(args.content);
    return {
      kind: "edit",
      ts,
      changes: [{ path: trimWorkspace(str(args.file_path) ?? ""), verb: "write", diff, ...count(diff) }],
    };
  }

  if (name === "NotebookEdit" && typeof args.new_source === "string") {
    const diff = allAdded(args.new_source);
    return {
      kind: "edit",
      ts,
      changes: [{ path: trimWorkspace(str(args.notebook_path) ?? ""), verb: "edit", diff, ...count(diff) }],
    };
  }

  if (name === "Bash" && typeof args.command === "string") {
    return {
      kind: "command",
      ts,
      command: args.command,
      description: str(args.description),
      running: true,
    };
  }

  if (name === "TodoWrite" && Array.isArray(args.todos)) {
    const todos: TodoItem[] = [];
    for (const todo of args.todos) {
      if (!isDict(todo)) continue;
      const text = str(todo.content) ?? str(todo.activeForm);
      if (!text) continue;
      const state = todo.status;
      todos.push({
        text,
        state: state === "completed" ? "completed" : state === "in_progress" ? "in_progress" : "pending",
      });
    }
    if (todos.length > 0) return { kind: "todos", ts, todos };
  }

  return {
    kind: "action",
    ts,
    label: TOOL_LABELS[name] ?? name,
    target: toolTarget(input),
    detail: isDict(input) && Object.keys(input).length > 0 ? pretty(input) : undefined,
  };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : pretty(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isDict(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// The reducer

class Feed {
  readonly items: ActivityItem[] = [];
  /** Claude tool_use id (or Codex call/item id) -> the item awaiting its result. */
  readonly open = new Map<string, ActivityItem>();

  push(item: ActivityItem, id?: string): void {
    this.items.push(item);
    if (id) this.open.set(id, item);
  }

  resolve(id: string, ok: boolean, text: string): void {
    const item = this.open.get(id);
    if (!item) return;
    this.open.delete(id);
    if (item.kind === "command") {
      item.running = false;
      item.ok = ok;
      const trimmed = text.trim();
      if (trimmed) item.output = clip(trimmed);
    } else if (item.kind === "edit") {
      item.ok = ok;
      if (!ok && text.trim()) item.error = clip(text.trim());
    } else if (item.kind === "action") {
      item.ok = ok;
      const trimmed = text.trim();
      if (trimmed) item.result = clip(trimmed);
    }
  }
}

function fromClaudeMessage(feed: Feed, ts: string, message: unknown, prose: boolean): void {
  if (!isDict(message)) return;
  const content = message.content;
  if (typeof content === "string") {
    if (prose && content.trim()) feed.push({ kind: "message", ts, text: content });
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!isDict(part)) continue;
    switch (part.type) {
      case "text": {
        const text = str(part.text)?.trim();
        if (prose && text) feed.push({ kind: "message", ts, text });
        break;
      }
      case "tool_use":
      case "server_tool_use": {
        const item = claudeToolItem(ts, str(part.name) ?? "tool", part.input);
        feed.push(item, str(part.id));
        break;
      }
      case "tool_result": {
        const id = str(part.tool_use_id);
        if (id) feed.resolve(id, part.is_error !== true, resultText(part.content));
        break;
      }
      // Thinking parts never render; the run's own thinking events carry the
      // spinner and the summed duration.
      default:
        break;
    }
  }
}

/** Codex >= 0.44 items ({type: "item.completed", item: {...}}). */
function fromCodexItem(feed: Feed, ts: string, item: Dict, completed: boolean): void {
  const id = str(item.id);
  switch (item.item_type ?? item.type) {
    case "agent_message": {
      const text = str(item.text)?.trim();
      if (text && completed) feed.push({ kind: "message", ts, text });
      break;
    }
    case "reasoning": {
      const text = str(item.text)?.trim();
      if (text && completed)
        feed.push({ kind: "action", ts, label: "Reasoned", target: "", detail: text });
      break;
    }
    case "command_execution": {
      const command = str(item.command) ?? "";
      if (!completed) {
        if (command) feed.push({ kind: "command", ts, command, running: true }, id);
        break;
      }
      const existing = id ? feed.open.get(id) : undefined;
      const ok = item.exit_code === undefined ? item.status !== "failed" : item.exit_code === 0;
      const output = str(item.aggregated_output) ?? "";
      if (existing) {
        if (id) feed.resolve(id, ok, output);
      } else if (command) {
        const trimmed = output.trim();
        feed.push({
          kind: "command",
          ts,
          command,
          running: false,
          ok,
          ...(trimmed ? { output: clip(trimmed) } : {}),
        });
      }
      break;
    }
    case "file_change": {
      if (!completed || !Array.isArray(item.changes)) break;
      const changes: FileChange[] = [];
      for (const change of item.changes) {
        if (!isDict(change)) continue;
        const path = trimWorkspace(str(change.path) ?? "");
        const kind = str(change.kind);
        const diff = typeof change.diff === "string" ? parseUnifiedDiff(change.diff) : [];
        changes.push({
          path,
          verb: kind === "add" ? "write" : kind === "delete" ? "delete" : kind === "rename" ? "rename" : "edit",
          diff,
          ...count(diff),
        });
      }
      if (changes.length > 0)
        feed.push({ kind: "edit", ts, changes, ok: item.status !== "failed" });
      break;
    }
    case "web_search": {
      if (completed)
        feed.push({ kind: "action", ts, label: "Searched the web", target: str(item.query) ?? "" });
      break;
    }
    case "mcp_tool_call": {
      if (completed)
        feed.push({
          kind: "action",
          ts,
          label: [str(item.server), str(item.tool)].filter(Boolean).join(" · ") || "Tool call",
          target: "",
          ok: item.status !== "failed",
        });
      break;
    }
    case "todo_list": {
      if (!Array.isArray(item.items)) break;
      const todos: TodoItem[] = [];
      for (const todo of item.items) {
        if (!isDict(todo)) continue;
        const text = str(todo.text);
        if (text) todos.push({ text, state: todo.completed === true ? "completed" : "pending" });
      }
      if (todos.length > 0 && completed) feed.push({ kind: "todos", ts, todos });
      break;
    }
    case "error": {
      const text = str(item.message)?.trim();
      if (text) feed.push({ kind: "action", ts, label: "Error", target: text, ok: false });
      break;
    }
    default:
      break;
  }
}

/** Codex < 0.44 envelopes ({id, msg: {type: ...}}). */
function fromCodexEnvelope(feed: Feed, ts: string, id: string | undefined, msg: Dict): void {
  switch (msg.type) {
    case "agent_message": {
      const text = str(msg.message)?.trim();
      if (text) feed.push({ kind: "message", ts, text });
      break;
    }
    case "agent_reasoning": {
      const text = str(msg.text)?.trim();
      if (text) feed.push({ kind: "action", ts, label: "Reasoned", target: "", detail: text });
      break;
    }
    case "exec_command_begin": {
      const command = Array.isArray(msg.command)
        ? msg.command.filter((part): part is string => typeof part === "string").join(" ")
        : (str(msg.command) ?? "");
      if (command)
        feed.push({ kind: "command", ts, command, running: true }, str(msg.call_id) ?? id);
      break;
    }
    case "exec_command_end": {
      const callId = str(msg.call_id) ?? id;
      const ok = msg.exit_code === undefined || msg.exit_code === 0;
      const output = [str(msg.stdout), str(msg.stderr)].filter(Boolean).join("\n");
      if (callId) feed.resolve(callId, ok, output);
      break;
    }
    case "patch_apply_begin": {
      if (!isDict(msg.changes)) break;
      const changes: FileChange[] = [];
      for (const [rawPath, change] of Object.entries(msg.changes)) {
        const path = trimWorkspace(rawPath);
        if (!isDict(change)) continue;
        if (isDict(change.add) && typeof change.add.content === "string") {
          const diff = allAdded(change.add.content);
          changes.push({ path, verb: "write", diff, ...count(diff) });
        } else if (isDict(change.update)) {
          const diff =
            typeof change.update.unified_diff === "string"
              ? parseUnifiedDiff(change.update.unified_diff)
              : [];
          changes.push({ path, verb: "edit", diff, ...count(diff) });
        } else if (change.delete !== undefined) {
          changes.push({ path, verb: "delete", diff: [], additions: 0, deletions: 0 });
        }
      }
      if (changes.length > 0) feed.push({ kind: "edit", ts, changes }, str(msg.call_id) ?? id);
      break;
    }
    case "patch_apply_end": {
      const callId = str(msg.call_id) ?? id;
      if (callId) feed.resolve(callId, msg.success !== false, "");
      break;
    }
    case "task_complete": {
      const text = str(msg.last_agent_message)?.trim();
      if (text) feed.push({ kind: "message", ts, text });
      break;
    }
    default: {
      if (typeof msg.type === "string" && /error/i.test(msg.type)) {
        const text = str(msg.message)?.trim() ?? msg.type;
        feed.push({ kind: "action", ts, label: "Error", target: text, ok: false });
      }
      break;
    }
  }
}

function fromAgentEvent(feed: Feed, ts: string, event: unknown): void {
  if (!isDict(event)) return;
  const type = str(event.type);

  if (type === "assistant" || type === "user") {
    // User messages only matter for the tool results they carry; their text
    // parts (subagent prompts, injected reminders) are not agent prose.
    fromClaudeMessage(feed, ts, event.message ?? event, type === "assistant");
    return;
  }
  if (type === "result") {
    const ok = event.is_error !== true && str(event.subtype) !== "error";
    const turns = event.num_turns;
    const ms = event.duration_ms;
    const bits = [
      typeof turns === "number" ? `${turns} turns` : undefined,
      typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : undefined,
    ].filter(Boolean);
    feed.push({
      kind: "outcome",
      ts,
      ok,
      text: str(event.result) ?? (ok ? "Agent finished" : "Agent stopped with an error"),
      detail: bits.join("  ·  "),
    });
    return;
  }
  if ((type === "item.started" || type === "item.completed") && isDict(event.item)) {
    fromCodexItem(feed, ts, event.item, type === "item.completed");
    return;
  }
  if (isDict(event.msg)) {
    fromCodexEnvelope(feed, ts, str(event.id), event.msg);
    return;
  }
  if (type === "error" || event.is_error === true) {
    const text = str(event.message) ?? str(event.error) ?? pretty(event);
    feed.push({ kind: "action", ts, label: "Error", target: text, ok: false });
  }
  // Everything else (system init, stream deltas, token counts) is noise here.
}

/**
 * The whole feed. Consecutive thinking events coalesce into one thought row,
 * exactly like the raw console does, so a spell that streams as several
 * start/stop pairs reads as a single duration.
 */
export function toActivity(events: RunEvent[]): ActivityItem[] {
  const feed = new Feed();
  for (const event of events) {
    switch (event.type) {
      case "agent":
        fromAgentEvent(feed, event.ts, event.event);
        break;
      case "thinking": {
        const finished = event.phase === "finished";
        const last = feed.items[feed.items.length - 1];
        if (last?.kind === "thought") {
          if (finished) last.durationMs += event.durationMs ?? 0;
          else last.pendingSince = Date.parse(event.ts);
          last.pending = !finished;
        } else {
          feed.items.push({
            kind: "thought",
            ts: event.ts,
            durationMs: finished ? (event.durationMs ?? 0) : 0,
            pending: !finished,
            pendingSince: finished ? 0 : Date.parse(event.ts),
          });
        }
        break;
      }
      case "status":
        feed.items.push({ kind: "status", ts: event.ts, status: event.status });
        break;
      case "attempt":
        feed.items.push({ kind: "attempt", ts: event.ts, number: event.number });
        break;
      case "limit":
        feed.items.push({ kind: "limit", ts: event.ts, limit: event.limit });
        break;
      case "artifact":
        feed.items.push({
          kind: "artifact",
          ts: event.ts,
          name: event.artifact.name,
          type: event.artifact.type,
        });
        break;
      // Raw stdout/stderr/system lines stay in the Raw tab; costs surface in
      // the run's cost badge.
      default:
        break;
    }
  }
  return feed.items;
}
