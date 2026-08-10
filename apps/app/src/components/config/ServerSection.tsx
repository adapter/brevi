import { useState } from "react";
import { DEFAULT_HOST, type BreviConfig } from "@brevi/shared/config";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useSettingsDraft, type SettingsDraft } from "../../lib/settings";
import { Warn } from "../Icons";
import { FieldRow, NumberField, SecretField, SectionIntro, SettingsCard, TextField } from "./Fields";

const ALL_INTERFACES = "0.0.0.0";

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
        Where the dashboard and API listen, and the OAuth apps the Connect flows go through.
      </SectionIntro>

      <div className="mt-3 flex flex-col gap-2.5">
        <SettingsCard title="Server" draft={server}>
          <NumberField
            label="Port"
            path="server.port"
            draft={server}
            min={1}
            max={65535}
            help="Port the dashboard and API are served on."
          />
          <BindAddressField draft={server} />
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

/**
 * The bind address, as the choice it actually is. Anything that is neither
 * loopback nor all-interfaces (a specific LAN address, say) opens the free
 * text box on load, so a hand-edited value is editable rather than silently
 * rewritten to one of the two presets.
 */
function BindAddressField({ draft }: { draft: SettingsDraft }) {
  const value = draft.value("server.host");
  const host = typeof value === "string" ? value : DEFAULT_HOST;
  const preset = host === DEFAULT_HOST || host === ALL_INTERFACES;
  const [choseOther, setChoseOther] = useState(false);
  // Discarding the card puts the value back without telling this control, so
  // a stale "Other" would leave the radio pointing at a box the saved config
  // does not use. Derived-state reset: once nothing is edited and the value is
  // a preset again, the preset is what's selected.
  if (choseOther && preset && !draft.dirty) setChoseOther(false);
  const choice = choseOther || !preset ? "other" : host;

  return (
    <FieldRow
      label="Bind address"
      path="server.host"
      draft={draft}
      wide
      help="The dashboard and API have no authentication of their own; the address they bind to is what limits who can reach them."
    >
      <RadioGroup
        value={choice}
        onValueChange={(next) => {
          if (next === "other") {
            setChoseOther(true);
            return;
          }
          setChoseOther(false);
          draft.set("server.host", next);
        }}
        className="gap-2"
      >
        <label className="flex cursor-pointer items-start gap-2 text-[12px] text-haze-200">
          <RadioGroupItem value={DEFAULT_HOST} className="mt-px shrink-0" />
          <span>
            This machine only
            <span className="ml-1.5 font-mono text-[11px] text-haze-700">{DEFAULT_HOST}</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-[12px] text-haze-200">
          <RadioGroupItem value={ALL_INTERFACES} className="mt-px shrink-0" />
          <span className="min-w-0">
            All interfaces
            <span className="ml-1.5 font-mono text-[11px] text-haze-700">{ALL_INTERFACES}</span>
            <span className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-rust-400">
              <Warn className="mt-px size-3 shrink-0" />
              Exposes the unauthenticated dashboard and API to the whole network.
            </span>
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
          onChange={(event) => draft.set("server.host", event.target.value)}
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
