import type { BreviConfig, HealthResponse } from "@brevi/shared";
import {
  FIRECRACKER_SIZES,
  resolveFirecrackerResources,
  type FirecrackerVmSize,
} from "@brevi/shared/sizes";
import { Button } from "@/components/ui/button";
import { useSettingsDraft } from "../../lib/settings";
import { Warn } from "../Icons";
import {
  Advanced,
  FieldRow,
  NumberField,
  RadioField,
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
  onConfig,
}: {
  config: BreviConfig;
  health: HealthResponse | null;
  onConfig: (config: BreviConfig) => void;
}) {
  const sandbox = useSettingsDraft(config, onConfig);
  const vm = useSettingsDraft(config, onConfig);

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
            label="Run timeout"
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
              help="Ext4 rootfs with node, git, and the coding agent preinstalled. Empty uses the image build-rootfs.sh writes."
            />
          </Advanced>
        </SettingsCard>
      </div>
    </>
  );
}
