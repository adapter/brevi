import type { BreviConfig, HealthResponse } from "@brevi/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Connection, Page } from "../lib/useOrchestrator";
import { PROVIDERS } from "./Configuration";

const CONNECTION = {
  connecting: { label: "Connecting", dot: "bg-haze-600", text: "text-haze-400", live: false },
  live: { label: "Live", dot: "bg-mint-500", text: "text-mint-400", live: true },
  reconnecting: { label: "Reconnecting", dot: "bg-ember-300", text: "text-ember-300", live: false },
  offline: { label: "Orchestrator offline", dot: "bg-rust-500", text: "text-rust-400", live: false },
} as const;

export function SiteHeader({
  conn,
  health,
  config,
  page,
  onOpenConfig,
}: {
  conn: Connection;
  health: HealthResponse | null;
  config: BreviConfig | null;
  page: Page;
  onOpenConfig: () => void;
}) {
  const c = CONNECTION[conn];
  const provider = health?.sandboxProvider ?? config?.sandbox.provider;
  const disconnected = config !== null && PROVIDERS.some((spec) => !spec.connected(config));
  const onConfig = page === "config";

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-2.5 border-b border-ink-700 bg-ink-900/80 px-4 backdrop-blur-md">
      <Button
        variant="ghost"
        size="plate"
        aria-current={onConfig ? "page" : undefined}
        onClick={onOpenConfig}
        className={onConfig ? "bg-ink-750 text-haze-100 hover:bg-ink-750" : "text-haze-400"}
      >
        <span className="relative inline-flex">
          Configuration
          {disconnected && (
            <span
              className="absolute -top-1 -right-1.5 size-[6px] rounded-full bg-ember-400"
              role="img"
              aria-label="A connection needs attention"
              title="A connection needs attention"
            />
          )}
        </span>
      </Button>

      <div className="ml-auto flex items-center gap-2.5">
        {provider && (
          <Badge variant="secondary" className="hidden gap-1.5 px-2 py-1.5 sm:inline-flex">
            <span className="text-haze-700">Sandbox</span>
            <span className="font-mono text-[11px] leading-none tracking-normal normal-case text-haze-200">
              {provider}
            </span>
          </Badge>
        )}

        <Badge variant="secondary" className={`gap-2 px-2 py-1.5 ${c.text}`}>
          <span
            className={`inline-block size-[7px] shrink-0 rounded-full ${c.dot} ${
              c.live || conn === "reconnecting" ? "animate-beacon" : ""
            }`}
          />
          {c.label}
        </Badge>
      </div>
    </header>
  );
}
