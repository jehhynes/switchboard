export interface ZohoConfig {
  /** Prints a Desk access token on stdout, such as the operator's `desk-token.sh` runner. Switchboard never reads the credentials. */
  tokenCommand: string;
  apiBase: string;
  orgId: string;
  /** The operator's Zoho agent ID. */
  agentId: string;
  escalationField: string;
  escalationValue: string;
  /** Automations and queues: holding a ticket is not a claim. */
  automationAgentIds: string[];
  maxPages: number;
}

export type ConfigResult = { config: ZohoConfig } | { error: string };

/** The two non-human agents from the Support board's zoho.js: Acme API and Product Team. */
const AUTOMATIONS = ['8000000000000000002', '8000000000000000003'];

const KEYS = ['tokenCommand', 'apiBase', 'orgId', 'agentId', 'escalationField', 'escalationValue', 'automationAgentIds', 'maxPages'];

const ID = /^\d+$/;

/** Reads the Zoho keys of the source `name`. IDs are strings, because 19-digit numbers do not fit a JavaScript number. */
export function parseZohoConfig(options: Record<string, unknown>, name = 'zoho'): ConfigResult {
  const path = `sources.${name}`;
  const unknown = Object.keys(options).filter((key) => !KEYS.includes(key));

  if (unknown.length > 0) {
    return { error: `${path}.${unknown[0]} is not a setting.` };
  }

  const {
    tokenCommand = 'bash ~/.claude/scripts/desk-token.sh',
    apiBase = 'https://desk.zoho.com/api/v1',
    orgId,
    agentId,
    escalationField = 'cf_queue',
    escalationValue = 'Support',
    automationAgentIds = AUTOMATIONS,
    maxPages = 20,
  } = options;

  if (typeof orgId !== 'string' || !ID.test(orgId)) {
    return { error: `${path}.orgId must be set to the Desk organization ID, as a string.` };
  }

  if (typeof agentId !== 'string' || !ID.test(agentId)) {
    return { error: `${path}.agentId must be set to your Zoho agent ID, as a string.` };
  }

  for (const [key, value] of Object.entries({ tokenCommand, apiBase, escalationField, escalationValue })) {
    if (typeof value !== 'string' || value === '') {
      return { error: `${path}.${key} must be a non-empty string.` };
    }
  }

  if (!Array.isArray(automationAgentIds) || !automationAgentIds.every((id) => typeof id === 'string' && ID.test(id))) {
    return { error: `${path}.automationAgentIds must list agent IDs as strings.` };
  }

  if (typeof maxPages !== 'number' || !Number.isInteger(maxPages) || maxPages < 1) {
    return { error: `${path}.maxPages must be a whole number of at least 1.` };
  }

  return {
    config: {
      tokenCommand: tokenCommand as string,
      apiBase: (apiBase as string).replace(/\/+$/, ''),
      orgId,
      agentId,
      escalationField: escalationField as string,
      escalationValue: escalationValue as string,
      automationAgentIds,
      maxPages,
    },
  };
}
