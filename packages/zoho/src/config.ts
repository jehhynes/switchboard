export interface ZohoConfig {
  /** Prints a Desk access token on stdout, such as a runner script. Switchboard never reads the credentials. */
  tokenCommand: string;
  apiBase: string;
  orgId: string;
  /** The operator's Zoho agent ID. */
  agentId: string;
  /** The custom field, such as `cf_tier`, whose value puts an Open ticket in scope. */
  scopeField: string;
  scopeValue: string;
  /** The scope field's name in ticket history, such as `Escalation`; empty, only a change to the current status counts as entering scope. */
  scopeHistoryField: string;
  /** Teams whose members' hold on a ticket is not a claim, so it stays in the pool. */
  poolTeams: string[];
  /** Automations and queues: holding a ticket is not a claim. */
  automationAgentIds: string[];
  /** Custom fields the triage context shows. */
  contextFields: string[];
  /** History fields whose changes the triage context shows. */
  historyFields: string[];
  maxPages: number;
}

export type ConfigResult = { config: ZohoConfig } | { error: string };

const KEYS = ['tokenCommand', 'apiBase', 'orgId', 'agentId', 'scopeField', 'scopeValue', 'scopeHistoryField', 'poolTeams', 'automationAgentIds', 'contextFields', 'historyFields', 'maxPages'];

/** Keys renamed when scope stopped having built-in values. */
const RENAMED: Record<string, string> = { escalationField: 'scopeField', escalationValue: 'scopeValue' };

const ID = /^\d+$/;

const strings = (value: unknown, pattern = /./): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && pattern.test(entry));

/** Reads the Zoho keys of the source `name`. IDs are strings, because 19-digit numbers do not fit a JavaScript number. */
export function parseZohoConfig(options: Record<string, unknown>, name = 'zoho'): ConfigResult {
  const path = `sources.${name}`;
  const renamed = Object.keys(options).find((key) => RENAMED[key] !== undefined);

  if (renamed !== undefined) {
    return { error: `${path}.${renamed} is now ${RENAMED[renamed]}.` };
  }

  const unknown = Object.keys(options).filter((key) => !KEYS.includes(key));

  if (unknown.length > 0) {
    return { error: `${path}.${unknown[0]} is not a setting.` };
  }

  const {
    tokenCommand,
    apiBase = 'https://desk.zoho.com/api/v1',
    orgId,
    agentId,
    scopeField,
    scopeValue,
    scopeHistoryField = '',
    poolTeams = [],
    automationAgentIds = [],
    contextFields,
    historyFields = ['Status', 'Case Owner', 'Team'],
    maxPages = 20,
  } = options;

  if (typeof orgId !== 'string' || !ID.test(orgId)) {
    return { error: `${path}.orgId must be set to the Desk organization ID, as a string.` };
  }

  if (typeof agentId !== 'string' || !ID.test(agentId)) {
    return { error: `${path}.agentId must be set to your Zoho agent ID, as a string.` };
  }

  for (const [key, value] of Object.entries({ tokenCommand, apiBase, scopeField, scopeValue })) {
    if (typeof value !== 'string' || value === '') {
      return { error: `${path}.${key} must be a non-empty string.` };
    }
  }

  if (typeof scopeHistoryField !== 'string') {
    return { error: `${path}.scopeHistoryField must be a string.` };
  }

  if (!strings(automationAgentIds, ID)) {
    return { error: `${path}.automationAgentIds must list agent IDs as strings.` };
  }

  for (const [key, value] of Object.entries({ poolTeams, contextFields: contextFields ?? [], historyFields })) {
    if (!strings(value)) {
      return { error: `${path}.${key} must list names as non-empty strings.` };
    }
  }

  if (typeof maxPages !== 'number' || !Number.isInteger(maxPages) || maxPages < 1) {
    return { error: `${path}.maxPages must be a whole number of at least 1.` };
  }

  const history = historyFields as string[];

  return {
    config: {
      tokenCommand: tokenCommand as string,
      apiBase: (apiBase as string).replace(/\/+$/, ''),
      orgId,
      agentId,
      scopeField: scopeField as string,
      scopeValue: scopeValue as string,
      scopeHistoryField,
      poolTeams: poolTeams as string[],
      automationAgentIds,
      contextFields: (contextFields as string[] | undefined) ?? [scopeField as string],
      // The scope field's own changes always show, since they are how a ticket entered scope.
      historyFields: scopeHistoryField === '' || history.includes(scopeHistoryField) ? history : [scopeHistoryField, ...history],
      maxPages,
    },
  };
}
