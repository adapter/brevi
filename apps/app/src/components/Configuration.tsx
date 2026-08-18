import type { BreviConfig, HealthResponse, LinearStatus, Run, WorkerView } from "@brevi/shared";
import type { ConfigSection } from "../lib/useOrchestrator";
import { AgentSection } from "./config/AgentSection";
import { ConnectorsSection } from "./config/ConnectorsSection";
import { MemorySection } from "./config/MemorySection";
import { OrchestratorSection } from "./config/OrchestratorSection";
import { RepositoriesSection } from "./config/RepositoriesSection";
import { ServerSection } from "./config/ServerSection";
import { WorkersSection } from "./config/WorkersSection";

const SECTIONS: { id: ConfigSection; label: string }[] = [
  { id: "connectors", label: "Connectors" },
  { id: "repositories", label: "Repositories" },
  { id: "agent", label: "Agent" },
  { id: "workers", label: "Workers" },
  { id: "memory", label: "Memory" },
  { id: "orchestrator", label: "Orchestrator" },
  { id: "server", label: "Server" },
];

/**
 * The Configuration page: every field of ~/.brevi/config.json, split into
 * subpages behind a submenu. Rendered in the main content area at
 * /config/<section>. Each control is hand-built against the zod schema in
 * @brevi/shared, which stays the single source of truth for validation,
 * defaults, and the help text below: a new config field is only done once
 * its control lands here too.
 */
export function ConfigurationPage({
  config,
  runs,
  workers,
  linearStatus,
  health,
  section,
  onSection,
  onConfig,
  onWorkers,
}: {
  config: BreviConfig | null;
  runs: Run[];
  workers: WorkerView[];
  linearStatus: LinearStatus | null;
  health: HealthResponse | null;
  section: ConfigSection;
  onSection: (section: ConfigSection) => void;
  onConfig: (config: BreviConfig) => void;
  onWorkers: (workers: WorkerView[]) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-5 sm:py-7 md:px-8">
      <header className="flex items-baseline gap-2.5">
        <h2 className="text-[16px] font-semibold text-haze-50">
          Configuration
        </h2>
      </header>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
        Everything in <code className="font-mono text-[11px]">~/.brevi/config.json</code>. Changes
        are written straight back to that file and, unless a field says otherwise, reach the next
        run without a restart.
      </p>

      <nav
        aria-label="Configuration sections"
        className="no-scrollbar mt-5 flex items-center gap-4 overflow-x-auto border-b border-ink-700"
      >
        {SECTIONS.map(({ id, label }) => {
          const active = section === id;
          return (
            <a
              key={id}
              href={`/config/${id}`}
              aria-current={active ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                onSection(id);
              }}
              className={`touch-target -mb-px shrink-0 border-b pb-2 text-[12px] font-medium whitespace-nowrap ${
                active ? "border-haze-50 text-haze-50" : "border-transparent text-haze-600 hover:text-haze-300"
              }`}
            >
              {label}
            </a>
          );
        })}
      </nav>

      {config ? (
        <>
          {/* Every section stays mounted while hidden. Unmounting would throw
              away a card's unsaved edits on a stray click in the submenu, with
              no warning and no way back, and it would drop an in-flight
              connect flow (GitHub device polling, a redirect or wrangler login
              wait) on the floor. */}
          <div hidden={section !== "connectors"}>
            <ConnectorsSection config={config} linearStatus={linearStatus} onConfig={onConfig} />
          </div>
          <div hidden={section !== "repositories"}>
            <RepositoriesSection
              config={config}
              runs={runs}
              linearStatus={linearStatus}
              onConfig={onConfig}
            />
          </div>
          <div hidden={section !== "agent"}>
            <AgentSection config={config} onConfig={onConfig} />
          </div>
          <div hidden={section !== "workers"}>
            <WorkersSection
              config={config}
              workers={workers}
              health={health}
              onConfig={onConfig}
              onWorkers={onWorkers}
            />
          </div>
          <div hidden={section !== "memory"}>
            <MemorySection config={config} onConfig={onConfig} />
          </div>
          <div hidden={section !== "orchestrator"}>
            <OrchestratorSection config={config} onConfig={onConfig} />
          </div>
          <div hidden={section !== "server"}>
            <ServerSection config={config} onConfig={onConfig} />
          </div>
        </>
      ) : (
        <p className="mt-6 text-[12.5px] leading-relaxed text-haze-700">
          Waiting for the orchestrator; configuration can be edited once it answers.
        </p>
      )}
    </div>
  );
}
