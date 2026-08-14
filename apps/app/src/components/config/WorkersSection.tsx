import { useState } from "react";
import type {
  FleetResponse,
  HealthResponse,
  HostExecution,
  PairingTokenResponse,
  WorkerConnection,
  WorkerView,
} from "@brevi/shared";
import { DEFAULT_FLEET_PORT, type BreviConfig } from "@brevi/shared/config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Command } from "../Bits";
import { api } from "../../lib/api";
import { relative } from "../../lib/format";
import { useSettingsDraft, type SettingsDraft } from "../../lib/settings";
import { useNow } from "../../lib/useNow";
import { Check, Copy, Edit, Warn } from "../Icons";
import { FieldRow, NumberField, SectionIntro, SettingsCard } from "./Fields";

const ALL_INTERFACES = "0.0.0.0";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The empty-fleet explanation: the plain "enroll one" copy when this host
 * can execute runs itself (or is too old to report), otherwise say why not
 * before pointing at "Add a worker".
 */
function emptyFleetCopy(hostExecution: HostExecution | undefined) {
  if (hostExecution?.kind !== "none") {
    return (
      <>
        No workers enrolled yet. Runs stay queued until one joins; use{" "}
        <span className="text-haze-400">Add a worker</span> above to enroll the first machine.
      </>
    );
  }
  if (hostExecution.reason === "bwrap-unavailable") {
    return (
      <>
        No workers enrolled yet, and this machine can&apos;t run agents itself. Install bubblewrap (
        <code className="font-mono text-[11px]">brevi setup</code>) or use{" "}
        <span className="text-haze-400">Add a worker</span> above to enroll a Linux machine.
      </>
    );
  }
  return (
    <>
      No workers enrolled yet, and this machine can&apos;t run agents itself. Use{" "}
      <span className="text-haze-400">Add a worker</span> above to enroll one.
    </>
  );
}

/**
 * Connected, and whether anything is happening on it. The warm accent is
 * reserved for a worker actually executing runs, the way it is everywhere
 * else; a connected but idle machine is mint, like the header's own live
 * indicator, and an absent one is plain chrome.
 */
function ConnectionDot({ connection, busy }: { connection: WorkerConnection; busy: boolean }) {
  const online = connection === "online";
  const label = !online ? "Offline" : busy ? "Online, running" : "Online, idle";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block size-[7px] shrink-0 rounded-full ${
        online ? `animate-beacon ${busy ? "bg-ember-500" : "bg-mint-500"}` : "bg-haze-700"
      }`}
    />
  );
}

/**
 * The fleet: machines other than this host that can execute runs. A machine
 * joins by running the one command an "Add a worker" pairing mints, and every
 * enrolled worker can be renamed, drained, re-enabled, or revoked from here.
 * Rendered at /config/workers.
 */
export function WorkersSection({
  config,
  workers,
  health,
  onConfig,
  onWorkers,
}: {
  config: BreviConfig;
  workers: WorkerView[];
  health: HealthResponse | null;
  onConfig: (config: BreviConfig) => void;
  onWorkers: (workers: WorkerView[]) => void;
}) {
  const now = useNow(true, 30_000);
  // Two cards over one config section, the way SandboxSection splits its own:
  // the listener is a restart-required decision about reachability, the
  // timeouts are live-edited operational tuning.
  const fleet = useSettingsDraft(config, onConfig);
  const liveness = useSettingsDraft(config, onConfig);

  const [pairing, setPairing] = useState<PairingTokenResponse | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, true | undefined>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  /** Worker id whose "Revoke" is armed, so one click cannot drop a machine's credential. */
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);

  const addWorker = () => {
    setPairBusy(true);
    setPairError(null);
    api
      .pairWorker()
      .then((response) => {
        setPairing(response);
        setCopied(false);
      })
      .catch((cause: unknown) => setPairError(errorText(cause)))
      .finally(() => setPairBusy(false));
  };

  const copyCommand = () => {
    if (!pairing) return;
    navigator.clipboard
      .writeText(pairing.command)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setPairError("Could not use the clipboard; select the command and copy it by hand."));
  };

  const mutate = (id: string, action: Promise<FleetResponse>) => {
    setBusy((prev) => ({ ...prev, [id]: true }));
    setError(null);
    action
      .then((response) => onWorkers(response.workers))
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() =>
        setBusy((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        }),
      );
  };

  const startRename = (worker: WorkerView) => {
    setRenamingId(worker.id);
    setRenameValue(worker.name);
  };

  const commitRename = (worker: WorkerView) => {
    const value = renameValue.trim();
    setRenamingId(null);
    if (!value || value === worker.name) return;
    mutate(worker.id, api.renameWorker(worker.id, value));
  };

  const minutesLeft = pairing
    ? Math.max(0, Math.round((Date.parse(pairing.expiresAt) - now) / 60_000))
    : 0;

  // The host's own local worker pinned first, out of enrollment order.
  const orderedWorkers = [...workers].sort(
    (a, b) => Number(Boolean(b.local)) - Number(Boolean(a.local)),
  );

  return (
    <>
      <SectionIntro title="Workers">
        Every run executes on an enrolled worker; this host only schedules them. A machine joins
        the fleet by running one printed command, and its credential can be revoked from here at
        any time.
      </SectionIntro>

      <div className="mt-3 flex flex-col gap-2.5">
        <Card size="sm" className="gap-2">
          <CardHeader className="gap-0">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-plate text-[12px] font-semibold tracking-[0.04em] text-haze-50">
                Enroll a worker
              </h3>
              <Button type="button" size="plate" onClick={addWorker} disabled={pairBusy}>
                {pairBusy ? "Minting" : "Add a worker"}
              </Button>
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-haze-400">
              Mints a single-use pairing token and the command that redeems it. Run it on the
              machine that should join the fleet.
            </p>
          </CardHeader>
          <CardContent className="mt-2.5 flex flex-col gap-2.5">
            {pairError && (
              <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
                <Warn className="mt-px size-3 shrink-0" />
                {pairError}
              </p>
            )}
            {pairing && (
              <div className="flex flex-col gap-2">
                <div className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <Command text={pairing.command} />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-xs"
                    onClick={copyCommand}
                    aria-label="Copy the enrollment command"
                    title="Copy"
                    className="mt-0.5 shrink-0"
                  >
                    {copied ? <Check /> : <Copy />}
                  </Button>
                </div>
                <p className="text-[11.5px] leading-relaxed text-haze-700">
                  {copied ? "Copied. " : ""}
                  Single-use, shown once: it expires unredeemed in {minutesLeft}{" "}
                  {minutesLeft === 1 ? "minute" : "minutes"}, and this page cannot show it again
                  after you leave. Mint a new one if it lapses.
                </p>
                {pairing.remote ? (
                  <p className="text-[11.5px] leading-relaxed text-haze-700">
                    The command points at{" "}
                    <span className="font-mono text-haze-400">{pairing.host}</span>, an address the
                    worker channel is listening on. If the worker reaches this host at a different
                    one, edit the <code className="font-mono">--host</code> value before running
                    the command.
                  </p>
                ) : (
                  <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-haze-700">
                    <Warn className="mt-px size-3 shrink-0" />
                    <span>
                      Only this machine can enroll with this command right now: the worker
                      channel's only listener is loopback-only, so{" "}
                      <span className="font-mono text-haze-400">{pairing.host}</span> answers
                      nowhere else. Set a bind address on the{" "}
                      <span className="text-haze-400">Worker channel</span> card below and restart
                      brevi to enroll a machine on the network.
                    </span>
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <SettingsCard title="Worker channel" draft={fleet}>
          <NumberField
            label="Port"
            path="fleet.port"
            draft={fleet}
            min={1}
            max={65535}
            help={`Port the worker channel listens on, deliberately separate from the dashboard's own port. Defaults to ${DEFAULT_FLEET_PORT}.`}
          />
          <FleetBindAddressField draft={fleet} />
        </SettingsCard>

        <SettingsCard title="Connection health" draft={liveness}>
          <NumberField
            label="Heartbeat timeout"
            path="fleet.heartbeatTimeoutSeconds"
            draft={liveness}
            unit="s"
            min={30}
            max={600}
            help="Seconds a connected worker may go silent before the host drops it and fails its in-flight runs. Workers heartbeat every 15s, so the floor is two intervals: a timeout close to one interval lets ordinary jitter drop a healthy worker."
          />
          <NumberField
            label="Reconnect grace"
            path="fleet.reconnectGraceSeconds"
            draft={liveness}
            unit="s"
            min={10}
            max={3600}
            help="How long a worker that dropped mid-run has to reconnect before its runs are failed."
          />
        </SettingsCard>

        <Card size="sm" className="gap-2">
          <CardHeader className="gap-0">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-plate text-[12px] font-semibold tracking-[0.04em] text-haze-50">
                Fleet
              </h3>
              <span className="font-plate text-[9px] tracking-[0.14em] text-haze-700 uppercase">
                {workers.length} {workers.length === 1 ? "worker" : "workers"}
              </span>
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-haze-400">
              Every enrolled worker, its live connection, and what it reports about itself.
            </p>
          </CardHeader>
          <CardContent className="mt-2.5 flex flex-col gap-4">
            {error && (
              <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
                <Warn className="mt-px size-3 shrink-0" />
                {error}
              </p>
            )}
            {workers.length === 0 ? (
              <p className="text-[12.5px] leading-relaxed text-haze-700">
                {emptyFleetCopy(health?.hostExecution)}
              </p>
            ) : (
              <ul>
                {orderedWorkers.map((worker) => {
                  const rowBusy = busy[worker.id] === true;
                  const draining = worker.state === "draining";
                  return (
                    <li
                      key={worker.id}
                      className="group flex flex-col gap-2 border-b border-ink-800 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <ConnectionDot
                            connection={worker.connection}
                            busy={worker.activeRuns > 0}
                          />
                          {worker.local ? (
                            <span className="truncate font-mono text-[12.5px] text-haze-100">
                              This machine
                            </span>
                          ) : renamingId === worker.id ? (
                            <Input
                              autoFocus
                              value={renameValue}
                              onChange={(event) => setRenameValue(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitRename(worker);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  setRenamingId(null);
                                }
                              }}
                              onBlur={() => setRenamingId(null)}
                              aria-label={`Rename ${worker.name}`}
                              className="h-7 max-w-56 rounded-[4px] border-ink-600 bg-ink-950/70 px-2 font-mono text-[12.5px] text-haze-100"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => startRename(worker)}
                              className="truncate rounded-[3px] font-mono text-[12.5px] text-haze-100 hover:text-haze-50"
                              title="Click to rename"
                            >
                              {worker.name}
                            </button>
                          )}
                          {worker.local && <Badge variant="outline">Local</Badge>}
                          {draining && (
                            <Badge
                              variant="outline"
                              className="border-iris-400/35 bg-iris-400/12 text-iris-400"
                            >
                              Draining
                            </Badge>
                          )}
                        </div>
                        {draining && (
                          <p className="mt-1 text-[11px] leading-relaxed text-haze-700">
                            Finishing runs already in flight; it accepts nothing new until
                            re-enabled.
                          </p>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {worker.capabilities && (
                            <>
                              <Badge variant="outline">
                                <span className="font-mono tracking-normal normal-case">
                                  {worker.capabilities.os}/{worker.capabilities.arch}
                                </span>
                              </Badge>
                              <Badge variant="outline">
                                <span className="font-mono tracking-normal normal-case">
                                  v{worker.capabilities.version}
                                </span>
                              </Badge>
                            </>
                          )}
                          <span className="font-mono text-[11px] text-haze-700">
                            {worker.activeRuns}/{worker.capabilities?.maxConcurrency ?? "?"} active
                          </span>
                          <span className="font-mono text-[11px] text-haze-700">
                            {worker.lastSeenAt ? relative(worker.lastSeenAt, now) : "never connected"}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        {!worker.local && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            disabled={rowBusy}
                            onClick={() => startRename(worker)}
                            aria-label={`Rename ${worker.name}`}
                            title="Rename"
                          >
                            <Edit />
                          </Button>
                        )}
                        {draining ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="plate"
                            disabled={rowBusy}
                            onClick={() => mutate(worker.id, api.enableWorker(worker.id))}
                          >
                            Re-enable
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="plate"
                            disabled={rowBusy}
                            onClick={() => mutate(worker.id, api.drainWorker(worker.id))}
                          >
                            Drain
                          </Button>
                        )}
                        {!worker.local && (
                          <Button
                            type="button"
                            variant={revokeConfirmId === worker.id ? "destructive" : "ghost"}
                            size="plate"
                            disabled={rowBusy}
                            onClick={() => {
                              if (revokeConfirmId === worker.id) {
                                mutate(worker.id, api.revokeWorker(worker.id));
                                setRevokeConfirmId(null);
                              } else {
                                setRevokeConfirmId(worker.id);
                              }
                            }}
                            onBlur={() =>
                              setRevokeConfirmId((id) => (id === worker.id ? null : id))
                            }
                          >
                            {revokeConfirmId === worker.id ? "Confirm" : "Revoke"}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/**
 * The bind address for the worker channel (/ws/worker), separate from the
 * dashboard's own `server.host`: this listener carries only the
 * authenticated worker channel, so opening it wider is a different, milder
 * tradeoff than opening the unauthenticated dashboard API, and the help text
 * says so rather than reusing ServerSection's warning. Empty is the off
 * preset here, not loopback, since a worker channel that isn't explicitly
 * turned on stays limited to this machine's own dashboard upgrade.
 */
function FleetBindAddressField({ draft }: { draft: SettingsDraft }) {
  const value = draft.value("fleet.host");
  const host = typeof value === "string" ? value : "";
  const preset = host === "" || host === ALL_INTERFACES;
  const [choseOther, setChoseOther] = useState(false);
  // Same derived-state reset as ServerSection's BindAddressField: discarding
  // the card resets the value without telling this control.
  if (choseOther && preset && !draft.dirty) setChoseOther(false);
  const choice = choseOther || !preset ? "other" : host;

  return (
    <FieldRow
      label="Bind address"
      path="fleet.host"
      draft={draft}
      wide
      help="This listener carries only the authenticated worker channel: a pairing token or a worker's own credential, never the dashboard or its unauthenticated API. Those stay on the Server page's bind address no matter what this is set to."
    >
      <RadioGroup
        value={choice}
        onValueChange={(next) => {
          if (next === "other") {
            setChoseOther(true);
            return;
          }
          setChoseOther(false);
          draft.set("fleet.host", next);
        }}
        className="gap-2"
      >
        <label className="flex cursor-pointer items-start gap-2 text-[12px] text-haze-200">
          <RadioGroupItem value="" className="mt-px shrink-0" />
          <span>Off, this machine only</span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-[12px] text-haze-200">
          <RadioGroupItem value={ALL_INTERFACES} className="mt-px shrink-0" />
          <span className="min-w-0">
            All interfaces
            <span className="ml-1.5 font-mono text-[11px] text-haze-700">{ALL_INTERFACES}</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-[12px] text-haze-200">
          <RadioGroupItem value="other" className="mt-px shrink-0" />
          <span>Other</span>
        </label>
      </RadioGroup>
      {choice === "other" && (
        <Input
          type="text"
          value={preset && !choseOther ? "" : host}
          onChange={(event) => draft.set("fleet.host", event.target.value)}
          placeholder="192.168.1.10"
          spellCheck={false}
          autoComplete="off"
          aria-label="Custom bind address"
          className="mt-2 h-7 rounded-[4px] border-ink-600 bg-ink-950/70 px-2 font-mono text-[12px] text-haze-100 placeholder:text-haze-700 md:text-[12px]"
        />
      )}
    </FieldRow>
  );
}
