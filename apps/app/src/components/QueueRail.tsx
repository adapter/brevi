import type { BreviConfig, Run, Ticket } from "@brevi/shared";
import { STATUS_TONE } from "../lib/status";
import { Button, KindChip, Plate, RepoChip, StatusDot } from "./Bits";
import { External, Play } from "./Icons";

export function QueueRail({
  tickets,
  activeByTicket,
  config,
  busy,
  unreachable,
  onRun,
  onOpenRun,
}: {
  tickets: Ticket[];
  activeByTicket: Map<string, Run>;
  config: BreviConfig | null;
  busy: Record<string, true | undefined>;
  /** No orchestrator has answered yet, so an empty queue means nothing. */
  unreachable: boolean;
  onRun: (ticketId: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col border-b border-ink-700 bg-ink-900/50 lg:border-r lg:border-b-0">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ink-700/70 px-4">
        <Plate className="text-haze-400">Queue</Plate>
        <span className="font-mono text-[11px] leading-none text-haze-700">{tickets.length}</span>
        <span className="ml-auto">
          <Plate className="text-haze-700">Linear</Plate>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tickets.length === 0 ? (
          unreachable ? (
            <p className="px-1 py-2 text-[12.5px] leading-relaxed text-haze-700">
              The queue loads once the orchestrator is running.
            </p>
          ) : (
            <SummonCard config={config} />
          )
        ) : (
          <ul className="flex flex-col gap-2">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <TicketStrip
                  ticket={ticket}
                  active={activeByTicket.get(ticket.id)}
                  busy={busy[ticket.id] === true}
                  onRun={() => onRun(ticket.id)}
                  onOpenRun={onOpenRun}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function TicketStrip({
  ticket,
  active,
  busy,
  onRun,
  onOpenRun,
}: {
  ticket: Ticket;
  active?: Run;
  busy: boolean;
  onRun: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const band = active
    ? STATUS_TONE[active.status].fill
    : ticket.kind === "spike"
      ? "bg-iris-400/70"
      : "bg-peri-400/60";

  return (
    <article className="strip group flex overflow-hidden">
      <span className={`w-[3px] shrink-0 ${band}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-2.5">
        <div className="flex items-center gap-2">
          <a
            href={ticket.url}
            target="_blank"
            rel="noreferrer"
            className="group/id inline-flex items-center gap-1 font-plate text-[10px] tracking-[0.08em] text-haze-300 hover:text-haze-50"
          >
            {ticket.identifier}
            <External className="size-3 text-haze-700 opacity-0 transition-opacity group-hover/id:opacity-100" />
          </a>
          <KindChip kind={ticket.kind} />
          <span className="ml-auto truncate font-mono text-[10px] text-haze-700">
            {ticket.state}
          </span>
        </div>

        <h3 className="mt-2 line-clamp-2 text-[13px] leading-snug text-haze-50">{ticket.title}</h3>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <RepoChip repo={ticket.repo} />
          <span className="ml-auto">
            {active ? (
              <button
                type="button"
                onClick={() => onOpenRun(active.id)}
                className={`plate inline-flex items-center gap-1.5 rounded-[4px] border border-ink-600 px-2 py-1.5 ${STATUS_TONE[active.status].fg} hover:border-ink-500 hover:bg-ink-750`}
              >
                <StatusDot status={active.status} size={6} />
                {STATUS_TONE[active.status].label}
              </button>
            ) : (
              <Button tone="ember" onClick={onRun} disabled={busy}>
                <Play className="size-3" />
                {busy ? "Queueing" : "Run"}
              </Button>
            )}
          </span>
        </div>
      </div>
    </article>
  );
}

/** First-run UX: the queue is empty because brevi has not been summoned yet. */
function SummonCard({ config }: { config: BreviConfig | null }) {
  const tag = config?.trigger.tag ?? "@brevi";
  const label = config?.trigger.label ?? "brevi";
  const spike = config?.trigger.spikeMarker ?? "SPIKE";
  const poll = config?.pollIntervalSeconds ?? 60;

  const rules: [string, string][] = [
    ["Assignee", "The issue is assigned to you."],
    ["Trigger", `${tag} appears in the title or description, or the ${label} label is on it.`],
    ["Research", `Start the title with ${spike} to get a written answer instead of a PR.`],
  ];

  return (
    <div className="panel p-4">
      <Plate className="text-haze-700">Nothing queued</Plate>
      <h3 className="mt-2.5 text-[15px] leading-snug text-haze-50">How to summon brevi</h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
        brevi watches Linear and picks up issues that match all of these.
      </p>

      <dl className="mt-3.5 flex flex-col">
        {rules.map(([key, description]) => (
          <div key={key} className="border-t border-ink-700 py-3">
            <dt className="plate text-haze-700">{key}</dt>
            <dd className="mt-1.5 text-[12.5px] leading-relaxed text-haze-300">{description}</dd>
          </div>
        ))}
      </dl>

      <p className="border-t border-ink-700 pt-3 font-mono text-[11px] text-haze-700">
        Checking Linear every {poll}s
      </p>
    </div>
  );
}
