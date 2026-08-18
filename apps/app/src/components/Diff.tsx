import type { DiffLine } from "../lib/activity";

/**
 * Diff rendering shared by the activity feed's edit cards and the pull
 * request view's file diffs: a monospace table with GitHub-style tinting.
 */

export function DiffRow({ line }: { line: DiffLine }) {
  if (line.sign === "@") {
    return (
      <tr className="bg-ink-850">
        <td className="w-5 px-1.5 text-center text-haze-700 select-none" />
        <td className="px-2 whitespace-pre text-haze-600">{line.text}</td>
      </tr>
    );
  }
  const tone =
    line.sign === "+"
      ? { row: "bg-mint-500/10", sign: "text-mint-400", text: "text-haze-100" }
      : line.sign === "-"
        ? { row: "bg-rust-500/10", sign: "text-rust-400", text: "text-haze-400" }
        : { row: "", sign: "text-haze-700", text: "text-haze-400" };
  return (
    <tr className={tone.row}>
      <td className={`w-5 px-1.5 text-center select-none ${tone.sign}`}>
        {line.sign === " " ? "" : line.sign}
      </td>
      <td className={`px-2 whitespace-pre ${tone.text}`}>{line.text || " "}</td>
    </tr>
  );
}

export function DiffTable({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="overflow-x-auto bg-ink-900/60">
      <table className="w-full border-collapse font-mono text-[11px] leading-[1.65]">
        <tbody>
          {lines.map((line, i) => (
            <DiffRow key={i} line={line} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
