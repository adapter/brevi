/**
 * The orchestrator forwards the coding agent's stream-json output verbatim, typed
 * as `unknown`. This turns whatever arrives into a small set of blocks the console
 * knows how to draw, and never throws on a shape it has not seen.
 */

export type AgentBlock =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; target: string; detail: string }
  | { kind: "tool-result"; ok: boolean; text: string }
  | { kind: "note"; text: string }
  | { kind: "result"; ok: boolean; text: string; detail: string };

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function pretty(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

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
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ");
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return pretty(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isDict(part) && typeof part["text"] === "string") return part["text"];
      return pretty(part);
    })
    .join("\n")
    .trim();
}

function fromMessage(message: unknown, out: AgentBlock[]): void {
  if (!isDict(message)) return;
  const content = message["content"];
  if (typeof content === "string") {
    if (content.trim()) out.push({ kind: "text", text: content });
    return;
  }
  if (!Array.isArray(content)) return;

  for (const part of content) {
    if (!isDict(part)) continue;
    switch (part["type"]) {
      case "text": {
        const text = str(part["text"])?.trim();
        if (text) out.push({ kind: "text", text });
        break;
      }
      // Thinking is never shown as text; the console renders the run's
      // "thinking" events (spinner, then duration) in its place.
      case "thinking":
      case "redacted_thinking":
        break;
      case "tool_use":
      case "server_tool_use": {
        out.push({
          kind: "tool",
          name: str(part["name"]) ?? "tool",
          target: toolTarget(part["input"]),
          detail: pretty(part["input"]),
        });
        break;
      }
      case "tool_result": {
        const text = contentText(part["content"]);
        out.push({ kind: "tool-result", ok: part["is_error"] !== true, text });
        break;
      }
      default:
        break;
    }
  }
}

export function toAgentBlocks(event: unknown): AgentBlock[] {
  const out: AgentBlock[] = [];
  if (typeof event === "string") {
    if (event.trim()) out.push({ kind: "note", text: event.trim() });
    return out;
  }
  if (!isDict(event)) return out;

  const type = str(event["type"]);

  if (type === "assistant" || type === "user") {
    // A message may legitimately yield nothing (e.g. it only carried thinking);
    // never fall through to the raw dump below.
    fromMessage(event["message"] ?? event, out);
    return out;
  }
  if (type === "system") {
    const subtype = str(event["subtype"]) ?? "system";
    const model = str(event["model"]);
    const tools = Array.isArray(event["tools"]) ? event["tools"].length : undefined;
    const bits = [subtype, model, tools !== undefined ? `${tools} tools` : undefined].filter(
      Boolean,
    );
    out.push({ kind: "note", text: bits.join(" · ") });
  } else if (type === "result") {
    const ok = event["is_error"] !== true && str(event["subtype"]) !== "error";
    const turns = event["num_turns"];
    const ms = event["duration_ms"];
    const cost = event["total_cost_usd"];
    const bits = [
      typeof turns === "number" ? `${turns} turns` : undefined,
      typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : undefined,
      typeof cost === "number" ? `$${cost.toFixed(3)}` : undefined,
    ].filter(Boolean);
    out.push({
      kind: "result",
      ok,
      text: str(event["result"]) ?? (ok ? "Agent finished" : "Agent stopped with an error"),
      detail: bits.join("  ·  "),
    });
  } else if (typeof event["text"] === "string") {
    out.push({ kind: "text", text: event["text"] });
  } else if (type) {
    out.push({ kind: "note", text: type });
  }

  if (out.length === 0) out.push({ kind: "note", text: pretty(event) });
  return out;
}
