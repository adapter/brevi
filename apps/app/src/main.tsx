import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./index.css";

/**
 * One client for every REST read of the loopback API. Run and ticket state
 * streams over the WebSocket and stays in useOrchestrator's reducer; queries
 * cover the request/response surfaces (pull requests, usage) that have no
 * push channel. The orchestrator is local, so a single retry covers a
 * restart blip, and a short staleTime keeps window-focus refetches from
 * hammering GitHub-backed routes.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
    },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
