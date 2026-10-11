import { describe, expect, it } from 'vitest';
import { isCodexPermissionMode } from '@switchboard/core';
import { codexPrompt, forkArgs, modeArgs, resumeArgs, startArgs, tomlString } from '../src/args.js';

const OPTIONS = { mode: 'auto' as const, model: null, contract: 'Report to Switchboard with these commands:', tag: 's1-1' };

describe('modeArgs', () => {
  it('gives each mode as config overrides, which exec resume also takes', () => {
    expect(modeArgs('auto')).toEqual(['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true']);
    expect(modeArgs('plan')).toEqual(['-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"']);
    expect(modeArgs('dontAsk')).toEqual(['-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true']);
    expect(modeArgs('bypassPermissions')).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('accepts only the modes a background run can finish in', () => {
    expect(['auto', 'plan', 'dontAsk', 'bypassPermissions'].every(isCodexPermissionMode)).toBe(true);
    expect(isCodexPermissionMode('default')).toBe(false);
    expect(isCodexPermissionMode('acceptEdits')).toBe(false);
  });
});

describe('tomlString', () => {
  it('escapes quotes, backslashes, newlines and DEL', () => {
    expect(tomlString('say "hi"\\\nnext\u007f')).toBe('"say \\"hi\\"\\\\\\nnext\\u007F"');
  });
});

describe('codexPrompt', () => {
  it('turns a leading slash skill into a dollar skill and keeps its arguments', () => {
    expect(codexPrompt('/gc-plan 15619')).toBe('$gc-plan 15619');
    expect(codexPrompt('/review-pr pr:123 publish')).toBe('$review-pr pr:123 publish');
    expect(codexPrompt('/support:process')).toBe('$support:process');
  });

  it('leaves a path, a slash later in the prompt and a plain prompt alone', () => {
    expect(codexPrompt('/d/git/widgets is the repo')).toBe('/d/git/widgets is the repo');
    expect(codexPrompt('Run /gc-plan 1')).toBe('Run /gc-plan 1');
    expect(codexPrompt('Fix the bug')).toBe('Fix the bug');
  });
});

describe('startArgs, resumeArgs and forkArgs', () => {
  it('starts with the mode, contract, tag and model, then the work directory and the prompt after --', () => {
    expect(startArgs('D:/git/widgets', '/gc-plan 1', { ...OPTIONS, model: 'gpt-6' })).toEqual([
      'exec',
      '--json',
      ...modeArgs('auto'),
      '-c',
      'developer_instructions="Report to Switchboard with these commands:"',
      '-c',
      'switchboard_run="s1-1"',
      '-m',
      'gpt-6',
      '-C',
      'D:/git/widgets',
      '--',
      '$gc-plan 1',
    ]);
    expect(startArgs('D:/git/widgets', 'x', OPTIONS)).not.toContain('-m');
  });

  it('resumes the thread with the same options and the text after --', () => {
    expect(resumeArgs('thread-1', '/not-a-skill-here', OPTIONS)).toEqual([
      'exec',
      'resume',
      '--json',
      ...modeArgs('auto'),
      '-c',
      'developer_instructions="Report to Switchboard with these commands:"',
      '-c',
      'switchboard_run="s1-1"',
      'thread-1',
      '--',
      '/not-a-skill-here',
    ]);
  });

  it('forks without persisting', () => {
    expect(forkArgs('thread-1', 'What slowed you down?')).toEqual(['exec', 'fork', '--json', '--ephemeral', 'thread-1', '--', 'What slowed you down?']);
  });
});
