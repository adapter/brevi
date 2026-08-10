import type { BreviConfig } from "@brevi/shared";
import { Badge } from "@/components/ui/badge";
import { useSettingsDraft } from "../../lib/settings";
import { FieldRow, NumberField, SectionIntro, SettingsCard, SwitchField, TextField } from "./Fields";

/**
 * What brevi watches for and how hard it retries: the Linear label that opts
 * a ticket in, how often Linear is polled, and the usage-limit restart
 * policy. Rendered at /config/orchestrator.
 */
export function OrchestratorSection({
  config,
  onConfig,
}: {
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
}) {
  const trigger = useSettingsDraft(config, onConfig);
  const restart = useSettingsDraft(config, onConfig);

  const label = trigger.value("trigger.label");
  const auto = restart.value("restart.auto") === true;

  return (
    <>
      <SectionIntro title="Orchestrator">
        How tickets reach brevi, and what happens when the agent runs into a usage limit
        mid-run.
      </SectionIntro>

      <div className="mt-3 flex flex-col gap-2.5">
        <SettingsCard title="Trigger" draft={trigger}>
          <TextField
            label="Label"
            path="trigger.label"
            draft={trigger}
            help="Label name that opts a Linear ticket in. Matched case-insensitively."
          />
          {typeof label === "string" && label.trim() !== "" && (
            <FieldRow label="Preview">
              <Badge variant="default" className="tracking-normal normal-case">
                {label}
              </Badge>
            </FieldRow>
          )}
          <NumberField
            label="Poll interval"
            path="pollIntervalSeconds"
            draft={trigger}
            unit="s"
            min={10}
            step={10}
            help="How often Linear is polled for labeled tickets. Minimum 10."
          />
        </SettingsCard>

        <SettingsCard
          title="Usage-limit restarts"
          draft={restart}
          description="When the agent reports a usage limit, brevi parks the run and picks it back up once the limit lifts instead of failing it."
        >
          <SwitchField
            label="Auto-restart"
            path="restart.auto"
            draft={restart}
            help="Automatically wait out agent usage limits and start a new attempt."
          />
          <NumberField
            label="Max attempts"
            path="restart.maxAttempts"
            draft={restart}
            min={1}
            disabled={!auto}
            help="Cap on agent executions per run, counting the first."
          />
          <NumberField
            label="Probe interval"
            path="restart.probeIntervalMinutes"
            draft={restart}
            unit="min"
            min={1}
            disabled={!auto}
            help="Minutes between liveness probes while waiting on a limit whose reset time the agent didn't report."
          />
        </SettingsCard>
      </div>
    </>
  );
}
