import { useMemo } from "react";
import type React from "react";
import type { Run } from "@brevi/shared";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./components/AppSidebar";
import { ConfigurationPage } from "./components/Configuration";
import { Overview } from "./components/Overview";
import { RunDetail } from "./components/RunDetail";
import { Setup } from "./components/Setup";
import { SiteHeader } from "./components/SiteHeader";
import { Close, Warn } from "./components/Icons";
import { repoDisplay } from "./lib/repo";
import { isActive } from "./lib/status";
import { useNow } from "./lib/useNow";
import { useOrchestrator, type ConfigSection } from "./lib/useOrchestrator";

export default function App() {
  const {
    conn,
    runs,
    tickets,
    config,
    linearStatus,
    health,
    workers,
    events,
    busy,
    notice,
    selectedRun,
    selectedRunId,
    loaded,
    page,
    openRun,
    openConfig,
    runTicket,
    cancelRun,
    retryRun,
    archiveRun,
    unarchiveRun,
    followUpRun,
    dismissNotice,
    applyConfig,
    applyWorkers,
  } = useOrchestrator();

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

  /**
   * Queue a run and hand the new id back to the sidebar, which selects it via
   * its own openRun so the phone drawer closes over the fresh detail view.
   */
  const handleRun = async (ticketId: string): Promise<string | null> => {
    const run = await runTicket(ticketId);
    return run ? run.id : null;
  };

  return (
    <SidebarProvider
      className="h-svh min-h-svh overflow-hidden md:max-xl:[--sidebar-width:16rem]!"
      style={{ "--sidebar-width": "18rem" } as React.CSSProperties}
    >
      <AppSidebar
        tickets={tickets}
        runs={runs}
        now={now}
        selectedRunId={selectedRunId}
        activeByTicket={activeByTicket}
        config={config}
        linearStatus={linearStatus}
        health={health}
        workers={workers}
        busy={busy}
        unreachable={unreachable}
        page={page}
        onRun={handleRun}
        onOpenRun={openRun}
        onArchiveRun={(id) => void archiveRun(id)}
        onUnarchiveRun={(id) => void unarchiveRun(id)}
        onOpenConfig={() => openConfig()}
        onOpenWorkers={() => openConfig("workers")}
      />

      <SidebarInset className="flex h-svh min-w-0 flex-col overflow-hidden">
        <SiteHeader conn={conn} />

        {notice && (
          <Alert
            variant="destructive"
            className="shrink-0 items-center rounded-none border-x-0 border-t-0 border-rust-500/30 bg-rust-500/10 px-4 py-2 has-data-[slot=alert-action]:pr-12"
          >
            <Warn className="size-3.5 text-rust-400" />
            <AlertDescription className="text-[12.5px] text-rust-400">{notice}</AlertDescription>
            <AlertAction className="top-1/2 right-2.5 -translate-y-1/2">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={dismissNotice}
                aria-label="Dismiss"
                className="text-rust-400 hover:bg-rust-500/15 hover:text-rust-400"
              >
                <Close className="size-3" />
              </Button>
            </AlertAction>
          </Alert>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {page === "home" ? (
            selectedRun ? (
              <RunDetail
                run={selectedRun}
                repoName={repoDisplay(config, selectedRun.ticket.repo)}
                workers={workers}
                health={health}
                events={events[selectedRun.id] ?? []}
                now={now}
                busy={busy[selectedRun.id] === true}
                onCancel={() => void cancelRun(selectedRun.id)}
                onRetry={() => void retryRun(selectedRun.id)}
                onArchive={() =>
                  void (selectedRun.archivedAt ? unarchiveRun : archiveRun)(selectedRun.id)
                }
                onFollowUp={() => followUpRun(selectedRun.id)}
                onOpenWorkers={() => openConfig("workers")}
              />
            ) : (
              <Overview
                offline={unreachable}
                hasRuns={runs.length > 0}
                missingRun={selectedRunId !== null && loaded}
              />
            )
          ) : page === "setup" ? (
            <Setup
              config={config}
              linearStatus={linearStatus}
              onConfig={applyConfig}
              onDone={() => openRun(null)}
            />
          ) : (
            <ConfigurationPage
              config={config}
              runs={runs}
              workers={workers}
              linearStatus={linearStatus}
              health={health}
              section={page.slice("config:".length) as ConfigSection}
              onSection={openConfig}
              onConfig={applyConfig}
              onWorkers={applyWorkers}
            />
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
