import {
  discoverAnthropicCredential,
  discoverCodexCredential,
  discoverGithubToken,
  discoverXaiCredential,
  githubClientId,
  hostedApiReachable,
  linearOauthApp,
  startGithubDeviceFlow,
  startLinearOauth,
  validateAnthropicCredential,
  validateCodexApiKey,
  validateCodexChatgptAuth,
  validateGithubToken,
  validateGrokAuth,
  validateXaiApiKey,
  type DiscoveredCredential,
  type GithubDeviceSession,
  type LinearOauthSession,
} from "@brevi/integrations";
import {
  redactConfig,
  type BreviConfig,
  type ConnectResponse,
  type CredentialProvider,
  type CredentialResult,
} from "@brevi/shared";

/**
 * The narrow slice of the Orchestrator a connect flow needs: the live config
 * to read and mutate, one persist-and-emit callback for credential writes,
 * and somewhere to stash the in-flight OAuth/device session for the poll and
 * callback endpoints to finish later.
 */
export interface ConnectorHost {
  readonly config: BreviConfig;
  /** Persist a credential mutation and hot-apply it (emits the config event). */
  saveCredential(set: () => void): Promise<void>;
  setGithubDevice(session: GithubDeviceSession): void;
  setLinearOauth(session: LinearOauthSession): void;
}

/**
 * The shape every agent provider's one-click connect shares: discover a
 * credential on the host, validate it, write it into the config. Only the
 * three functions and the not-found message differ per provider.
 */
interface AgentConnector {
  discover(): Promise<DiscoveredCredential | null>;
  validate(found: DiscoveredCredential): Promise<CredentialResult> | CredentialResult;
  apply(config: BreviConfig, found: DiscoveredCredential): void;
  missingReason: string;
}

const AGENT_CONNECTORS: Record<"anthropic" | "codex" | "grok", AgentConnector> = {
  anthropic: {
    discover: discoverAnthropicCredential,
    validate: (found) => validateAnthropicCredential(found.value, found.kind === "oauth" ? "oauth" : "api-key"),
    apply: (config, found) => {
      if (found.kind === "oauth") config.agent.claudeCodeOauthToken = found.value;
      else config.agent.anthropicApiKey = found.value;
    },
    missingReason:
      "No Anthropic credential found on this machine (checked ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, and the Claude Code login). Paste an API key instead.",
  },
  codex: {
    discover: discoverCodexCredential,
    validate: (found) =>
      found.kind === "chatgpt" ? validateCodexChatgptAuth(found.value) : validateCodexApiKey(found.value),
    apply: (config, found) => {
      if (found.kind === "chatgpt") config.agent.codexAuthJson = found.value;
      else config.agent.codexApiKey = found.value;
    },
    missingReason:
      "No Codex credential found on this machine (checked OPENAI_API_KEY and ~/.codex/auth.json). Log in with `codex login` and connect again, or paste an OpenAI API key.",
  },
  grok: {
    discover: discoverXaiCredential,
    validate: (found) => (found.kind === "grok" ? validateGrokAuth(found.value) : validateXaiApiKey(found.value)),
    apply: (config, found) => {
      if (found.kind === "grok") {
        config.agent.grokAuthJson = found.value;
        config.agent.xaiApiKey = "";
      } else {
        config.agent.xaiApiKey = found.value;
        config.agent.grokAuthJson = "";
      }
    },
    missingReason:
      "No Grok credential found on this machine (checked XAI_API_KEY, GROK_CODE_XAI_API_KEY, GROK_AUTH, and ~/.grok/auth.json). Log in with `grok login` and connect again, or paste an xAI API key.",
  },
};

/**
 * One-click connect: try host discovery / OAuth flows for a provider.
 * Falls back to "manual" (dashboard shows the key input) with a reason.
 */
export async function connectProvider(
  host: ConnectorHost,
  provider: CredentialProvider,
  serverUrl: string,
): Promise<ConnectResponse> {
  switch (provider) {
    case "github":
      return connectGithub(host);
    case "linear":
      return connectLinear(host, serverUrl);
    default:
      return connectAgent(host, provider);
  }
}

/** GitHub: a discovered `gh` login wins; otherwise fall back to the device flow. */
async function connectGithub(host: ConnectorHost): Promise<ConnectResponse> {
  const provider = "github" as const;
  const discovered = await discoverGithubToken();
  if (discovered) {
    const result = await validateGithubToken(discovered.value);
    if (result.ok) {
      await host.saveCredential(() => {
        host.config.github.token = discovered.value;
      });
      return {
        status: "connected",
        provider,
        detail: `${result.detail} (via ${discovered.source})`,
        config: redactConfig(host.config),
      };
    }
  }
  const clientId = githubClientId(host.config);
  const deviceSource = clientId
    ? { clientId }
    : (await hostedApiReachable(host.config.connect.apiBase))
      ? { apiBase: host.config.connect.apiBase }
      : null;
  if (deviceSource) {
    const session = await startGithubDeviceFlow(deviceSource);
    host.setGithubDevice(session);
    return {
      status: "device",
      provider,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      interval: session.interval,
      expiresIn: Math.floor((session.expiresAt - Date.now()) / 1000),
    };
  }
  return {
    status: "manual",
    provider,
    reason:
      "No GitHub CLI login found and the brevi connect service is unreachable. Run `gh auth login` and connect again, or paste a token.",
  };
}

/** Linear: always an OAuth redirect (personal app or hosted helper), never discovery. */
async function connectLinear(host: ConnectorHost, serverUrl: string): Promise<ConnectResponse> {
  const provider = "linear" as const;
  const app = linearOauthApp(host.config);
  if (app) {
    const { session, url } = startLinearOauth({ app, serverUrl });
    host.setLinearOauth(session);
    return { status: "redirect", provider, url };
  }
  if (await hostedApiReachable(host.config.connect.apiBase)) {
    const { session, url } = startLinearOauth({
      apiBase: host.config.connect.apiBase,
      // From the URL the caller bound, not config.server.port: the port
      // is editable from the dashboard and only takes effect on restart,
      // so the config can name a port nothing is listening on. The
      // hosted backend redirects the callback to whatever it is told.
      port: Number(new URL(serverUrl).port) || host.config.server.port,
    });
    host.setLinearOauth(session);
    return { status: "redirect", provider, url };
  }
  return {
    status: "manual",
    provider,
    reason:
      "The brevi connect service is unreachable and no personal OAuth app is configured (connect.linearClientId/Secret). Paste a personal API key instead.",
  };
}

/** Agent providers share one discover, validate, save shape. */
async function connectAgent(
  host: ConnectorHost,
  provider: "anthropic" | "codex" | "grok",
): Promise<ConnectResponse> {
  const connector = AGENT_CONNECTORS[provider];
  const found = await connector.discover();
  if (!found) {
    return { status: "manual", provider, reason: connector.missingReason };
  }
  const result = await connector.validate(found);
  if (!result.ok) {
    return {
      status: "manual",
      provider,
      reason: `Found a credential from ${found.source}, but it failed: ${result.detail}`,
    };
  }
  await host.saveCredential(() => connector.apply(host.config, found));
  return {
    status: "connected",
    provider,
    detail: `${result.detail} (from ${found.source})`,
    config: redactConfig(host.config),
  };
}
