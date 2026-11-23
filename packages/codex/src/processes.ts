/** The message for a Codex CLI the hub could not find. */
export function codexNotFound(codexPath: string): string {
  return `Codex was not found at ${codexPath}. Install it or set sessions.codexPath.`;
}
