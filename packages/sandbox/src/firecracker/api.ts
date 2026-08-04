import { Agent, request } from "undici";

/** Minimal client for the Firecracker HTTP API, which is served over a unix socket. */
export class FirecrackerApi {
  readonly #agent: Agent;

  constructor(socketPath: string) {
    this.#agent = new Agent({ connect: { socketPath } });
  }

  async put(path: string, body: unknown): Promise<void> {
    const response = await request(`http://localhost${path}`, {
      dispatcher: this.#agent,
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.body.text();
    if (response.statusCode >= 300) {
      throw new Error(
        `firecracker API PUT ${path} failed (${response.statusCode}): ${text.trim() || "no response body"}`,
      );
    }
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }
}
