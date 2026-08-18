import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The standalone Vite server is for renderer development only; production is
// loaded by Electron from the private brevi:// origin.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 4401,
    proxy: {
      "/api": "http://localhost:4400",
      "/ws": { target: "ws://localhost:4400", ws: true },
    },
  },
});
