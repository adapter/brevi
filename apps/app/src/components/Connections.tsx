import { useState } from "react";
import type {
  BreviConfig,
  CredentialProvider,
  CredentialResult,
  CredentialsUpdateRequest,
} from "@brevi/shared";
import { api } from "../lib/api";
import { Button, Plate } from "./Bits";
import { Check, Close, External, Warn } from "./Icons";

interface ProviderSpec {
  id: CredentialProvider;
  field: keyof CredentialsUpdateRequest;
  name: string;
  role: string;
  inputLabel: string;
  keyUrl: string;
  keyUrlLabel: string;
  connected: (config: BreviConfig) => boolean;
}

const PROVIDERS: ProviderSpec[] = [
  {
    id: "linear",
    field: "linearApiKey",
    name: "Linear",
    role: "Ticket source — polling starts once connected",
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
    inputLabel: 'Access token with the "repo" scope',
    keyUrl: "https://github.com/settings/tokens",
    keyUrlLabel: "github.com/settings/tokens",
    connected: (c) => c.github.token !== "",
  },
  {
    id: "anthropic",
    field: "anthropicApiKey",
    name: "Anthropic",
    role: "Runs the coding agent in the sandbox",
    inputLabel: "API key",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyUrlLabel: "console.anthropic.com",
    connected: (c) => c.agent.anthropicApiKey !== "",
  },
  {
    id: "codex",
    field: "codexApiKey",
    name: "Codex",
    role: "Alternative agent key (OpenAI)",
    inputLabel: "API key",
    keyUrl: "https://platform.openai.com/api-keys",
    keyUrlLabel: "platform.openai.com",
    connected: (c) => c.agent.codexApiKey !== "",
  },
];

/** Slide-over panel to connect Linear, GitHub, and agent API keys. */
export function Connections({
  open,
  config,
  onClose,
  onConfig,
}: {
  open: boolean;
  config: BreviConfig | null;
  onClose: () => void;
  onConfig: (config: BreviConfig) => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-label="Connections">
      <button
        type="button"
        aria-label="Close connections"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink-950/60 backdrop-blur-[2px]"
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[400px] flex-col border-l border-ink-700 bg-ink-900 shadow-2xl">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-700 px-4">
          <Plate className="text-haze-400">Connections</Plate>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-[4px] p-1.5 text-haze-400 hover:bg-ink-750 hover:text-haze-50"
          >
            <Close className="size-3.5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="text-[12.5px] leading-relaxed text-haze-400">
            Keys are validated with the provider, then stored locally in{" "}
            <code className="font-mono text-[11.5px] text-haze-300">~/.brevi/config.json</code>.
            They never leave this machine.
          </p>

          {config ? (
            <ul className="mt-4 flex flex-col gap-3">
              {PROVIDERS.map((spec) => (
                <li key={spec.id}>
                  <ProviderRow spec={spec} config={config} onConfig={onConfig} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-[12.5px] leading-relaxed text-haze-700">
              Waiting for the orchestrator — connections can be edited once it answers.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
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
  const connected = spec.connected(config);

  const submit = async (next: string) => {
    setPending(true);
    setResult(null);
    try {
      const response = await api.updateCredentials({ [spec.field]: next });
      const outcome = response.results[spec.id];
      onConfig(response.config);
      setResult(outcome ?? null);
      if (outcome?.ok) setValue("");
    } catch (err) {
      setResult({
        ok: false,
        detail: err instanceof Error ? err.message : "The orchestrator did not respond.",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <article className="panel p-3.5">
      <div className="flex items-center gap-2">
        <h3 className="font-plate text-[12px] font-semibold tracking-[0.04em] text-haze-50">
          {spec.name}
        </h3>
        <span
          className={`plate inline-flex items-center gap-1.5 rounded-[4px] border px-1.5 py-1 ${
            connected
              ? "border-mint-500/30 bg-mint-500/10 text-mint-400"
              : "border-ink-600 text-haze-700"
          }`}
        >
          <span
            className={`inline-block size-[5px] rounded-full ${connected ? "bg-mint-500" : "bg-haze-700"}`}
          />
          {connected ? "Connected" : "Not connected"}
        </span>
        {connected && (
          <span className="ml-auto">
            <Button onClick={() => void submit("")} disabled={pending} title="Remove this key">
              Disconnect
            </Button>
          </span>
        )}
      </div>

      <p className="mt-1.5 text-[12px] leading-relaxed text-haze-400">{spec.role}</p>

      <form
        className="mt-2.5 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void submit(value);
        }}
      >
        <input
          type="password"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setResult(null);
          }}
          placeholder={connected ? "Replace key" : spec.inputLabel}
          autoComplete="off"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-[4px] border border-ink-600 bg-ink-950/70 px-2.5 font-mono text-[12px] text-haze-100 placeholder:text-haze-700 focus:border-haze-600 focus:outline-none"
        />
        <Button type="submit" tone="ember" disabled={pending || value.trim() === ""}>
          {pending ? "Checking" : "Save"}
        </Button>
      </form>

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

      <a
        href={spec.keyUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-2.5 inline-flex items-center gap-1 font-mono text-[10.5px] text-haze-700 hover:text-haze-300"
      >
        Get a key: {spec.keyUrlLabel}
        <External className="size-2.5" />
      </a>
    </article>
  );
}
