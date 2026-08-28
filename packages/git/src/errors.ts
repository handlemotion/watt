export class GitError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitError";
    this.code = code;
  }
}

export function isGitError(value: unknown): value is GitError {
  return value instanceof GitError;
}
