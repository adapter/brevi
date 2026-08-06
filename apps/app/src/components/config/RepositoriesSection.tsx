import { useEffect, useMemo, useState } from "react";
import type { BreviConfig, GithubRepo, LinearProject, RepoConfig } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { api } from "../../lib/api";
import { Plate, RepoChip } from "../Bits";
import { ChevronRight, Close, Plus, Warn } from "../Icons";

/**
 * Repo mappings, sourced from the connected GitHub account. Tickets resolve to
 * a repo via a "repo:<key>" label, a project name, or the default mapping.
 */
export function RepositoriesSection({
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
    <section className="mt-6">
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
          Connect GitHub on the Connectors page to pick repositories from your account.
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
