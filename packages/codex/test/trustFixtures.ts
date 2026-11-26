export const OURS = new Set(['node "C:/h/codex-hook.mjs"', 'node "C:/h/contract.mjs"']);
/** The edit for LISTED: Switchboard's untrusted and modified hooks. */
export const EDIT = { 'C:\\c\\hooks.json:stop:1:0': { trusted_hash: 'sha256:a' }, 'C:\\c\\hooks.json:session_start:1:0': { trusted_hash: 'sha256:c' } };

/** A `hooks/list` result as Codex 0.160 gives it (mechanics M31). */
export const LISTED = {
  data: [
    {
      hooks: [
        { key: 'C:\\c\\hooks.json:stop:0:0', command: 'node other.js', trustStatus: 'untrusted', currentHash: 'sha256:other' },
        { key: 'C:\\c\\hooks.json:stop:1:0', command: 'node "C:/h/codex-hook.mjs"', trustStatus: 'untrusted', currentHash: 'sha256:a' },
        { key: 'C:\\c\\hooks.json:session_start:0:0', command: 'node "C:/h/codex-hook.mjs"', trustStatus: 'trusted', currentHash: 'sha256:b' },
        { key: 'C:\\c\\hooks.json:session_start:1:0', command: 'node "C:/h/contract.mjs"', trustStatus: 'modified', currentHash: 'sha256:c' },
        { key: 'C:\\c\\hooks.json:stop:2:0', command: 'node "C:/h/codex-hook.mjs"', trustStatus: 'untrusted' },
      ],
    },
  ],
};
