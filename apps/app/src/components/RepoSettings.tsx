import { useCallback, useEffect, useState } from "react";
import type { BreviConfig, LinearProject, LinearStatus, RepoMemory } from "@brevi/shared";
import { joinConfigPath } from "@brevi/shared/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { api } from "../lib/api";
import { relative } from "../lib/format";
import { linearConnected as isLinearConnected } from "../lib/linear";
import { useSettingsDraft } from "../lib/settings";
import { ProjectsRow } from "./config/RepositoriesSection";
import { SettingsCard, TextField } from "./config/Fields";
import { Branch, Close, Refresh, Warn } from "./Icons";

/**
 * One repository's settings, at /repos/<key>: identity and ticket routing
 * for the repos.<key> entry in config.json. Opened from the gear on the
 * sidebar's project header.
 */
export function RepoSettingsPage({
  config,
  linearStatus,
  repoKey,
  onConfig,
}: {
  config: BreviConfig | null;
  linearStatus: LinearStatus | null;
  repoKey: string;
  onConfig: (config: BreviConfig) => void;
}) {
  const repo = config?.repos[repoKey];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-5 sm:py-7 md:px-8">
      <header>
        <h2 className="min-w-0 truncate text-[16px] font-semibold text-haze-50">
          {repo?.remote ?? "Repository settings"}
        </h2>
      </header>
      {repo && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] leading-relaxed text-haze-400">
          <span
            className="font-mono text-[11px] text-haze-600"
            title={`Tickets labeled repo:${repoKey} route here`}
          >
            repo:{repoKey}
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-haze-600">
            <Branch className="size-3" />
            {repo.defaultBranch}
          </span>
        </p>
      )}

      {config === null ? (
        <p className="mt-6 text-[12.5px] leading-relaxed text-haze-700">
          Waiting for the orchestrator; settings can be edited once it answers.
        </p>
      ) : !repo ? (
        <p className="mt-6 text-[12.5px] leading-relaxed text-haze-700">
          No repository named <code className="font-mono text-[11px]">{repoKey}</code> is
          configured. It may have been removed on the Repositories page.
        </p>
      ) : (
        <RepoSettingsBody
          // Remount on repo switch: the drafts inside hold entries keyed by
          // the previous repo's paths, and a reused instance would carry
          // repo A's unsaved edits onto repo B's page and save them there.
          key={repoKey}
          config={config}
          linearStatus={linearStatus}
          repoKey={repoKey}
          onConfig={onConfig}
        />
      )}
    </div>
  );
}

/** The cards, split out so hooks only run once the repo is known to exist. */
function RepoSettingsBody({
  config,
  linearStatus,
  repoKey,
  onConfig,
}: {
  config: BreviConfig;
  linearStatus: LinearStatus | null;
  repoKey: string;
  onConfig: (config: BreviConfig) => void;
}) {
  // Each card owns its own draft so a save only touches that card's fields.
  const identityDraft = useSettingsDraft(config, onConfig);
  const routingDraft = useSettingsDraft(config, onConfig);
  const linearConnected = isLinearConnected(config, linearStatus);
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

  // Built segment by segment, not interpolated: a repo key is a GitHub
  // repository name and may contain dots (next.js, socket.io), which a raw
  // dotted path would split into extra levels.
  const at = (field: string) => joinConfigPath(["repos", repoKey, field]);

  return (
    <div className="mt-5 flex flex-col gap-3">
      <SettingsCard
        title="Repository"
        description="How runs branch from this repository."
        draft={identityDraft}
      >
        <TextField
          label="Default branch"
          path={at("defaultBranch")}
          draft={identityDraft}
          placeholder="main"
          help="Branch every run is cut from and every PR targets."
        />
      </SettingsCard>

      <SettingsCard
        title="Ticket routing"
        description={
          <>
            Tickets reach this repo through a{" "}
            <code className="font-mono text-[11px]">repo:{repoKey}</code> label or a mapped Linear
            project.
          </>
        }
        draft={routingDraft}
      >
        <ProjectsRow
          repoKey={repoKey}
          projects={routingDraft.value(at("projects"))}
          options={linearProjects}
          onChange={(projects) => routingDraft.set(at("projects"), projects)}
          wide={false}
        />
      </SettingsCard>

      <MemoriesCard repoKey={repoKey} />
    </div>
  );
}

/**
 * This repository's stored memories: durable facts runs recorded on the way
 * out, handed to every future run in the repo. Listed here so a memory that
 * turned out to be wrong can be dropped; forgetting is immediate and cannot
 * be undone. The memory feature's global knobs live on the Agent page.
 */
function MemoriesCard({ repoKey }: { repoKey: string }) {
  const [memories, setMemories] = useState<RepoMemory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** "Forget all" is armed by a first click, so one click cannot wipe the repo's history. */
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    api
      .memories()
      .then((response) => {
        setMemories(response.repos[repoKey] ?? []);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  }, [repoKey]);

  // Loaded once on mount and refreshed on demand: memories change only when a
  // run finishes, which is far too rare to poll for.
  useEffect(load, [load]);

  const mutate = (action: Promise<{ repos: Record<string, RepoMemory[]> }>): void => {
    setBusy(true);
    action
      .then((response) => {
        setMemories(response.repos[repoKey] ?? []);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        setBusy(false);
        setConfirming(false);
      });
  };

  const now = Date.now();

  return (
    <Card size="sm" className="gap-2">
      <CardHeader className="gap-0">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[13px] font-semibold text-haze-50">Memories</h3>
          <div className="flex shrink-0 items-center gap-1">
            {memories !== null && memories.length > 0 && (
              <Button
                type="button"
                variant={confirming ? "destructive" : "ghost"}
                size="plate"
                disabled={busy}
                onClick={() => {
                  if (confirming) mutate(api.clearMemories(repoKey));
                  else setConfirming(true);
                }}
                onBlur={() => setConfirming(false)}
              >
                {confirming ? "Confirm" : "Forget all"}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="plate"
              onClick={load}
              disabled={busy}
              aria-label="Refresh memories"
            >
              <Refresh />
              Refresh
            </Button>
          </div>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-haze-400">
          Durable facts runs recorded about this repository, handed to every future run in it. A
          wrong memory is worse than no memory; forgetting one here is immediate and cannot be
          undone.
        </p>
      </CardHeader>
      <CardContent className="mt-2.5 flex flex-col">
        {error && (
          <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
            <Warn className="mt-px size-3 shrink-0" />
            {error}
          </p>
        )}
        {memories === null && !error ? (
          <p className="text-[12px] text-haze-700">Loading.</p>
        ) : memories !== null && memories.length === 0 ? (
          <p className="text-[12.5px] leading-relaxed text-haze-700">
            Nothing remembered yet. The first run to finish in this repo writes its memories here.
          </p>
        ) : (
          <ul>
            {(memories ?? []).map((entry) => (
              <li
                key={entry.id}
                className="group flex items-start gap-2 border-b border-ink-800 py-1.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] leading-relaxed break-words text-haze-200">
                    {entry.text}
                  </p>
                  <p className="mt-0.5 text-[10.5px] font-medium text-haze-600">
                    {[
                      entry.ident,
                      entry.hits > 1 ? `seen ${entry.hits}x` : null,
                      relative(entry.updatedAt, now),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={busy}
                  title="Forget this memory"
                  aria-label={`Forget: ${entry.text}`}
                  className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => mutate(api.forgetMemory(repoKey, entry.id))}
                >
                  <Close />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
