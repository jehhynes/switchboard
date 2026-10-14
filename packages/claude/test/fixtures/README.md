# Fork fixtures

`fork-<case>-original.jsonl` is a synthetic transcript in Claude's format, written by `fork-fixtures.mjs`, and `fork-<case>-copy.jsonl` the fork that the Claude VS Code extension 2.1.296's own `forkSession` and `getTranscript` wrote from its messages (mechanics M36). The generator passes the messages to those methods directly, so the extension's transcript loading and its Fork conversation UI are not part of the recording; live acceptance covers them.

```bash
node fork-fixtures.mjs ~/.vscode/extensions/anthropic.claude-code-2.1.296-win32-x64/extension.js
```

| Case | Fork |
|---|---|
| `plain` | Fork conversation on a session: the whole chain |
| `message` | Fork from the first assistant message |
| `compacted` | Fork conversation after a compaction boundary: the chain from the boundary, so its first `requestId` is not the original's first |

