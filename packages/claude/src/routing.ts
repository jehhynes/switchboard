import { readFileSync } from 'node:fs';

/**
 * `env` names that choose the Anthropic API endpoint, its credential and the network path to it. Model choices stay out, so triage keeps its
 * own model; Bedrock, Vertex and other providers are not carried, because they need further provider-specific variables.
 */
const ROUTING_NAMES = new Set([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
]);

/**
 * The routing variables in the `env` of Claude's user settings, which a run with `--setting-sources ""` does not read (mechanics M3).
 * A missing file has none; an unreadable one is an error, because a run without them would bypass the operator's endpoint.
 */
export function claudeRouting(settingsPath: string): { env: Record<string, string> } | { error: string } {
  let text: string;

  try {
    text = readFileSync(settingsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { env: {} };
    }

    return { error: `Claude's settings at ${settingsPath} could not be read: ${(error as Error).message}` };
  }

  let settings: unknown;

  try {
    settings = JSON.parse(text);
  } catch {
    // The parser's message quotes the file, which may hold credentials.
    return { error: `Claude's settings at ${settingsPath} are not valid JSON.` };
  }

  const env: Record<string, string> = {};
  const declared = isRecord(settings) ? settings['env'] : undefined;

  if (isRecord(declared)) {
    for (const [name, value] of Object.entries(declared)) {
      if (ROUTING_NAMES.has(name) && typeof value === 'string') {
        env[name] = value;
      }
    }
  }

  return { env };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
