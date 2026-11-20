import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_COMMANDS, SessionCommands } from '../src/commands.js';
import { skillListing } from '../src/transcript.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conversation-commands-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A `skill_listing` attachment line as Claude Code 2.1.329 writes it (mechanics M88). */
const listing = (initial: boolean, skills: Array<[string, string]>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'attachment',
    uuid: 'x',
    attachment: { type: 'skill_listing', content: skills.map(([name, description]) => `- ${name}: ${description}`).join('\n'), skillCount: skills.length, isInitial: initial, names: skills.map(([name]) => name), ...extra },
  });

describe('skillListing', () => {
  it('reads the names in order with their descriptions, plugin names included, and whether it is the whole list', () => {
    expect(skillListing(listing(true, [['hello7', 'Say hello seven'], ['anthropic-skills:docx', 'Use this skill: for Word documents']]))).toEqual({
      initial: true,
      skills: [
        { name: 'hello7', description: 'Say hello seven' },
        { name: 'anthropic-skills:docx', description: 'Use this skill: for Word documents' },
      ],
    });
    expect(skillListing(listing(false, [['demo-video', 'Record a video']]))?.initial).toBe(false);
  });

  it('cuts a long description, gives none to a name the content does not describe, and drops a name that cannot be a command', () => {
    const line = JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content: `- long: ${'x'.repeat(400)}`, isInitial: true, names: ['long', 'bare', 'two words', 7] } });

    expect(skillListing(line)?.skills).toEqual([
      { name: 'long', description: 'x'.repeat(300) },
      { name: 'bare', description: '' },
    ]);
  });

  it('reads nothing from another line, another attachment or a broken one', () => {
    expect(skillListing(JSON.stringify({ type: 'user', message: { content: 'skill_listing' } }))).toBeNull();
    expect(skillListing(JSON.stringify({ type: 'attachment', attachment: { type: 'agent_listing_delta', content: '"skill_listing"' } }))).toBeNull();
    expect(skillListing('{"type":"attachment","attachment":{"type":"skill_listing"')).toBeNull();
  });
});

describe('SessionCommands', () => {
  it('lists the built-ins, then the skills of the whole listing and its later additions, reading only what was added since', () => {
    const path = join(dir, 'a.jsonl');
    const commands = new SessionCommands();

    writeFileSync(path, '');
    expect(commands.list(path)).toEqual(BUILT_IN_COMMANDS);
    expect(BUILT_IN_COMMANDS.map((command) => command.name)).toEqual(['clear', 'compact']);

    appendFileSync(path, `${listing(true, [['hello7', 'Say hello seven'], ['init', 'Initialize a new CLAUDE.md file']])}\n`);
    expect(commands.list(path).map((command) => command.name)).toEqual(['clear', 'compact', 'hello7', 'init']);

    // An addition updates a description in place and adds a skill at the end; a line still being written waits.
    appendFileSync(path, `${listing(false, [['hello7', 'Say hello, seven'], ['demo-video', 'Record a video']])}\n${listing(true, [['only', 'x']]).slice(0, 40)}`);
    expect(commands.list(path)).toEqual([...BUILT_IN_COMMANDS, { name: 'hello7', description: 'Say hello, seven' }, { name: 'init', description: 'Initialize a new CLAUDE.md file' }, { name: 'demo-video', description: 'Record a video' }]);

    // A new whole listing replaces the skills, and a built-in named as a skill is listed once.
    appendFileSync(path, `\n${listing(true, [['compact', 'Skill named as a built-in'], ['sb-plan', 'Plan']])}\n`);
    expect(commands.list(path).map((command) => command.name)).toEqual(['clear', 'compact', 'sb-plan']);
  });

  it('starts over for another transcript file, as after /clear, and lists only the built-ins without one', () => {
    const first = join(dir, 'a.jsonl');
    const second = join(dir, 'b.jsonl');
    const commands = new SessionCommands();

    writeFileSync(first, `${listing(true, [['hello7', 'Say hello seven']])}\n`);
    writeFileSync(second, '{"type":"user"}\n');
    expect(commands.list(first).map((command) => command.name)).toEqual(['clear', 'compact', 'hello7']);
    expect(commands.list(second).map((command) => command.name)).toEqual(['clear', 'compact']);
    expect(commands.list(null).map((command) => command.name)).toEqual(['clear', 'compact']);
    expect(commands.list(join(dir, 'missing.jsonl')).map((command) => command.name)).toEqual(['clear', 'compact']);
  });
});
