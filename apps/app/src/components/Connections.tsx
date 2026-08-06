import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BreviConfig,
  CredentialProvider,
  CredentialResult,
  CredentialsUpdateRequest,
  GithubRepo,
  LinearProject,
  R2Status,
  RepoConfig,
} from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sidebar, SidebarContent, SidebarHeader } from "@/components/ui/sidebar";
import { api } from "../lib/api";
import { Plate, RepoChip } from "./Bits";
import { Check, ChevronRight, Close, External, Minus, Plus, Warn } from "./Icons";

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
];

/**
 * Permanent right sidebar to connect Linear, GitHub, and agent credentials,
 * the mirror of the runs sidebar on the left.
 */
export function ConnectionsSidebar({
  config,
  onConfig,
}: {
  config: BreviConfig | null;
  onConfig: (config: BreviConfig) => void;
}) {
  const connectedCount = config
    ? PROVIDERS.filter((spec) => spec.connected(config)).length
    : 0;

  return (
    <Sidebar
      side="right"
      collapsible="none"
      className="h-svh w-[22rem] shrink-0 border-l border-sidebar-border"
    >
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-4">
        <div className="flex items-center gap-2">
          <Plate className="text-haze-400">Connections</Plate>
          <span className="font-mono text-[11px] leading-none font-normal text-haze-700">
            {config ? `${connectedCount}/${PROVIDERS.length}` : "-"}
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent className="min-h-0 flex-1 overflow-y-auto p-3">
        {config ? (
          <>
            <ul className="flex flex-col gap-2.5">
              {PROVIDERS.map((spec) => (
                <li key={spec.id}>
                  <ProviderRow spec={spec} config={config} onConfig={onConfig} />
                </li>
              ))}
              <li>
                <R2Row config={config} onConfig={onConfig} />
              </li>
            </ul>
            <RepositoriesSection config={config} onConfig={onConfig} />
            <SandboxSection config={config} onConfig={onConfig} />
            <p className="mt-4 border-t border-ink-700 pt-3 text-[11.5px] leading-relaxed text-haze-700">
              Credentials are validated with the provider, then stored in{" "}
              <code className="font-mono text-[10.5px] text-haze-400">~/.brevi/config.json</code>.
              They never leave this machine.
            </p>
          </>
        ) : (
          <p className="mt-3 px-1 text-[12.5px] leading-relaxed text-haze-700">
            Waiting for the orchestrator; connections can be edited once it answers.
          </p>
        )}
      </SidebarContent>
    </Sidebar>
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
}: {
  spec: ProviderSpec;
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
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
  useEffect(() => {
    if (connected) {
      setAwaitingRedirect(false);
      setDevice(null);
      stopPolling();
    }
  }, [connected]);

  const fail = (detail: string) => setResult({ ok: false, detail });

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
        case "device":
          setDevice({
            userCode: response.userCode,
            verificationUri: response.verificationUri,
            interval: response.interval,
          });
          window.open(response.verificationUri, "_blank", "noopener");
          pollDevice(response.interval);
          break;
        case "redirect":
          setAwaitingRedirect(true);
          window.open(response.url, "_blank", "noopener");
          break;
        case "manual":
          setManual(true);
          setManualReason(response.reason);
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

  return (
    <Card size="sm" className="gap-1.5">
      <CardHeader className="gap-0">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block size-[7px] shrink-0 rounded-full ${connected ? "bg-mint-500" : "bg-haze-700"}`}
            role="img"
            aria-label={connected ? "Connected" : "Not connected"}
            title={connected ? "Connected" : "Not connected"}
          />
          <h3 className="font-plate text-[12px] font-semibold tracking-[0.04em] text-haze-50">
            {spec.name}
          </h3>
          <span className="ml-auto">
            {connected ? (
              <Button
                variant="outline"
                size="plate"
                onClick={() => void submit("")}
                disabled={pending}
                title="Remove this key"
              >
                Disconnect
              </Button>
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
        </div>
      </CardHeader>

      <CardContent>
        <p className="text-[12px] leading-relaxed text-haze-400">{spec.role}</p>

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

        {awaitingRedirect && !connected && (
          <p className="mt-2.5 flex items-center gap-1.5 text-[12px] text-haze-400">
            <span className="inline-block size-[6px] animate-beacon rounded-full bg-ember-500" />
            Finish authorizing in the opened tab; this panel updates by itself.
          </p>
        )}

        {manualReason && (
          <p className="mt-2.5 text-[12px] leading-relaxed text-haze-400">{manualReason}</p>
        )}

        {manual && !connected ? (
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
          !connected &&
          !device && (
            <Button
              variant="ghost"
              size="plate"
              onClick={() => setManual(true)}
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

        {manual && !connected && (
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
      </CardContent>
    </Card>
  );
}

/** How long an in-flight `wrangler login` may stay pending before we give up polling. */
const R2_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const R2_POLL_INTERVAL_MS = 3000;

/**
 * Cloudflare R2 evidence connector. Unlike the credential providers above,
 * "connected" is a live probe of the host's wrangler CLI, not a stored
 * secret, so this is a dedicated card rather than a ProviderSpec entry.
 */
function R2Row({
  config,
  onConfig,
}: {
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
}) {
  const [status, setStatus] = useState<R2Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [connectDetail, setConnectDetail] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [bucket, setBucket] = useState(config.r2.bucket);
  const [publicBaseUrl, setPublicBaseUrl] = useState(config.r2.publicBaseUrl);
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsResult, setSettingsResult] = useState<CredentialResult | null>(null);

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

  useEffect(() => {
    setBucket(config.r2.bucket);
    setPublicBaseUrl(config.r2.publicBaseUrl);
  }, [config.r2.bucket, config.r2.publicBaseUrl]);

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

  // The login happens in a host browser tab; once polling sees loggedIn flip
  // we're done.
  useEffect(() => {
    if (status?.loggedIn) {
      setConnectDetail(null);
      stopPolling();
    }
  }, [status?.loggedIn]);

  const connect = async () => {
    setPending(true);
    setLoadError(null);
    setConnectDetail(null);
    setUnavailableReason(null);
    try {
      const response = await api.connectR2();
      switch (response.status) {
        case "connected":
          setStatus(response.r2);
          break;
        case "login-started":
          setConnectDetail(response.detail);
          pollStatus(Date.now() + R2_POLL_TIMEOUT_MS);
          break;
        case "unavailable":
          setUnavailableReason(response.reason);
          break;
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "The orchestrator did not respond.");
    } finally {
      setPending(false);
    }
  };

  const saveSettings = async () => {
    setSettingsPending(true);
    setSettingsResult(null);
    try {
      const response = await api.updateR2Settings({ bucket, publicBaseUrl });
      onConfig(response.config);
      setStatus(response.r2);
      setSettingsResult({ ok: true, detail: "Saved." });
    } catch (err) {
      setSettingsResult({
        ok: false,
        detail: err instanceof Error ? err.message : "The orchestrator did not respond.",
      });
    } finally {
      setSettingsPending(false);
    }
  };

  const ready = status?.ready ?? false;
  const showConnect = status !== null && status.installed && !status.loggedIn;

  return (
    <Card size="sm" className="gap-1.5">
      <CardHeader className="gap-0">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block size-[7px] shrink-0 rounded-full ${ready ? "bg-mint-500" : "bg-haze-700"}`}
            role="img"
            aria-label={ready ? "Connected" : "Not connected"}
            title={ready ? "Connected" : "Not connected"}
          />
          <h3 className="font-plate text-[12px] font-semibold tracking-[0.04em] text-haze-50">
            Cloudflare R2
          </h3>
          {showConnect && (
            <span className="ml-auto">
              <Button
                size="plate"
                onClick={() => void connect()}
                disabled={pending || connectDetail !== null}
                title="Authenticate wrangler with your Cloudflare account"
              >
                {pending ? "Connecting" : "Connect"}
              </Button>
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent>
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

        <div className="mt-3 flex flex-col gap-2">
          <Input
            type="text"
            value={bucket}
            onChange={(e) => {
              setBucket(e.target.value);
              setSettingsResult(null);
            }}
            placeholder="Bucket name"
            autoComplete="off"
            spellCheck={false}
            className="rounded-[4px] bg-ink-950/70 font-mono text-[12px] text-haze-100 placeholder:text-haze-700 md:text-[12px]"
          />
          <Input
            type="text"
            value={publicBaseUrl}
            onChange={(e) => {
              setPublicBaseUrl(e.target.value);
              setSettingsResult(null);
            }}
            placeholder="https://pub-xxxx.r2.dev"
            autoComplete="off"
            spellCheck={false}
            className="rounded-[4px] bg-ink-950/70 font-mono text-[12px] text-haze-100 placeholder:text-haze-700 md:text-[12px]"
          />
          <Button
            size="plate"
            onClick={() => void saveSettings()}
            disabled={settingsPending}
            className="self-start"
          >
            {settingsPending ? "Saving" : "Save"}
          </Button>
        </div>

        {status?.loggedIn && (bucket.trim() === "" || publicBaseUrl.trim() === "") && (
          <p className="mt-2.5 text-[12px] leading-relaxed text-haze-700">
            Set a bucket and its public URL to activate uploads.
          </p>
        )}

        <p className="mt-2 text-[11px] leading-relaxed text-haze-700">
          The bucket must be public: enable its r2.dev development URL or attach a custom domain.
        </p>

        {settingsResult && (
          <p
            className={`mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed ${
              settingsResult.ok ? "text-mint-400" : "text-rust-400"
            }`}
          >
            {settingsResult.ok ? (
              <Check className="mt-px size-3 shrink-0" />
            ) : (
              <Warn className="mt-px size-3 shrink-0" />
            )}
            {settingsResult.detail}
          </p>
        )}

        {loadError && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
            <Warn className="mt-px size-3 shrink-0" />
            {loadError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Repo mappings, sourced from the connected GitHub account. Tickets resolve to
 * a repo via a "repo:<key>" label, a project name, or the default mapping.
 */
function RepositoriesSection({
  config,
  onConfig,
}: {
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
}) {
  const githubConnected = config.github.token !== "";
  const linearConnected = config.linear.apiKey !== "";
  const mapped = Object.entries(config.repos);

  const [available, setAvailable] = useState<GithubRepo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [mutateError, setMutateError] = useState<string | null>(null);
  const [linearProjects, setLinearProjects] = useState<LinearProject[] | null>(null);

  useEffect(() => {
    if (!linearConnected) {
      setLinearProjects(null);
      return;
    }
    let cancelled = false;
    api
      .linearProjects()
      .then((projects) => {
        if (!cancelled) setLinearProjects(projects);
      })
      .catch(() => {
        // The picker degrades to showing configured names; no need to shout.
        if (!cancelled) setLinearProjects(null);
      });
    return () => {
      cancelled = true;
    };
  }, [linearConnected, config.linear.apiKey]);

  useEffect(() => {
    if (!githubConnected) {
      setAvailable(null);
      return;
    }
    let cancelled = false;
    setLoadError(null);
    api
      .githubRepos()
      .then((repos) => {
        if (!cancelled) setAvailable(repos);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not list repos.");
      });
    return () => {
      cancelled = true;
    };
  }, [githubConnected, config.github.token]);

  const mappedRemotes = useMemo(() => new Set(mapped.map(([, repo]) => repo.remote)), [mapped]);
  const candidates = useMemo(() => {
    if (!available) return [];
    const q = search.trim().toLowerCase();
    return available
      .filter((repo) => !mappedRemotes.has(repo.fullName))
      .filter((repo) => q === "" || repo.fullName.toLowerCase().includes(q))
      .slice(0, 8);
  }, [available, mappedRemotes, search]);

  const mutate = async (repos: Record<string, RepoConfig>, defaultRepo?: string) => {
    setPending(true);
    setMutateError(null);
    try {
      const response = await api.updateRepos({ repos, defaultRepo });
      onConfig(response.config);
    } catch (err) {
      setMutateError(err instanceof Error ? err.message : "The orchestrator did not respond.");
    } finally {
      setPending(false);
    }
  };

  const add = (repo: GithubRepo) => {
    const name = repo.fullName.split("/")[1] ?? repo.fullName;
    const key = config.repos[name] ? repo.fullName.replace("/", "-") : name;
    void mutate(
      {
        ...config.repos,
        [key]: { remote: repo.fullName, defaultBranch: repo.defaultBranch, projects: [], demo: "auto" },
      },
      config.defaultRepo ?? key,
    );
    setSearch("");
    setAdding(false);
  };

  const setProjects = (key: string, projects: string[]) => {
    const repo = config.repos[key];
    if (!repo) return;
    void mutate({ ...config.repos, [key]: { ...repo, projects } }, config.defaultRepo);
  };

  const remove = (key: string) => {
    const next = { ...config.repos };
    delete next[key];
    const defaultRepo = config.defaultRepo === key ? undefined : config.defaultRepo;
    void mutate(next, defaultRepo);
  };

  return (
    <section className="mt-5 border-t border-ink-700 pt-4">
      <div className="flex items-center gap-2">
        <Plate className="text-haze-400">Repositories</Plate>
        <span className="font-mono text-[11px] leading-none text-haze-700">{mapped.length}</span>
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-haze-400">
        Tickets run against these checkouts. A <code className="font-mono text-[11px]">repo:&lt;key&gt;</code>{" "}
        label, a mapped Linear project, or a matching project name picks one; everything else uses
        the default.
      </p>

      {!githubConnected ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-haze-700">
          Connect GitHub above to pick repositories from your account.
        </p>
      ) : (
        <>
          {mapped.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {mapped.map(([key, repo]) => (
                <li key={key} className="strip flex flex-col gap-2 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <RepoChip repo={key} />
                    <span className="min-w-0 truncate font-mono text-[11px] text-haze-400">
                      {repo.remote}
                    </span>
                    <span className="font-mono text-[10px] text-haze-700">
                      {repo.defaultBranch}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => remove(key)}
                        disabled={pending}
                        aria-label={`Remove ${key}`}
                        className="hover:text-rust-400"
                      >
                        <Close className="size-3" />
                      </Button>
                    </span>
                  </div>
                  <ProjectsField
                    // A running orchestrator from before this field may serve
                    // configs without it; never let that take the app down.
                    projects={repo.projects ?? []}
                    options={linearProjects}
                    pending={pending}
                    onCommit={(projects) => setProjects(key, projects)}
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3">
            {!adding ? (
              <Button
                variant="outline"
                size="plate"
                onClick={() => setAdding(true)}
                className="text-haze-400"
              >
                <Plus className="size-3" />
                Add repository
              </Button>
            ) : (
              <>
            <div className="flex items-center gap-1.5">
              <Input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={available ? "Search your account" : "Loading repositories…"}
                disabled={!available}
                spellCheck={false}
                autoFocus
                className="rounded-[4px] bg-ink-950/70 font-mono text-[12px] text-haze-100 placeholder:text-haze-700 md:text-[12px]"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  setAdding(false);
                  setSearch("");
                }}
                aria-label="Stop adding"
              >
                <Close className="size-3" />
              </Button>
            </div>
            {loadError && (
              <p className="mt-2 flex items-start gap-1.5 text-[12px] text-rust-400">
                <Warn className="mt-px size-3 shrink-0" />
                {loadError}
              </p>
            )}
            {available && candidates.length > 0 && (
              <ul className="mt-2 overflow-hidden rounded-[5px] border border-ink-600">
                {candidates.map((repo) => (
                  <li key={repo.fullName} className="border-b border-ink-700 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => add(repo)}
                      disabled={pending}
                      className="flex w-full items-center gap-2 bg-ink-900 px-2.5 py-2 text-left hover:bg-ink-750"
                    >
                      <span className="min-w-0 truncate font-mono text-[12px] text-haze-100">
                        {repo.fullName}
                      </span>
                      {repo.private && <Plate className="text-haze-700">private</Plate>}
                      <span className="ml-auto font-mono text-[10px] text-haze-700">
                        {repo.defaultBranch}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {available && search.trim() !== "" && candidates.length === 0 && (
              <p className="mt-2 text-[12px] text-haze-700">No unmapped repos match.</p>
            )}
              </>
            )}
          </div>

          {mutateError && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-rust-400">
              <Warn className="mt-px size-3 shrink-0" />
              {mutateError}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** How many sandboxed runs may execute at once, above which host memory gets tight. */
const CONCURRENCY_MEMORY_HINT = 4;

/**
 * Sandbox run concurrency: a stepper backed by the orchestrator's live
 * sandbox settings. The value shown always comes from the server-confirmed
 * config, never local optimistic state.
 */
function SandboxSection({
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
    <section className="mt-5 border-t border-ink-700 pt-4">
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

/**
 * Multi-select of Linear projects that route tickets to a repo. Options come
 * from the orchestrator's project list; names already configured but no longer
 * returned by Linear stay selectable so they can be unmapped.
 */
function ProjectsField({
  projects,
  options,
  pending,
  onCommit,
}: {
  projects: string[];
  options: LinearProject[] | null;
  pending: boolean;
  onCommit: (projects: string[]) => void;
}) {
  const names = useMemo(() => {
    const set = new Set<string>(options?.map((project) => project.name) ?? []);
    for (const name of projects) set.add(name);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [options, projects]);

  const toggle = (name: string, checked: boolean) => {
    onCommit(checked ? [...projects, name] : projects.filter((p) => p !== name));
  };

  const empty = names.length === 0;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Plate className="shrink-0 text-haze-700">Projects</Plate>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="plate"
              disabled={pending || empty}
              className="min-w-0 flex-1 justify-start font-mono text-[11px] tracking-normal normal-case"
            />
          }
        >
          <span className={`truncate ${projects.length === 0 ? "text-haze-700" : "text-haze-200"}`}>
            {empty
              ? options === null
                ? "Linear projects unavailable"
                : "No Linear projects found"
              : projects.length === 0
                ? "Map Linear projects"
                : projects.join(", ")}
          </span>
          <ChevronRight className="ml-auto size-3 rotate-90 text-haze-700" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-64 min-w-52 overflow-y-auto">
          {names.map((name) => (
            <DropdownMenuCheckboxItem
              key={name}
              checked={projects.includes(name)}
              onCheckedChange={(checked) => toggle(name, checked === true)}
              closeOnClick={false}
            >
              {name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
