import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifierPrompt, classifierSchema, validateClassification } from '@switchboard/core';
import type { ClassifyInput, ClassifyResult, Exec } from '@switchboard/core';
import { modeArgs } from './args.js';
import { lastErrorLine, parseRunLog } from './log.js';

export interface CodexClassifyInput extends ClassifyInput {
  codexPath: string;
  env: Record<string, string>;
}

export async function classifyCodex(input: CodexClassifyInput, exec: Exec): Promise<ClassifyResult> {
  mkdirSync(input.cwd, { recursive: true });
  const dir = mkdtempSync(join(input.cwd, 'triage-'));

  try {
    const schemaPath = join(dir, 'schema.json');
    const outputPath = join(dir, 'answer.json');
    const schema = classifierSchema(input);
    // Codex's strict output schema requires every property to be required.
    schema.required = Object.keys(schema.properties);
    writeFileSync(schemaPath, JSON.stringify(schema));
    const result = await exec(input.codexPath, [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      ...modeArgs('plan'),
      '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
      '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'hooks',
      '--output-schema', schemaPath, '--output-last-message', outputPath,
      ...(input.model === null ? [] : ['--model', input.model]), '-',
    ], {
      cwd: dir,
      stdin: `${classifierPrompt(input.systemPrompt, input.focusIds.length > 0)}\n\n${input.context}`,
      env: input.env,
      timeoutMs: input.timeoutSeconds * 1000,
    });

    if (result.missing) {
      return { error: `${input.codexPath} was not found. Install Codex or set its path.` };
    }

    if (result.timedOut) {
      return { error: `Codex did not finish triage within ${input.timeoutSeconds} seconds.` };
    }

    const log = parseRunLog(result.stdout);

    if (log.end?.state === 'failed') {
      return { error: `Codex did not finish triage: ${log.end.message}` };
    }

    if (result.code !== 0 || log.end === null) {
      return { error: lastErrorLine(result.stderr) ?? `Codex did not finish triage (exit code ${String(result.code)}).` };
    }

    let value: unknown;

    try {
      value = JSON.parse(readFileSync(outputPath, 'utf8'));
    } catch {
      return { error: 'Codex returned no valid JSON triage result.' };
    }

    return validateClassification(value, input.choices, input.rates, input.focusIds, 'Codex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
