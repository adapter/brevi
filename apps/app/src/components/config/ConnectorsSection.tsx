import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  BreviConfig,
  CredentialProvider,
  CredentialResult,
  CredentialsUpdateRequest,
  LinearStatus,
  R2Status,
} from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { api } from "../../lib/api";
import { linearConnected } from "../../lib/linear";
import { safeExternalUrl, trustedOriginOf } from "../../lib/url";
import { useSettingsDraft } from "../../lib/settings";
import { Plate } from "../Bits";
import { Check, ChevronRight, External, Warn } from "../Icons";
import { SegmentedField, SettingsCard, TagField, TextField } from "./Fields";

type ConnectorKey = CredentialProvider | "r2";
type ConnectorTone = "ok" | "warn" | "error" | "idle";

/** How the "Connect" button acquires a credential, shown as a hint. */
type ConnectHint = string;

interface ProviderSpec {
  id: CredentialProvider;
  field: keyof CredentialsUpdateRequest;
  name: string;
  role: string;
  connectHint: ConnectHint;
  inputLabel: string;
  keyUrl: string;
  keyUrlLabel: string;
  connected: (config: BreviConfig) => boolean;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "linear",
    field: "linearApiKey",
    name: "Linear",
    role: "Ticket source; polling starts once connected",
    connectHint: "Authorize in the browser",
    inputLabel: "Personal API key",
    keyUrl: "https://linear.app/settings/api",
    keyUrlLabel: "linear.app/settings/api",
    connected: (c) => c.linear.apiKey !== "",
  },
  {
    id: "github",
    field: "githubToken",
    name: "GitHub",
    role: "Branches and pull requests",
    connectHint: "Uses your gh CLI login or a device code",
    inputLabel: 'Access token with the "repo" scope',
    keyUrl: "https://github.com/settings/tokens",
    keyUrlLabel: "github.com/settings/tokens",
    connected: (c) => c.github.token !== "",
  },
  {
    id: "anthropic",
    field: "anthropicApiKey",
    name: "Claude",
    role: "Runs the coding agent in the sandbox",
    connectHint: "Found on this machine (Claude Code login or env)",
    inputLabel: "Anthropic API key",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyUrlLabel: "console.anthropic.com",
    connected: (c) => c.agent.anthropicApiKey !== "" || c.agent.claudeCodeOauthToken !== "",
  },
  {
    id: "codex",
    field: "codexApiKey",
    name: "Codex",
    role: "Alternative agent key (OpenAI)",
    connectHint: "Found on this machine (Codex CLI login or env)",
    inputLabel: "OpenAI API key",
    keyUrl: "https://platform.openai.com/api-keys",
    keyUrlLabel: "platform.openai.com",
    connected: (c) => c.agent.codexApiKey !== "" || c.agent.codexAuthJson !== "",
  },
  {
    id: "grok",
    field: "xaiApiKey",
    name: "Grok",
    role: "Alternative agent key (xAI)",
    connectHint: "Found on this machine (Grok CLI env, login, or XAI_API_KEY)",
    inputLabel: "xAI API key",
    keyUrl: "https://console.x.ai",
    keyUrlLabel: "console.x.ai",
    connected: (c) => c.agent.xaiApiKey !== "" || c.agent.grokAuthJson !== "",
  },
];

const TONE_DOT: Record<ConnectorTone, string> = {
  ok: "bg-mint-500",
  warn: "bg-ember-400",
  error: "bg-rust-400",
  idle: "bg-haze-700",
};

const TONE_LABEL: Record<ConnectorTone, string> = {
  ok: "text-mint-400",
  warn: "text-ember-300",
  error: "text-rust-400",
  idle: "text-haze-700",
};

/**
 * One row in the connectors accordion. The trigger is the name and status;
 * Connect/Disconnect sit beside it as their own buttons so they are not
 * nested inside the trigger.
 */
function ConnectorItem({
  name,
  open,
  onOpenChange,
  tone,
  statusLabel,
  actions,
  children,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tone: ConnectorTone;
  statusLabel: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="border-t border-ink-700 first:border-t-0"
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
          <span
            className={`inline-block size-[7px] shrink-0 rounded-full ${TONE_DOT[tone]}`}
            role="img"
            aria-label={statusLabel}
            title={statusLabel}
          />
          <h3 className="font-plate text-[12px] font-semibold tracking-[0.04em] text-haze-50">
            {name}
          </h3>
          <span className={`min-w-0 truncate text-[11px] ${TONE_LABEL[tone]}`}>{statusLabel}</span>
        </CollapsibleTrigger>
        {actions}
        <CollapsibleTrigger
          aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
          className="shrink-0 cursor-pointer p-0.5 text-haze-700 hover:text-haze-300"
        >
          <ChevronRight className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="px-3 pb-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Provider connections: Linear, GitHub, and the agent credentials (Claude,
 * Codex, Grok), plus the Cloudflare R2 evidence connector. Rendered at
 * /config/connectors as a single-column accordion.
 */
export function ConnectorsSection({
  config,
  linearStatus,
  onConfig,
}: {
  config: BreviConfig;
  linearStatus: LinearStatus | null;
  onConfig: (config: BreviConfig) => void;
}) {
  const connectedCount = PROVIDERS.filter((spec) =>
    spec.id === "linear" ? linearConnected(config, linearStatus) : spec.connected(config),
  ).length;
  // Normalized to end with a period: the row renders a follow-up sentence
  // right after it, and error details arrive with and without one.
  const period = (text: string) => (text.endsWith(".") ? text : `${text}.`);
  const linearAuthError =
    linearStatus?.state === "auth-error"
      ? period(linearStatus.error ?? "Linear rejected the stored credential")
      : undefined;
  const linearRefreshWarning =
    linearStatus?.state === "refresh-failing"
      ? period(linearStatus.error ?? "The Linear token could not be refreshed")
      : undefined;
  const [openId, setOpenId] = useState<ConnectorKey | null>(() => {
    if (linearStatus?.state === "auth-error" || linearStatus?.state === "refresh-failing") {
      return "linear";
    }
    return (
      PROVIDERS.find((spec) =>
        spec.id === "linear" ? !linearConnected(config, linearStatus) : !spec.connected(config),
      )?.id ?? null
    );
  });
  const setOpen = (id: ConnectorKey) => (open: boolean) => {
    setOpenId((current) => (open ? id : current === id ? null : current));
  };

  return (
    <section className="mt-6">
      <div className="flex items-center gap-2">
        <Plate className="text-haze-400">Connections</Plate>
        <span className="font-mono text-[11px] leading-none text-haze-700">
          {connectedCount}/{PROVIDERS.length}
        </span>
      </div>
      <Card size="sm" className="mt-3 gap-0 py-0">
        {PROVIDERS.map((spec) => (
          <ProviderRow
            key={spec.id}
            spec={spec}
            config={config}
            onConfig={onConfig}
            open={openId === spec.id}
            onOpenChange={setOpen(spec.id)}
            authError={spec.id === "linear" ? linearAuthError : undefined}
            refreshWarning={spec.id === "linear" ? linearRefreshWarning : undefined}
          />
        ))}
        <R2Row
          config={config}
          onConfig={onConfig}
          open={openId === "r2"}
          onOpenChange={setOpen("r2")}
        />
      </Card>
      <div className="mt-2.5 flex flex-col gap-2.5">
        <LinearSettingsCard config={config} onConfig={onConfig} />
        <GithubSettingsCard config={config} onConfig={onConfig} />
      </div>

      <p className="mt-6 border-t border-ink-700 pt-3.5 text-[11.5px] leading-relaxed text-haze-700">
        Credentials are validated with the provider, then stored in{" "}
        <code className="font-mono text-[10.5px] text-haze-400">~/.brevi/config.json</code>.
        They never leave this machine. Keys are never shown back to this page, so they are not
        editable as form fields: connect or disconnect instead.
      </p>
    </section>
  );
}

/** Polling scope for the Linear connector, next to the connection itself. */
function LinearSettingsCard({
  config,
  onConfig,
}: {
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
}) {
  const draft = useSettingsDraft(config, onConfig);
  return (
    <SettingsCard title="Linear polling" draft={draft}>
      <TagField
        label="Team keys"
        path="linear.teamKeys"
        draft={draft}
        placeholder="ENG, then press Enter"
        help="Restrict polling to these team keys. Empty polls every team you can see."
      />
    </SettingsCard>
  );
}

/** How the agent is told to write the pull request it opens. */
function GithubSettingsCard({
  config,
  onConfig,
}: {
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
}) {
  const draft = useSettingsDraft(config, onConfig);
  return (
    <SettingsCard title="Pull requests" draft={draft}>
      <SegmentedField
        label="PR description"
        path="github.prDescription"
        draft={draft}
        options={[
          { value: "concise", label: "Concise" },
          { value: "detailed", label: "Detailed" },
        ]}
        help="How the agent is told to write the PR description: concise asks for a couple of sentences plus a few bullets, detailed allows a full write-up."
      />
    </SettingsCard>
  );
}

interface DeviceState {
  userCode: string;
  verificationUri: string;
  interval: number;
}

function ProviderRow({
  spec,
  config,
  onConfig,
  open,
  onOpenChange,
  authError,
  refreshWarning,
}: {
  spec: ProviderSpec;
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  authError?: string;
  refreshWarning?: string;
}) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CredentialResult | null>(null);
  const [manual, setManual] = useState(false);
  const [manualReason, setManualReason] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [awaitingRedirect, setAwaitingRedirect] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connected = spec.connected(config);

  const stopPolling = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  };
  useEffect(() => stopPolling, []);

  // The redirect flow completes server-side; the config broadcast tells us.
  // A reconnect after an auth error keeps `connected` true throughout, so
  // this also has to fire when the auth error itself clears (the
  // linear-status broadcast that follows a completed reconnect).
  useEffect(() => {
    if (connected && !authError) {
      setAwaitingRedirect(false);
      setDevice(null);
      stopPolling();
    }
  }, [connected, authError]);

  const fail = (detail: string) => setResult({ ok: false, detail });

  // Origins the orchestrator may legitimately send us to for a flow: the
  // provider's own authorization origin, plus the configured hosted OAuth
  // backend (connect.apiBase), which serves the flow when no personal OAuth
  // app is set up. Anything else is rejected before navigation.
  const flowOrigins = (providerOrigin: string): string[] => {
    const apiOrigin = trustedOriginOf(config.connect.apiBase);
    return apiOrigin ? [providerOrigin, apiOrigin] : [providerOrigin];
  };

  const pollDevice = (interval: number) => {
    pollTimer.current = setTimeout(() => {
      void api
        .pollGithubDevice()
        .then((poll) => {
          if (poll.status === "pending") {
            pollDevice(interval);
            return;
          }
          setDevice(null);
          if (poll.status === "connected") {
            onConfig(poll.config);
            setResult({ ok: true, detail: poll.detail });
          } else {
            fail(poll.detail);
          }
        })
        .catch(() => pollDevice(interval));
    }, interval * 1000);
  };

  const connect = async () => {
    setPending(true);
    setResult(null);
    setManualReason(null);
    try {
      const response = await api.connect(spec.id);
      switch (response.status) {
        case "connected":
          onConfig(response.config);
          setResult({ ok: true, detail: response.detail });
          setManual(false);
          break;
        case "device": {
          const verificationUri = safeExternalUrl(
            response.verificationUri,
            flowOrigins("https://github.com"),
          );
          if (!verificationUri) {
            fail("The verification URL received from the orchestrator was not a trusted destination.");
            break;
          }
          setDevice({
            userCode: response.userCode,
            verificationUri,
            interval: response.interval,
          });
          onOpenChange(true);
          window.open(verificationUri, "_blank", "noopener");
          pollDevice(response.interval);
          break;
        }
        case "redirect": {
          const url = safeExternalUrl(response.url, flowOrigins("https://linear.app"));
          if (!url) {
            fail("The authorization URL received from the orchestrator was not a trusted destination.");
            break;
          }
          setAwaitingRedirect(true);
          onOpenChange(true);
          window.open(url, "_blank", "noopener");
          break;
        }
        case "manual":
          setManual(true);
          setManualReason(response.reason);
          onOpenChange(true);
          break;
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : "The orchestrator did not respond.");
    } finally {
      setPending(false);
    }
  };

  const submit = async (next: string) => {
    setPending(true);
    setResult(null);
    try {
      const response = await api.updateCredentials({ [spec.field]: next });
      const outcome = response.results[spec.id];
      onConfig(response.config);
      setResult(outcome ?? null);
      if (outcome?.ok) {
        setValue("");
        setManual(false);
        setManualReason(null);
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : "The orchestrator did not respond.");
    } finally {
      setPending(false);
    }
  };

  const tone: ConnectorTone = authError ? "error" : refreshWarning ? "warn" : connected ? "ok" : "idle";
  const statusLabel = authError || refreshWarning ? "Needs attention" : connected ? "Connected" : "Not connected";

  return (
    <ConnectorItem
      name={spec.name}
      open={open}
      onOpenChange={onOpenChange}
      tone={tone}
      statusLabel={statusLabel}
      actions={
        <span className="flex shrink-0 items-center gap-1.5">
          {connected ? (
            <>
              {(authError || refreshWarning) && (
                <Button
                  size="plate"
                  onClick={() => void connect()}
                  disabled={pending || device !== null}
                  title="Authorize in the browser again"
                >
                  Reconnect
                </Button>
              )}
              <Button
                variant="outline"
                size="plate"
                onClick={() => void submit("")}
                disabled={pending}
                title="Remove this key"
              >
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              size="plate"
              onClick={() => void connect()}
              disabled={pending || device !== null}
              title={spec.connectHint}
            >
              {pending ? "Connecting" : "Connect"}
            </Button>
          )}
        </span>
      }
    >
      <p className="text-[12px] leading-relaxed text-haze-400">{spec.role}</p>

        {authError && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
            <Warn className="mt-px size-3 shrink-0" />
            {authError} Polling is paused until Linear is reconnected.
          </p>
        )}

        {refreshWarning && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-ember-300">
            <Warn className="mt-px size-3 shrink-0" />
            {refreshWarning} brevi retries automatically; polling resumes once a refresh succeeds.
          </p>
        )}

        {device && (
          <div className="mt-2.5 rounded-[5px] border border-ink-600 bg-ink-950/70 p-3">
            <Plate className="text-haze-700">Enter this code on GitHub</Plate>
            <p className="mt-2 select-all font-mono text-[20px] font-semibold tracking-[0.2em] text-haze-50">
              {device.userCode}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-haze-400">
              <span className="inline-block size-[6px] animate-beacon rounded-full bg-ember-500" />
              Waiting for authorization at{" "}
              <a
                href={device.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="text-haze-200 underline decoration-ink-500 hover:text-haze-50"
              >
                {device.verificationUri.replace("https://", "")}
              </a>
            </p>
            <Button
              variant="ghost"
              size="plate"
              onClick={() => {
                setDevice(null);
                stopPolling();
              }}
              className="mt-2.5 -ml-2 hover:bg-transparent hover:text-haze-300"
            >
              Cancel
            </Button>
          </div>
        )}

        {awaitingRedirect && (!connected || authError) && (
          <p className="mt-2.5 flex items-center gap-1.5 text-[12px] text-haze-400">
            <span className="inline-block size-[6px] animate-beacon rounded-full bg-ember-500" />
            Finish authorizing in the opened tab; this panel updates by itself.
          </p>
        )}

        {manualReason && (
          <p className="mt-2.5 text-[12px] leading-relaxed text-haze-400">{manualReason}</p>
        )}

        {manual && (!connected || authError !== undefined) ? (
          <form
            className="mt-2.5 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) void submit(value);
            }}
          >
            <Input
              type="password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setResult(null);
              }}
              placeholder={spec.inputLabel}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 rounded-[4px] bg-ink-950/70 font-mono text-[12px] text-haze-100 placeholder:text-haze-700 md:text-[12px]"
            />
            <Button type="submit" size="plate" disabled={pending || value.trim() === ""}>
              {pending ? "Checking" : "Save"}
            </Button>
          </form>
        ) : (
          (!connected || authError !== undefined) &&
          !device && (
            <Button
              variant="ghost"
              size="plate"
              onClick={() => {
                setManual(true);
                onOpenChange(true);
              }}
              className="mt-2.5 -ml-2 hover:bg-transparent hover:text-haze-300"
            >
              Enter a key manually instead
            </Button>
          )
        )}

        {result && (
          <p
            className={`mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed ${
              result.ok ? "text-mint-400" : "text-rust-400"
            }`}
          >
            {result.ok ? (
              <Check className="mt-px size-3 shrink-0" />
            ) : (
              <Warn className="mt-px size-3 shrink-0" />
            )}
            {result.detail}
          </p>
        )}

        {manual && (!connected || authError !== undefined) && (
          <a
            href={spec.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2.5 inline-flex items-center gap-1 font-mono text-[10.5px] text-haze-700 hover:text-haze-300"
          >
            Get a key: {spec.keyUrlLabel}
            <External className="size-2.5" />
          </a>
        )}
    </ConnectorItem>
  );
}

/** How long an in-flight `wrangler login` may stay pending before we give up polling. */
const R2_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const R2_POLL_INTERVAL_MS = 3000;

/**
 * Cloudflare R2 evidence connector. Unlike the credential providers above,
 * "connected" is a live probe of the host's wrangler CLI, not a stored
 * secret, so this is a dedicated card rather than a ProviderSpec entry.
 *
 * One click covers the happy path: Connect triggers a `wrangler login` when
 * logged out, then (once the login poll sees it complete) automatically
 * provisions the evidence bucket. Manual bucket/URL entry is a fallback,
 * reached via "Edit" or "Enter bucket details manually instead", for custom
 * domains or anyone who wants to point at an existing bucket.
 */
function R2Row({
  config,
  onConfig,
  open,
  onOpenChange,
}: {
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = useState<R2Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [connectDetail, setConnectDetail] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards the auto-provision call below: armed (set false) only when a
  // Connect click starts a login, and disarmed after one follow-up
  // connect(). Merely loading the page while wrangler happens to be logged
  // in must never provision, and a provisioning failure must not loop; the
  // user retries via the button instead.
  const autoProvisioned = useRef(true);

  const [editing, setEditing] = useState(false);
  // The two bucket fields go through the shared draft, so they validate
  // against the schema inline and an incoming config broadcast refreshes
  // whatever is not being typed instead of resetting the whole form.
  const settings = useSettingsDraft(config, onConfig);

  const stopPolling = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  };
  useEffect(() => stopPolling, []);

  const refresh = () => {
    setLoadError(null);
    return api.r2Status().then(
      (next) => {
        setStatus(next);
        return next;
      },
      (err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "The orchestrator did not respond.");
        return null;
      },
    );
  };

  // Refetch on mount, and again whenever the saved bucket/URL change under us
  // (e.g. applied from another tab via the config broadcast).
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.r2.bucket, config.r2.publicBaseUrl]);

  // Close the editor once a save lands, but only when nothing is left dirty.
  useEffect(() => {
    if (settings.applied !== null && !settings.dirty) setEditing(false);
  }, [settings.applied, settings.dirty]);

  // Give up on a wrangler login that never completed: re-enable Connect and
  // say why, rather than leaving the button dead until a page reload.
  const expireLogin = () => {
    setConnectDetail(null);
    setLoadError("The Cloudflare login was not completed in time. Connect again to retry.");
  };

  const pollStatus = (deadline: number) => {
    pollTimer.current = setTimeout(() => {
      void api.r2Status().then(
        (next) => {
          setStatus(next);
          if (next.loggedIn) return;
          if (Date.now() < deadline) pollStatus(deadline);
          else expireLogin();
        },
        () => {
          if (Date.now() < deadline) pollStatus(deadline);
          else expireLogin();
        },
      );
    }, R2_POLL_INTERVAL_MS);
  };

  const connect = async () => {
    setPending(true);
    setLoadError(null);
    setConnectDetail(null);
    setConnectError(null);
    setUnavailableReason(null);
    try {
      const response = await api.connectR2();
      switch (response.status) {
        case "connected":
          setStatus(response.r2);
          // Provisioning wrote the bucket into config server-side, so any
          // half-typed manual entry is stale now and would otherwise be
          // saved back over the freshly provisioned values.
          settings.discard();
          break;
        case "login-started":
          autoProvisioned.current = false;
          setConnectDetail(response.detail);
          onOpenChange(true);
          pollStatus(Date.now() + R2_POLL_TIMEOUT_MS);
          break;
        case "provision-failed":
          setStatus(response.r2);
          setConnectError(response.reason);
          onOpenChange(true);
          break;
        case "unavailable":
          setUnavailableReason(response.reason);
          onOpenChange(true);
          break;
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "The orchestrator did not respond.");
    } finally {
      setPending(false);
    }
  };

  // The login happens in a host browser tab; once polling sees loggedIn flip
  // we're done with that step. If the bucket still isn't provisioned, finish
  // the one-click flow by connecting again, which now provisions instead of
  // asking to log in.
  useEffect(() => {
    if (!status?.loggedIn) return;
    setConnectDetail(null);
    stopPolling();
    if (!status.ready && !autoProvisioned.current) {
      autoProvisioned.current = true;
      void connect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.loggedIn, status?.ready]);

  const cancelEdit = () => {
    settings.discard();
    setEditing(false);
  };

  const ready = status?.ready ?? false;
  const configured = status !== null && status.bucket !== "" && status.publicBaseUrl !== "";
  const showConnect = status !== null && status.installed && !ready;
  // Not gated on being logged in: pointing at an existing public bucket (or a
  // custom domain) is a legitimate setup that needs no wrangler session here.
  const showManualEntry = !configured && !editing;

  return (
    <ConnectorItem
      name="Cloudflare R2"
      open={open}
      onOpenChange={onOpenChange}
      tone={ready ? "ok" : "idle"}
      statusLabel={ready ? "Connected" : "Not connected"}
      actions={
        showConnect ? (
          <Button
            size="plate"
            onClick={() => void connect()}
            disabled={pending || connectDetail !== null}
            title="Authenticate wrangler with your Cloudflare account and provision the evidence bucket"
          >
            {pending ? "Connecting" : "Connect"}
          </Button>
        ) : undefined
      }
    >
      <p className="text-[12px] leading-relaxed text-haze-400">
        Publishes run evidence (screenshots, recordings) to a public bucket, embedded in PR
        descriptions.
      </p>

        {status && !status.installed && (
          <>
            <p className="mt-2.5 text-[12px] leading-relaxed text-haze-400">
              The wrangler CLI was not found on this machine. Install it with{" "}
              <code className="font-mono text-[11px] text-haze-200">npm install -g wrangler</code>,
              then recheck.
            </p>
            <Button variant="outline" size="plate" onClick={() => void refresh()} className="mt-2.5">
              Recheck
            </Button>
          </>
        )}

        {connectDetail && (
          <p className="mt-2.5 flex items-center gap-1.5 text-[12px] text-haze-400">
            <span className="inline-block size-[6px] animate-beacon rounded-full bg-ember-500" />
            {connectDetail}
          </p>
        )}

        {unavailableReason && (
          <p className="mt-2.5 text-[12px] leading-relaxed text-haze-400">{unavailableReason}</p>
        )}

        {status?.loggedIn && (
          <>
            <p className="mt-2.5 text-[12px] leading-relaxed text-haze-400">
              Authenticated {status.account ? `as ${status.account} ` : ""}via wrangler
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-haze-700">
              Run <code className="font-mono text-[10.5px] text-haze-400">wrangler logout</code> on
              this machine to disconnect.
            </p>
          </>
        )}

        {connectError && (
          <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
            <Warn className="mt-px size-3 shrink-0" />
            {connectError}
          </p>
        )}

        {configured && !editing && (
          <div className="mt-2.5 flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <span className="w-14 shrink-0 text-[11px] text-haze-700">Bucket</span>
              <span className="min-w-0 truncate font-mono text-[12px] text-haze-200">
                {status.bucket}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="w-14 shrink-0 text-[11px] text-haze-700">Public URL</span>
              <span className="min-w-0 truncate font-mono text-[12px] text-haze-200">
                {status.publicBaseUrl}
              </span>
            </div>
            <Button
              variant="ghost"
              size="plate"
              onClick={() => {
                setEditing(true);
                onOpenChange(true);
              }}
              className="mt-1 -ml-2 self-start hover:bg-transparent hover:text-haze-300"
            >
              Edit
            </Button>
          </div>
        )}

        {showManualEntry && (
          <Button
            variant="ghost"
            size="plate"
            onClick={() => {
              setEditing(true);
              onOpenChange(true);
            }}
            className="mt-2.5 -ml-2 hover:bg-transparent hover:text-haze-300"
          >
            Enter bucket details manually instead
          </Button>
        )}

        {editing && (
          <div className="mt-3 flex flex-col">
            <TextField
              label="Bucket"
              path="r2.bucket"
              draft={settings}
              placeholder="brevi-evidence"
              wide
              help="Public R2 bucket demo evidence is uploaded to. Empty disables uploads."
            />
            <TextField
              label="Public base URL"
              path="r2.publicBaseUrl"
              draft={settings}
              placeholder="https://pub-xxxx.r2.dev"
              wide
              help="Its r2.dev development URL or a custom domain, used verbatim to build the links embedded in PR descriptions."
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="plate"
                onClick={settings.save}
                disabled={settings.saving || settings.invalid || !settings.dirty}
                className="self-start"
              >
                {settings.saving ? "Saving" : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="plate"
                onClick={cancelEdit}
                disabled={settings.saving}
                className="self-start hover:bg-transparent hover:text-haze-300"
              >
                Cancel
              </Button>
            </div>
            {settings.error && (
              <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
                <Warn className="mt-px size-3 shrink-0" />
                {settings.error}
              </p>
            )}
          </div>
        )}

        <p className="mt-2 text-[11px] leading-relaxed text-haze-700">
          The bucket must be public: enable its r2.dev development URL or attach a custom domain.
        </p>

        {!editing && settings.applied !== null && (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-mint-400">
            <Check className="size-3 shrink-0" />
            Saved.
          </p>
        )}

        {loadError && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
            <Warn className="mt-px size-3 shrink-0" />
            {loadError}
          </p>
        )}
    </ConnectorItem>
  );
}
