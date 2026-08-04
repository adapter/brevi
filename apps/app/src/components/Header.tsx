import type { BreviConfig, HealthResponse } from "@brevi/shared";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { Connection } from "../lib/useOrchestrator";
import { Command, Plate } from "./Bits";

const CONNECTION = {
  connecting: { label: "Connecting", dot: "bg-haze-600", text: "text-haze-400", live: false },
  live: { label: "Live", dot: "bg-mint-500", text: "text-mint-400", live: true },
  reconnecting: { label: "Reconnecting", dot: "bg-ember-300", text: "text-ember-300", live: false },
  offline: { label: "Orchestrator offline", dot: "bg-rust-500", text: "text-rust-400", live: false },
} as const;

export function Header({
  conn,
  health,
  config,
  busy,
  showHint,
}: {
  conn: Connection;
  health: HealthResponse | null;
  config: BreviConfig | null;
  /** True while any run is active — the mark's top rule runs hot. */
  busy: boolean;
  /** Suppressed when the main pane is already showing the offline card. */
  showHint: boolean;
}) {
  const c = CONNECTION[conn];
  const provider = health?.sandboxProvider ?? config?.sandbox.provider;

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900/80 px-4 backdrop-blur-md">
      <div className="flex items-center gap-2.5">
        <img
          src="/logo.png"
          alt=""
          className={`size-[22px] ${busy ? "animate-beacon" : ""}`}
        />
        <span className="font-plate text-[15px] leading-none font-semibold tracking-[0.02em] text-haze-50">
          brevi
        </span>
        {health?.version && (
          <span className="mt-px font-mono text-[10.5px] leading-none text-haze-700">
            v{health.version}
          </span>
        )}
      </div>

      <Separator orientation="vertical" className="hidden h-4 self-center bg-ink-600 sm:block" />
      <Plate className="hidden text-haze-700 sm:block">Mission control</Plate>

      <div className="ml-auto flex items-center gap-2.5">
        {conn === "offline" && showHint && (
          <div className="hidden items-center gap-2 lg:flex">
            <Plate className="text-haze-700">Start it with</Plate>
            <Command text="npx @brevi/cli ui" />
          </div>
        )}

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
