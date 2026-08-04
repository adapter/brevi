import { useMemo } from "react";
import type { Run } from "@brevi/shared";
import { Header } from "./components/Header";
import { QueueRail } from "./components/QueueRail";
import { RunDetail } from "./components/RunDetail";
import { RunsList } from "./components/RunsList";
import { Close, Warn } from "./components/Icons";
import { isActive } from "./lib/status";
import { useNow } from "./lib/useNow";
import { useOrchestrator } from "./lib/useOrchestrator";

export default function App() {
  const {
    conn,
    runs,
    tickets,
    config,
    health,
    events,
    busy,
    notice,
    selectedRun,
    selectedRunId,
    loaded,
    openRun,
    runTicket,
    cancelRun,
    dismissNotice,
  } = useOrchestrator();

  // TEMP-REVIEW
  const h = typeof location !== "undefined" ? location.hash.slice(1) : "";
  useMemo(() => {
    if (h) setTimeout(() => openRun(h), 300);
  }, [h, openRun]);

  const anyActive = useMemo(() => runs.some((r) => isActive(r.status)), [runs]);
  const now = useNow(anyActive);

  /** The newest still-active run per ticket, so the queue never double-queues. */
  const activeByTicket = useMemo(() => {
    const map = new Map<string, Run>();
    for (const run of runs) {
      if (isActive(run.status) && !map.has(run.ticket.id)) map.set(run.ticket.id, run);
    }
    return map;
  }, [runs]);

  /** Nothing has answered yet: the main pane explains how to start one. */
  const unreachable = conn === "offline" && !loaded;
  const offlineCard = unreachable && !selectedRun;

  const handleRun = async (ticketId: string) => {
    const run = await runTicket(ticketId);
    if (run) openRun(run.id);
  };

  return (
    <div className="flex h-full flex-col">
      <Header
        conn={conn}
        health={health}
        config={config}
        busy={anyActive}
        showHint={!offlineCard}
      />

      {notice && (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-rust-500/30 bg-rust-500/10 px-4 py-2 text-rust-400">
          <Warn className="size-3.5 shrink-0" />
          <p className="min-w-0 flex-1 text-[12.5px]">{notice}</p>
          <button
            type="button"
            onClick={dismissNotice}
            aria-label="Dismiss"
            className="rounded-[3px] p-1 hover:bg-rust-500/15"
          >
            <Close className="size-3" />
          </button>
        </div>
      )}

      <main className="grid min-h-0 flex-1 grid-rows-[minmax(0,38vh)_minmax(0,1fr)] lg:grid-cols-[340px_minmax(0,1fr)] lg:grid-rows-1">
        <QueueRail
          tickets={tickets}
          activeByTicket={activeByTicket}
          config={config}
          unreachable={unreachable}
          busy={busy}
          onRun={(id) => void handleRun(id)}
          onOpenRun={openRun}
        />

        <section className="flex min-h-0 flex-col">
          {selectedRun ? (
            <RunDetail
              run={selectedRun}
              events={events[selectedRun.id] ?? []}
              now={now}
              busy={busy[selectedRun.id] === true}
              onBack={() => openRun(null)}
              onCancel={() => void cancelRun(selectedRun.id)}
            />
          ) : (
            <RunsList
              runs={runs}
              now={now}
              conn={conn}
              loaded={loaded || selectedRunId !== null}
              onOpen={openRun}
            />
          )}
        </section>
      </main>
    </div>
  );
}
