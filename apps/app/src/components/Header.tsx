import type { BreviConfig, HealthResponse } from "@brevi/shared";
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
        <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[18px] text-haze-300">
          <rect
            x="1"
            y="2.5"
            width="14"
            height="2.4"
            rx="1.2"
            className={busy ? "fill-ember-500" : "fill-haze-400"}
          />
          <rect x="1" y="6.8" width="10" height="2.4" rx="1.2" fill="currentColor" opacity="0.5" />
          <rect x="1" y="11.1" width="6" height="2.4" rx="1.2" fill="currentColor" opacity="0.24" />
        </svg>
        <span className="font-plate text-[15px] leading-none font-semibold tracking-[0.02em] text-haze-50">
          brevi
        </span>
        {health?.version && (
          <span className="mt-px font-mono text-[10.5px] leading-none text-haze-700">
            v{health.version}
          </span>
        )}
      </div>

      <span className="hidden h-4 w-px bg-ink-600 sm:block" />
      <Plate className="hidden text-haze-700 sm:block">Mission control</Plate>

      <div className="ml-auto flex items-center gap-2.5">
        {conn === "offline" && showHint && (
          <div className="hidden items-center gap-2 lg:flex">
            <Plate className="text-haze-700">Start it with</Plate>
            <Command text="npx @brevi/cli ui" />
          </div>
        )}

        {provider && (
          <span className="hidden items-center gap-1.5 rounded-[4px] border border-ink-600 bg-ink-800 px-2 py-1.5 sm:inline-flex">
            <Plate className="text-haze-700">Sandbox</Plate>
            <span className="font-mono text-[11px] leading-none text-haze-200">{provider}</span>
          </span>
        )}

        <span
          className={`inline-flex items-center gap-2 rounded-[4px] border border-ink-600 bg-ink-800 px-2 py-1.5 ${c.text}`}
        >
          <span
            className={`inline-block size-[7px] shrink-0 rounded-full ${c.dot} ${
              c.live || conn === "reconnecting" ? "animate-beacon" : ""
            }`}
          />
          <span className="plate">{c.label}</span>
        </span>
      </div>
    </header>
  );
}
