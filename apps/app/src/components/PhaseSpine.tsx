import type { Run, RunEvent, RunStatus } from "@brevi/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { clock, duration } from "../lib/format";
import { PHASES, STATUS_TONE, isTerminal, phaseIndex } from "../lib/status";

/**
 * The spine: five notches a run passes through, left to right. History is cold
 * and solid, the future is a dashed hairline, and the only moving thing on the
 * board is the segment the run is travelling right now.
 */
export function PhaseSpine({
  run,
  events,
  now,
}: {
  run: Run;
  events: RunEvent[];
  now: number;
}) {
  const stamps = new Map<RunStatus, string>();
  for (const e of events) if (e.type === "status" && !stamps.has(e.status)) stamps.set(e.status, e.ts);
  if (!stamps.has("queued")) stamps.set("queued", run.createdAt);
  if (run.startedAt && !stamps.has("running")) stamps.set("running", run.startedAt);
  if (run.finishedAt && !stamps.has(run.status)) stamps.set(run.status, run.finishedAt);

  const terminal = isTerminal(run.status);
  const index = phaseIndex(run.status);
  const tone = STATUS_TONE[run.status];

  const nodes = [
    ...PHASES.map((phase, i) => ({
      key: phase,
      label: STATUS_TONE[phase].label,
      ts: stamps.get(phase),
      state: terminal || i < index ? "done" : i === index ? "active" : ("pending" as const),
      tone: STATUS_TONE[phase],
    })),
    {
      key: "terminal",
      label: terminal ? tone.label : "Done",
      ts: terminal ? stamps.get(run.status) : undefined,
      state: terminal ? "active" : ("pending" as const),
      tone,
    },
  ];

  return (
    <div className="panel px-4 py-3.5">
      <div className="flex items-start">
        {nodes.map((node, i) => {
          const last = i === nodes.length - 1;
          return (
            <div
              key={node.key}
              className={`flex flex-col ${last ? "w-[88px] shrink-0" : "min-w-0 flex-1"}`}
            >
              <div className="flex h-[9px] items-center">
                <span
                  className={`block size-[9px] shrink-0 rounded-[2px] ${
                    node.state === "pending"
                      ? "bg-transparent shadow-[inset_0_0_0_1.5px_var(--color-ink-500)]"
                      : node.state === "active"
                        ? `${node.tone.fill} ${node.tone.fg} ${run.status === "running" ? "animate-beacon" : ""}`
                        : "bg-haze-700"
                  }`}
                />
                {!last && (
                  <span
                    className={`mx-2 h-[2px] min-w-4 flex-1 rounded-full ${
                      terminal || i < index
                        ? "bg-ink-500"
                        : i === index
                          ? "track-active animate-sweep"
                          : "track-pending"
                    }`}
                    aria-hidden="true"
                  />
                )}
              </div>

              <span
                className={`plate mt-2.5 truncate ${
                  node.state === "active"
                    ? node.tone.fg
                    : node.state === "done"
                      ? "text-haze-600"
                      : "text-haze-700"
                }`}
              >
                {node.label}
              </span>
              <span className="mt-1.5 font-mono text-[10px] leading-none text-haze-700">
                {node.ts ? clock(node.ts) : "··:··:··"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-ink-700 pt-3">
        <Field label="Elapsed">
          {run.finishedAt && run.startedAt
            ? duration(run.startedAt, Date.parse(run.finishedAt))
            : duration(run.startedAt ?? run.createdAt, now)}
        </Field>
        <Field label="Sandbox">{run.sandbox.provider}</Field>
        {run.sandbox.id && <Field label="VM">{run.sandbox.id}</Field>}
        <Field label="Run">{run.id}</Field>
      </div>

      {run.error && (
        <Alert
          variant="destructive"
          className="mt-3 rounded-[5px] border-rust-500/35 bg-rust-500/8 p-3"
        >
          <AlertTitle className="plate text-rust-400">Error</AlertTitle>
          <AlertDescription className="mt-1 font-mono text-[11.5px] leading-relaxed text-wrap break-words whitespace-pre-wrap text-rust-400/90 md:text-wrap">
            {run.error}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="plate shrink-0 text-haze-700">{label}</span>
      <span className="truncate font-mono text-[11px] text-haze-300">{children}</span>
    </span>
  );
}
