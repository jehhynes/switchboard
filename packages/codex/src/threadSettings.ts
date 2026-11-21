import { object } from './appServer.js';
import type { Json } from './appServer.js';
import { permissionOptions } from './appServerRunner.js';

/** The parts of a thread's settings that change how its turns run, as `thread/settings/updated` reports them (mechanics M108). */
export interface ThreadSettings {
  model: string | null;
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: string;
  /** The sandbox's network access, or null when not known, which is then not compared. */
  network: boolean | null;
  mode: string;
}

const SANDBOXES: Record<string, string> = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access', externalSandbox: 'external-sandbox' };

/** A `thread/settings/updated` notification's settings, with the sandbox named as `thread/start` takes it. */
export function threadSettings(settings: Json): ThreadSettings {
  const policy = settings['approvalPolicy'];
  const sandbox = String(object(settings['sandboxPolicy'])['type'] ?? '');
  const network = object(settings['sandboxPolicy'])['networkAccess'];

  return {
    model: typeof settings['model'] === 'string' ? settings['model'] : null,
    approvalPolicy: typeof policy === 'string' ? policy : policy !== null && typeof policy === 'object' ? Object.keys(policy)[0] ?? 'unknown' : 'unknown',
    approvalsReviewer: String(settings['approvalsReviewer'] ?? 'user'),
    sandbox: SANDBOXES[sandbox] ?? sandbox,
    network: typeof network === 'boolean' ? network : null,
    mode: String(object(settings['collaborationMode'])['mode'] ?? 'default'),
  };
}

/**
 * The settings Switchboard starts and resumes a thread with when its start's answer is not known: its permission mode's, the model when one is
 * set, and Codex's default mode; network access is left out, since the daemon's config can set it.
 */
export function startSettings(permissionMode: string, model: string | null): ThreadSettings {
  const options = permissionOptions(permissionMode);

  return { model: model === '' ? null : model, approvalPolicy: String(options['approvalPolicy']), approvalsReviewer: String(options['approvalsReviewer']), sandbox: String(options['sandbox']), network: null, mode: 'default' };
}

/** The settings a `thread/start` or `thread/resume` answer reports the thread runs with, or null when it reports none. */
export function answeredSettings(answer: Json): ThreadSettings | null {
  return typeof answer['approvalPolicy'] === 'undefined' || typeof answer['sandbox'] !== 'object' ? null : threadSettings({ ...answer, sandboxPolicy: answer['sandbox'], collaborationMode: { mode: 'default' } });
}

/**
 * What differs in a thread's settings from what Switchboard started it with, as phrases such as "model gpt-x (started with gpt-y)" or "Plan
 * mode". With no model set at the start, the model is compared with `seen`, the first one seen for the thread.
 */
export function settingsDifferences(start: ThreadSettings, now: ThreadSettings, seen: string | null): string[] {
  const model = start.model ?? seen;
  const differences: string[] = [];

  if (model !== null && now.model !== null && now.model !== model) differences.push(`model ${now.model} (${start.model === null ? 'was' : 'started with'} ${model})`);
  if (now.approvalPolicy !== start.approvalPolicy || now.approvalsReviewer !== start.approvalsReviewer) differences.push(`approvals ${now.approvalPolicy}, reviewed by ${now.approvalsReviewer} (started with ${start.approvalPolicy}, reviewed by ${start.approvalsReviewer})`);
  if (now.sandbox !== start.sandbox) differences.push(`sandbox ${now.sandbox} (started with ${start.sandbox})`);
  else if (now.network !== null && start.network !== null && now.network !== start.network) differences.push(`network access ${now.network ? 'on' : 'off'} (started ${start.network ? 'on' : 'off'})`);
  if (now.mode !== start.mode) differences.push(`${now.mode === 'plan' ? 'Plan' : now.mode} mode`);

  return differences;
}
