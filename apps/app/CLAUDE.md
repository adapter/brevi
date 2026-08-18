# Mission Control renderer

Vite and React renderer loaded only by Electron from `brevi://app`. Production API and WebSocket URLs, plus the per-launch management token, arrive in the private app URL. Preserve those query parameters when changing history routes.

Do not add Node integration or move SSH credentials or pairing tokens into renderer state.
