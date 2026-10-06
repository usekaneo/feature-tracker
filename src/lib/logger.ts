export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error instanceof Error ? error.message : (error ?? "")),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Path safe for logs: drops query strings and token-bearing auth path segments. */
export function loggablePath(path: string): string {
  if (path.startsWith("/api/auth/")) {
    const [, , , endpoint] = path.split("/");
    return `/api/auth/${endpoint ?? ""}`;
  }
  return path;
}
