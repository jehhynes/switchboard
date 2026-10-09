/**
 * Whether a `claim` event's JSON names this window's workspace file, so the window claims what the dock left for it even while it is already
 * in front (PRD R71). A window with no workspace file never matches.
 */
export function claimIsFor(data: string, workspace: string | null): boolean {
  let named: unknown;

  try {
    named = (JSON.parse(data) as { workspace?: unknown } | null)?.workspace;
  } catch {
    return false;
  }

  return workspace !== null && typeof named === 'string' && normal(named) === normal(workspace);
}

function normal(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}
