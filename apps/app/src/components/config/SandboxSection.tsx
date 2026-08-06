import { useState } from "react";
import type { BreviConfig } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { api } from "../../lib/api";
import { Plate } from "../Bits";
import { Minus, Plus, Warn } from "../Icons";

/** How many sandboxed runs may execute at once, above which host memory gets tight. */
const CONCURRENCY_MEMORY_HINT = 4;

/**
 * Sandbox run concurrency: a stepper backed by the orchestrator's live
 * sandbox settings. The value shown always comes from the server-confirmed
 * config, never local optimistic state.
 */
export function SandboxSection({
  config,
  onConfig,
}: {
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const concurrency = config.sandbox.concurrency;

  const step = async (next: number) => {
    setPending(true);
    setError(null);
    try {
      const response = await api.updateSandboxSettings({ concurrency: next });
      onConfig(response.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The orchestrator did not respond.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="mt-6">
      <div className="flex items-center gap-2">
        <Plate className="text-haze-400">Sandbox</Plate>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-haze-200">Parallel runs</p>
          <p className="text-[12px] leading-relaxed text-haze-700">
            Sandboxed runs that may execute at once
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon-xs"
            onClick={() => void step(concurrency - 1)}
            disabled={pending || concurrency <= 1}
            aria-label="Decrease parallel runs"
          >
            <Minus className="size-3" />
          </Button>
          <span className="w-4 text-center font-mono text-[12.5px] text-haze-50">
            {concurrency}
          </span>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={() => void step(concurrency + 1)}
            disabled={pending || concurrency >= 16}
            aria-label="Increase parallel runs"
          >
            <Plus className="size-3" />
          </Button>
        </div>
      </div>

      {concurrency >= CONCURRENCY_MEMORY_HINT && (
        <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-haze-700">
          <Warn className="mt-px size-3 shrink-0" />
          Each Firecracker VM reserves its own memory (4 GiB by default); make sure the host has
          room for all of them.
        </p>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
          <Warn className="mt-px size-3 shrink-0" />
          {error}
        </p>
      )}
    </section>
  );
}
