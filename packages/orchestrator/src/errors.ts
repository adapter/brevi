/** Error with an HTTP-mappable code, thrown by orchestrator commands. */
export class OrchestratorError extends Error {
  constructor(
    readonly code: "not-found" | "conflict" | "invalid" | "gone",
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}
