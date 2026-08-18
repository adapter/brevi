import type { BreviConfig, HealthResponse, LinearStatus, Run, Ticket, WorkerView } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";
import { duration, relative } from "../lib/format";
import { queueOnly } from "../lib/fleet";
import {
  linearConnected as isLinearConnected,
  linearNeedsAttention,
} from "../lib/linear";
import { repoDisplay } from "../lib/repo";
import { isActive, isTerminal, STATUS_TONE } from "../lib/status";
import type { Page } from "../lib/useOrchestrator";
import { Plate, StatusDot } from "./Bits";
import { PROVIDERS } from "./config/ConnectorsSection";
import { ChevronRight, Gear, Play, Repo } from "./Icons";
import { ThemeToggle } from "./ThemeToggle";

/** Everything one project (repo key) holds, in the order the list renders it. */
interface ProjectGroup {
  /** Repo key from config; "" collects tickets that resolve to no repo. */
  key: string;
  /** Short folder-style name shown in the header. */
  name: string;
  /** Full owner/name remote, for the hover title. */
  full?: string;
  active: Run[];
  queued: Run[];
  pending: Ticket[];
  finished: Run[];
}

export function AppSidebar({
  tickets,
  runs,
  now,
  selectedRunId,
  activeByTicket,
  config,
  linearStatus,
  health,
  workers,
  busy,
  unreachable,
  page,
  onRun,
  onOpenRun,
  onOpenConfig,
  onOpenWorkers,
}: {
  tickets: Ticket[];
  runs: Run[];
  now: number;
  selectedRunId: string | null;
  activeByTicket: Map<string, Run>;
  config: BreviConfig | null;
  linearStatus: LinearStatus | null;
  health: HealthResponse | null;
  workers: WorkerView[];
  busy: Record<string, true | undefined>;
  /** No orchestrator has answered yet, so an empty queue means nothing. */
  unreachable: boolean;
  page: Page;
  /** Queues a run for the ticket; resolves to the new run's id, or null. */
  onRun: (ticketId: string) => Promise<string | null>;
  onOpenRun: (runId: string) => void;
  onOpenConfig: () => void;
  /** Opens the Workers config page, for the queue-only notice below. */
  onOpenWorkers: () => void;
}) {
  // config === null still counts as connected so the connect card doesn't
  // flash before the first config arrives.
  const linearConnected = config === null || isLinearConnected(config, linearStatus);
  const linearAuthError = linearStatus?.state === "auth-error";
  const attention =
    config !== null &&
    (PROVIDERS.some((spec) => spec.id !== "linear" && !spec.connected(config)) ||
      !isLinearConnected(config, linearStatus) ||
      linearNeedsAttention(linearStatus));
  const onConfig = page.startsWith("config:");

  const { isMobile, setOpenMobile } = useSidebar();
  const openRun = (runId: string) => {
    if (isMobile) setOpenMobile(false);
    onOpenRun(runId);
  };

  /**
   * Runs that still need to happen: tickets with no run for their current
   * revision, the same (id, updatedAt) rule the scheduler queues by.
   */
  const pending = tickets.filter(
    (ticket) =>
      !runs.some((r) => r.ticket.id === ticket.id && r.ticket.updatedAt === ticket.updatedAt),
  );

  const projects = groupByProject(runs, pending, config);
  const runCount = runs.length + pending.length;

  const hostExecution = health?.hostExecution;
  const showQueueOnly = queueOnly(health, workers);

  return (
    <Sidebar collapsible="offcanvas" className="border-sidebar-border">
      <SidebarHeader className="h-13 justify-center border-b border-sidebar-border px-4">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="size-[22px]" />
          <span className="text-[14px] leading-none font-semibold text-haze-50">
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
            {runCount > 0 && (
              <span className="font-mono text-[10px] leading-none text-haze-700">{runCount}</span>
            )}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {showQueueOnly && hostExecution?.kind === "none" && (
              <QueueOnlyNotice reason={hostExecution.reason} onOpenWorkers={onOpenWorkers} />
            )}
            {runCount === 0 ? (
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
              <div className="flex flex-col gap-0.5 px-1">
                {projects.map((project) => (
                  <ProjectSection
                    key={project.key || "~none"}
                    project={project}
                    now={now}
                    selectedRunId={selectedRunId}
                    activeByTicket={activeByTicket}
                    busy={busy}
                    onRun={onRun}
                    onOpenRun={openRun}
                  />
                ))}
              </div>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        <button
          type="button"
          onClick={() => onOpenConfig()}
          aria-current={onConfig ? "page" : undefined}
          className={`touch-target flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
            onConfig
              ? "bg-ink-750 text-haze-50"
              : "text-haze-400 hover:bg-ink-800/70 hover:text-haze-100"
          }`}
        >
          <Gear className="size-3.5" />
          Configuration
          {attention && (
            <span
              className="ml-auto size-[6px] rounded-full bg-iris-400"
              role="img"
              aria-label="A connection needs attention"
              title="A connection needs attention"
            />
          )}
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * Bucket runs and pending tickets by their repo key. Within a project the
 * list keeps scheduler order: working runs first, then the queue in pickup
 * order (ascending queuedAt, since a requeue can push an old run to the back
 * without touching createdAt), then tickets not yet queued, then history.
 * Projects sort by name; tickets that resolve to no repo land last.
 */
function groupByProject(
  runs: Run[],
  pending: Ticket[],
  config: BreviConfig | null,
): ProjectGroup[] {
  const buckets = new Map<string, { runs: Run[]; tickets: Ticket[] }>();
  const bucket = (key: string) => {
    let entry = buckets.get(key);
    if (!entry) {
      entry = { runs: [], tickets: [] };
      buckets.set(key, entry);
    }
    return entry;
  };
  for (const run of runs) bucket(run.ticket.repo ?? "").runs.push(run);
  for (const ticket of pending) bucket(ticket.repo ?? "").tickets.push(ticket);

  return [...buckets.entries()]
    .map(([key, entry]): ProjectGroup => {
      const full = repoDisplay(config, key || undefined);
      const name = full ? (full.split("/").pop() ?? full) : "No project";
      return {
        key,
        name,
        full,
        active: entry.runs.filter((r) => isActive(r.status) && r.status !== "queued"),
        queued: entry.runs
          .filter((r) => r.status === "queued")
          .sort(
            (a, b) => Date.parse(a.queuedAt ?? a.createdAt) - Date.parse(b.queuedAt ?? b.createdAt),
          ),
        pending: entry.tickets,
        finished: entry.runs.filter((r) => isTerminal(r.status)),
      };
    })
    .sort((a, b) => {
      if (a.key === "") return 1;
      if (b.key === "") return -1;
      return a.name.localeCompare(b.name);
    });
}

/** One project: a folder header with its runs indented beneath it. */
function ProjectSection({
  project,
  now,
  selectedRunId,
  activeByTicket,
  busy,
  onRun,
  onOpenRun,
}: {
  project: ProjectGroup;
  now: number;
  selectedRunId: string | null;
  activeByTicket: Map<string, Run>;
  busy: Record<string, true | undefined>;
  onRun: (ticketId: string) => Promise<string | null>;
  onOpenRun: (runId: string) => void;
}) {
  const count =
    project.active.length + project.queued.length + project.pending.length + project.finished.length;

  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger
        className="group/project touch-target flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ink-800/60"
        title={project.full}
      >
        <ChevronRight className="size-3 shrink-0 text-haze-700 transition-transform group-data-[panel-open]/project:rotate-90" />
        <Repo className="size-3.5 shrink-0 text-haze-600" />
        <span className="min-w-0 truncate text-[12.5px] font-medium text-haze-200">
          {project.name}
        </span>
        <span className="ml-auto font-mono text-[10px] leading-none text-haze-700">{count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-px pb-1">
          {project.active.map((run) => (
            <li key={run.id}>
              <RunRow
                run={run}
                now={now}
                selected={run.id === selectedRunId}
                onOpen={() => onOpenRun(run.id)}
              />
            </li>
          ))}
          {project.queued.map((run) => (
            <li key={run.id}>
              <RunRow
                run={run}
                now={now}
                selected={run.id === selectedRunId}
                onOpen={() => onOpenRun(run.id)}
              />
            </li>
          ))}
          {project.pending.map((ticket) => (
            <li key={`ticket-${ticket.id}`}>
              <TicketRow
                ticket={ticket}
                active={activeByTicket.get(ticket.id)}
                busy={busy[ticket.id] === true}
                onRun={() => {
                  void onRun(ticket.id).then((runId) => {
                    if (runId !== null) onOpenRun(runId);
                  });
                }}
                onOpenRun={onOpenRun}
              />
            </li>
          ))}
          {project.finished.map((run) => (
            <li key={run.id}>
              <RunRow
                run={run}
                now={now}
                selected={run.id === selectedRunId}
                onOpen={() => onOpenRun(run.id)}
              />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One run as a compact row: status dot, title, and time. Everything else
 * (chips, costs, actions) lives on the run's own page; the row is a plain
 * link so copy link and middle-click behave normally.
 */
function RunRow({
  run,
  now,
  selected,
  onOpen,
}: {
  run: Run;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const live = isActive(run.status);
  const time =
    live && run.startedAt ? duration(run.startedAt, now) : relative(run.createdAt, now);

  return (
    <a
      href={`/runs/${encodeURIComponent(run.id)}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onOpen();
      }}
      aria-current={selected ? "page" : undefined}
      title={`${run.ticket.identifier}: ${run.ticket.title} (${STATUS_TONE[run.status].label})`}
      className={`flex items-center gap-2 rounded-lg py-1.5 pr-2 pl-[26px] transition-colors ${
        selected
          ? "bg-ink-750 text-haze-50"
          : "text-haze-300 hover:bg-ink-800/70 hover:text-haze-100"
      }`}
    >
      <StatusDot status={run.status} size={6} />
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{run.ticket.title}</span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-haze-600">{time}</span>
    </a>
  );
}

/**
 * A ticket with no run for its current revision. When an older revision's run
 * is still in flight the row points at it; otherwise it offers to queue one.
 */
function TicketRow({
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
  return (
    <div
      className="group/ticket flex items-center gap-2 rounded-lg py-1 pr-1 pl-[26px] text-haze-300 transition-colors hover:bg-ink-800/70"
      title={`${ticket.identifier}: ${ticket.title}`}
    >
      {active ? (
        <StatusDot status={active.status} size={6} />
      ) : (
        <span
          className="inline-block size-[6px] shrink-0 rounded-full border border-haze-600"
          aria-hidden="true"
        />
      )}
      <a
        href={ticket.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate text-[12.5px] hover:text-haze-100"
      >
        {ticket.title}
      </a>
      {active ? (
        <Button
          variant="ghost"
          size="plate"
          onClick={() => onOpenRun(active.id)}
          className={STATUS_TONE[active.status].fg}
        >
          {STATUS_TONE[active.status].label}
        </Button>
      ) : (
        <Button variant="outline" size="plate" onClick={onRun} disabled={busy}>
          <Play className="size-2.5" />
          {busy ? "Queueing" : "Run"}
        </Button>
      )}
    </div>
  );
}

/**
 * This machine cannot execute runs and nothing else is connected, so the
 * queue cannot drain. Shown whenever the condition holds, since the per-run
 * queueReason banner only appears once a run exists to carry it.
 */
function QueueOnlyNotice({
  onOpenWorkers,
}: {
  reason: "bwrap-unavailable" | "unsupported-platform";
  onOpenWorkers: () => void;
}) {
  return (
    <div className="mx-1 mb-2 rounded-lg border border-ink-700 bg-ink-850 p-3">
      <p className="text-[12px] leading-relaxed text-haze-400">
        This machine can&apos;t run agents itself. Queued runs will wait for a Linux worker with
        bubblewrap.{" "}
        Set up a Linux machine over SSH from the{" "}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 align-baseline text-[12px] text-haze-200 hover:text-haze-50"
          onClick={onOpenWorkers}
        >
          Workers page
        </Button>
        .
      </p>
    </div>
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
