import { AppServer, object } from './appServer.js';
import type { Json } from './appServer.js';
import { items } from './appServerRunner.js';
import type { CodexDebriefRange } from './debrief.js';

/** A range of durable Codex turn items, including paginated threads with no rollout file. */
export function appServerDebriefRange(turns: Json[], afterId: string | null): { range: CodexDebriefRange; writtenAt: number } | null {
  const after = afterId === null ? -1 : turns.findIndex(turn => turn['id'] === afterId);
  const remaining = turns.slice(after + 1);
  const last = remaining.map(turn => turn['status'] === 'completed').lastIndexOf(true);
  if (last === -1) return null;
  const covered = remaining.slice(0, last + 1);
  const tail = covered.at(-1)!;
  if (typeof tail['id'] !== 'string' || typeof tail['completedAt'] !== 'number') return null;
  const prompt = after === -1 ? null : items(covered[0]!).find(item => item['type'] === 'userMessage');
  const content = prompt !== null && Array.isArray(prompt?.['content']) ? prompt['content'].map(object).filter(c => c['type'] === 'text').map(c => String(c['text'] ?? '')).join('\n') : null;
  const tools = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageGeneration']);
  return { writtenAt: tail['completedAt'] * 1_000, range: { throughTurnId: tail['id'], toolCalls: covered.reduce((n, turn) => n + items(turn).filter(item => tools.has(String(item['type']))).length, 0), fromPrompt: content === null ? null : content.replace(/\s+/g, ' ').trim().slice(0, 200) } };
}

/** An ephemeral, read-only app-server fork; its events never belong to a work item's conversation. */
export async function runAppServerDebrief(server: AppServer, threadId: string, prompt: string, timeoutMs: number): Promise<{ text: string } | { error: string }> {
  let forkId: string | null = null;
  let turnId: string | null = null;
  let unlisten = (): void => {};
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await server.request('thread/fork', { threadId, ephemeral: true, excludeTurns: true, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', developerInstructions: 'This is a read-only debrief. Do not send Switchboard reports. Return the requested JSON.' });
    const id = object(result['thread'])['id'];
    if (typeof id !== 'string') throw new Error('Codex returned no debrief thread ID.');
    forkId = id;
    const finished = new Promise<{ text: string } | { error: string }>(resolve => {
      let text = '';
      timer = setTimeout(() => resolve({ error: 'The Codex debrief timed out.' }), timeoutMs);
      unlisten = server.listen(event => {
        const params = object(event['params']);
        if (params['threadId'] !== id) return;
        if (event['method'] === 'turn/started' && typeof object(params['turn'])['id'] === 'string') turnId = String(object(params['turn'])['id']);
        const item = object(params['item']);
        if (event['method'] === 'item/completed' && item['type'] === 'agentMessage' && typeof item['text'] === 'string') text = item['text'];
        if (event['method'] === 'turn/completed') resolve(object(params['turn'])['status'] === 'completed' ? { text } : { error: String(object(object(params['turn'])['error'])['message'] ?? 'The Codex debrief failed.') });
      });
    });
    const started = await server.request('turn/start', { threadId: id, input: [{ type: 'text', text: prompt }] });
    turnId = String(object(started['turn'])['id'] ?? turnId ?? '');
    return await finished;
  } catch (error) { return { error: String(error) }; }
  finally {
    clearTimeout(timer); unlisten();
    if (forkId !== null) {
      if (turnId !== null && turnId !== '') await server.request('turn/interrupt', { threadId: forkId, turnId }).catch(() => {});
      await server.request('thread/unsubscribe', { threadId: forkId }).catch(() => {});
    }
  }
}
