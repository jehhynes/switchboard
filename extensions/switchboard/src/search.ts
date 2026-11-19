/** The ticket URL of a `vscode://switchboard.switchboard/open?url=<url>` URI's path and decoded query, or null for another URI (PRD R69). */
export function openUrlOf(path: string, query: string): string | null {
  return path === '/open' && query.startsWith('url=') && query.length > 4 ? query.slice(4) : null;
}
