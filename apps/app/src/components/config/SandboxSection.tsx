import { useState } from "react";
import type { BreviConfig, HealthResponse, SandboxSettingsUpdateRequest } from "@brevi/shared";
import { resolveFirecrackerResources, type FirecrackerVmSize } from "@brevi/shared/sizes";
import { Button } from "@/components/ui/button";
import { api } from "../../lib/api";
import { Plate } from "../Bits";
import { Minus, Plus, Warn } from "../Icons";

const SIZES: { id: FirecrackerVmSize; label: string }[] = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
];

/** MiB to a GB string with up to two decimals, trailing zeros stripped. */
function formatGb(mib: number): string {
  return (Math.round((mib / 1024) * 100) / 100).toString();
}

/**
 * Sandbox settings: run concurrency and, when the orchestrator runs
 * Firecracker microVMs, the VM size preset and a live host-memory capacity
 * hint. Backed by the orchestrator's live sandbox settings; the values shown
 * always come from the server-confirmed config, never local optimistic
 * state.
 */
export function SandboxSection({
  config,
  health,
  onConfig,
}: {
  config: BreviConfig;
  health: HealthResponse | null;
  onConfig: (config: BreviConfig) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const concurrency = config.sandbox.concurrency;
  const firecracker = health?.sandboxProvider === "firecracker";

  const update = async (request: SandboxSettingsUpdateRequest) => {
    setPending(true);
    setError(null);
    try {
      const response = await api.updateSandboxSettings(request);
      onConfig(response.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The orchestrator did not respond.");
    } finally {
      setPending(false);
    }
  };

  const fc = config.sandbox.firecracker;
  const override = fc.vcpus !== undefined || fc.memMib !== undefined;
  const { vcpus, memMib } = resolveFirecrackerResources(fc);
  const reservedMib = memMib * concurrency;

  const runWord = concurrency === 1 ? "run" : "runs";
  const verb = concurrency === 1 ? "reserves" : "reserve";
  const hintWords: string[] = [String(concurrency)];
  if (concurrency > 1) hintWords.push("concurrent");
  if (!override) hintWords.push(fc.size);
  hintWords.push(runWord, verb, `${formatGb(reservedMib)} GB of host memory`);
  const hint = hintWords.join(" ");

  const hostMemMib = health?.hostMemMib;

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
            onClick={() => void update({ concurrency: concurrency - 1 })}
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
            onClick={() => void update({ concurrency: concurrency + 1 })}
            disabled={pending || concurrency >= 16}
            aria-label="Increase parallel runs"
          >
            <Plus className="size-3" />
          </Button>
        </div>
      </div>

      {firecracker && (
        <>
          <div className="mt-4 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] text-haze-200">VM size</p>
              <p className="text-[12px] leading-relaxed text-haze-700">
                Resources for each Firecracker microVM
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {SIZES.map(({ id, label }) => {
                const active = fc.size === id;
                return (
                  <Button
                    key={id}
                    variant="outline"
                    size="xs"
                    aria-pressed={active}
                    onClick={() => void update({ size: id })}
                    disabled={pending}
                    className={
                      active
                        ? "border-haze-300 text-haze-50"
                        : "border-ink-600 text-haze-600"
                    }
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
          </div>

          <p className="mt-2 text-[12px] text-haze-700">
            {vcpus} vCPU, {formatGb(memMib)} GB memory per VM
          </p>

          {override && (
            <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-haze-700">
              <Warn className="mt-px size-3 shrink-0" />
              The config file sets explicit vcpus/memMib, which win over the preset. Picking a
              size clears them.
            </p>
          )}

          <p className="mt-2.5 text-[12px] leading-relaxed text-haze-700">{hint}</p>

          {typeof hostMemMib === "number" && reservedMib > hostMemMib && (
            <p className="mt-1 flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
              <Warn className="mt-px size-3 shrink-0" />
              That exceeds this host's {formatGb(hostMemMib)} GB of memory.
            </p>
          )}
        </>
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
