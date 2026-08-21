# Integrations

Third-party service clients shared by the orchestrator and the worker: GitHub, Linear, R2, credentials, usage limits, memories, machine usage. No scheduling state lives here, and the package may depend only on `@brevi/shared` (plus service SDKs). Credential material passes through as function arguments; never persist or log it here.
