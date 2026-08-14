import type { BreviConfig, LinearStatus } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { ConnectorsSection } from "./config/ConnectorsSection";

/**
 * First-run setup, rendered once at /setup: the Connectors panel, required
 * before brevi is actually usable. `index.ts` in the desktop app sends a
 * genuinely first launch (no prior ~/.brevi/config.json) here instead of
 * the dashboard; a CLI user reaches the same page by visiting the URL
 * directly. Everything below wraps the real Configuration controls rather
 * than reimplementing them.
 */
export function Setup({
  config,
  linearStatus,
  onConfig,
  onDone,
}: {
  config: BreviConfig | null;
  linearStatus: LinearStatus | null;
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
          <ConnectorsSection config={config} linearStatus={linearStatus} onConfig={onConfig} />

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
