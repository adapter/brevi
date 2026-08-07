import type { BreviConfig, HealthResponse, LinearStatus, Run, Ticket } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { Card } from "@/components/ui/card";
import { duration, relative } from "../lib/format";
import { linearConnected as isLinearConnected } from "../lib/linear";
import { repoDisplay } from "../lib/repo";
import { isActive, isTerminal, STATUS_TONE } from "../lib/status";
import { Plate, RepoChip, StatusDot } from "./Bits";
import { CostBadge } from "./CostBadge";
import { External, Play } from "./Icons";
import { ThemeToggle } from "./ThemeToggle";

export function AppSidebar({
  tickets,
  runs,
  now,
  selectedRunId,
  activeByTicket,
  config,
  linearStatus,
  health,
  busy,
  unreachable,
  onRun,
  onOpenRun,
}: {
  tickets: Ticket[];
  runs: Run[];
  now: number;
  selectedRunId: string | null;
  activeByTicket: Map<string, Run>;
  config: BreviConfig | null;
  linearStatus: LinearStatus | null;
  health: HealthResponse | null;
  busy: Record<string, true | undefined>;
  /** No orchestrator has answered yet, so an empty queue means nothing. */
  unreachable: boolean;
  onRun: (ticketId: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  // config === null still counts as connected so the connect card doesn't
  // flash before the first config arrives.
  const linearConnected = config === null || isLinearConnected(config, linearStatus);
  const linearAuthError = linearStatus?.state === "auth-error";

  /**
   * Runs that still need to happen: tickets with no run for their current
   * revision, the same (id, updatedAt) rule the scheduler queues by.
   */
  const pending = tickets.filter(
    (ticket) =>
      !runs.some((r) => r.ticket.id === ticket.id && r.ticket.updatedAt === ticket.updatedAt),
  );

  /**
   * In-flight runs split into "actively doing something" and "queued", the
   * latter reordered into scheduler pickup order (ascending queuedAt) since
   * a requeue can push an old run to the back without touching createdAt.
   */
  const active = runs.filter((r) => isActive(r.status) && r.status !== "queued");
  const queued = runs
    .filter((r) => r.status === "queued")
    .sort((a, b) => Date.parse(a.queuedAt ?? a.createdAt) - Date.parse(b.queuedAt ?? b.createdAt));
  const finished = runs.filter((r) => isTerminal(r.status));
  const inFlightCount = active.length + queued.length + pending.length;

  return (
    <Sidebar collapsible="none" className="h-svh w-[22rem] shrink-0 border-r border-sidebar-border">
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-4">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="size-[22px]" />
          <span className="font-plate text-[15px] leading-none font-semibold tracking-[0.02em] text-haze-50">
            brevi
          </span>
          {health?.version && (
            <span className="mt-px font-mono text-[10.5px] leading-none text-haze-700">
              v{health.version}
            </span>
          )}
          <span className="ml-auto">
            <ThemeToggle />
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="gap-2">
            <Plate className="text-haze-400">Runs</Plate>
            <span className="ml-auto">
              <Plate className="text-haze-700">Linear</Plate>
            </span>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {pending.length === 0 && runs.length === 0 ? (
              unreachable ? (
                <p className="px-2 py-2 text-[12.5px] leading-relaxed text-haze-700">
                  Runs appear once the orchestrator is running.
                </p>
              ) : !linearConnected ? (
                <ConnectLinearCard reconnect={linearAuthError} />
              ) : (
                <SummonCard config={config} />
              )
            ) : (
              <>
                {inFlightCount > 0 && (
                  <>
                    <SectionLabel label="In flight" />
                    <ul className="flex flex-col gap-2 px-1 pt-1">
                      {active.map((run) => (
                        <li key={run.id}>
                          <RunStrip
                            run={run}
                            repoName={repoDisplay(config, run.ticket.repo)}
                            now={now}
                            selected={run.id === selectedRunId}
                            onOpen={() => onOpenRun(run.id)}
                          />
                        </li>
                      ))}
                      {queued.map((run) => (
                        <li key={run.id}>
                          <RunStrip
                            run={run}
                            repoName={repoDisplay(config, run.ticket.repo)}
                            now={now}
                            selected={run.id === selectedRunId}
                            onOpen={() => onOpenRun(run.id)}
                          />
                        </li>
                      ))}
                      {pending.map((ticket) => (
                        <li key={`ticket-${ticket.id}`}>
                          <TicketStrip
                            ticket={ticket}
                            repoName={repoDisplay(config, ticket.repo)}
                            active={activeByTicket.get(ticket.id)}
                            busy={busy[ticket.id] === true}
                            onRun={() => onRun(ticket.id)}
                            onOpenRun={onOpenRun}
                          />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {finished.length > 0 && (
                  <div className={inFlightCount > 0 ? "mt-3 border-t border-sidebar-border" : ""}>
                    <SectionLabel label="Finished" />
                    <ul className="flex flex-col gap-2 px-1 pt-1">
                      {finished.map((run) => (
                        <li key={run.id}>
                          <RunStrip
                            run={run}
                            repoName={repoDisplay(config, run.ticket.repo)}
                            now={now}
                            selected={run.id === selectedRunId}
                            onOpen={() => onOpenRun(run.id)}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

/** Quiet sub-header inside the Runs group, matching the group's own label style. */
function SectionLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-2 pt-3 pb-1">
      <Plate className="text-haze-700">{label}</Plate>
    </div>
  );
}

function TicketStrip({
  ticket,
  repoName,
  active,
  busy,
  onRun,
  onOpenRun,
}: {
  ticket: Ticket;
  /** owner/name of the mapped repo, resolved from config. */
  repoName: string | undefined;
  active?: Run;
  busy: boolean;
  onRun: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const band = active ? STATUS_TONE[active.status].fill : "bg-peri-400/60";

  return (
    <Card size="sm" className="group flex-row gap-0 overflow-hidden rounded-strip py-0">
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
          <span className="ml-auto truncate font-mono text-[10px] text-haze-700">
            {ticket.state}
          </span>
        </div>

        <h3 className="mt-2 line-clamp-2 text-[13px] leading-snug text-haze-50">{ticket.title}</h3>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <RepoChip repo={repoName} />
          <span className="ml-auto">
            {active ? (
              <Button variant="outline" size="plate" onClick={() => onOpenRun(active.id)}>
                <StatusDot status={active.status} size={6} />
                <span className={STATUS_TONE[active.status].fg}>
                  {STATUS_TONE[active.status].label}
                </span>
              </Button>
            ) : (
              <Button size="plate" onClick={onRun} disabled={busy}>
                <Play className="size-3" />
                {busy ? "Queueing" : "Run"}
              </Button>
            )}
          </span>
        </div>
      </div>
    </Card>
  );
}

/**
 * One run in the sidebar: status, ticket, and elapsed time. A real anchor to
 * /runs/<id> (so copy link and middle-click behave like any link) that hands
 * plain left-clicks to the router.
 */
function RunStrip({
  run,
  repoName,
  now,
  selected,
  onOpen,
}: {
  run: Run;
  /** owner/name of the mapped repo, resolved from config. */
  repoName: string | undefined;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const tone = STATUS_TONE[run.status];
  const live = isActive(run.status);
  const span = live
    ? run.startedAt
      ? duration(run.startedAt, now)
      : "-"
    : run.finishedAt && run.startedAt
      ? duration(run.startedAt, Date.parse(run.finishedAt))
      : "-";

  return (
    <a
      href={`/runs/${encodeURIComponent(run.id)}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onOpen();
      }}
      aria-current={selected ? "page" : undefined}
      className={`flex overflow-hidden rounded-strip bg-card ring-1 transition-colors hover:bg-ink-800 ${
        selected ? "bg-ink-800 ring-haze-600/50" : "ring-foreground/10"
      }`}
    >
      <span className={`w-[3px] shrink-0 ${tone.fill}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-2.5">
        <div className="flex items-center gap-1.5">
          <StatusDot status={run.status} size={6} />
          <span className={`plate ${tone.fg}`}>{tone.label}</span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-haze-700">{span}</span>
        </div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="shrink-0 font-plate text-[10px] tracking-[0.08em] text-haze-300">
            {run.ticket.identifier}
          </span>
          <span className="truncate text-[12.5px] leading-snug text-haze-50">
            {run.ticket.title}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <RepoChip repo={repoName} />
          <CostBadge costs={run.costs} totals={run.costTotals} align="end" />
          <span className="ml-auto font-mono text-[10px] text-haze-700">
            {relative(run.createdAt, now)}
          </span>
        </div>
      </div>
    </a>
  );
}

/**
 * No ticket source: either Linear has never been connected, or a stored
 * credential has stopped authenticating and needs the user's attention.
 */
function ConnectLinearCard({ reconnect }: { reconnect?: boolean }) {
  if (reconnect) {
    return (
      <Card size="sm" className="mx-1 block p-4">
        <Plate className="text-haze-700">Ticket source disconnected</Plate>
        <h3 className="mt-2.5 text-[15px] leading-snug text-haze-50">Reconnect Linear</h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
          The stored Linear credential no longer authenticates, so polling is paused. Reconnect it
          from the Connectors section of the Configuration page to resume.
        </p>
      </Card>
    );
  }

  return (
    <Card size="sm" className="mx-1 block p-4">
      <Plate className="text-haze-700">No ticket source</Plate>
      <h3 className="mt-2.5 text-[15px] leading-snug text-haze-50">Connect Linear to begin</h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
        brevi polls Linear for issues assigned to you. Connect Linear in the panel on the right
        (and GitHub plus an agent key while you&apos;re there) and the queue fills itself.
      </p>
    </Card>
  );
}

/** First-run UX: the queue is empty because brevi has not been summoned yet. */
function SummonCard({ config }: { config: BreviConfig | null }) {
  const label = config?.trigger.label ?? "brevi";
  const poll = config?.pollIntervalSeconds ?? 60;

  return (
    <Card size="sm" className="mx-1 block p-4">
      <Plate className="text-haze-700">Nothing queued</Plate>
      <p className="mt-2 text-[12.5px] leading-relaxed text-haze-400">
        Assign yourself a Linear issue and add the {label} label; brevi picks it up and opens a
        pull request.
      </p>
      <p className="mt-3 border-t border-ink-700 pt-3 font-mono text-[11px] text-haze-700">
        Checking Linear every {poll}s
      </p>
    </Card>
  );
}
