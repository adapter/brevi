import type { BreviConfig } from "@brevi/shared/config";
import { useSettingsDraft } from "../../lib/settings";
import { NumberField, SecretField, SectionIntro, SettingsCard, TextField } from "./Fields";

/**
 * The dashboard's own listener and the OAuth apps behind the one-click
 * Connect flows. Rendered at /config/server. Both listener fields are read
 * once at startup, so they carry the restart badge.
 */
export function ServerSection({
  config,
  onConfig,
}: {
  config: BreviConfig;
  onConfig: (config: BreviConfig) => void;
}) {
  const server = useSettingsDraft(config, onConfig);
  const connect = useSettingsDraft(config, onConfig);

  return (
    <>
      <SectionIntro title="Server">
        Mission Control&apos;s private loopback API and the OAuth apps behind the Connect flows.
      </SectionIntro>

      <div className="mt-3 flex flex-col gap-2.5">
        <SettingsCard title="Server" draft={server}>
          <NumberField
            label="Port"
            path="server.port"
            draft={server}
            min={1}
            max={65535}
            help="Port used by Mission Control's loopback-only API. It is never exposed to the LAN."
          />
        </SettingsCard>

        <SettingsCard
          title="Connect flows"
          draft={connect}
          description="Leave these alone to use brevi's hosted OAuth backend. Fill them in to run the Connect flows through your own OAuth apps instead."
        >
          <TextField
            label="Hosted API base"
            path="connect.apiBase"
            draft={connect}
            wide
            help="Point at your own deployment of apps/api to self-host; empty disables the hosted flows entirely."
          />
          <TextField
            label="GitHub client id"
            path="connect.githubClientId"
            draft={connect}
            placeholder="Personal GitHub OAuth app (device flow)"
            help="Personal GitHub OAuth app client id. Overrides the hosted API base above."
          />
          <TextField
            label="Linear client id"
            path="connect.linearClientId"
            draft={connect}
            placeholder="Personal Linear OAuth app (redirect flow)"
            help="Personal Linear OAuth app client id. Needs the client secret below to be used."
          />
          <SecretField
            label="Linear client secret"
            path="connect.linearClientSecret"
            draft={connect}
            placeholder="Linear OAuth app client secret"
            help="Write-only: stored in config.json and never sent back to this page."
          />
        </SettingsCard>
      </div>
    </>
  );
}
