import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, the orchestrator (started via `brevi ui` or `brevi start`) runs on 4400;
// the Vite dev server proxies API and WebSocket traffic to it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4401,
    proxy: {
      "/api": "http://localhost:4400",
      "/ws": { target: "ws://localhost:4400", ws: true },
    },
  },
});
