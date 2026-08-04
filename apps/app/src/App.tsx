import { useMemo, useState } from "react";
import type { Run } from "@brevi/shared";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./components/AppSidebar";
import { ConnectionsSheet, PROVIDERS } from "./components/ConnectionsSheet";
import { RunDetail } from "./components/RunDetail";
import { RunsDashboard } from "./components/RunsDashboard";
import { SiteHeader } from "./components/SiteHeader";
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
    applyConfig,
  } = useOrchestrator();

  // The Connections sheet. Open by default on first run; the choice sticks
  // across sessions so a configured machine starts with it closed.
  const [connectionsOpen, setConnectionsOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem("brevi.connections.open");
    return saved === null ? true : saved === "1";
  });
  const toggleConnections = (next: boolean) => {
    setConnectionsOpen(next);
    localStorage.setItem("brevi.connections.open", next ? "1" : "0");
  };

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

  const connectedCount = config
    ? PROVIDERS.filter((spec) => spec.connected(config)).length
    : 0;
  const needsSetup = config !== null && config.linear.apiKey === "";

  const handleRun = async (ticketId: string) => {
    const run = await runTicket(ticketId);
    if (run) openRun(run.id);
  };

  return (
    <SidebarProvider className="h-svh min-h-svh overflow-hidden">
      <AppSidebar
        tickets={tickets}
        activeByTicket={activeByTicket}
        config={config}
        health={health}
        busy={busy}
        unreachable={unreachable}
        connectedCount={connectedCount}
        providerCount={PROVIDERS.length}
        needsSetup={needsSetup}
        onRun={(id) => void handleRun(id)}
        onOpenRun={openRun}
        onOpenConnections={() => toggleConnections(true)}
      />

      <SidebarInset className="flex h-svh min-w-0 flex-col overflow-hidden">
        <SiteHeader conn={conn} health={health} config={config} showHint={!offlineCard} />

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
            <RunsDashboard
              runs={runs}
              tickets={tickets}
              now={now}
              conn={conn}
              loaded={loaded || selectedRunId !== null}
              onOpen={openRun}
            />
          )}
        </div>
      </SidebarInset>

      <ConnectionsSheet
        open={connectionsOpen}
        onOpenChange={toggleConnections}
        config={config}
        onConfig={applyConfig}
      />
    </SidebarProvider>
  );
}
