import { describe, expect, it } from 'vitest';
import { release, signAndRelease } from '../src/release.mjs';
import type { Release, SignSteps, Signed } from '../src/release.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const VERSION = '0.0.1.441400';

/** Steps that sign and release successfully, recording each call, with `change` overriding any of them. */
function fake(change: Partial<SignSteps> & { releasesList?: Release[]; recordAtStart?: Signed } = {}) {
  const calls: string[] = [];
  let record: Signed | null = change.recordAtStart ?? null;
  const env: Record<string, string | undefined> = { WEB_EXT_API_KEY: 'user:1', WEB_EXT_API_SECRET: 'secret' };
  const steps: SignSteps = {
    env,
    platform: 'linux',
    keysPath: '/home/op/.switchboard/amo.env',
    fileMode: () => null,
    loadEnvFile: (path) => void calls.push(`load ${path}`),
    uncommitted: () => false,
    head: () => COMMIT,
    onGitHub: () => true,
    releases: () => change.releasesList ?? [],
    builtVersion: () => VERSION,
    tempDir: () => '/tmp/sign-1',
    sign: (dir) => void calls.push(`sign ${dir}`),
    files: () => ['2170cace57234e8a8e3f-0.0.1.441399.xpi', `2170cace57234e8a8e3f-${VERSION}.xpi`],
    copy: (from, to) => void calls.push(`copy ${from} ${to}`),
    remove: (dir) => void calls.push(`remove ${dir}`),
    signedFile: '/repo/extensions/firefox/switchboard-firefox-signed.xpi',
    writeRecord: (signed) => {
      record = signed;
      calls.push(`record ${signed.version} ${signed.commit}`);
    },
    deleteRecord: () => {
      record = null;
      calls.push('forget');
    },
    readRecord: () => record,
    deleteRelease: (tag) => void calls.push(`delete ${tag}`),
    createRelease: ({ tag, file, commit, title, notes }) => void calls.push(`release ${tag} ${file} ${commit} | ${title} | ${notes}`),
    ...change,
  };

  return { steps, calls, env };
}

describe('signAndRelease', () => {
  it('signs, keeps the signed file with its record, removes the temporary folder and releases at the commit', () => {
    const { steps, calls } = fake();

    expect(signAndRelease(steps)).toBe(`Signed version ${VERSION}: /repo/extensions/firefox/switchboard-firefox-signed.xpi, released as firefox-v${VERSION}.`);
    expect(calls).toEqual([
      'sign /tmp/sign-1',
      'forget',
      `copy /tmp/sign-1/2170cace57234e8a8e3f-${VERSION}.xpi /repo/extensions/firefox/switchboard-firefox-signed.xpi`,
      `record ${VERSION} ${COMMIT}`,
      'remove /tmp/sign-1',
      `release firefox-v${VERSION} /repo/extensions/firefox/switchboard-firefox-signed.xpi ${COMMIT} | Firefox extension ${VERSION} | Signed by addons.mozilla.org as an unlisted add-on, built from ${COMMIT}.`,
    ]);
  });

  it('loads a private keys file and refuses one other users can read, except on Windows', () => {
    const loaded = fake({ fileMode: () => 0o100600 });

    signAndRelease(loaded.steps);
    expect(loaded.calls[0]).toBe('load /home/op/.switchboard/amo.env');

    const open = fake({ fileMode: () => 0o100644 });

    expect(() => signAndRelease(open.steps)).toThrow('Other users can read /home/op/.switchboard/amo.env. Run: chmod 600 /home/op/.switchboard/amo.env');
    expect(open.calls).toEqual([]);

    const windows = fake({ fileMode: () => 0o100666, platform: 'win32' });

    signAndRelease(windows.steps);
    expect(windows.calls[0]).toBe('load /home/op/.switchboard/amo.env');
  });

  it('refuses without keys, with uncommitted changes, an unpushed commit, or a version already released, before signing', () => {
    const noKeys = fake();

    noKeys.env.WEB_EXT_API_SECRET = '';
    expect(() => signAndRelease(noKeys.steps)).toThrow('Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET');

    const dirty = fake({ uncommitted: () => true });

    expect(() => signAndRelease(dirty.steps)).toThrow('The checkout has uncommitted changes.');

    const unpushed = fake({ onGitHub: () => false });

    expect(() => signAndRelease(unpushed.steps)).toThrow('GitHub does not have commit 0123456789ab. Push it first');

    const same = fake({ releasesList: [{ tag: `firefox-v${VERSION}`, draft: true }] });

    expect(() => signAndRelease(same.steps)).toThrow(`Version ${VERSION} is already signed.`);

    const lower = fake({ releasesList: [{ tag: 'firefox-v0.0.1.441401', draft: false }, { tag: 'v9', draft: false }] });

    expect(() => signAndRelease(lower.steps)).toThrow('lower than the signed version 0.0.1.441401');

    for (const { calls } of [noKeys, dirty, unpushed, same, lower]) {
      expect(calls).toEqual([]);
    }
  });

  it('removes the temporary folder when signing fails, and keeps it when the signed file cannot be copied or is missing', () => {
    const refused = fake({
      sign: () => {
        throw new Error('AMO refused');
      },
    });

    expect(() => signAndRelease(refused.steps)).toThrow('web-ext could not sign the add-on');
    expect(refused.calls).toEqual(['remove /tmp/sign-1']);

    const readOnly = fake({
      copy: () => {
        throw new Error('EACCES: permission denied');
      },
    });

    expect(() => signAndRelease(readOnly.steps)).toThrow(
      `Version ${VERSION} is signed in /tmp/sign-1/2170cace57234e8a8e3f-${VERSION}.xpi, but it could not be kept as /repo/extensions/firefox/switchboard-firefox-signed.xpi: EACCES: permission denied`,
    );
    expect(readOnly.calls).toEqual(['sign /tmp/sign-1', 'forget']);

    const missing = fake({ files: () => ['other-0.0.1.1.xpi'] });

    expect(() => signAndRelease(missing.steps)).toThrow(`saved no .xpi for version ${VERSION} in /tmp/sign-1`);
    expect(missing.calls).toEqual(['sign /tmp/sign-1']);
  });

  it('leaves no record of an older version when the new record cannot be written', () => {
    const { steps, calls } = fake({
      recordAtStart: { version: '0.0.1.441300', commit: 'old' },
      releasesList: [{ tag: 'firefox-v0.0.1.441300', draft: false }],
      writeRecord: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });

    expect(() => signAndRelease(steps)).toThrow(`Version ${VERSION} is signed in /tmp/sign-1/2170cace57234e8a8e3f-${VERSION}.xpi, but it could not be kept`);
    expect(steps.readRecord()).toBeNull();
    expect(calls).not.toContain('remove /tmp/sign-1');
    expect(() => release(steps)).toThrow('has no record of its version');
  });

  it('refuses to sign while a signed version is not released, and signs once it is', () => {
    const waiting = { version: '0.0.1.441300', commit: 'old' };
    const pending = fake({ recordAtStart: waiting, releasesList: [{ tag: 'firefox-v0.0.1.441300', draft: true }] });

    expect(() => signAndRelease(pending.steps)).toThrow('Version 0.0.1.441300 is signed but not released. Release it first: npm run release --workspace @switchboard/firefox');
    expect(pending.calls).toEqual([]);

    const released = fake({ recordAtStart: waiting, releasesList: [{ tag: 'firefox-v0.0.1.441300', draft: false }] });

    expect(signAndRelease(released.steps)).toContain(`released as firefox-v${VERSION}`);
    expect(released.steps.readRecord()).toEqual({ version: VERSION, commit: COMMIT });
  });

  it('keeps the signed file and its record when the release fails, so npm run release can finish it', () => {
    const failed = fake({
      createRelease: () => {
        throw new Error('network');
      },
    });

    expect(() => signAndRelease(failed.steps)).toThrow(`Version ${VERSION} is signed in /repo/extensions/firefox/switchboard-firefox-signed.xpi, but the release failed; gh's output above says why. To try again, run: npm run release --workspace @switchboard/firefox`);
    expect(failed.calls).toContain(`record ${VERSION} ${COMMIT}`);
    expect(failed.steps.readRecord()).toEqual({ version: VERSION, commit: COMMIT });
  });
});

describe('release', () => {
  const recorded = (change: Partial<SignSteps> & { releasesList?: Release[] } = {}) => fake({ recordAtStart: { version: VERSION, commit: COMMIT }, ...change });

  it('releases the recorded version at its commit, replacing a draft a failed release left', () => {
    const fresh = recorded();

    expect(release(fresh.steps)).toBe(`Signed version ${VERSION}: /repo/extensions/firefox/switchboard-firefox-signed.xpi, released as firefox-v${VERSION}.`);
    expect(fresh.calls).toEqual([`release firefox-v${VERSION} /repo/extensions/firefox/switchboard-firefox-signed.xpi ${COMMIT} | Firefox extension ${VERSION} | Signed by addons.mozilla.org as an unlisted add-on, built from ${COMMIT}.`]);

    const draft = recorded({ releasesList: [{ tag: `firefox-v${VERSION}`, draft: true }] });

    release(draft.steps);
    expect(draft.calls.map((call) => call.split(' ').slice(0, 2).join(' '))).toEqual([`delete firefox-v${VERSION}`, `release firefox-v${VERSION}`]);
  });

  it('does nothing for a version already released, and refuses with no record or when gh fails', () => {
    const done = recorded({ releasesList: [{ tag: `firefox-v${VERSION}`, draft: false }] });

    expect(release(done.steps)).toBe(`Version ${VERSION} is already released as firefox-v${VERSION}.`);
    expect(done.calls).toEqual([]);

    expect(() => release(fake().steps)).toThrow('/repo/extensions/firefox/switchboard-firefox-signed.xpi has no record of its version. Sign it with npm run sign');

    const failing = recorded({
      releasesList: [{ tag: `firefox-v${VERSION}`, draft: true }],
      deleteRelease: () => {
        throw new Error('network');
      },
    });

    expect(() => release(failing.steps)).toThrow('To try again, run: npm run release --workspace @switchboard/firefox');
  });
});
