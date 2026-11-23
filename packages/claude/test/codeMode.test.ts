import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_PROMPT, START_PROMPT } from '@switchboard/core';
import type { Session, StartAction } from '@switchboard/core';
import type { SessionEntry, SpawnRequest } from '@switchboard/holder';
import {
  CODE_MODE_IDLE_MS,
  CodeModeRunner,
  HOOKS_REQUIRED,
  LINK_PROMPT,
  PANEL_PROMPT,
  claudeFile,
  codeModeEnvironment,
  codeModeEvidence,
  codeModePrompt,
  codeModeResumeArgs,
  codeModeSettings,
  codeModeStartArgs,
  makeArtifactsDir,
  LAUNCH_TAIL_BYTES,
  readTranscriptLaunch,
  showsStartPrompt,
  transcriptLaunch,
} from '../src/codeMode.js';
import type { CodeModeRunnerDeps, HolderAccess, HolderLookup } from '../src/codeMode.js';
import { conversationRules } from '../src/conversationRules.js';

const fixture = (name: string): { head: string; text: string } => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'codemode', `${name}.json`), 'utf8')) as { head: string; text: string };
const ON = fixture('on');
const OFF = fixture('telemetry-off');
const TRUST = fixture('trust');
const SETTINGS = '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_API_KEY":"","ANTHROPIC_AUTH_TOKEN":"","ANTHROPIC_CUSTOM_HEADERS":""},"viewMode":"focus","tui":"default"}';
const NATIVE = '11111111-2222-3333-4444-555555555555';
const LAUNCH = 'launch-1';
const ARTIFACTS = join('D:/w12', '.wip', 'artifacts', 'w12');
const RULES = conversationRules(ARTIFACTS);
const PROMPT = codeModePrompt(ARTIFACTS);

describe('Code Mode command', () => {
  it('builds the environment from the hub\'s without VS Code, Node.js options, session markers or credentials, with Code Mode, the direct API, the launch and the artifact folder', () => {
    const env = codeModeEnvironment(
      {
        PATH: 'C:/bin',
        CLAUDE_CONFIG_DIR: 'C:/cfg',
        ELECTRON_RUN_AS_NODE: '1',
        VSCODE_PID: '7',
        NODE_OPTIONS: '--inspect',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'parent',
        AI_AGENT: 'x',
        ANTHROPIC_API_KEY: 'key',
        ANTHROPIC_AUTH_TOKEN: 'token',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Key: k',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
        ANTHROPIC_MODEL: 'kept',
        CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bin/bash.exe',
        CLAUDE_CODE_MESSAGING_PORT: '9',
        CLAUDE_CODE_NO_FLICKER: '1',
        // The holder's terminal is an xterm, whatever the hub's says.
        TERM: 'dumb',
      },
      LAUNCH,
      'claude',
      'D:/w/.wip/artifacts/w7',
    );

    expect(env).toEqual({
      PATH: 'C:/bin',
      CLAUDE_CONFIG_DIR: 'C:/cfg',
      ANTHROPIC_MODEL: 'kept',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bin/bash.exe',
      CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      TERM: 'xterm-256color',
      SWITCHBOARD_LAUNCH: LAUNCH,
      CLAUDE_ARTIFACTS_DIR: 'D:/w/.wip/artifacts/w7',
    });
  });

  it('builds a held session without Code Mode with neither Code Mode nor the direct API, even when the hub has them, and keeps the credentials (PRD R81)', () => {
    const env = codeModeEnvironment({ PATH: 'C:/bin', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318', ANTHROPIC_API_KEY: 'key' }, LAUNCH, 'claude', ARTIFACTS, false);

    expect(env).toEqual({ PATH: 'C:/bin', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318', ANTHROPIC_API_KEY: 'key', TERM: 'xterm-256color', SWITCHBOARD_LAUNCH: LAUNCH, CLAUDE_ARTIFACTS_DIR: ARTIFACTS });
    expect(codeModeSettings(false)).toBe('{"viewMode":"focus","tui":"default"}');
  });

  it('puts an absolute claudePath\'s folder first on PATH', () => {
    const claude = join(tmpdir(), 'tools', 'claude.exe');
    const env = codeModeEnvironment({ Path: 'C:/bin' }, LAUNCH, claude, ARTIFACTS);

    expect(env['Path']).toBe(`${join(tmpdir(), 'tools')}${delimiter}C:/bin`);
    expect(env['PATH']).toBeUndefined();
  });

  it('appends conversation rules that name only the tags the view reads, details, aside, rewrite and status, and set no reply length or shape but the primary response', () => {
    // The question shape (PRD R103) and where the [details] line goes are the exceptions: a card's usefulness depends on its content, and the
    // view shows the text above the line first, whether or not it is spoken.
    const questions = RULES.slice(RULES.indexOf('- Use a question card only'), RULES.indexOf("- Don't ask the operator with AskUserQuestion"));
    const primary = RULES.slice(RULES.indexOf('- Write each reply'), RULES.indexOf('\n', RULES.indexOf('- Write each reply')) + 1);
    const tagged = RULES.replace(questions, '');
    const rest = tagged.replace(primary, '');

    // The [details] line marks what the operator can skip, not a summary: what they act on stays above it, links, paths and code allowed, and
    // nothing is restated or added.
    expect(primary).toContain('- Write each reply as you normally would, then put a `[details]` line of its own before the part the operator can skip and still act correctly: evidence, how you checked, test counts, file and commit lists, alternatives you ruled out, background.');
    expect(primary).toContain('Anything they need to decide or act on, such as a result, a change, a decision, a question or a risk, stays above the line, links, paths and code included.');
    expect(primary).toContain("Don't restate or summarise the details; if nothing can be skipped, leave the `[details]` line out.");
    expect(primary).toContain('a reply with no `[details]` line shows whole.');
    expect(primary).not.toMatch(/no lists|file paths|URLs|at most about three|bubble|smaller/);
    expect(tagged.match(/\[[a-z]+\]/g)?.filter((tag, index, all) => all.indexOf(tag) === index)).toEqual(['[details]', '[aside]', '[rewrite]', '[status]']);
    expect(RULES).toContain('they do not change how you write, except where you put a `[details]` line and how you ask the operator a question, below');
    expect(rest).not.toMatch(/\d+ words\b|\bsentences\b|short answer|\blines\b|one line|don't paste/i);
    // A turn may write several replies between tool calls; the rules give only the reason text before a tool call is lost (decision 24).
    expect(RULES).not.toMatch(/end of (your|the) turn/i);
    expect(RULES).toContain('Text written directly before a tool call in the same response can be saved only as thinking, so it never reaches the view.');
    expect(PROMPT.endsWith(RULES)).toBe(true);
  });

  it('asks for a card only for a real decision, in the shape the view draws, and in a reply rather than with AskUserQuestion, with why (PRD R103)', () => {
    // When a card is worth asking, and when it is not.
    expect(RULES).toContain('Use a question card only for a real decision between known alternatives that blocks or shapes your work.');
    expect(RULES).toContain('Never use one to gather a description or details');
    expect(RULES).toContain("Never ask one while the operator is mid-thought, such as after a `[partial]` message");
    expect(RULES).toContain('act on your clear recommendation and say what you chose instead of asking');
    // The shape the parser reads (packages/conversation/src/questions.ts): ids, topics, context, described options, at most four.
    expect(RULES).toContain('{#persona-registered}');
    expect(RULES).toContain("- A) Register on save (recommended) — keeps today's behaviour");
    expect(RULES).toContain('never its position such as `{#q1}`');
    expect(RULES).toContain('Write the id only in that `{#slug}` form at the end of the line, never as a backticked name or a prefix before the question.');
    expect(RULES).toContain('Mark your recommendation with `(recommended)` after its label, before the ` — `.');
    expect(RULES).toContain('Give two to four options');
    expect(RULES).toContain('Ask at most four questions at a time');
    // Questions stay open; withdraw what no longer matters; answers come by slug.
    expect(RULES).toContain('withdraw it with a line `[withdraw: persona-registered]`');
    expect(RULES).toContain('Answers arrive as a message that starts with `[answers]`');
    expect(RULES).toContain("Don't ask in a status");
    expect(RULES).toContain("Don't ask the operator with AskUserQuestion in this session, even where the report contract or a skill says to: its menu holds the whole session until it is answered in the terminal");
    expect(RULES).toContain('Ask in a reply instead, as above.');
  });

  it('adds the spoken-reply section only with voice on: [spoken], the primary response read aloud and the tone line, setting no reply length or shape', () => {
    const voiced = conversationRules(ARTIFACTS, true);

    expect(RULES).not.toContain('[speak]');
    expect(RULES).not.toContain('## Spoken replies');
    expect(voiced).toContain(`${RULES.slice(0, RULES.indexOf('## Artifacts'))}## Spoken replies\n`);
    expect(voiced).toContain("A message from the operator that starts with `[spoken]` will have its reply's primary response, the part before its `[details]` line, read aloud up to its first list, table, code block, heading, quote or rule; the details never are. Write that reply exactly as you would any other.");
    expect(voiced).not.toContain('[speak]');
    expect(voiced).toContain('`[tone: …]` alone on its first line');
    expect(voiced.endsWith(RULES.slice(RULES.indexOf('## Artifacts')))).toBe(true);
    expect(codeModePrompt(ARTIFACTS, true).endsWith(voiced)).toBe(true);
    expect(codeModeResumeArgs(NATIVE, 'auto', null, ARTIFACTS, true)).toContain(codeModePrompt(ARTIFACTS, true));
  });

  it('adds the dictation section after the spoken-reply section only with voice on: [voice], [partial] and the heard tag', () => {
    const voiced = conversationRules(ARTIFACTS, true);

    expect(RULES).not.toContain('## Dictated messages');
    expect(RULES).not.toContain('<!--heard:');
    expect(voiced.indexOf('## Spoken replies')).toBeLessThan(voiced.indexOf('## Dictated messages'));
    expect(voiced.indexOf('## Dictated messages')).toBeLessThan(voiced.indexOf('## Artifacts'));
    expect(voiced).toContain('A message from the operator that starts with `[voice]` was dictated');
    expect(voiced).toContain("A message tagged `[voice] [partial]` is the next part of a long message the operator is still speaking while you work. Don't answer or acknowledge it");
    // Stray speech: talk to someone else or background audio is not acted on, only noted in an aside.
    expect(voiced).toContain("When a `[voice]` message clearly isn't addressed to you, don't act on it: reply only with a short `[aside]` saying you ignored it.");
    expect(voiced).toContain('`[heard all of your reply but: "…"]` or `[interrupted your reply before its first words]` was spoken over your reply while it was read aloud, which stopped it there.');
    expect(voiced).toContain('carries the rest; answer the parts together as one message.');
    expect(voiced).toContain('add `<!--heard:what came through=what was meant-->` to your reply, for example `<!--heard:a llama=Ollama-->`');
  });

  it('explains where and how to write an artifact, naming the folder and its variable, and not when to write one', () => {
    expect(RULES).toMatch(/\n\n## Artifacts\n/);
    expect(RULES).toContain(`artifact folder, \`${ARTIFACTS}\` (also in the \`CLAUDE_ARTIFACTS_DIR\` environment variable)`);
    expect(RULES).toContain('they do not say when to write one');
    expect(RULES).toContain('`<owner>/<kind>-<slug>.md`');
    expect(RULES).toContain('kind: plan\n  title: ');
    expect(RULES).toContain('rewrite the same file');
    expect(RULES).toContain('```mermaid code block');
    expect(RULES).not.toMatch(/15 lines|three columns|when an answer/);
  });

  it('makes the artifact folder with a .gitignore that ignores everything in it, and keeps one the session changed', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifacts-'));
    const dir = join(root, '.wip', 'artifacts', 'w3');

    try {
      makeArtifactsDir(dir);
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n');
      writeFileSync(join(dir, '.gitignore'), '*\n!keep\n');
      makeArtifactsDir(dir);
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n!keep\n');
      // A folder that cannot be made, under a file, fails nothing.
      writeFileSync(join(root, 'file'), '');
      expect(() => makeArtifactsDir(join(root, 'file', 'w4'))).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('overrides the gateway and credentials in --settings, so user settings cannot restore them (mechanics M64), and starts in Focus view in the classic renderer', () => {
    expect(codeModeSettings()).toBe(SETTINGS);
  });

  it("appends only the panel's Code References and Focus view sections", () => {
    expect(PANEL_PROMPT.match(/^## .*$/gm)).toEqual(['## Code References in Text', '## Focus view in this editor']);
    expect(PANEL_PROMPT).toContain('DO NOT USE backtickets ` or HTML tags');
    expect(PANEL_PROMPT).toMatch(/^## Code References in Text\n[\s\S]*the user's workspace\.\n\n## Focus view in this editor\nThis section applies only while a section titled "Focus mode"[\s\S]*so put everything it needs there\.$/);
  });

  it('adds a link section after the panel\'s, so relative link targets start with ./ and the terminal makes them clickable (mechanics M83)', () => {
    expect(PROMPT).toBe(`${PANEL_PROMPT}\n\n${LINK_PROMPT}\n\n${RULES}`);
    expect(LINK_PROMPT).toMatch(/^## Links in this terminal\nStart each relative file link target with "\.\/", as in \[filename\.ts:42\]\(\.\/src\/filename\.ts#L42\), so VS Code's terminal makes it clickable\.$/);
  });

  it('starts with the session ID, permission mode, name, model, contract and settings, and the prompt as one last argument', () => {
    const action = { permissionMode: 'auto', name: 'Switchboard · #12', model: 'haiku', contract: 'Report with …', prompt: '/fix the bug\nnow', cwd: 'D:/w12', workItemId: 12 } as const;

    expect(codeModeStartArgs(action, NATIVE)).toEqual(['--session-id', NATIVE, '--permission-mode', 'auto', '-n', 'Switchboard · #12', '--model', 'haiku', '--append-system-prompt', `Report with …\n\n${PROMPT}`, '--settings', SETTINGS, '/fix the bug\nnow']);
    expect(codeModeStartArgs({ ...action, model: null }, NATIVE)).not.toContain('--model');
    // An empty prompt is left out, so the session waits for the first message (mechanics M87).
    expect(codeModeStartArgs({ ...action, prompt: '' }, NATIVE).at(-1)).toBe(SETTINGS);
  });

  it("appends a persona's tone section after the conversation rules at a start and a resume (architecture.md § Personas)", () => {
    const action = { permissionMode: 'auto', name: 'Switchboard · #12', model: null, contract: 'Report with …', prompt: '', cwd: 'D:/w12', workItemId: 12 } as const;
    const tone = '## Persona\nIn this session you are Nova. Warm.';

    expect(codeModeStartArgs({ ...action, tone }, NATIVE)).toContain(`Report with …\n\n${PROMPT}\n\n${tone}`);
    expect(codeModePrompt(ARTIFACTS, false, tone)).toBe(`${PROMPT}\n\n${tone}`);
    expect(codeModePrompt(ARTIFACTS, false, null)).toBe(PROMPT);
    expect(codeModeResumeArgs(NATIVE, 'auto', null, ARTIFACTS, false, tone)).toContain(`${PROMPT}\n\n${tone}`);
  });

  it("resumes with no prompt, keeping the permission mode, model and settings, and appends the panel's sections for after a compaction", () => {
    expect(codeModeResumeArgs(NATIVE, 'manual', 'opus', ARTIFACTS)).toEqual(['--resume', NATIVE, '--permission-mode', 'manual', '--model', 'opus', '--append-system-prompt', PROMPT, '--settings', SETTINGS]);
    expect(codeModeResumeArgs(NATIVE, 'auto', null, ARTIFACTS)).toEqual(['--resume', NATIVE, '--permission-mode', 'auto', '--append-system-prompt', PROMPT, '--settings', SETTINGS]);
  });

  it("resumes a registered session with its contract first in the appended prompt, and without Code Mode's settings when it ran without it (PRD R81)", () => {
    expect(codeModeResumeArgs(NATIVE, 'auto', null, ARTIFACTS, false, null, { contract: 'Report with …' })).toEqual(['--resume', NATIVE, '--permission-mode', 'auto', '--append-system-prompt', `Report with …\n\n${PROMPT}`, '--settings', SETTINGS]);
    expect(codeModeResumeArgs(NATIVE, 'auto', null, ARTIFACTS, false, null, { codeMode: false, contract: 'Report with …' }).at(-1)).toBe('{"viewMode":"focus","tui":"default"}');
  });

  it('runs claude.exe on Windows when the path names no extension', () => {
    expect(claudeFile('claude', 'win32')).toBe('claude.exe');
    expect(claudeFile('C:/x.y/claude', 'win32')).toBe('C:/x.y/claude.exe');
    expect(claudeFile('C:/bin/claude.exe', 'win32')).toBe('C:/bin/claude.exe');
    expect(claudeFile('claude', 'linux')).toBe('claude');
  });
});

describe('codeModeEvidence', () => {
  it('reads the is-on line from a recorded start (mechanics M63)', () => {
    expect(codeModeEvidence(ON.head)).toEqual({ on: true });
  });

  it("reads Claude's reason from a recorded start without Code Mode, across the line wrap (mechanics M71)", () => {
    expect(codeModeEvidence(OFF.head)).toEqual({
      off: "Code Mode (experimental) isn't available: it needs settings that Claude Code downloads from Anthropic, and this session doesn't download them (DISABLE_TELEMETRY, DO_NOT_TRACK, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC or CLAUDE_CODE_DISABLE_FEATURE_FLAGS turns that off). Starting with the ordinary tools.",
    });
  });

  it('reads nothing from a dialog before the start, which shows a start prompt (mechanics M70)', () => {
    expect(codeModeEvidence(TRUST.head)).toBeNull();
    expect(showsStartPrompt(TRUST.text)).toBe(true);
    expect(showsStartPrompt(ON.text)).toBe(false);
  });

  it('reads cursor moves as the spaces they skip, and takes the first of the two lines when output quotes the other later', () => {
    expect(codeModeEvidence('Code\u001b[1CMode (experimental)\u001b[2Cis on')).toEqual({ on: true });
    expect(codeModeEvidence(`${ON.head}\r\n● Quoting: Code Mode (experimental) isn't available: x`)).toEqual({ on: true });
  });

  it('reads the Linux banner and refusal with absolute column moves', () => {
    expect(codeModeEvidence(fixture('linux-on').head)).toEqual({ on: true });
    expect(codeModeEvidence("Code\u001b[8GMode\u001b[13G(experimental)\u001b[28Gisn't\u001b[34Gavailable: telemetry disabled. Starting with the ordinary tools.")).toEqual({ off: "Code Mode (experimental) isn't available: telemetry disabled. Starting with the ordinary tools." });
  });

  it('reads the refusal without the warning sign and split by escape sequences', () => {
    expect(codeModeEvidence("\u001b[33mCode Mode (experimental) isn't\u001b[0m\r\n available: for now it only works directly")).toEqual({ off: "Code Mode (experimental) isn't available: for now it only works directly" });
  });
});

/** A holder whose answers the test sets; it fails on a call it was not set up for. */
class FakeHolder implements HolderAccess {
  spawned: SpawnRequest[] = [];
  killed: string[] = [];
  screens = new Map<string, { head: string; text: string }>();
  entries: SessionEntry[] = [];
  failSpawn: string | null = null;
  failKill: string | null = null;

  spawn(request: SpawnRequest): Promise<{ session: string; pid: number }> {
    if (this.failSpawn !== null) {
      return Promise.reject(new Error(this.failSpawn));
    }

    this.spawned.push(request);
    this.entries.push(entry(request.session));

    return Promise.resolve({ session: request.session, pid: 100 });
  }

  list(): Promise<SessionEntry[]> {
    return Promise.resolve(this.entries);
  }

  kill(session: string): Promise<number | null> {
    if (this.failKill !== null) {
      return Promise.reject(new Error(this.failKill));
    }

    const found = this.entries.find((one) => one.session === session && one.exitedAt === null);

    if (found === undefined) {
      return Promise.reject(new Error(`No session ${session} is held.`));
    }

    this.killed.push(session);
    found.exitedAt = 1;
    found.exitCode = 1;

    return Promise.resolve(1);
  }

  screen(session: string): Promise<{ head: string; text: string }> {
    const screen = this.screens.get(session);

    return screen === undefined ? Promise.reject(new Error(`No screen for ${session}`)) : Promise.resolve(screen);
  }
}

function entry(session: string, exited = false): SessionEntry {
  return { session, label: 'l', pid: 100, cwd: 'D:/work', startedAt: 0, lastInputAt: null, lastOutputAt: null, exitedAt: exited ? 5 : null, exitCode: exited ? 3 : null, clients: 0, memoryBytes: null };
}

const ACTION: StartAction = {
  type: 'start-session',
  sessionId: 'sb-1',
  workItemId: 1,
  kind: 'task',
  provider: 'claude',
  cwd: 'D:/work',
  prompt: 'Do it',
  contract: 'Contract',
  name: 'Switchboard · #1',
  permissionMode: 'auto',
  model: 'haiku',
  nativeSessionId: NATIVE,
  launchId: LAUNCH,
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sb-1', workItemId: 1, kind: 'task', provider: 'claude', nativeSessionId: NATIVE, shortId: NATIVE.slice(0, 8), cwd: 'D:/work', state: 'running', stateAt: 0,
    stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 0, endedAt: null, released: false, releasing: false, question: null, reports: [],
    retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, codeMode: true, launchId: LAUNCH, ...overrides,
  };
}

let home: string;
let clock: number;
let holder: FakeHolder;
let lookup: HolderLookup;
let hooks: boolean;
let onSleep: ((now: number) => void) | null;
let roster: Array<{ sessionId: string; pid?: number }>;
let made: string[];

function marker(sessionId: string, fields: Record<string, unknown>): void {
  mkdirSync(join(home, 'activity'), { recursive: true });
  writeFileSync(join(home, 'activity', `${sessionId}.json`), JSON.stringify({ v: 1, sessionId, at: clock, notificationType: null, source: null, toolName: null, backgroundTasks: 0, error: null, errorMessage: null, ...fields }));
}

function runner(extra: Partial<CodeModeRunnerDeps> = {}): CodeModeRunner {
  return new CodeModeRunner({
    claudePath: () => 'claude',
    home,
    hooks: () => hooks,
    holder: () => Promise.resolve(lookup),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      onSleep?.(clock);

      return Promise.resolve();
    },
    newId: () => 'new-id',
    roster: () => Promise.resolve(roster),
    readTimeoutMs: 20,
    environment: { PATH: 'C:/bin' },
    platform: 'linux',
    makeArtifactsDir: (dir) => made.push(dir),
    ...extra,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'code-mode-'));
  clock = 1_000;
  holder = new FakeHolder();
  lookup = { holder };
  hooks = true;
  onSleep = null;
  roster = [];
  made = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('CodeModeRunner.start', () => {
  it('spawns claude in the holder and starts once the output shows Code Mode on and a marker of the launch exists', async () => {
    holder.screens.set('sb-1', { head: '', text: '' });
    onSleep = (now) => {
      if (now >= 3_000) {
        holder.screens.set('sb-1', ON);
        marker(NATIVE, { event: 'UserPromptSubmit', launch: LAUNCH });
      }
    };

    expect(await runner().start(ACTION)).toEqual({ shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE, launchId: LAUNCH });
    expect(holder.spawned).toEqual([
      {
        session: 'sb-1',
        label: `Switchboard · #1 ${NATIVE}`,
        file: 'claude',
        args: codeModeStartArgs(ACTION, NATIVE),
        cwd: 'D:/work',
        env: { PATH: 'C:/bin', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', TERM: 'xterm-256color', SWITCHBOARD_LAUNCH: LAUNCH, CLAUDE_ARTIFACTS_DIR: join('D:/work', '.wip', 'artifacts', 'w1') },
        cols: 120,
        rows: 40,
      },
    ]);
    expect(made).toEqual([join('D:/work', '.wip', 'artifacts', 'w1')]);
    expect(holder.killed).toEqual([]);
  });

  it("fails with Claude's reason and ends the process when Claude starts without Code Mode", async () => {
    holder.screens.set('sb-1', OFF);

    const result = await runner().start(ACTION);

    expect(result).toEqual({ error: expect.stringMatching(/^Code Mode \(experimental\) isn't available: it needs settings/) as unknown });
    expect(holder.killed).toEqual(['sb-1']);
  });

  it('fails a start whose marker arrives without the is-on line, after one more look', async () => {
    holder.screens.set('sb-1', { head: 'Claude Code v2.1.327\r\n', text: '' });
    marker(NATIVE, { event: 'SessionStart', source: 'startup', launch: LAUNCH });

    expect(await runner().start(ACTION)).toEqual({ error: 'Claude started the session without Code Mode: its output has no "Code Mode (experimental) is on" line.' });
    expect(clock).toBe(2_000);
    expect(holder.killed).toEqual(['sb-1']);
  });

  it('starts a session without Code Mode on its launch\'s first marker, with neither Code Mode nor the direct API, and ignores a Code Mode line (mechanics M148)', async () => {
    const regular: StartAction = { ...ACTION, withoutCodeMode: true };

    holder.screens.set('sb-1', { head: 'Claude Code v2.1.330\r\n', text: '' });
    onSleep = (now) => {
      if (now >= 3_000) {
        marker(NATIVE, { event: 'UserPromptSubmit', launch: LAUNCH });
      }
    };

    expect(await runner({ environment: { PATH: 'C:/bin', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1', ANTHROPIC_AUTH_TOKEN: 'token' } }).start(regular)).toEqual({ shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE, launchId: LAUNCH });
    expect(clock).toBe(3_000);
    expect(holder.spawned[0]!.args).toEqual(codeModeStartArgs(regular, NATIVE, false, false));
    expect(holder.spawned[0]!.args[holder.spawned[0]!.args.indexOf('--settings') + 1]).toBe(codeModeSettings(false));
    expect(holder.spawned[0]!.env).toEqual({ PATH: 'C:/bin', ANTHROPIC_AUTH_TOKEN: 'token', TERM: 'xterm-256color', SWITCHBOARD_LAUNCH: LAUNCH, CLAUDE_ARTIFACTS_DIR: join('D:/work', '.wip', 'artifacts', 'w1') });
    expect(holder.killed).toEqual([]);

    // A refusal line means nothing to a session that never asked for Code Mode.
    holder = new FakeHolder();
    lookup = { holder };
    holder.screens.set('sb-1', OFF);
    expect(await runner().start(regular)).toEqual({ shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE, launchId: LAUNCH });
    expect(holder.killed).toEqual([]);
  });

  it('ignores a marker of an older launch or another session, and starts waiting on a prompt after the start-prompt wait', async () => {
    holder.screens.set('sb-1', { head: ON.head, text: '' });
    marker(NATIVE, { event: 'Stop', launch: 'older' });
    marker('other', { event: 'Stop', launch: LAUNCH });

    expect(await runner().start(ACTION)).toEqual({ shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE, launchId: LAUNCH, startPrompt: true });
    expect(clock).toBe(21_000);
  });

  it('starts waiting on a prompt at once when a dialog shows, such as folder trust (mechanics M70)', async () => {
    holder.screens.set('sb-1', TRUST);

    expect(await runner().start(ACTION)).toEqual({ shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE, launchId: LAUNCH, startPrompt: true });
    expect(clock).toBe(1_000);
  });

  it("fails a process that exits before the session starts with the screen's last lines", async () => {
    holder.screens.set('sb-1', { head: '', text: 'Claude Code v2.1.327\n\nError: something broke\n\n' });
    holder.spawn = (request) => {
      holder.spawned.push(request);
      holder.entries.push(entry(request.session, true));

      return Promise.resolve({ session: request.session, pid: 100 });
    };

    expect(await runner().start(ACTION)).toEqual({ error: 'Claude exited with code 3 before the session started: Claude Code v2.1.327\nError: something broke' });
  });

  it('refuses a start with hooks off, and spawns nothing (PRD R93)', async () => {
    hooks = false;

    expect(await runner().start(ACTION)).toEqual({ error: HOOKS_REQUIRED });
    expect(holder.spawned).toEqual([]);
  });

  it('looks again after a holder read fails, and ends the process when the deadline passes without an answer', async () => {
    let reads = 0;

    holder.screen = () => (++reads <= 2 ? Promise.reject(new Error('The terminal holder closed the connection.')) : Promise.resolve(TRUST));
    expect(await runner().start(ACTION)).toMatchObject({ startPrompt: true });
    expect(reads).toBe(3);

    holder.screen = () => Promise.reject(new Error('The terminal holder closed the connection.'));
    holder.entries = [];
    clock = 1_000;
    expect(await runner().start(ACTION)).toEqual({ error: 'The session did not start within 60 seconds: The terminal holder closed the connection.' });
    expect(holder.killed).toEqual(['sb-1']);
  });

  it('counts a holder request that never answers as failed, and ends the process at the deadline', async () => {
    holder.screen = () => new Promise(() => undefined);

    expect(await runner().start(ACTION)).toEqual({ error: 'The session did not start within 60 seconds: The terminal holder did not answer within 0.02 seconds.' });
    expect(holder.killed).toEqual(['sb-1']);
  });

  it('says so when ending a refused start fails too', async () => {
    holder.screens.set('sb-1', OFF);
    holder.failKill = 'Access is denied.';

    expect(await runner().start(ACTION)).toEqual({ error: expect.stringMatching(/Starting with the ordinary tools\. Ending it failed too: Access is denied\.$/) as unknown });
  });

  it('fails with the reason when the holder cannot start or refuses the spawn', async () => {
    lookup = { error: 'The terminal holder did not write its record within 10 seconds; see C:/h/holder.log.' };
    expect(await runner().start(ACTION)).toEqual({ error: 'The terminal holder did not write its record within 10 seconds; see C:/h/holder.log.' });

    lookup = { holder };
    holder.failSpawn = 'claude could not be started: File not found';
    expect(await runner().start(ACTION)).toEqual({ error: 'claude could not be started: File not found' });
  });

  it('names a missing bare executable from the Linux terminal exit', async () => {
    holder.screens.set('sb-1', { head: '', text: 'execvp(3) failed.: No such file or directory' });
    holder.spawn = async request => {
      holder.entries.push({ ...entry(request.session, true), cwd: home });
      return { session: request.session, pid: 100 };
    };
    expect(await runner({ claudePath: () => 'missing-claude' }).start(ACTION)).toEqual({ error: 'Claude Code was not found at missing-claude. Install it or set sessions.claudePath.' });
  });

  it('names an absolute missing executable before asking the holder to spawn', async () => {
    const missing = join(home, 'missing', 'claude');
    expect(await runner({ claudePath: () => missing }).start(ACTION)).toEqual({ error: `Claude Code was not found at ${missing}. Install it or set sessions.claudePath.` });
  });

  it('generates the session ID and launch when the action names none', async () => {
    holder.screens.set('sb-1', ON);
    marker('new-id', { event: 'UserPromptSubmit', launch: 'new-id' });

    const { nativeSessionId: _native, launchId: _launch, ...action } = ACTION;

    expect(await runner().start(action)).toEqual({ shortId: 'new-id', nativeSessionId: 'new-id', launchId: 'new-id' });
  });
});

describe('CodeModeRunner.observe', () => {
  it('lists held sessions with the state of their own launch\'s marker, and leaves out exited and unheld ones', async () => {
    holder.entries = [entry('sb-1'), entry('sb-2', true)];
    marker(NATIVE, { event: 'Stop', launch: LAUNCH });

    expect(await runner().observe([session(), session({ id: 'sb-2' }), session({ id: 'sb-3' })])).toEqual({ sessions: [{ sessionId: 'sb-1', state: 'idle', detail: null, interactive: false }], forks: [], idle: [] });
  });

  it('keeps the last state when no marker of the launch exists, and reads a promptless resume as idle (mechanics M68)', async () => {
    holder.entries = [entry('sb-1')];
    marker(NATIVE, { event: 'Stop', launch: 'older' });

    expect(await runner().observe([session({ state: 'waiting', stateDetail: PERMISSION_PROMPT })])).toMatchObject({ sessions: [{ state: 'waiting', detail: PERMISSION_PROMPT }] });

    marker(NATIVE, { event: 'SessionStart', source: 'resume', launch: LAUNCH });
    expect(await runner().observe([session()])).toMatchObject({ sessions: [{ state: 'idle', detail: null }] });
  });

  it('reads a fresh start as running and leaves the state as it was after a compaction (mechanics M65)', async () => {
    holder.entries = [entry('sb-1')];
    marker(NATIVE, { event: 'SessionStart', source: 'startup', launch: LAUNCH });
    expect(await runner().observe([session({ state: 'starting' })])).toMatchObject({ sessions: [{ state: 'running' }] });

    marker(NATIVE, { event: 'SessionStart', source: 'compact', launch: LAUNCH });
    expect(await runner().observe([session({ state: 'idle' })])).toMatchObject({ sessions: [{ state: 'idle' }] });
  });

  it('takes no resumed ID as a change while the session\'s own marker remains, as for a nested claude -p --resume', async () => {
    holder.entries = [entry('sb-1')];
    marker(NATIVE, { event: 'PostToolBatch', launch: LAUNCH });
    marker('resumed-elsewhere', { event: 'SessionStart', source: 'resume', launch: LAUNCH, startSource: 'resume' });

    expect(await runner().observe([session()])).toMatchObject({ forks: [] });
  });

  it('keeps a session waiting on its start prompt when its screen cannot be read', async () => {
    holder.entries = [entry('sb-1')];
    marker(NATIVE, { event: 'SessionStart', source: 'startup', launch: LAUNCH });

    expect(await runner().observe([session({ state: 'waiting', stateDetail: START_PROMPT })])).toMatchObject({ sessions: [{ state: 'waiting', detail: START_PROMPT }] });
    expect(holder.killed).toEqual([]);
  });

  it('reports an ID change in the terminal as a fork, but not a nested claude -p run (mechanics M73, M77)', async () => {
    holder.entries = [entry('sb-1')];
    marker('nested', { event: 'Stop', launch: LAUNCH, startSource: null });

    expect(await runner().observe([session()])).toMatchObject({ forks: [] });

    marker('cleared-id', { event: 'UserPromptSubmit', launch: LAUNCH, startSource: 'clear' });
    // Not followed until the roster lists the held process with the new ID.
    expect(await runner().observe([session()])).toMatchObject({ forks: [] });

    roster = [{ sessionId: 'cleared-id', pid: 100 }];
    expect((await runner().observe([session()]) as { forks: unknown[] }).forks).toEqual([{ sessionId: 'sb-1', nativeSessionId: 'cleared-id', shortId: 'cleared-', state: 'running', detail: null }]);
  });

  it('follows the ID the roster lists for the held process when a nested resumed run left a marker too', async () => {
    holder.entries = [entry('sb-1')];
    marker('nested-resumed', { event: 'Stop', launch: LAUNCH, startSource: 'resume' });
    marker('cleared-id', { event: 'SessionStart', source: 'clear', launch: LAUNCH, startSource: 'clear' });
    roster = [{ sessionId: 'nested-resumed' }, { sessionId: 'cleared-id', pid: 100 }];

    expect((await runner().observe([session()]) as { forks: Array<{ nativeSessionId: string }> }).forks.map((fork) => fork.nativeSessionId)).toEqual(['cleared-id']);
  });

  it('fails and ends a session that started on a prompt when its first marker comes without Code Mode', async () => {
    holder.entries = [entry('sb-1')];
    holder.screens.set('sb-1', { head: 'no banner', text: '' });
    marker(NATIVE, { event: 'SessionStart', source: 'startup', launch: LAUNCH });

    expect(await runner().observe([session({ state: 'waiting', stateDetail: START_PROMPT })])).toMatchObject({ sessions: [{ state: 'failed', detail: expect.stringContaining('without Code Mode') as unknown }] });
    expect(holder.killed).toEqual(['sb-1']);

    holder.entries = [entry('sb-1')];
    holder.screens.set('sb-1', ON);
    expect(await runner().observe([session({ state: 'waiting', stateDetail: START_PROMPT })])).toMatchObject({ sessions: [{ state: 'running', detail: null }] });
  });

  it('takes the first marker of a session without Code Mode that started on a prompt as its state, without looking for Code Mode', async () => {
    holder.entries = [entry('sb-1')];
    marker(NATIVE, { event: 'SessionStart', source: 'startup', launch: LAUNCH });

    expect(await runner().observe([session({ state: 'waiting', stateDetail: START_PROMPT, withoutCodeMode: true })])).toMatchObject({ sessions: [{ state: 'running', detail: null }] });
    expect(holder.killed).toEqual([]);
  });

  it('reports a gone holder and a failed read apart', async () => {
    lookup = { gone: true };
    expect(await runner().observe([session()])).toEqual({ sessions: [], forks: [], gone: true, idle: [] });

    lookup = { error: 'The terminal holder did not answer.' };
    expect(await runner().observe([session()])).toEqual({ error: 'The terminal holder did not answer.' });

    lookup = { holder };
    holder.list = () => Promise.reject(new Error('The terminal holder closed the connection.'));
    expect(await runner().observe([session()])).toEqual({ error: 'The terminal holder closed the connection.' });
  });

  it('names held sessions with no terminal attached and no input or output for the idle limit (PRD R95)', async () => {
    clock = CODE_MODE_IDLE_MS + 1_000;
    holder.entries = [
      { ...entry('sb-1'), lastOutputAt: clock - CODE_MODE_IDLE_MS },
      { ...entry('sb-2'), lastOutputAt: clock - CODE_MODE_IDLE_MS, clients: 1 },
      { ...entry('sb-3'), lastInputAt: clock - CODE_MODE_IDLE_MS + 1 },
      { ...entry('sb-4'), startedAt: clock - CODE_MODE_IDLE_MS + 1 },
    ];

    const observed = await runner().observe(['sb-1', 'sb-2', 'sb-3', 'sb-4'].map((id) => session({ id, state: 'idle' })));

    expect(observed).toMatchObject({ idle: ['sb-1'] });
  });

  it('finds the held session whose launch wrote a marker of another session ID, as after /clear (PRD R81)', () => {
    marker('cleared-uuid', { event: 'SessionStart', source: 'clear', launch: LAUNCH });
    marker('own-uuid', { event: 'Stop' });

    expect(runner().heldBy('cleared-uuid', [session({ id: 'sb-0', codeMode: false, launchId: null }), session()])?.id).toBe('sb-1');
    expect(runner().heldBy('own-uuid', [session()])).toBeNull();
    expect(runner().heldBy('unknown', [session()])).toBeNull();
    hooks = false;
    expect(runner().heldBy('cleared-uuid', [session()])?.id).toBe('sb-1');
  });

  it('reads the terminals attached to a held session and its last input, none for an exited one or a gone holder, and fails a failed read', async () => {
    holder.entries = [{ ...entry('sb-1'), clients: 2 }, { ...entry('sb-2', true), clients: 1 }];

    holder.entries[0]!.lastInputAt = 900;
    holder.entries[0]!.lastOutputAt = 950;
    expect(await runner().heldActivity('sb-1')).toEqual({ clients: 2, lastInputAt: 900, lastOutputAt: 950 });
    expect(await runner().heldActivity('sb-2')).toEqual({ clients: 0, lastInputAt: null, lastOutputAt: null });
    lookup = { gone: true };
    expect(await runner().heldActivity('sb-1')).toEqual({ clients: 0, lastInputAt: null, lastOutputAt: null });
    lookup = { error: 'The terminal holder holds its lock but does not answer.' };
    expect(await runner().heldActivity('sb-1')).toEqual({ error: 'The terminal holder holds its lock but does not answer.' });
  });

  it('reads markers of its sessions\' own launches only, and none with hooks off', () => {
    marker(NATIVE, { event: 'PermissionRequest', toolName: 'Bash', launch: LAUNCH, at: 42 });
    marker('other', { event: 'Stop', launch: 'x' });

    expect([...runner().markers([session()])]).toEqual([[NATIVE, { at: 42, cwd: null, observed: { state: 'waiting', detail: PERMISSION_PROMPT }, recheck: false }]]);
    expect(runner().markers([session({ launchId: 'other' })]).size).toBe(0);

    marker(NATIVE, { event: 'SessionStart', source: 'compact', launch: LAUNCH, at: 43 });
    expect(runner().markers([session()]).get(NATIVE)).toEqual({ at: 43, cwd: null, observed: null, recheck: false, compacted: true });

    hooks = false;
    expect(runner().markers([session()]).size).toBe(0);
  });
});

describe('CodeModeRunner stop, resume and reconcile', () => {
  it('stops by killing the session in the holder; an unheld session or a gone holder has stopped already', async () => {
    holder.entries = [entry('sb-1')];
    expect(await runner().isBackground({ sessionId: 'sb-1', shortId: null })).toBe(true);
    expect(await runner().stop({ sessionId: 'sb-1', shortId: null }, 'operator')).toBeNull();
    expect(holder.killed).toEqual(['sb-1']);
    expect(await runner().isBackground({ sessionId: 'sb-1', shortId: null })).toBe(false);
    expect(await runner().stop({ sessionId: 'sb-9', shortId: null }, 'operator')).toBeNull();

    holder.entries = [entry('sb-1')];
    holder.failKill = 'Session sb-1 did not exit within 15 seconds.';
    expect(await runner().stop({ sessionId: 'sb-1', shortId: null }, 'operator')).toEqual({ error: 'Session sb-1 did not exit within 15 seconds.' });

    lookup = { gone: true };
    expect(await runner().stop({ sessionId: 'sb-1', shortId: null }, 'operator')).toBeNull();
    expect(await runner().isBackground({ sessionId: 'sb-1', shortId: null })).toBe(false);
  });


  it('starts a promptless session that ended before its first message again under its session ID, since it has no transcript to resume (mechanics M87)', async () => {
    const fresh = { contract: 'Report with …', name: 'switchboard · ad-hoc · adhoc 3' };

    expect(await runner({ transcriptExists: () => false }).resumeHeld(session(), 'auto', 'haiku', 'label', 'l2', fresh)).toEqual({ launchId: 'l2' });
    expect(holder.spawned[0]!.args).toEqual(codeModeStartArgs({ permissionMode: 'auto', name: fresh.name, model: 'haiku', contract: fresh.contract, prompt: '', cwd: 'D:/work', workItemId: 1 }, NATIVE));
    expect(holder.spawned[0]!.args.at(-2)).toBe('--settings');

    // With a transcript, or for a session started with a prompt, it resumes.
    expect(await runner({ transcriptExists: () => true }).resumeHeld(session(), 'auto', 'haiku', 'label', 'l3', fresh)).toEqual({ launchId: 'l3' });
    expect(await runner({ transcriptExists: () => false }).resumeHeld(session(), 'auto', 'haiku', 'label', 'l4')).toEqual({ launchId: 'l4' });
    expect(holder.spawned.slice(1).map((one) => one.args[0])).toEqual(['--resume', '--resume']);

    // A session without Code Mode starts again without it.
    expect(await runner({ transcriptExists: () => false }).resumeHeld(session({ withoutCodeMode: true }), 'auto', 'haiku', 'label', 'l5', fresh)).toEqual({ launchId: 'l5' });
    expect(holder.spawned[3]!.args).toEqual(codeModeStartArgs({ permissionMode: 'auto', name: fresh.name, model: 'haiku', contract: fresh.contract, prompt: '', cwd: 'D:/work', workItemId: 1 }, NATIVE, false, false));
    expect(holder.spawned[3]!.env).not.toHaveProperty('CLAUDE_CODE_EXPERIMENTAL_CODE_MODE');
  });

  it('reads a promptless start as idle and a prompted one as running (mechanics M87)', () => {
    marker(NATIVE, { event: 'SessionStart', source: 'startup', launch: LAUNCH, at: 44 });

    expect(runner().markers([session()]).get(NATIVE)?.observed).toEqual({ state: 'running', detail: null });
    expect(runner().markers([session({ promptless: true })]).get(NATIVE)?.observed).toEqual({ state: 'idle', detail: null });
  });

  it('resumes a registered session without Code Mode with its contract, and one that ran in Code Mode with Code Mode (PRD R81)', async () => {
    const artifacts = join('D:/work', '.wip', 'artifacts', 'w1');

    expect(await runner({ environment: { PATH: 'C:/bin', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' } }).resumeHeld(session({ withoutCodeMode: true }), 'auto', null, 'label', 'l1', undefined, 'Report with …')).toEqual({ launchId: 'l1' });
    expect(holder.spawned[0]!.args).toEqual(codeModeResumeArgs(NATIVE, 'auto', null, artifacts, false, null, { codeMode: false, contract: 'Report with …' }));
    expect(holder.spawned[0]!.env).not.toHaveProperty('CLAUDE_CODE_EXPERIMENTAL_CODE_MODE');
    expect(holder.spawned[0]!.env).not.toHaveProperty('ANTHROPIC_BASE_URL');

    expect(await runner().resumeHeld(session({ withoutCodeMode: false }), 'auto', null, 'label', 'l2', undefined, 'Report with …')).toEqual({ launchId: 'l2' });
    expect(holder.spawned[1]!.args).toEqual(codeModeResumeArgs(NATIVE, 'auto', null, artifacts, false, null, { contract: 'Report with …' }));
    expect(holder.spawned[1]!.env).toMatchObject({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
  });

  it('resumes an ended session in the holder with a new launch and no prompt', async () => {
    expect(await runner().resumeHeld(session(), 'auto', 'haiku', 'label')).toEqual({ launchId: 'new-id' });
    expect(holder.spawned[0]).toMatchObject({ session: 'sb-1', label: 'label', args: codeModeResumeArgs(NATIVE, 'auto', 'haiku', join('D:/work', '.wip', 'artifacts', 'w1')), env: { SWITCHBOARD_LAUNCH: 'new-id', CLAUDE_ARTIFACTS_DIR: join('D:/work', '.wip', 'artifacts', 'w1') } });
    expect(made).toEqual([join('D:/work', '.wip', 'artifacts', 'w1')]);
    expect(await runner().resumeHeld(session({ nativeSessionId: null }), 'auto', null, 'label')).toEqual({ error: 'The session never started, so it cannot be resumed.' });

    // With voice on, a resume appends the rules with their spoken-reply section.
    holder.spawned.length = 0;
    expect(await runner({ voice: () => true }).resumeHeld(session(), 'auto', 'haiku', 'label', 'l9')).toEqual({ launchId: 'l9' });
    expect(holder.spawned[0]!.args).toEqual(codeModeResumeArgs(NATIVE, 'auto', 'haiku', join('D:/work', '.wip', 'artifacts', 'w1'), true));
    expect(holder.spawned[0]!.args.join(' ')).toContain('## Spoken replies');

    // A resume reads the session's tone section as the settings have it now.
    holder.spawned.length = 0;
    const asked: string[] = [];
    expect(await runner({ tone: (id) => (asked.push(id), '## Persona\nIn this session you are Orion.') }).resumeHeld(session(), 'auto', 'haiku', 'label', 'l10')).toEqual({ launchId: 'l10' });
    expect(asked).toEqual(['sb-1']);
    expect(holder.spawned[0]!.args.at(-3)).toMatch(/\n\n## Persona\nIn this session you are Orion\.$/);
  });

  it('settles sessions a stopped hub left starting with the same check', async () => {
    holder.entries = [entry('sb-1'), entry('sb-2'), entry('sb-4'), entry('sb-6')];
    holder.screens.set('sb-1', ON);
    holder.screens.set('sb-2', OFF);
    holder.screens.set('sb-4', { head: '', text: '' });
    holder.screens.set('sb-6', { head: 'no banner', text: '' });
    marker(NATIVE, { event: 'Stop', launch: LAUNCH });
    marker('six', { event: 'Stop', launch: LAUNCH });
    clock = 5_000;

    expect(
      await runner().reconcile([
        session({ state: 'starting' }),
        session({ id: 'sb-2', state: 'starting' }),
        session({ id: 'sb-3', state: 'starting' }),
        session({ id: 'sb-4', state: 'starting', nativeSessionId: 'other' }),
        session({ id: 'sb-5', state: 'starting', nativeSessionId: null }),
        session({ id: 'sb-6', state: 'starting', nativeSessionId: 'six' }),
      ]),
    ).toEqual([
      { sessionId: 'sb-1', started: { shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE } },
      { sessionId: 'sb-2', failed: expect.stringMatching(/^Code Mode \(experimental\) isn't available/) as unknown },
      { sessionId: 'sb-3', failed: 'The hub stopped while the session was starting.' },
      { sessionId: 'sb-4', pending: 'The session is still starting.' },
      { sessionId: 'sb-5', failed: 'The hub stopped while the session was starting.' },
      { sessionId: 'sb-6', failed: 'Claude started the session without Code Mode: its output has no "Code Mode (experimental) is on" line.' },
    ]);
    expect(holder.killed).toEqual(['sb-2', 'sb-6']);
  });

  it('settles a starting session without Code Mode on its marker alone', async () => {
    holder.entries = [entry('sb-1')];
    holder.screens.set('sb-1', { head: 'no banner', text: '' });
    marker(NATIVE, { event: 'Stop', launch: LAUNCH });
    clock = 5_000;

    expect(await runner().reconcile([session({ state: 'starting', withoutCodeMode: true })])).toEqual([{ sessionId: 'sb-1', started: { shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE } }]);
    expect(holder.killed).toEqual([]);
  });

  it('fails starting sessions when the holder is gone, and waits when it does not answer', async () => {
    lookup = { gone: true };
    expect(await runner().reconcile([session({ state: 'starting' })])).toEqual([{ sessionId: 'sb-1', failed: 'The hub stopped while the session was starting.' }]);

    lookup = { error: 'The terminal holder did not answer.' };
    expect(await runner().reconcile([session({ state: 'starting' })])).toEqual([{ sessionId: 'sb-1', pending: 'The terminal holder did not answer.' }]);
  });
});

describe('CodeModeRunner attach support (PRD R95)', () => {
  const TREE = [{ pid: 100, created: '133' }, { pid: 101, created: '134' }, { pid: 102, created: '135' }];
  const row = (pid: number, created: string) => ({ pid, ppid: 1, created, memoryBytes: 0 });

  it("carries a held session's process tree when the holder gives one", async () => {
    holder.entries = [{ ...entry('sb-1'), tree: TREE }, entry('sb-2')];

    const observed = await runner().observe([session(), session({ id: 'sb-2' })]);

    expect(observed).toMatchObject({ sessions: [{ sessionId: 'sb-1', tree: TREE }, { sessionId: 'sb-2' }] });
    expect('error' in observed ? null : observed.sessions[1]).not.toHaveProperty('tree');
  });

  it('names held sessions idle after the idle limit it was given', async () => {
    clock = 61_000;
    holder.entries = [{ ...entry('sb-1'), lastOutputAt: 1_000 }, { ...entry('sb-2'), lastOutputAt: 2_000 }];

    expect(await runner({ idleMs: 60_000 }).observe(['sb-1', 'sb-2'].map((id) => session({ id, state: 'idle' })))).toMatchObject({ idle: ['sb-1'] });
  });

  it('finds the members of a tree that still run with the same creation time, not a reused pid', async () => {
    let reads = 0;
    const processes = async () => {
      reads += 1;
      return [row(100, '133'), row(101, '999'), row(7, '1')];
    };

    expect(await runner({ processes }).leftovers(TREE)).toEqual([{ pid: 100, created: '133' }]);
    expect(reads).toBe(1);
    expect(await runner({ processes }).leftovers([])).toEqual([]);
    expect(reads).toBe(1);
  });

  it('fails the check when the process table cannot be read', async () => {
    expect(await runner({ processes: async () => ({ error: 'Access is denied.' }) }).leftovers(TREE)).toEqual({ error: 'The process table could not be read: Access is denied.' });
  });

  it('stops only the leftover processes that still run, not the session, and names those it could not end', async () => {
    const killed: number[] = [];
    const processes = async () => [row(100, '133'), row(102, '135'), row(101, 'reused')];
    const stop = (failing: number[]) =>
      runner({
        processes,
        killTree: async (pid) => {
          killed.push(pid);
          return failing.includes(pid) ? { error: 'Access is denied.' } : null;
        },
      }).stop({ sessionId: 'sb-1', shortId: null, lastTree: TREE }, 'operator');

    holder.entries = [entry('sb-1')];
    expect(await stop([])).toBeNull();
    expect(killed).toEqual([100, 102]);
    expect(holder.killed).toEqual([]);

    killed.length = 0;
    expect(await stop([102])).toEqual({ error: 'Process 102 could not be ended: Access is denied.' });
    expect(await stop([100, 102])).toEqual({ error: 'Processes 100, 102 could not be ended: Access is denied.' });
  });

  it('ends a leftover with its tree and reads the table again before ending members under it, so a pid reused meanwhile is spared', async () => {
    let child = '134';
    let reads = 0;
    const killed: number[] = [];
    const processes = async () => {
      reads += 1;
      return [row(100, '133'), { ...row(101, child), ppid: 100 }];
    };
    const killTree = async (pid: number) => {
      killed.push(pid);

      // Ending 100 with its tree ends 101 too, and another process takes pid 101.
      if (pid === 100) {
        child = 'unrelated';
      }

      return null;
    };

    expect(await runner({ processes, killTree }).stop({ sessionId: 'sb-1', shortId: null, lastTree: [{ pid: 100, created: '133' }, { pid: 101, created: '134' }] }, 'operator')).toBeNull();
    expect(killed).toEqual([100]);
    expect(reads).toBe(2);
  });

  it('reads the table again before each kill, so an independent leftover whose pid is reused during an earlier kill is spared', async () => {
    let first = true;
    let second = '134';
    const killed: number[] = [];
    const processes = async () => [...(first ? [{ ...row(100, '133'), ppid: 50 }] : []), { ...row(101, second), ppid: 50 }];
    const killTree = async (pid: number) => {
      killed.push(pid);
      first = false;
      second = '999';
      return null;
    };

    expect(await runner({ processes, killTree }).stop({ sessionId: 'sb-1', shortId: null, lastTree: [{ pid: 100, created: '133' }, { pid: 101, created: '134' }] }, 'operator')).toBeNull();
    expect(killed).toEqual([100]);
  });

  it('ignores a parent created after its child, as when a dead parent pid is reused under it, and ends the leftovers', async () => {
    let reads = 0;
    const killed: number[] = [];
    const processes = async () =>
      [
        { pid: 2000, ppid: 1000, created: '20', memoryBytes: 0 },
        { pid: 3000, ppid: 2000, created: '30', memoryBytes: 0 },
        { pid: 1000, ppid: 3000, created: '40', memoryBytes: 0 },
      ].filter((one) => (reads++, !killed.includes(2000) || one.pid === 1000));
    const killTree = async (pid: number) => {
      killed.push(pid);
      return null;
    };

    expect(await runner({ processes, killTree }).stop({ sessionId: 'sb-1', shortId: null, lastTree: [{ pid: 1000, created: '10' }, { pid: 2000, created: '20' }, { pid: 3000, created: '30' }] }, 'operator')).toBeNull();
    expect(killed).toEqual([2000]);
  });

  it('ends the earliest member when each has another above it, and stops after one round per member', async () => {
    let reads = 0;
    const killed: number[] = [];
    const processes = async () => {
      reads += 1;
      return [{ pid: 100, ppid: 101, created: '5', memoryBytes: 0 }, { pid: 101, ppid: 100, created: '5', memoryBytes: 0 }];
    };
    const killTree = async (pid: number) => {
      killed.push(pid);
      return { error: 'Access is denied.' };
    };

    expect(await runner({ processes, killTree }).stop({ sessionId: 'sb-1', shortId: null, lastTree: [{ pid: 100, created: '5' }, { pid: 101, created: '5' }] }, 'operator')).toEqual({ error: 'Processes 100, 101 could not be ended: Access is denied.' });
    expect(killed).toEqual([100, 101]);
    expect(reads).toBe(3);
  });

  it('ends a nested tree of leftovers with one kill of its topmost member and two reads of the table', async () => {
    const tree = Array.from({ length: 52 }, (_, index) => ({ pid: 100 + index, created: String(1000 + index) }));
    let alive = true;
    let reads = 0;
    const killed: number[] = [];
    const processes = async () => {
      reads += 1;
      return alive ? tree.map((member, index) => ({ pid: member.pid, ppid: index === 0 ? 1 : 100, created: member.created, memoryBytes: 0 })) : [];
    };
    const killTree = async (pid: number) => {
      killed.push(pid);
      alive = false;
      return null;
    };

    expect(await runner({ processes, killTree }).stop({ sessionId: 'sb-1', shortId: null, lastTree: tree }, 'operator')).toBeNull();
    expect(killed).toEqual([100]);
    expect(reads).toBe(2);
  });

  it('fails a leftover stop when the process table cannot be read', async () => {
    expect(await runner({ processes: async () => ({ error: 'Access is denied.' }) }).stop({ sessionId: 'sb-1', shortId: null, lastTree: TREE }, 'operator')).toEqual({ error: 'The process table could not be read: Access is denied.' });
  });
});

describe('transcriptLaunch (mechanics M117)', () => {
  const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
  const user = (permissionMode: string) => line({ parentUuid: null, type: 'user', message: { role: 'user', content: 'hi' }, permissionMode, sessionId: NATIVE });
  const assistant = (model: string) => line({ parentUuid: 'u', type: 'assistant', message: { model, role: 'assistant', content: [] }, sessionId: NATIVE });

  it('reads Code Mode from the last repl-mode line, and the last permission mode and model', () => {
    const text = [
      line({ type: 'mode', mode: 'normal', sessionId: NATIVE }),
      line({ type: 'repl-mode', replMode: true, sessionId: NATIVE }),
      line({ type: 'permission-mode', permissionMode: 'plan', sessionId: NATIVE }),
      user('plan'),
      assistant('claude-opus-5-5'),
      line({ type: 'permission-mode', permissionMode: 'auto', sessionId: NATIVE }),
      assistant('<synthetic>'),
      '',
    ].join('\n');

    expect(transcriptLaunch(text)).toEqual({ codeMode: true, permissionMode: 'auto', model: 'claude-opus-5-5' });
  });

  it("reads a VS Code panel session, which writes no repl-mode or permission-mode line, from its user lines, with Claude's older default as manual", () => {
    expect(transcriptLaunch([user('bypassPermissions'), assistant('claude-sonnet-5'), user('default'), assistant('claude-haiku-5-5')].join('\n'))).toEqual({ codeMode: false, permissionMode: 'manual', model: 'claude-haiku-5-5' });
  });

  it('records nothing it cannot read: an unknown mode, malformed lines and an empty transcript', () => {
    expect(transcriptLaunch([user('somethingNew'), '{"type":"repl-mode",', assistant('<synthetic>')].join('\n'))).toEqual({ codeMode: false, permissionMode: null, model: null });
    expect(transcriptLaunch('')).toEqual({ codeMode: false, permissionMode: null, model: null });
  });

  it('reads a transcript file, and none that is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchboard-transcript-'));

    try {
      writeFileSync(join(dir, 't.jsonl'), line({ type: 'repl-mode', replMode: true, sessionId: NATIVE }));
      expect(readTranscriptLaunch(join(dir, 't.jsonl'))).toEqual({ codeMode: true, permissionMode: null, model: null });
      expect(readTranscriptLaunch(join(dir, 'missing.jsonl'))).toBeNull();
      // Only the end is read for the mode and the model: a line before it, here the only one with the model, and one it cuts are not.
      const tail = `${line({ type: 'repl-mode', replMode: true, sessionId: NATIVE })}\n${line({ type: 'permission-mode', permissionMode: 'plan', sessionId: NATIVE })}`;
      writeFileSync(join(dir, 't.jsonl'), `${line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [] } })}\n${tail}`);
      expect(readTranscriptLaunch(join(dir, 't.jsonl'), tail.length + 1)).toEqual({ codeMode: true, permissionMode: 'plan', model: null });
      // Code Mode is found before the end, however far, as a turn can write more than the end after its last mode line.
      expect(readTranscriptLaunch(join(dir, 't.jsonl'), tail.length - 5)).toEqual({ codeMode: true, permissionMode: 'plan', model: null });
      writeFileSync(join(dir, 't.jsonl'), `${line({ type: 'repl-mode', replMode: true, sessionId: NATIVE })}\n${'x'.repeat(LAUNCH_TAIL_BYTES + 10)}\n${tail.split('\n')[1]}`);
      expect(readTranscriptLaunch(join(dir, 't.jsonl'))).toEqual({ codeMode: true, permissionMode: 'plan', model: null });
      writeFileSync(join(dir, 't.jsonl'), `${line({ type: 'mode', mode: 'normal' })}\n${'x'.repeat(LAUNCH_TAIL_BYTES + 10)}\n${tail.split('\n')[1]}`);
      expect(readTranscriptLaunch(join(dir, 't.jsonl'))).toEqual({ codeMode: false, permissionMode: 'plan', model: null });
      // A mode line in the tail decides, over an earlier one.
      writeFileSync(join(dir, 't.jsonl'), `${line({ type: 'repl-mode', replMode: true, sessionId: NATIVE })}\n${'x'.repeat(LAUNCH_TAIL_BYTES + 10)}\n${line({ type: 'repl-mode', replMode: false, sessionId: NATIVE })}`);
      expect(readTranscriptLaunch(join(dir, 't.jsonl'))).toMatchObject({ codeMode: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
