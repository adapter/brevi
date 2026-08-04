import type { BreviConfig, HealthResponse, Run, Ticket } from "@brevi/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Connection } from "../lib/useOrchestrator";
import { isActive } from "../lib/status";
import { useTheme, type ThemePref } from "../lib/useTheme";
import { Command, Plate } from "./Bits";
import { Monitor, Moon, Sun } from "./Icons";

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
  runs,
  tickets,
  showHint,
}: {
  conn: Connection;
  health: HealthResponse | null;
  config: BreviConfig | null;
  runs: Run[];
  tickets: Ticket[];
  /** Suppressed when the main pane is already showing the offline card. */
  showHint: boolean;
}) {
  const c = CONNECTION[conn];
  const provider = health?.sandboxProvider ?? config?.sandbox.provider;
  const active = runs.filter((r) => isActive(r.status)).length;
  const completed = runs.filter((r) => r.status === "completed").length;
  const failed = runs.filter((r) => r.status === "failed").length;

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-2.5 border-b border-ink-700 bg-ink-900/80 px-4 backdrop-blur-md">
      <div className="hidden items-center gap-4 md:flex">
        <Stat label="Active" value={active} tone={active > 0 ? "text-ember-500" : undefined} live={active > 0} />
        <Stat label="Queued" value={tickets.length} />
        <Stat label="Completed" value={completed} tone={completed > 0 ? "text-mint-400" : undefined} />
        <Stat label="Failed" value={failed} tone={failed > 0 ? "text-rust-400" : undefined} />
      </div>
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

        <ThemeToggle />
      </div>
    </header>
  );
}

function Stat({
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
    <span className="flex items-baseline gap-1.5">
      <Plate className="text-haze-700">{label}</Plate>
      <span
        className={`font-mono text-[13px] leading-none font-semibold tabular-nums ${tone ?? "text-haze-300"}`}
      >
        {value}
      </span>
      {live && (
        <span className="inline-block size-[6px] animate-beacon self-center rounded-[1.5px] bg-ember-500 text-ember-500" />
      )}
    </span>
  );
}

function ThemeToggle() {
  const [pref, setPref] = useTheme();
  const Icon = pref === "light" ? Sun : pref === "dark" ? Moon : Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Theme"
            title="Theme"
            className="text-haze-400"
          />
        }
      >
        <Icon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuRadioGroup
          value={pref}
          onValueChange={(value) => setPref(value as ThemePref)}
        >
          <DropdownMenuRadioItem value="light">
            <Sun className="size-3.5" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-3.5" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-3.5" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
