import type { BreviConfig, HealthResponse, Run } from "@brevi/shared";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { Connection } from "../lib/useOrchestrator";
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
  run,
  showHint,
  onBack,
}: {
  conn: Connection;
  health: HealthResponse | null;
  config: BreviConfig | null;
  /** The open run, if the detail view is showing. */
  run: Run | null;
  /** Suppressed when the main pane is already showing the offline card. */
  showHint: boolean;
  onBack: () => void;
}) {
  const c = CONNECTION[conn];
  const provider = health?.sandboxProvider ?? config?.sandbox.provider;

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900/80 px-4 backdrop-blur-md">
      <SidebarTrigger className="-ml-1 text-haze-400 hover:text-haze-50" />
      <Separator orientation="vertical" className="h-4 self-center bg-ink-600" />

      <Breadcrumb>
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem>
            <Plate className="text-haze-700">Mission control</Plate>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {run ? (
              <BreadcrumbLink
                onClick={onBack}
                className="plate cursor-pointer text-haze-400 hover:text-haze-50"
              >
                Runs
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage className="plate text-haze-300">Runs</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {run && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="font-plate text-[11px] tracking-[0.06em] text-haze-200">
                  {run.ticket.identifier}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>

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
