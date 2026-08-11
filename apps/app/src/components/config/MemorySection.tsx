import { useCallback, useEffect, useState } from "react";
import type { BreviConfig, RepoMemory } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { api } from "../../lib/api";
import { relative } from "../../lib/format";
import { useSettingsDraft } from "../../lib/settings";
import { Close, Refresh, Warn } from "../Icons";
import { NumberField, SectionIntro, SettingsCard, SwitchField } from "./Fields";

/**
 * What brevi carries between sandboxes: the memory settings, and the memories
 * themselves. Every run starts in a fresh VM, so anything a run worked out
 * about a repo would otherwise be rediscovered at full token price by the next
 * ticket. The list below is here so a memory that turned out to be wrong can
 * be dropped: it is handed to every future run in that repo until it is.
 * Rendered at /config/memory.
 */
export function MemorySection({
  config,
  onConfig,
}: {
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
}) {
  const memory = useSettingsDraft(config, onConfig);
  const enabled = memory.value("memory.enabled") === true;

  const [repos, setRepos] = useState<Record<string, RepoMemory[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Repo key whose "Forget all" is armed, so one click cannot wipe a repo's history. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    api
      .memories()
      .then((response) => {
        setRepos(response.repos);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  }, []);

  // Loaded once on mount and refreshed on demand: memories change only when a
  // run finishes, which is far too rare to poll for.
  useEffect(load, [load]);

  const mutate = (action: Promise<{ repos: Record<string, RepoMemory[]> }>): void => {
    setBusy(true);
    action
      .then((response) => {
        setRepos(response.repos);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        setBusy(false);
        setConfirming(null);
      });
  };

  const entries = Object.entries(repos ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const now = Date.now();

  return (
    <>
      <SectionIntro title="Memory">
        Runs execute in a throwaway sandbox, so everything an agent works out about a repository
        dies with it. Memories are the exception: durable facts a run records on the way out, kept
        on the host and handed to the next run in that repo instead of being rediscovered.
      </SectionIntro>

      <div className="mt-3 flex flex-col gap-2.5">
        <SettingsCard
          title="Repository memories"
          draft={memory}
          description="Stored under ~/.brevi/memories, one file per repository. Injected into the run prompt before the agent starts, and topped up from what it writes to .brevi/memories.md when it finishes."
        >
          <SwitchField
            label="Remember"
            path="memory.enabled"
            draft={memory}
            help="Inject stored memories into run prompts and harvest new ones afterwards."
          />
          <NumberField
            label="Max entries"
            path="memory.maxEntries"
            draft={memory}
            min={1}
            max={500}
            disabled={!enabled}
            help="How many memories are kept per repo. Once full, the least recently recorded ones are dropped."
          />
          <NumberField
            label="Prompt budget"
            path="memory.maxChars"
            draft={memory}
            unit="chars"
            min={200}
            max={50000}
            step={500}
            disabled={!enabled}
            help="Character budget for the memories block injected into a prompt. It only pays for itself while it stays cheaper than the exploration it replaces."
          />
        </SettingsCard>

        <Card size="sm" className="gap-2">
          <CardHeader className="gap-0">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-plate text-[12px] font-semibold tracking-[0.04em] text-haze-50">
                What brevi remembers
              </h3>
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
            <p className="mt-1.5 text-[12px] leading-relaxed text-haze-400">
              A wrong memory is worse than no memory: it is handed to every run in that repo until
              you drop it. Forgetting one here is immediate and cannot be undone.
            </p>
          </CardHeader>
          <CardContent className="mt-2.5 flex flex-col gap-4">
            {error && (
              <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
                <Warn className="mt-px size-3 shrink-0" />
                {error}
              </p>
            )}
            {repos === null && !error ? (
              <p className="text-[12px] text-haze-700">Loading.</p>
            ) : entries.length === 0 ? (
              <p className="text-[12.5px] leading-relaxed text-haze-700">
                Nothing remembered yet. The first run to finish in a repo writes its memories here.
              </p>
            ) : (
              entries.map(([repoKey, memories]) => (
                <section key={repoKey}>
                  <div className="flex items-baseline justify-between gap-3 border-b border-ink-700 pb-1.5">
                    <h4 className="truncate font-mono text-[12px] text-haze-100">{repoKey}</h4>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="font-plate text-[9px] tracking-[0.14em] text-haze-700 uppercase">
                        {memories.length} {memories.length === 1 ? "memory" : "memories"}
                      </span>
                      <Button
                        type="button"
                        variant={confirming === repoKey ? "destructive" : "ghost"}
                        size="plate"
                        disabled={busy}
                        onClick={() => {
                          if (confirming === repoKey) mutate(api.clearMemories(repoKey));
                          else setConfirming(repoKey);
                        }}
                        onBlur={() => setConfirming((key) => (key === repoKey ? null : key))}
                      >
                        {confirming === repoKey ? "Confirm" : "Forget all"}
                      </Button>
                    </div>
                  </div>
                  <ul className="mt-1">
                    {memories.map((entry) => (
                      <li
                        key={entry.id}
                        className="group flex items-start gap-2 border-b border-ink-800 py-1.5 last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-[12.5px] leading-relaxed break-words text-haze-200">
                            {entry.text}
                          </p>
                          <p className="mt-0.5 font-plate text-[9px] tracking-[0.14em] text-haze-700 uppercase">
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
                </section>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
