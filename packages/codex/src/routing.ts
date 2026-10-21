import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

/**
 * `-c` overrides for the model endpoint in `config.toml`, which `--ignore-user-config` skips: `model_provider`, `openai_base_url` and the
 * selected provider's `model_providers` entry. A file that cannot be read or parsed is an error, as the run would bypass the endpoint.
 */
export function codexRouting(configPath: string): { args: string[] } | { error: string } {
  let text: string;

  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { args: [] };
    }

    return { error: `Codex's config at ${configPath} could not be read: ${(error as Error).message}` };
  }

  let config: Record<string, unknown>;

  try {
    // Every integer as a bigint, so a large one parses and is written back as an integer, unlike a float.
    config = parse(text, { integersAsBigInt: true });
  } catch {
    // The parser's message quotes the file, which may hold credentials.
    return { error: `Codex's config at ${configPath} is not valid TOML.` };
  }

  const args: string[] = [];
  const provider = config['model_provider'];
  const baseUrl = config['openai_base_url'];

  if (typeof provider === 'string') {
    args.push('-c', `model_provider=${tomlValue(provider)}`);
  }

  if (typeof baseUrl === 'string') {
    args.push('-c', `openai_base_url=${tomlValue(baseUrl)}`);
  }

  const providers = config['model_providers'];
  const definition = typeof provider === 'string' && isTable(providers) ? providers[provider] : undefined;

  if (definition !== undefined) {
    args.push('-c', `model_providers=${tomlValue({ [provider as string]: definition })}`);
  }

  return { args };
}

/** A parsed TOML value written back inline, as `-c` reads it. */
function tomlValue(value: unknown): string {
  if (typeof value === 'string') {
    return tomlString(value);
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return 'nan';
    }

    if (!Number.isFinite(value)) {
      return value > 0 ? 'inf' : '-inf';
    }

    // Integers parse as bigints, so a number is a float and keeps a float's syntax.
    const text = String(value);
    return /[.eE]/.test(text) ? text : `${text}.0`;
  }

  if (typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return `[${value.map(tomlValue).join(', ')}]`;
  }

  if (isTable(value)) {
    return `{ ${Object.entries(value).map(([key, item]) => `${tomlString(key)} = ${tomlValue(item)}`).join(', ')} }`;
  }

  throw new Error(`Unsupported TOML value: ${String(value)}`);
}

/** A TOML basic string, which must escape every control character, DEL included. */
function tomlString(value: string): string {
  return `"${value.replace(/[\\"\u0000-\u001f\u007f]/g, (char) =>
    char === '\\' || char === '"' ? `\\${char}` : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}
