import type { BreviConfig, LinearStatus } from "@brevi/shared";
import type { ConfigSection } from "../lib/useOrchestrator";
import { ConnectorsSection } from "./config/ConnectorsSection";
import { RepositoriesSection } from "./config/RepositoriesSection";
import { SandboxSection } from "./config/SandboxSection";

const SECTIONS: { id: ConfigSection; label: string }[] = [
  { id: "connectors", label: "Connectors" },
  { id: "repositories", label: "Repositories" },
  { id: "sandbox", label: "Sandbox" },
];

/**
 * The Configuration page: provider connections, repository mappings, and
 * sandbox settings, split into subpages behind a submenu. Rendered in the
 * main content area at /config/<section>.
 */
export function ConfigurationPage({
  config,
  linearStatus,
  section,
  onSection,
  onConfig,
}: {
  config: BreviConfig | null;
  linearStatus: LinearStatus | null;
  section: ConfigSection;
  onSection: (section: ConfigSection) => void;
  onConfig: (config: BreviConfig) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-5 sm:py-7 md:px-8">
      <header className="flex items-baseline gap-2.5">
        <h2 className="font-plate text-[13px] font-semibold tracking-[0.08em] text-haze-50 uppercase">
          Configuration
        </h2>
      </header>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
        Connections and run settings for this orchestrator.
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
              className={`touch-target -mb-px shrink-0 border-b pb-2 font-plate text-[11.5px] font-semibold tracking-[0.08em] whitespace-nowrap uppercase ${
                active ? "border-haze-300 text-haze-50" : "border-transparent text-haze-600 hover:text-haze-300"
              }`}
            >
              {label}
            </a>
          );
        })}
      </nav>

      {config ? (
        <>
          {/* Connectors stays mounted while hidden: an in-flight connect flow
              (GitHub device polling, redirect or wrangler login waits) must
              survive a switch to another section, or the grant is lost. */}
          <div hidden={section !== "connectors"}>
            <ConnectorsSection config={config} linearStatus={linearStatus} onConfig={onConfig} />
          </div>
          {section === "repositories" && (
            <RepositoriesSection config={config} linearStatus={linearStatus} onConfig={onConfig} />
          )}
          {section === "sandbox" && <SandboxSection config={config} onConfig={onConfig} />}
        </>
      ) : (
        <p className="mt-6 text-[12.5px] leading-relaxed text-haze-700">
          Waiting for the orchestrator; configuration can be edited once it answers.
        </p>
      )}
    </div>
  );
}
