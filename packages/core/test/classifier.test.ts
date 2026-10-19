import { describe, expect, it } from 'vitest';
import { classifierPrompt, classifierSchema, triageModel, validateClassification } from '../src/classifier.js';

const choices = [{ name: 'dev:build', description: 'Build', focus: null }];

describe('triageModel', () => {
  it.each(['claude-sonnet-5-5', 'Claude-opus-4-1', 'sonnet', 'opus[1m]', 'haiku'])('defaults a Claude model %s on Codex', (model) => {
    expect(triageModel('codex', model)).toBeNull();
  });
  it.each(['gpt-6.1', 'chatgpt-4o-latest', 'codex-mini-latest', 'o3', 'o4-mini'])('defaults an OpenAI model %s on Claude', (model) => {
    expect(triageModel('claude', model)).toBeNull();
  });
  it('preserves matching and unknown model names and an unset override', () => {
    expect(triageModel('codex', 'gpt-6.1')).toBe('gpt-6.1');
    expect(triageModel('claude', 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(triageModel('codex', 'custom-model')).toBe('custom-model');
    expect(triageModel('claude', 'custom-model')).toBe('custom-model');
    expect(triageModel('codex', null)).toBeNull();
  });
});

describe('classification contract', () => {
  it('offers only the supplied playbooks, ratings and anchors', () => {
    expect(classifierSchema({ choices, rates: false, focusIds: [] })).toEqual({ type: 'object', properties: { playbook: { type: 'string', enum: ['dev:build'] } }, required: ['playbook'], additionalProperties: false });
    expect(classifierSchema({ choices, rates: true, focusIds: ['ticket'] }).properties).toEqual({
      playbook: { type: 'string', enum: ['dev:build'] }, focus: { type: 'string', enum: ['ticket'] },
      immediacy: { type: 'string', enum: ['URGENT', 'BLOCKING', 'NON-BLOCKING'] }, severity: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
    });
    expect(classifierPrompt('Choose.\n', false)).toBe('Choose.\n\nThe ticket follows as the user message.');
    expect(classifierPrompt('Choose.', true)).toContain('Set focus to the bracketed id');
  });
  it('validates playbooks and drops unavailable or invalid ratings and focus', () => {
    expect(validateClassification(null, choices, false, [], 'Codex')).toEqual({ error: 'Codex returned no playbook.' });
    expect(validateClassification({}, choices, false, [], 'Claude')).toEqual({ error: 'Claude returned no playbook.' });
    expect(validateClassification({ playbook: 'other' }, choices, false, [], 'Codex')).toEqual({ error: 'Triage chose an unknown playbook: other.' });
    const value = { playbook: 'dev:build', immediacy: 'URGENT', severity: 'HIGH', focus: 'ticket' };
    expect(validateClassification(value, choices, true, ['ticket'], 'Codex')).toEqual(value);
    expect(validateClassification(value, choices, false, [], 'Codex')).toEqual({ playbook: 'dev:build', immediacy: null, severity: null, focus: null });
    expect(validateClassification({ ...value, immediacy: 'bad', severity: 3, focus: null }, choices, true, ['ticket'], 'Codex')).toEqual({ playbook: 'dev:build', immediacy: null, severity: null, focus: null });
  });
});
