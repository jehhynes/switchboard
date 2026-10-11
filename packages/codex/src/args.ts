import type { CodexPermissionMode } from '@switchboard/core';

/**
 * Each mode as config overrides, which both `exec` and `exec resume` take; resume keeps the sandbox but takes the approval
 * policy from the config, so every run passes them (mechanics M31). `auto` is `--approve-for-me`, the workspace-write sandbox
 * with escalations reviewed automatically, plus network access.
 */
export function modeArgs(mode: CodexPermissionMode): string[] {
  switch (mode) {
    // A workspace-write sandbox blocks network access, which skills need for gh and the like, and a model does not always ask
    // to escalate a refused call (GC M46, mechanics M31).
    case 'auto':
      return ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true'];
    case 'plan':
      return ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"'];
    case 'dontAsk':
      return ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true'];
    case 'bypassPermissions':
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

/** A TOML basic string. JSON's escapes are valid TOML, except that TOML also forbids a raw DEL. */
export function tomlString(text: string): string {
  return JSON.stringify(text).replaceAll('\u007f', '\\u007F');
}

/**
 * A prompt that starts with a skill invocation, `/<name>`, starts with `$<name>` instead: Codex injects a `$` skill, while it
 * reads a `/` skill only if the model chooses to and its sandbox allows the read (mechanics M31). A path has a second slash.
 */
export function codexPrompt(prompt: string): string {
  return prompt.replace(/^\/([A-Za-z0-9][\w:-]*)(?=\s|$)/, '$$$1');
}

export interface RunOptions {
  mode: CodexPermissionMode;
  /** Null for Codex's own default. */
  model: string | null;
  /** The report contract, in the developer instructions. */
  contract: string;
  /** Marks the process's command line, so a restarted hub can find it (mechanics M31). */
  tag: string;
}

function sharedArgs(options: RunOptions): string[] {
  return [
    ...modeArgs(options.mode),
    '-c',
    `developer_instructions=${tomlString(options.contract)}`,
    '-c',
    `switchboard_run=${tomlString(options.tag)}`,
    ...(options.model === null ? [] : ['-m', options.model]),
  ];
}

/** A new background session. `--` keeps a prompt that starts with a subcommand's name from being read as one. */
export function startArgs(cwd: string, prompt: string, options: RunOptions): string[] {
  return ['exec', '--json', ...sharedArgs(options), '-C', cwd, '--', codexPrompt(prompt)];
}

/** The next turn of a thread in the background, with the same mode, model and contract as its start. */
export function resumeArgs(threadId: string, text: string, options: RunOptions): string[] {
  return ['exec', 'resume', '--json', ...sharedArgs(options), threadId, '--', text];
}

/** An ephemeral fork for a friction debrief: it writes no rollout and leaves the thread unchanged (mechanics M31). */
export function forkArgs(threadId: string, prompt: string): string[] {
  return ['exec', 'fork', '--json', '--ephemeral', threadId, '--', prompt];
}
