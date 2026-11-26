import { describe, expect, it } from 'vitest';
import { answeredSettings, settingsDifferences, startSettings, threadSettings } from '../src/threadSettings.js';

describe('thread settings (mechanics M108)', () => {
  it("reads a settings update as thread/start names it, and Switchboard's start settings from its permission mode", () => {
    expect(threadSettings({ model: 'gpt-a', effort: 'high', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite', networkAccess: true }, collaborationMode: { mode: 'plan' } })).toEqual({ model: 'gpt-a', effort: 'high', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', network: true, mode: 'plan' });
    expect(threadSettings({ approvalPolicy: { granular: { rules: true } }, sandboxPolicy: { type: 'readOnly' } })).toEqual({ model: null, effort: null, approvalPolicy: 'granular', approvalsReviewer: 'user', sandbox: 'read-only', network: null, mode: 'default' });
    expect(startSettings('auto', '')).toEqual({ model: null, effort: null, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', network: null, mode: 'default' });
    expect(startSettings('bypassPermissions', 'gpt-a')).toEqual({ model: 'gpt-a', effort: null, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', network: null, mode: 'default' });
    // A thread/start answer as Codex 0.171 gave it (mechanics M108); one without settings gives none.
    expect(answeredSettings({ model: 'gpt-6.2-astra', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, serviceTier: null, reasoningEffort: 'xhigh' })).toEqual({ model: 'gpt-6.2-astra', effort: 'xhigh', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', network: false, mode: 'default' });
    expect(answeredSettings({ thread: { id: 't' } })).toBeNull();
    expect(startSettings('plan', null)).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only' });
  });

  it('names what differs from the start, and the model against the first one seen when the start set none', () => {
    const start = startSettings('bypassPermissions', null);
    expect(settingsDifferences(start, { ...start, model: 'gpt-a' }, null)).toEqual([]);
    expect(settingsDifferences(start, { ...start, model: 'gpt-a' }, 'gpt-a')).toEqual([]);
    expect(settingsDifferences(start, { ...start, model: 'gpt-b' }, 'gpt-a')).toEqual(['model gpt-b (was gpt-a)']);
    expect(settingsDifferences({ ...start, model: 'gpt-a' }, { ...start, model: 'gpt-b' }, null)).toEqual(['model gpt-b (started with gpt-a)']);
    expect(settingsDifferences({ ...start, sandbox: 'workspace-write', network: false }, { ...start, sandbox: 'workspace-write', network: true }, null)).toEqual(['network access on (started off)']);
    expect(settingsDifferences({ ...start, sandbox: 'workspace-write', network: null }, { ...start, sandbox: 'workspace-write', network: true }, null)).toEqual([]);
    expect(settingsDifferences(start, { ...start, approvalsReviewer: 'auto_review', sandbox: 'read-only', mode: 'plan' }, null)).toEqual(['approvals never, reviewed by auto_review (started with never, reviewed by user)', 'sandbox read-only (started with danger-full-access)', 'Plan mode']);
  });
});
