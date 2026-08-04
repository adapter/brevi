import type { Run, Ticket } from "@brevi/shared";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { duration, relative } from "../lib/format";
import { isActive } from "../lib/status";
import { Command, Plate, StatusChip, StatusDot } from "./Bits";
import { ChevronRight } from "./Icons";
import type { Connection } from "../lib/useOrchestrator";

export function RunsDashboard({
  runs,
  tickets,
  now,
  conn,
  loaded,
  onOpen,
}: {
  runs: Run[];
  tickets: Ticket[];
  now: number;
  conn: Connection;
  loaded: boolean;
  onOpen: (runId: string) => void;
}) {
  const active = runs.filter((r) => isActive(r.status)).length;
  const completed = runs.filter((r) => r.status === "completed").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const offline = conn === "offline" && !loaded;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Active" value={active} tone={active > 0 ? "text-ember-500" : undefined} live={active > 0} />
        <StatCard label="Queued" value={tickets.length} />
        <StatCard label="Completed" value={completed} tone={completed > 0 ? "text-mint-400" : undefined} />
        <StatCard label="Failed" value={failed} tone={failed > 0 ? "text-rust-400" : undefined} />
      </div>

      <Card className="gap-0 py-0">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ink-700/70 px-4">
          <Plate className="text-haze-400">Runs</Plate>
          <span className="font-mono text-[11px] leading-none text-haze-700">{runs.length}</span>
          {active > 0 && (
            <span className="ml-1 inline-flex items-center gap-1.5 text-ember-500">
              <StatusDot status="running" size={6} />
              <span className="plate">{active} active</span>
            </span>
          )}
        </div>

        {runs.length === 0 ? (
          <NoRuns offline={offline} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[110px] pl-4"><Plate className="text-haze-600">Status</Plate></TableHead>
                <TableHead className="w-[90px]"><Plate className="text-haze-600">Ticket</Plate></TableHead>
                <TableHead><Plate className="text-haze-600">Title</Plate></TableHead>
                <TableHead className="hidden md:table-cell"><Plate className="text-haze-600">Repo</Plate></TableHead>
                <TableHead className="hidden xl:table-cell"><Plate className="text-haze-600">Sandbox</Plate></TableHead>
                <TableHead className="w-[70px] text-right"><Plate className="text-haze-600">Elapsed</Plate></TableHead>
                <TableHead className="hidden w-[80px] text-right sm:table-cell"><Plate className="text-haze-600">Started</Plate></TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <RunRow key={run.id} run={run} now={now} onOpen={() => onOpen(run.id)} />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  live,
}: {
  label: string;
  value: number;
  tone?: string;
  live?: boolean;
}) {
  return (
    <Card size="sm" className="gap-1">
      <CardHeader className="gap-1">
        <CardDescription>
          <Plate className="text-haze-600">{label}</Plate>
        </CardDescription>
        <CardTitle
          className={`flex items-baseline gap-2 font-mono text-[26px] leading-none font-semibold tabular-nums ${tone ?? "text-haze-200"}`}
        >
          {value}
          {live && (
            <span className="inline-block size-[7px] animate-beacon rounded-[1.5px] bg-ember-500 text-ember-500" />
          )}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

function RunRow({ run, now, onOpen }: { run: Run; now: number; onOpen: () => void }) {
  const live = isActive(run.status);
  const span = live
    ? duration(run.startedAt ?? run.createdAt, now)
    : run.finishedAt && run.startedAt
      ? duration(run.startedAt, Date.parse(run.finishedAt))
      : "—";

  return (
    <TableRow onClick={onOpen} className="cursor-pointer border-ink-700/70 hover:bg-ink-800">
      <TableCell className="pl-4">
        <StatusChip status={run.status} />
      </TableCell>
      <TableCell className="font-plate text-[10px] tracking-[0.06em] text-haze-300">
        {run.ticket.identifier}
      </TableCell>
      <TableCell className="max-w-0 truncate text-[13px] text-haze-50">
        {run.ticket.title}
        {run.ticket.kind === "spike" && (
          <span className="plate ml-2 rounded-[3px] border border-iris-400/30 bg-iris-400/10 px-1.5 py-0.5 text-iris-400">
            Spike
          </span>
        )}
      </TableCell>
      <TableCell className="hidden font-mono text-[11px] text-haze-600 md:table-cell">
        {run.ticket.repo ?? "—"}
      </TableCell>
      <TableCell className="hidden xl:table-cell">
        <Plate className="text-haze-700">{run.sandbox.provider}</Plate>
      </TableCell>
      <TableCell className="text-right font-mono text-[11px] tabular-nums text-haze-300">
        {span}
      </TableCell>
      <TableCell className="hidden text-right font-mono text-[11px] text-haze-700 sm:table-cell">
        {relative(run.createdAt, now)}
      </TableCell>
      <TableCell>
        <ChevronRight className="size-3.5 text-haze-700" />
      </TableCell>
    </TableRow>
  );
}

function NoRuns({ offline }: { offline: boolean }) {
  if (offline) {
    return (
      <div className="flex justify-center px-8 py-14">
        <div className="max-w-md">
          <span className="inline-flex items-center gap-2 text-rust-400">
            <span className="inline-block size-[7px] rounded-full bg-rust-500" />
            <Plate>Orchestrator offline</Plate>
          </span>
          <h2 className="mt-2.5 text-[15px] text-haze-50">Nothing is listening on this port</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
            The dashboard talks to a brevi orchestrator running on your machine. Start one and this
            page reconnects on its own.
          </p>
          <div className="mt-3.5">
            <Command text="npx @brevi/cli ui" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-center px-8 py-14">
      <div className="max-w-sm text-center">
        <p className="text-[13.5px] text-haze-300">No runs yet</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-600">
          Run a ticket from the queue, or leave brevi to pick one up on its next pass through
          Linear. Everything it does shows up here.
        </p>
      </div>
    </div>
  );
}
