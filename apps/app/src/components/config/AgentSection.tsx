import type { BreviConfig } from "@brevi/shared";
import { useSettingsDraft } from "../../lib/settings";
import {
  Advanced,
  NumberField,
  OptionalTextField,
  SectionIntro,
  SegmentedField,
  SettingsCard,
  SwitchField,
  TagField,
  TextField,
} from "./Fields";

/** Models the Claude side of a run is usually pointed at, offered as completions. */
const CLAUDE_MODELS = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"];

const EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/**
 * The coding agent itself: which models plan and implement, and whether an
 * adversarial Codex review gates the PR. Rendered at /config/agent.
 */
export function AgentSection({
  config,
  onConfig,
}: {
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
}) {
  const models = useSettingsDraft(config, onConfig);
  const review = useSettingsDraft(config, onConfig);
  const memory = useSettingsDraft(config, onConfig);
  const memoryEnabled = memory.value("memory.enabled") === true;

  // The single-model override runs everything on one model with no subagent
  // delegation, so the split below it stops meaning anything.
  const single = typeof models.value("agent.model") === "string" && models.value("agent.model") !== "";
  const codexReview = review.value("agent.codexReview") === true;
  const codexConnected = config.agent.codexApiKey !== "" || config.agent.codexAuthJson !== "";

  return (
    <>
      <SectionIntro title="Agent">
        The coding agent brevi executes inside each sandbox, and the models it runs on. Model and
        effort changes reach the next run without a restart.
      </SectionIntro>

      <div className="mt-3 flex flex-col gap-2.5">
        <SettingsCard title="Models" draft={models}>
          <OptionalTextField
            label="Single-model override"
            path="agent.model"
            draft={models}
            placeholder="Leave empty to use the split below"
            help="When set, runs everything on this one model with no subagent delegation, overriding the two models below."
          />
          <TextField
            label="Orchestrator model"
            path="agent.orchestratorModel"
            draft={models}
            suggestions={CLAUDE_MODELS}
            disabled={single}
            help="Model the main agent loop runs on: it plans, reviews, and delegates implementation to subagents. Claude agents only."
          />
          <TextField
            label="Implementer model"
            path="agent.implementModel"
            draft={models}
            suggestions={CLAUDE_MODELS}
            disabled={single}
            help="Model for the implementer subagent that executes the coding tasks."
          />
          <SegmentedField
            label="Orchestrator effort"
            path="agent.orchestratorEffort"
            draft={models}
            options={EFFORTS}
            help="Reasoning effort for the main agent loop. The implementer subagent keeps the agent's default effort."
          />
          <Advanced>
            <TextField
              label="Command"
              path="agent.command"
              draft={models}
              wide
              help="Coding agent CLI brevi executes. It has to be on the worker host's PATH; bwrap bind-mounts those binaries into the sandbox."
            />
            <TagField
              label="Args"
              path="agent.args"
              draft={models}
              placeholder="Add an argument, then press Enter"
              help="Extra arguments appended to every agent invocation."
            />
          </Advanced>
        </SettingsCard>

        <SettingsCard
          title="Codex review"
          draft={review}
          description="After the coding agent finishes, parallel Codex reviewers judge the diff against the ticket and the codebase. Confirmed findings trigger a fix pass before the PR opens."
        >
          <SwitchField
            label="Enabled"
            path="agent.codexReview"
            draft={review}
            help={
              codexReview && !codexConnected
                ? "No Codex credential is connected, so the review is skipped until you connect Codex on the Connectors page."
                : "Reviews Claude-primary implementation runs before their PR opens. A run whose agent command is already Codex skips it, so the review is always a cross-provider check."
            }
          />
          <TextField
            label="Review model"
            path="agent.reviewModel"
            draft={review}
            disabled={!codexReview}
            help="Model the Codex review runs on."
          />
          <SegmentedField
            label="Review effort"
            path="agent.reviewEffort"
            draft={review}
            disabled={!codexReview}
            options={[{ value: "minimal", label: "Minimal" }, ...EFFORTS]}
            help="Reasoning effort for Codex review executions."
          />
        </SettingsCard>

        <SettingsCard
          title="Repository memories"
          draft={memory}
          description="Durable facts a run records on the way out, stored under ~/.brevi/memories and handed to the next run in that repo. Each repository's stored memories are listed on its settings page."
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
            disabled={!memoryEnabled}
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
            disabled={!memoryEnabled}
            help="Character budget for the memories block injected into a prompt. It only pays for itself while it stays cheaper than the exploration it replaces."
          />
        </SettingsCard>
      </div>
    </>
  );
}
