import { releaseTag, releasedVersions, signingRefusal } from './firefox.mjs';

/**
 * @typedef {{ version: string, commit: string }} Signed
 * @typedef {{ tag: string, draft: boolean }} Release
 * @typedef {object} SignSteps The commands and files `signAndRelease` and `release` use, injected so tests need no network.
 * @property {Record<string, string | undefined>} env
 * @property {string} platform
 * @property {string} keysPath
 * @property {(path: string) => number | null} fileMode The file's mode bits, or null when it does not exist.
 * @property {(path: string) => void} loadEnvFile Adds the file's variables to `env`, keeping those already set.
 * @property {() => boolean} uncommitted
 * @property {() => string} head
 * @property {(commit: string) => boolean} onGitHub
 * @property {() => Release[]} releases Every release of the repository, drafts included.
 * @property {() => string} builtVersion The version in dist/manifest.json.
 * @property {() => string} tempDir
 * @property {(dir: string) => void} sign Signs dist/ into the folder; throws when addons.mozilla.org refuses.
 * @property {(dir: string) => string[]} files
 * @property {(from: string, to: string) => void} copy
 * @property {(dir: string) => void} remove
 * @property {string} signedFile Where the signed .xpi is kept, beside `signedRecord`.
 * @property {(signed: Signed) => void} writeRecord
 * @property {() => void} deleteRecord
 * @property {() => Signed | null} readRecord
 * @property {(tag: string) => void} deleteRelease
 * @property {(release: { tag: string, file: string, commit: string, title: string, notes: string }) => void} createRelease
 */

/**
 * Has addons.mozilla.org sign dist/ as an unlisted add-on, keeps the signed file, and releases it on GitHub, tagged at the commit it
 * was built from. Throws an Error whose message says what to do when it refuses or a step fails.
 * @param {SignSteps} steps
 * @returns {string} The success message.
 */
export function signAndRelease(steps) {
  const mode = steps.fileMode(steps.keysPath);

  if (mode !== null) {
    // Windows has no mode bits.
    if (steps.platform !== 'win32' && (mode & 0o077) !== 0) {
      throw new Error(`Other users can read ${steps.keysPath}. Run: chmod 600 ${steps.keysPath}`);
    }

    steps.loadEnvFile(steps.keysPath);
  }

  if (!steps.env.WEB_EXT_API_KEY || !steps.env.WEB_EXT_API_SECRET) {
    throw new Error(`Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET, your addons.mozilla.org JWT issuer and secret, in ${steps.keysPath} or the environment.`);
  }

  if (steps.uncommitted()) {
    throw new Error('The checkout has uncommitted changes. Commit them first, so the release names the commit it was built from.');
  }

  const commit = steps.head();

  if (!steps.onGitHub(commit)) {
    throw new Error(`GitHub does not have commit ${commit.slice(0, 12)}. Push it first, so the release can be tagged there.`);
  }

  const releases = steps.releases();
  const pending = steps.readRecord();

  // Signing again would replace the only copy of a version that is signed but not released.
  if (pending !== null && !releases.some((candidate) => candidate.tag === releaseTag(pending.version) && !candidate.draft)) {
    throw new Error(`Version ${pending.version} is signed but not released. Release it first: npm run release --workspace @switchboard/firefox`);
  }

  const version = steps.builtVersion();
  const refusal = signingRefusal(version, releasedVersions(releases.map((release) => release.tag)));

  if (refusal !== null) {
    throw new Error(refusal);
  }

  const dir = steps.tempDir();

  try {
    steps.sign(dir);
  } catch {
    steps.remove(dir);
    throw new Error('web-ext could not sign the add-on; its output above says why.');
  }

  // web-ext saves the signed file as <add-on slug>-<version>.xpi.
  const name = steps.files(dir).find((file) => file.endsWith(`-${version}.xpi`));

  if (name === undefined) {
    throw new Error(`web-ext reported success but saved no .xpi for version ${version} in ${dir}.`);
  }

  // addons.mozilla.org will not sign this version again, so the signed file is kept until it has a lasting copy. The old record goes
  // first, so a failure cannot leave it describing the new file.
  try {
    steps.deleteRecord();
    steps.copy(`${dir}/${name}`, steps.signedFile);
    steps.writeRecord({ version, commit });
  } catch (error) {
    throw new Error(`Version ${version} is signed in ${dir}/${name}, but it could not be kept as ${steps.signedFile}: ${error instanceof Error ? error.message : error}`);
  }

  steps.remove(dir);
  return release(steps);
}

/**
 * Releases the kept signed file on GitHub, replacing a draft that a failed release left. Throws when there is nothing to release
 * or the release fails.
 * @param {SignSteps} steps
 * @returns {string} The success message.
 */
export function release(steps) {
  const signed = steps.readRecord();

  if (signed === null) {
    throw new Error(`${steps.signedFile} has no record of its version. Sign it with npm run sign --workspace @switchboard/firefox.`);
  }

  const tag = releaseTag(signed.version);
  const existing = steps.releases().find((candidate) => candidate.tag === tag);

  if (existing !== undefined && !existing.draft) {
    return `Version ${signed.version} is already released as ${tag}.`;
  }

  try {
    if (existing !== undefined) {
      steps.deleteRelease(tag);
    }

    steps.createRelease({
      tag,
      file: steps.signedFile,
      commit: signed.commit,
      title: `Firefox extension ${signed.version}`,
      notes: `Signed by addons.mozilla.org as an unlisted add-on, built from ${signed.commit}.`,
    });
  } catch {
    throw new Error(`Version ${signed.version} is signed in ${steps.signedFile}, but the release failed; gh's output above says why. To try again, run: npm run release --workspace @switchboard/firefox`);
  }

  return `Signed version ${signed.version}: ${steps.signedFile}, released as ${tag}.`;
}
