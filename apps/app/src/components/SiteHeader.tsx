import type { BreviConfig, LinearStatus } from "@brevi/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { linearConnected, linearNeedsAttention } from "../lib/linear";
import type { Connection, Page } from "../lib/useOrchestrator";
import { PROVIDERS } from "./config/ConnectorsSection";

const CONNECTION = {
  connecting: { label: "Connecting", dot: "bg-haze-600", text: "text-haze-400", live: false },
  live: { label: "Live", dot: "bg-mint-500", text: "text-haze-400", live: true },
  reconnecting: { label: "Reconnecting", dot: "bg-iris-400", text: "text-haze-400", live: false },
  offline: { label: "Orchestrator offline", dot: "bg-rust-500", text: "text-rust-400", live: false },
} as const;

export function SiteHeader({
  conn,
  config,
  linearStatus,
  page,
  onOpenConfig,
}: {
  conn: Connection;
  config: BreviConfig | null;
  linearStatus: LinearStatus | null;
  page: Page;
  onOpenConfig: () => void;
}) {
  const c = CONNECTION[conn];
  const disconnected =
    config !== null &&
    (PROVIDERS.some((spec) => spec.id !== "linear" && !spec.connected(config)) ||
      !linearConnected(config, linearStatus) ||
      linearNeedsAttention(linearStatus));
  const onConfig = page.startsWith("config:");

  return (
    <header className="relative z-20 flex h-13 shrink-0 items-center gap-2.5 border-b border-ink-700 bg-background px-4">
      <SidebarTrigger className="-ml-1.5 text-haze-400 xl:hidden" aria-label="Toggle runs" />

      <Button
        variant="ghost"
        size="plate"
        aria-current={onConfig ? "page" : undefined}
        onClick={() => onOpenConfig()}
        className={onConfig ? "bg-ink-750 text-haze-100 hover:bg-ink-750" : "text-haze-400"}
      >
        <span className="relative inline-flex">
          Configuration
          {disconnected && (
            <span
              className="absolute -top-1 -right-1.5 size-[6px] rounded-full bg-iris-400"
              role="img"
              aria-label="A connection needs attention"
              title="A connection needs attention"
            />
          )}
        </span>
      </Button>

      <div className="ml-auto flex min-w-0 items-center gap-2.5">
        {/* `shrink` overrides the badge's shrink-0 so the label can truncate
            instead of the inset clipping the whole badge. */}
        <Badge variant="secondary" className={`min-w-0 shrink gap-2 px-2 py-1.5 ${c.text}`}>
          <span
            className={`inline-block size-[7px] shrink-0 rounded-full ${c.dot} ${
              c.live || conn === "reconnecting" ? "animate-beacon" : ""
            }`}
          />
          <span className="truncate">{c.label}</span>
        </Badge>
      </div>
    </header>
  );
}
