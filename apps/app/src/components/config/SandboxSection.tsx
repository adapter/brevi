import { useEffect, useState } from "react";
import type { BreviConfig, FleetPairingResponse, HealthResponse, WorkerSummary } from "@brevi/shared";
import {
  FIRECRACKER_SIZES,
  resolveFirecrackerResources,
  type FirecrackerVmSize,
} from "@brevi/shared/sizes";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { duration } from "../../lib/format";
import { useSettingsDraft } from "../../lib/settings";
import { Command } from "../Bits";
import { Warn } from "../Icons";
import {
  Advanced,
  FieldRow,
  NumberField,
  RadioField,
  SecretField,
  SectionIntro,
  SegmentedField,
  SettingsCard,
  TextField,
} from "./Fields";

/** MiB to a GB string with up to two decimals, trailing zeros stripped. */
function formatGb(mib: number): string {
  return (Math.round((mib / 1024) * 100) / 100).toString();
}

const SIZES = (["small", "medium", "large"] as const).map((size) => ({
  value: size,
  label: `${size[0]?.toUpperCase()}${size.slice(1)} (${FIRECRACKER_SIZES[size].vcpus} vCPU / ${formatGb(FIRECRACKER_SIZES[size].memMib)} GB)`,
}));

/**
 * Where runs execute: the provider, how many run at once, how long they may
 * take, how long their disks are kept, and the Firecracker microVM details.
 * Rendered at /config/sandbox.
 */
export function SandboxSection({
  config,
  health,
  workers,
  onConfig,
}: {
  config: BreviConfig;
  health: HealthResponse | null;
  workers: WorkerSummary[];
  onConfig: (config: BreviConfig) => void;
}) {
  const sandbox = useSettingsDraft(config, onConfig);
  const vm = useSettingsDraft(config, onConfig);
  const fleet = useSettingsDraft(config, onConfig);

  const provider = sandbox.value("sandbox.provider");
  // health.sandboxProvider is what the running process actually resolved
  // "auto" to; an unsaved edit to an explicit provider is what the user is
  // asking for, so it wins for describing the VM card.
  const resolved = provider === "auto" ? health?.sandboxProvider : provider;
  const firecracker = resolved === "firecracker";
  const kvmMissing = provider === "firecracker" && health?.sandboxProvider === "process";

  // Read through the draft, not the committed config: clearing the overrides
  // with "Use a preset" has to change the numbers on screen before the save,
  // or the card contradicts the choice the user just made.
  const size = vm.value("sandbox.firecracker.size");
  const vcpuOverride = vm.value("sandbox.firecracker.vcpus");
  const memOverride = vm.value("sandbox.firecracker.memMib");
  const override = typeof vcpuOverride === "number" || typeof memOverride === "number";
  const { vcpus, memMib } = resolveFirecrackerResources({
    size: (typeof size === "string" ? size : "medium") as FirecrackerVmSize,
    vcpus: typeof vcpuOverride === "number" ? vcpuOverride : undefined,
    memMib: typeof memOverride === "number" ? memOverride : undefined,
  });

  const concurrencyValue = sandbox.value("sandbox.concurrency");
  const concurrency = typeof concurrencyValue === "number" && concurrencyValue > 0 ? concurrencyValue : 1;
  const reservedMib = memMib * concurrency;
  const hostMemMib = health?.hostMemMib;

  const runWord = concurrency === 1 ? "run" : "runs";
  const verb = concurrency === 1 ? "reserves" : "reserve";
  const hintWords: string[] = [String(concurrency)];
  if (concurrency > 1) hintWords.push("concurrent");
  if (!override && typeof size === "string") hintWords.push(size);
  hintWords.push(runWord, verb, `${formatGb(reservedMib)} GB of host memory`);

  // fleet.token is masked in every config read, so the copyable `brevi
  // worker` command can only come from the loopback-only pairing route.
  // Fetched once on mount; a non-loopback browser (or the route being
  // unreachable) leaves pairing null and the command falls back to a
  // placeholder.
  const [pairing, setPairing] = useState<FleetPairingResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/fleet/pairing", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? (res.json() as Promise<FleetPairingResponse>) : Promise.reject(res)))
      .then((next) => {
        if (!cancelled) setPairing(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const workerCommand =
    pairing?.command ?? `brevi worker --host ${window.location.origin} --token <fleet.token>`;
  const now = Date.now();

  return (
    <>
      <SectionIntro title="Sandbox">
        Runs execute in an isolated sandbox, one per attempt. Firecracker microVMs give real
        isolation on Linux with KVM; the process provider runs commands directly on this machine
        as you.
      </SectionIntro>

      <div className="mt-3 flex flex-col gap-2.5">
        <SettingsCard title="Execution" draft={sandbox}>
          <RadioField
            label="Provider"
            path="sandbox.provider"
            draft={sandbox}
            options={[
              {
                value: "auto",
                label: "Auto",
                detail: "Firecracker on Linux with KVM, the process provider otherwise.",
              },
              { value: "firecracker", label: "Firecracker", detail: "Always boot a microVM." },
              {
                value: "process",
                label: "Process",
                detail: "No isolation: commands run on this host as you.",
              },
            ]}
          />
          {kvmMissing && (
            <p className="-mt-1 flex items-start gap-1.5 pb-3 text-[11.5px] leading-relaxed text-ember-300">
              <Warn className="mt-px size-3 shrink-0" />
              This host resolved to the process provider, so it has no usable KVM. Firecracker
              runs will fail to start until KVM is available.
            </p>
          )}
          <NumberField
            label="Parallel runs"
            path="sandbox.concurrency"
            draft={sandbox}
            min={1}
            max={16}
            help={
              firecracker
                ? hintWords.join(" ")
                : "How many sandboxed runs may execute at once."
            }
          />
          {firecracker && typeof hostMemMib === "number" && reservedMib > hostMemMib && (
            <p className="-mt-1 flex items-start gap-1.5 pb-3 text-[11.5px] leading-relaxed text-rust-400">
              <Warn className="mt-px size-3 shrink-0" />
              That exceeds this host's {formatGb(hostMemMib)} GB of memory.
            </p>
          )}
          <NumberField
            label="Execution timeout"
            path="sandbox.timeoutMinutes"
            draft={sandbox}
            unit="min"
            min={1}
            step={5}
            help="Hard wall-clock limit for each agent execution: the implementation pass, each Codex reviewer, and the fix pass each get their own budget."
          />
          <NumberField
            label="Sandbox retention"
            path="sandbox.retentionHours"
            draft={sandbox}
            unit="h"
            min={0}
            help="How long a finished run's sandbox disk is kept for interactive resume via brevi attach. Disk only, no memory or CPU. 0 disables retention."
          />
        </SettingsCard>

        <SettingsCard
          title="Firecracker"
          draft={vm}
          description={
            firecracker
              ? undefined
              : "Not the active provider on this host. These settings are still saved to config.json, so a machine that does boot microVMs picks them up."
          }
        >
          {override ? (
            <FieldRow
              label="VM size"
              help={`Overridden in config.json (${[
                typeof vcpuOverride === "number" ? `vcpus=${vcpuOverride}` : null,
                typeof memOverride === "number" ? `memMib=${memOverride}` : null,
              ]
                .filter(Boolean)
                .join(", ")}). Explicit values win over the preset.`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-haze-400">
                  {vcpus} vCPU / {formatGb(memMib)} GB
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="plate"
                  className="ml-auto"
                  onClick={() => {
                    vm.set("sandbox.firecracker.vcpus", null);
                    vm.set("sandbox.firecracker.memMib", null);
                  }}
                >
                  Use a preset
                </Button>
              </div>
            </FieldRow>
          ) : (
            <SegmentedField
              label="VM size"
              path="sandbox.firecracker.size"
              draft={vm}
              options={SIZES}
              help={`Resources each microVM boots with: ${vcpus} vCPU, ${formatGb(memMib)} GB memory. Applies to newly booted VMs.`}
            />
          )}
          <Advanced label="Image paths">
            <TextField
              label="Binary"
              path="sandbox.firecracker.binary"
              draft={vm}
              wide
              help="Path to the firecracker binary, or a bare name to resolve on PATH."
            />
            <TextField
              label="Kernel image"
              path="sandbox.firecracker.kernelImage"
              draft={vm}
              wide
              placeholder="~/.brevi/images/vmlinux"
              help="Uncompressed Linux kernel image (vmlinux). Empty uses the image brevi setup downloads."
            />
            <TextField
              label="Rootfs"
              path="sandbox.firecracker.rootfs"
              draft={vm}
              wide
              placeholder="~/.brevi/images/rootfs.ext4"
              help="Ext4 rootfs with node, git, and the coding agent preinstalled. Empty lets brevi manage it: a from-source build if one exists, otherwise a verified image downloaded per release. A path here is used as-is and never downloaded over."
            />
            <TextField
              label="Rootfs base URL"
              path="sandbox.firecracker.rootfsBaseUrl"
              draft={vm}
              wide
              placeholder="https://images.brevi.dev/rootfs"
              help="Where prebuilt rootfs images are downloaded from. Point it at a mirror for self-hosted or air-gapped setups."
            />
          </Advanced>
        </SettingsCard>

        <SettingsCard title="Fleet" draft={fleet}>
          <SecretField
            label="Pairing token"
            path="fleet.token"
            draft={fleet}
            help="Shared secret workers present with `brevi worker --host <url> --token <token>`. The host generates one on first start; it's readable in the clear only on the machine running brevi."
          />
          <NumberField
            label="Heartbeat timeout"
            path="fleet.heartbeatTimeoutSeconds"
            draft={fleet}
            unit="s"
            min={30}
            max={600}
            help="Seconds a connected worker may go silent before the host drops it and fails its in-flight runs. Workers heartbeat every 15s, so the floor is two intervals: a timeout close to one interval lets ordinary jitter drop a healthy worker."
          />
          <NumberField
            label="Reconnect grace"
            path="fleet.reconnectGraceSeconds"
            draft={fleet}
            unit="s"
            min={10}
            max={3600}
            help="How long a worker that dropped mid-run has to reconnect before its runs are failed."
          />
        </SettingsCard>

        <Card size="sm" className="gap-2">
          <CardHeader className="gap-0">
            <h3 className="font-plate text-[12px] font-semibold tracking-[0.04em] text-haze-50">
              Workers
            </h3>
            <p className="mt-1.5 text-[12px] leading-relaxed text-haze-400">
              Every run executes on a connected <code className="font-mono text-[11px]">brevi worker</code>{" "}
              daemon; with none connected, runs stay queued instead of failing.
            </p>
          </CardHeader>
          <CardContent className="mt-2.5 flex flex-col">
            {workers.length === 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-[12.5px] leading-relaxed text-haze-700">
                  No workers connected yet. Start one to let runs execute.
                </p>
                <Command text={workerCommand} />
                {!pairing && (
                  <p className="text-[11.5px] leading-relaxed text-haze-700">
                    The token is readable only from the machine running brevi, in
                    ~/.brevi/config.json.
                  </p>
                )}
              </div>
            ) : (
              <ul>
                {workers.map((worker) => (
                  <li
                    key={worker.id}
                    className="flex items-start justify-between gap-3 border-t border-ink-800 py-2 first:border-t-0 first:pt-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] text-haze-100">{worker.name}</p>
                      <p className="mt-0.5 font-plate text-[9px] tracking-[0.14em] text-haze-700 uppercase">
                        {[
                          worker.provider,
                          worker.kvm ? "kvm" : "no kvm",
                          `${worker.activeRuns}/${worker.maxConcurrency} active`,
                          `v${worker.version}`,
                          `connected ${duration(worker.connectedAt, now)}`,
                        ].join(" · ")}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
