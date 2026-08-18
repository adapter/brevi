import { useEffect, useMemo, useState } from "react";
import type { BreviConfig, GithubRepo, LinearProject, LinearStatus, Run } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { joinConfigPath } from "@brevi/shared/settings";
import { useSettingsDraft } from "../../lib/settings";
import { api } from "../../lib/api";
import { linearConnected as isLinearConnected } from "../../lib/linear";
import { Plate } from "../Bits";
import { Branch, ChevronRight, Close, Plus, Warn } from "../Icons";
import {
  FieldRow,
  OptionalTextField,
  SectionIntro,
  SettingsCard,
  TextField,
} from "./Fields";

/** Every non-terminal run status: these still have somewhere to go, so removing their repo hurts. */
const UNFINISHED = new Set(["queued", "preparing", "running", "finalizing", "waiting"]);

/**
 * Repo mappings, sourced from the connected GitHub account. Tickets resolve to
 * a repo via a "repo:<key>" label or a Linear project name. Each mapping is
 * its own card, saved on its own; adding and removing a repo writes through
 * the same settings endpoint.
 */
export function RepositoriesSection({
  config,
  runs,
  linearStatus,
  onConfig,
}: {
  config: BreviConfig;
  runs: Run[];
  linearStatus: LinearStatus | null;
  onConfig: (config: BreviConfig) => void;
}) {
  const githubConnected = config.github.token !== "";
  const linearConnected = isLinearConnected(config, linearStatus);
  const mapped = Object.entries(config.repos);

  const [available, setAvailable] = useState<GithubRepo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [mutateError, setMutateError] = useState<string | null>(null);
  const [linearProjects, setLinearProjects] = useState<LinearProject[] | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

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

  /** Add and remove write straight through, without a card to save. */
  const mutate = async (patch: Record<string, unknown>) => {
    setPending(true);
    setMutateError(null);
    try {
      const response = await api.updateSettings(patch);
      onConfig(response.config);
    } catch (err) {
      setMutateError(err instanceof Error ? err.message : "The orchestrator did not respond.");
    } finally {
      setPending(false);
    }
  };

  const add = (repo: GithubRepo) => {
    const name = repo.fullName.split("/")[1] ?? repo.fullName;
    // Both the bare name and the owner-qualified fallback can already be
    // taken; suffixing until the key is free beats silently replacing an
    // existing mapping (and the run history that routes through it).
    let key = name;
    if (config.repos[key]) key = repo.fullName.replace("/", "-");
    for (let n = 2; config.repos[key]; n += 1) key = `${repo.fullName.replace("/", "-")}-${n}`;
    void mutate({
      repos: {
        [key]: { remote: repo.fullName, defaultBranch: repo.defaultBranch, projects: [], demo: "auto" },
      },
    });
    setSearch("");
    setAdding(false);
  };

  const remove = (key: string) => {
    setConfirmRemove(null);
    void mutate({
      repos: { [key]: null },
    });
  };

  // Removing a mapping strands whatever is still in flight against it, so the
  // confirmation says how much that is.
  const unfinished = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of runs) {
      const key = run.ticket.repo;
      if (!key || !UNFINISHED.has(run.status)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [runs]);

  return (
    <>
      <SectionIntro title="Repositories">
        Tickets run against these checkouts. A <code className="font-mono text-[11px]">repo:&lt;key&gt;</code>{" "}
        label, a mapped Linear project, or a matching project name picks one. Tickets that match
        nothing do not run.
      </SectionIntro>

      <div className="mt-3 flex flex-col gap-2">
        {mapped.map(([key]) => (
          <RepoCard
            key={key}
            repoKey={key}
            config={config}
            onConfig={onConfig}
            linearProjects={linearProjects}
            unfinished={unfinished.get(key) ?? 0}
            removing={pending && confirmRemove === key}
            confirming={confirmRemove === key}
            onAskRemove={() => setConfirmRemove(key)}
            onCancelRemove={() => setConfirmRemove(null)}
            onRemove={() => remove(key)}
          />
        ))}

        {/* Only the picker needs GitHub: existing mappings and routing stay
            editable while it is disconnected, so a token that lapses does not
            hide the repos already configured. */}
        {!githubConnected ? (
          <p className="text-[12.5px] leading-relaxed text-haze-700">
            Connect GitHub on the Connectors page to add repositories from your account.
          </p>
        ) : (
          <div>
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
                    className="rounded-md bg-ink-950/70 font-mono text-[12px] text-haze-100 placeholder:text-haze-700 md:text-[12px]"
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
                  <ul className="mt-2 overflow-hidden rounded-lg border border-ink-600">
                    {candidates.map((repo) => (
                      <li key={repo.fullName} className="border-b border-ink-700 last:border-b-0">
                        <button
                          type="button"
                          onClick={() => add(repo)}
                          disabled={pending}
                          className="flex w-full items-center gap-2 bg-ink-900 px-2.5 py-2 text-left hover:bg-ink-750 pointer-coarse:min-h-11"
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
        )}

        {mutateError && (
          <p className="flex items-start gap-1.5 text-[12px] text-rust-400">
            <Warn className="mt-px size-3 shrink-0" />
            {mutateError}
          </p>
        )}
      </div>
    </>
  );
}

/** One repo mapping: identity on the header row, the rest behind Details. */
function RepoCard({
  repoKey,
  config,
  onConfig,
  linearProjects,
  unfinished,
  removing,
  confirming,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  repoKey: string;
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
  linearProjects: LinearProject[] | null;
  /** Queued, waiting, or running runs still pointing at this repo. */
  unfinished: number;
  removing: boolean;
  confirming: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  const draft = useSettingsDraft(config, onConfig);
  const repo = config.repos[repoKey];
  if (!repo) return null;
  // Built segment by segment, not interpolated: a repo key is a GitHub
  // repository name and may contain dots (next.js, socket.io), which a raw
  // dotted path would split into extra levels.
  const at = (field: string) => joinConfigPath(["repos", repoKey, field]);

  return (
    <SettingsCard
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="min-w-0 truncate">{repo.remote}</span>
          <span
            className="font-mono text-[10.5px] font-normal text-haze-600"
            title={`Tickets labeled repo:${repoKey} route here`}
          >
            repo:{repoKey}
          </span>
          <span className="flex items-center gap-1 font-mono text-[10.5px] font-normal text-haze-600">
            <Branch className="size-3" />
            {repo.defaultBranch}
          </span>
          <span className="ml-auto flex items-center gap-1.5 font-normal">
            {confirming ? (
              <>
                <span className="text-[11.5px] text-haze-400">
                  {unfinished > 0
                    ? `Remove this mapping? ${unfinished} unfinished ${unfinished === 1 ? "run" : "runs"} still point at it.`
                    : "Remove this mapping?"}
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="plate"
                  onClick={onRemove}
                  disabled={removing}
                >
                  {removing ? "Removing" : "Remove"}
                </Button>
                <Button type="button" variant="ghost" size="plate" onClick={onCancelRemove}>
                  Keep
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onAskRemove}
                aria-label={`Remove ${repoKey}`}
                className="hover:text-rust-400"
              >
                <Close className="size-3" />
              </Button>
            )}
          </span>
        </span>
      }
      draft={draft}
    >
      <ProjectsRow
        repoKey={repoKey}
        projects={draft.value(at("projects"))}
        options={linearProjects}
        onChange={(projects) => draft.set(at("projects"), projects)}
      />
      <Collapsible>
        <CollapsibleTrigger className="group/details flex cursor-pointer items-center gap-1.5 border-t border-ink-700 py-2 text-[11px] font-medium text-haze-600 hover:text-haze-300">
          <ChevronRight className="size-3 transition-transform group-data-[panel-open]/details:rotate-90" />
          Details
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col pb-1">
          <TextField
            label="Remote"
            path={at("remote")}
            draft={draft}
            placeholder="owner/name"
            help="Git remote in owner/name form."
          />
          <TextField
            label="Default branch"
            path={at("defaultBranch")}
            draft={draft}
            placeholder="main"
            help="Branch every run is cut from and every PR targets."
          />
          <OptionalTextField
            label="Local checkout path"
            path={at("path")}
            draft={draft}
            wide
            placeholder="/Users/you/code/web"
            help="Optional local checkout to clone from instead of the network."
          />
        </CollapsibleContent>
      </Collapsible>
    </SettingsCard>
  );
}

/**
 * Multi-select of Linear projects that route tickets to a repo. Options come
 * from the orchestrator's project list; names already configured but no longer
 * returned by Linear stay selectable so they can be unmapped. Shared with the
 * per-repo settings page.
 */
export function ProjectsRow({
  repoKey,
  projects: raw,
  options,
  onChange,
  wide = true,
}: {
  repoKey: string;
  projects: unknown;
  options: LinearProject[] | null;
  onChange: (projects: string[]) => void;
  /** Full-row control (the Repositories card); off, it sits in the standard 280px column. */
  wide?: boolean;
}) {
  // A running orchestrator from before this field may serve configs without
  // it; never let that take the app down.
  const projects = Array.isArray(raw) ? (raw as string[]) : [];
  const names = useMemo(() => {
    const set = new Set<string>(options?.map((project) => project.name) ?? []);
    for (const name of projects) set.add(name);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [options, projects]);
  const empty = names.length === 0;

  return (
    <FieldRow
      label="Linear projects"
      help="Tickets in these projects run against this repo, matched case-insensitively."
      wide={wide}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="plate"
              disabled={empty}
              className="w-full justify-start font-mono text-[11px] tracking-normal normal-case"
              aria-label={`Linear projects mapped to ${repoKey}`}
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
              onCheckedChange={(checked) =>
                onChange(
                  checked === true ? [...projects, name] : projects.filter((p) => p !== name),
                )
              }
              closeOnClick={false}
            >
              {name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </FieldRow>
  );
}
