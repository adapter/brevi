import type { BreviConfig, HealthResponse, LinearStatus } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { useSettingsDraft } from "../lib/settings";
import { ConnectorsSection } from "./config/ConnectorsSection";
import { SectionIntro, SettingsCard } from "./config/Fields";
import { SandboxProviderField } from "./config/SandboxSection";

/**
 * First-run setup, rendered once at /setup: the sandbox provider choice and
 * the Connectors panel, both required before brevi is actually usable.
 * A genuinely first launch (no prior ~/.brevi/config.json) lands here: the
 * desktop app sends the window, and `npx @brevi/cli` opens this URL in the
 * browser. Everything below wraps the real Configuration controls rather than
 * reimplementing them, so there is exactly one sandbox.provider control and
 * one Connectors implementation.
 */
export function Setup({
  config,
  linearStatus,
  health,
  onConfig,
  onDone,
}: {
  config: BreviConfig | null;
  linearStatus: LinearStatus | null;
  health: HealthResponse | null;
  onConfig: (config: BreviConfig) => void;
  onDone: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-5 sm:py-7 md:px-8">
      <header className="flex items-baseline gap-2.5">
        <h2 className="font-plate text-[13px] font-semibold tracking-[0.08em] text-haze-50 uppercase">
          Set up brevi
        </h2>
      </header>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
        A one-time pass before your first run. Everything here is also editable later under
        Configuration, and is written straight to{" "}
        <code className="font-mono text-[11px]">~/.brevi/config.json</code>.
      </p>

      {config ? (
        <>
          <SectionIntro title="Sandbox">
            Where runs execute. Firecracker microVMs give real isolation on Linux with KVM; the
            process provider runs commands directly on this machine as you.
          </SectionIntro>
          <div className="mt-3">
            <SandboxProviderCard config={config} health={health} onConfig={onConfig} />
          </div>

          <div className="mt-6">
            <ConnectorsSection config={config} linearStatus={linearStatus} onConfig={onConfig} />
          </div>

          <div className="mt-6 flex justify-end border-t border-ink-700 pt-4">
            <Button onClick={onDone}>Go to the dashboard</Button>
          </div>
        </>
      ) : (
        <p className="mt-6 text-[12.5px] leading-relaxed text-haze-700">
          Waiting for the orchestrator; setup can continue once it answers.
        </p>
      )}
    </div>
  );
}

/**
 * Wraps the shared provider control (see SandboxSection.tsx) in its own
 * card. On a host with no usable KVM, every macOS host and any Linux host
 * without it, Firecracker can never resolve here regardless of what's
 * picked: the auto-resolved provider from a fresh (still "auto") config
 * already tells us that, so offering the three-way choice would be
 * misleading. Say so plainly instead.
 */
function SandboxProviderCard({
  config,
  health,
  onConfig,
}: {
  config: BreviConfig;
  health: HealthResponse | null;
  onConfig: (config: BreviConfig) => void;
}) {
  const draft = useSettingsDraft(config, onConfig);
  const provider = draft.value("sandbox.provider");
  const noFirecracker = provider === "auto" && health?.sandboxProvider === "process";

  return (
    <SettingsCard title="Provider" draft={draft}>
      {noFirecracker ? (
        <p className="text-[12px] leading-relaxed text-haze-400">
          This machine has no usable KVM, so Firecracker isolation cannot run here. brevi will use
          the process provider: commands run directly on this machine as you, with no isolation.
          Revisit this later in Configuration's Sandbox section if that changes.
        </p>
      ) : (
        <SandboxProviderField draft={draft} health={health} />
      )}
    </SettingsCard>
  );
}
