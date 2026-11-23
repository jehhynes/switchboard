import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core';
import type { Playbook, Settings } from '@switchboard/core';
import { CLAUDE_ALIASES, claudeModelChoices, codexModelChoices, withConfigured } from '../src/models.js';

const settings = (model: string, triage: string): Settings => ({ ...DEFAULT_SETTINGS, sessions: { ...DEFAULT_SETTINGS.sessions, model }, triage: { ...DEFAULT_SETTINGS.triage, model: triage } });
const playbook = (model: string | null, provider: 'claude' | 'codex' | null): Playbook => ({ model, provider }) as Playbook;

describe('model choices (PRD R122)', () => {
  it("offers Claude's aliases, then each other Claude model settings.json names, once, and no Codex model", () => {
    const choices = claudeModelChoices(settings('claude-opus-4-1', 'sonnet'), [playbook('claude-haiku-4-5', null), playbook('gpt-6.2-sol', 'codex'), playbook('gpt-5', null), playbook(null, 'claude'), playbook('claude-opus-4-1', 'claude')]);

    expect(choices.map((one) => one.id)).toEqual([...CLAUDE_ALIASES, 'claude-opus-4-1', 'claude-haiku-4-5']);
    expect(choices[0]).toEqual({ id: 'opus', label: 'opus' });
  });

  it("lists Codex's models through every page of model/list, without hidden ones, labelled by their display names", async () => {
    const asked: unknown[] = [];
    const pages: Record<string, unknown> = {
      first: { data: [{ id: 'a', model: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', hidden: false }, { id: 'h', model: 'gpt-old', displayName: 'Old', hidden: true }], nextCursor: 'two' },
      two: { data: [{ id: 'gpt-mini', model: '', displayName: '' }], nextCursor: null },
    };
    const server = { request: async (method: string, params: Record<string, unknown> = {}) => (asked.push([method, params]), pages[(params['cursor'] as string | undefined) ?? 'first'] as never) };

    expect(await codexModelChoices(server)).toEqual([{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }, { id: 'gpt-mini', label: 'gpt-mini' }]);
    expect(asked).toEqual([['model/list', {}], ['model/list', { cursor: 'two' }]]);
  });

  it('throws when model/list fails, which leaves the configured Codex model alone', async () => {
    await expect(codexModelChoices({ request: async () => Promise.reject(new Error('unknown method')) })).rejects.toThrow('unknown method');
    expect(withConfigured([], 'gpt-6.2-sol')).toEqual([{ id: 'gpt-6.2-sol', label: 'gpt-6.2-sol' }]);
    expect(withConfigured([{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }], ' gpt-6.2-sol ')).toEqual([{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }]);
    expect(withConfigured([], '')).toEqual([]);
  });
});
