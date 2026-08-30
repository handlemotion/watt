export class AgentError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentError";
    this.code = code;
  }
}

export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError;
}
