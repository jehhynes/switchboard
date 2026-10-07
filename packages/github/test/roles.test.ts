import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRoles, readRolesFile } from '../src/roles.js';

describe('parseRoles', () => {
  it('reads roles by lowercased login and leaves out entries without a roles list', () => {
    const text = JSON.stringify({ QaTester: { name: 'Quinn', roles: ['tester'] }, devlead: { name: 'Dana', roles: ['dev', 'pm'] }, nobody: { name: 'N' }, empty: { roles: [] }, bad: { roles: [1] }, nil: null });

    expect(parseRoles(text)).toEqual({ roles: new Map([['qatester', ['tester']], ['devlead', ['dev', 'pm']]]) });
  });

  it.each([
    ['{', 'is not JSON'],
    ['[]', 'is not an object of logins'],
    ['null', 'is not an object of logins'],
  ])('rejects %s', (text, error) => {
    expect(parseRoles(text)).toEqual({ error });
  });
});

describe('readRolesFile', () => {
  let dir = '';

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a file under the profile through ~, and names the file when it fails', async () => {
    dir = mkdtempSync(join(tmpdir(), 'roles-'));
    mkdirSync(join(dir, 'gc'));
    writeFileSync(join(dir, 'gc', 'roster.json'), '{"QaTester": {"roles": ["tester"]}}');
    writeFileSync(join(dir, 'bad.json'), '{');

    expect(await readRolesFile('~/gc/roster.json', dir)).toEqual({ roles: new Map([['qatester', ['tester']]]) });
    expect(await readRolesFile(join(dir, 'missing.json'), dir)).toEqual({ error: `Roles file ${join(dir, 'missing.json')} could not be read: ENOENT.` });
    expect(await readRolesFile(join(dir, 'bad.json'), dir)).toEqual({ error: `Roles file ${join(dir, 'bad.json')} is not JSON.` });
  });
});
