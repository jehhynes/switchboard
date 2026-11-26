import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppServer, AppServerError, object, writeSocket } from '../src/appServer.js';
import type WebSocket from 'ws';
import type { Json } from '../src/appServer.js';
import { AppServerRunner, permissionOptions, threadState } from '../src/appServerRunner.js';
import type { Session, StartAction } from '@switchboard/core';
import { PERMISSION_PROMPT } from '@switchboard/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function peer(handler: (method: string, params: Json) => unknown = () => ({})) {
  let emit = (_message: Json): void => {};
  let disconnect = (_error: string): void => {};
  const sent: Json[] = [];
  const close = vi.fn();
  const connect = vi.fn(async (receive: (message: Json) => void, closed: (error: string) => void) => {
    emit = receive; disconnect = closed;
    return { close, send(message: Json) {
      sent.push(message);
      if (message['id'] === undefined || message['method'] === undefined) return;
      const method = String(message['method']);
      let result: unknown;
      try { result = method === 'initialize' ? {} : handler(method, object(message['params'])); }
      catch (error) { queueMicrotask(() => receive({ id: message['id'], error: { message: String(error) } })); return; }
      if (result !== undefined) void Promise.resolve(result).then(value => receive({ id: message['id'], result: value }));
    } };
  });
  const server = new AppServer({ codexPath: () => 'unused', codexHome: '/test', env: {}, log: () => {}, connect, timeoutMs: 40 });
  cleanup.push(() => server.close());
  return { server, connect, close, sent, emit: (message: Json) => emit(message), disconnect: () => disconnect('connection lost') };
}

describe('Codex app-server connection', () => {
  it('accepts a null write callback and distinguishes a closed socket from an unknown write failure', async () => {
    const send = vi.fn((_text: unknown, callback: (error: Error | null) => void) => callback(null));
    await expect(writeSocket({readyState:1,send} as unknown as Pick<WebSocket,'readyState'|'send'>,{id:1})).resolves.toBeUndefined();
    await expect(writeSocket({readyState:3,send} as unknown as Pick<WebSocket,'readyState'|'send'>,{id:2})).rejects.toMatchObject({refused:false,notSent:true});
    expect(send).toHaveBeenCalledTimes(1);
    send.mockImplementationOnce((_text,callback)=>callback(new Error('write failed')));
    await expect(writeSocket({readyState:1,send} as unknown as Pick<WebSocket,'readyState'|'send'>,{id:3})).rejects.toThrow('write failed');
  });
  it('initializes once before concurrent calls, delivers events and responds to server requests', async () => {
    const p = peer(() => ({ value: 1 }));
    const event = vi.fn(); const unlisten = p.server.listen(event);
    expect(await Promise.all([p.server.request('one'), p.server.request('two')])).toEqual([{ value: 1 }, { value: 1 }]);
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(p.sent.map(m => m['method'])).toEqual(['initialize', 'initialized', 'one', 'two']);
    p.emit({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
    expect(event).toHaveBeenCalledWith({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
    await p.server.respond(0, { decision: 'decline' });
    expect(p.sent.at(-1)).toEqual({ id: 0, result: { decision: 'decline' } });
    unlisten(); p.emit({ method: 'ignored' }); expect(event).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a refusal from lost delivery, rejects pending calls and reconnects without replaying them', async () => {
    const p = peer(method => { if (method === 'refuse') throw new Error('denied'); return undefined; });
    await expect(p.server.request('refuse')).rejects.toMatchObject({ refused: true, message: 'Error: denied' });
    const waiting = p.server.request('send');
    const rejected = expect(waiting).rejects.toMatchObject({ refused: false, message: 'connection lost' });
    await vi.waitFor(() => expect(p.sent.at(-1)?.['method']).toBe('send'), { interval: 1 });
    p.disconnect();
    await rejected;
    await expect(p.server.respond(1, {})).rejects.toThrow('disconnected');
    await expect(p.server.request('timeout')).rejects.toThrow('outcome is unknown');
    expect(p.connect).toHaveBeenCalledTimes(2);
    expect(p.sent.filter(m => m['method'] === 'send')).toHaveLength(1);
    p.server.close(); await expect(p.server.request('closed')).rejects.toThrow('has closed');
  });

  it('ignores responses from a retired connection and unknown IDs', async () => {
    const p = peer(); await p.server.request('one');
    p.emit({ id: 999, result: {} }); p.emit({ id: 'foreign', result: {} });
    p.disconnect(); await p.server.request('two');
    expect(p.connect).toHaveBeenCalledTimes(2);
    expect(object(null)).toEqual({}); expect(object([])).toEqual({}); expect(object({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('Codex app-server runner', () => {
  function setup(handler?: (method: string, params: Json) => unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'sb-appserver-')); cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
    const session = { id: 's1', nativeSessionId: null, state: 'starting', execution: 'app-server', released: false, cwd: dir, workItemId: 1 } as Session;
    const state = vi.fn();
    const limitFound = vi.fn();
    const p = peer(handler ?? ((method) => method === 'thread/start' ? { thread: { id: 'thread-1' } } : method === 'thread/turns/list' ? { data: [] } : { thread: { id: 'thread-1', status: { type: 'idle' } } }));
    const runner = new AppServerRunner({ server: p.server, session: () => session, sessions: () => [session], created: (_id, native) => { session.nativeSessionId = native; }, instructions: () => 'contract and rules', instructionsDelivered: (_id, hash, compactionId) => { session.instructionsHash = hash; session.instructionsCompactionId = compactionId; }, state, limitFound, now: () => 1 });
    const action = { sessionId: 's1', cwd: dir, workItemId: 1, permissionMode: 'plan', model: null, prompt: 'hello', name: 'task', contract: 'contract' } as StartAction;
    return { ...p, runner, session, state, limitFound, action };
  }

  it('starts a persistent thread with its contract, model and per-thread permissions, then sends the first prompt once', async () => {
    const p = setup();
    expect(await p.runner.start({ ...p.action, model: 'test-model', prompt: '/skill 12' })).toEqual({ nativeSessionId: 'thread-1', shortId: 'thread-1' });
    expect(p.session.nativeSessionId).toBe('thread-1');
    expect(p.sent.find(m => m['method'] === 'thread/start')?.['params']).toMatchObject({ cwd: p.action.cwd, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', model: 'test-model', developerInstructions: 'contract and rules' });
    expect(p.sent.find(m => m['method'] === 'turn/start')?.['params']).toEqual({ threadId: 'thread-1', clientUserMessageId: 'sb-start-s1', input: [{ type: 'text', text: '$skill 12' }] });
    expect(await p.runner.isBackground()).toBe(true); expect(await p.runner.installHooks()).toBeNull(); expect(p.runner.markers([]).size).toBe(0);
  });

  it('leaves a promptless thread idle and refuses unsupported modes', async () => {
    const p = setup();
    expect(await p.runner.start({ ...p.action, permissionMode: 'manual' })).toEqual({ error: 'Codex cannot use permission mode manual.' });
    expect(await p.runner.start({ ...p.action, prompt: '' })).toEqual({ nativeSessionId: 'thread-1', shortId: 'thread-1' });
    expect(p.sent.some(m => m['method'] === 'turn/start')).toBe(false);
  });

  it('observes native turn and request state, ignoring unrelated threads and hook markers', async () => {
    const p = setup(); await p.runner.start(p.action); p.session.state = 'running';
    p.emit({ method: 'turn/started', params: { threadId: 'other' } }); expect(p.state).not.toHaveBeenCalled();
    p.emit({ method: 'turn/started', params: { threadId: 'thread-1' } });
    p.emit({ method: 'item/commandExecution/requestApproval', id: 0, params: { threadId: 'thread-1' } });
    expect(p.state).toHaveBeenLastCalledWith('s1', 'waiting', PERMISSION_PROMPT);
    p.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'failed', error: { message: 'broken' } } } });
    p.emit({ method: 'thread/status/changed', params: { threadId: 'thread-1', status: { type: 'idle' } } });
    expect(await p.runner.observe([p.session])).toEqual({ sessions: [{ sessionId: 's1', state: 'failed', detail: 'broken' }] });
  });

  it('reads a usage or rate limit from a failed turn, with the reset of a full window from a rate-limit update (mechanics M100)', async () => {
    const p = setup(); await p.runner.start(p.action); p.session.state = 'running';
    p.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: 7_200, windowDurationMins: 300 }, secondary: { usedPercent: 40, resetsAt: 900_000 } } } });
    p.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'failed', error: { message: "You've hit your usage limit. Try again later.", codexErrorInfo: 'usageLimitExceeded' } } } });
    expect(p.state).toHaveBeenLastCalledWith('s1', 'failed', 'rate_limit', { kind: 'usage', window: null, resetsAt: 7_200_000, exact: true, cli: false, message: "You've hit your usage limit. Try again later." });

    p.emit({ method: 'turn/started', params: { threadId: 'thread-1' } });
    p.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 20, resetsAt: 7_200 } } } });
    p.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'failed', error: { message: 'Slow down.', codexErrorInfo: 'rateLimitExceeded' } } } });
    expect(p.state).toHaveBeenLastCalledWith('s1', 'failed', 'rate_limit', { kind: 'throttle', window: null, resetsAt: null, exact: false, cli: false, message: 'Slow down.' });

    p.emit({ method: 'turn/started', params: { threadId: 'thread-1' } });
    p.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'failed', error: { message: 'Overloaded.', codexErrorInfo: 'serverOverloaded' } } } });
    expect(p.state).toHaveBeenLastCalledWith('s1', 'failed', 'Overloaded.');
  });

  it('keeps every rate-limit window for the context details, the default limit first and each shortest first, named by its limit otherwise', async () => {
    const p = setup(); await p.runner.start(p.action);
    expect(p.runner.usageWindows()).toEqual([]);
    p.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, resetsAt: 7_200, windowDurationMins: 300 }, secondary: { usedPercent: 40, resetsAt: 900_000, windowDurationMins: 10_080 } } } });
    p.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex_other', limitName: 'GPT-6 Mini', primary: { usedPercent: 3, resetsAt: null, windowDurationMins: null } } } });
    // A sparse update replaces only the window it names.
    p.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 20, resetsAt: 7_300, windowDurationMins: 300 } } } });
    expect(p.runner.usageWindows()).toEqual([
      { minutes: 300, limit: null, usedPercent: 20, resetsAt: 7_300_000 },
      { minutes: 10_080, limit: null, usedPercent: 40, resetsAt: 900_000_000 },
      { minutes: null, limit: 'GPT-6 Mini', usedPercent: 3, resetsAt: null },
    ]);
  });

  it('gives a usage limit read without a reset the reset of a rate-limit update that comes after the failed turn, and replays it on a read', async () => {
    const p = setup(); await p.runner.start(p.action); p.session.state = 'running';
    p.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'failed', error: { message: 'Usage limit.', codexErrorInfo: 'usageLimitExceeded' } } } });
    expect(p.state).toHaveBeenLastCalledWith('s1', 'failed', 'rate_limit', expect.objectContaining({ resetsAt: null }));
    p.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 100, resetsAt: 9_000 } } } });
    expect(p.limitFound).toHaveBeenCalledWith('s1', expect.objectContaining({ kind: 'usage', resetsAt: 9_000_000, exact: true }));
    p.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 100, resetsAt: 9_000 } } } });
    expect(p.limitFound).toHaveBeenCalledTimes(1);
    expect(await p.runner.observe([p.session])).toEqual({ sessions: [{ sessionId: 's1', state: 'failed', detail: 'rate_limit', limit: expect.objectContaining({ resetsAt: 9_000_000 }) }] });
  });

  it('interrupts only the named thread and unsubscribes, without stopping the daemon', async () => {
    const p = setup((method) => method === 'thread/read' ? { thread: { status: { type: 'active' } } } : method === 'thread/turns/list' ? { data: [{ id: 'turn-1', status: 'inProgress' }, { id: 'old', status: 'completed' }] } : {});
    expect(await p.runner.stop({ sessionId: 's1', shortId: 'thread-1' }, 'operator')).toBeNull();
    expect(p.sent.filter(m => m['method'] === 'turn/interrupt')).toEqual([{ id: 4, method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } }]);
    expect(p.sent.at(-1)?.['method']).toBe('thread/unsubscribe');
    expect(p.sent.some(m => /daemon|shutdown/.test(String(m['method'])))).toBe(false);
    expect(await p.runner.stop({ sessionId: 's1', shortId: null }, 'operator')).toBeNull();
  });

  it('reconciles a confirmed start, refuses to resend an unconfirmed first prompt, and waits on unavailable history', async () => {
    const p = setup(method => method === 'thread/turns/list' ? { data: [{ items: [{ type: 'userMessage', clientId: 'sb-start-s1' }] }] } : { thread: { status: { type: 'idle' } } });
    expect(await p.runner.reconcile([p.session])).toEqual([{ sessionId: 's1', failed: 'Switchboard stopped before Codex returned its thread ID.' }]);
    p.session.nativeSessionId = 'thread-1';
    expect(await p.runner.reconcile([p.session])).toEqual([{ sessionId: 's1', started: { shortId: 'thread-1', nativeSessionId: 'thread-1' } }]);
    const empty = setup(); empty.session.nativeSessionId = 'thread-2';
    expect((await empty.runner.reconcile([empty.session]))[0]).toHaveProperty('pending');
    empty.session.promptless = true; expect((await empty.runner.reconcile([empty.session]))[0]).toHaveProperty('started');
    const broken = setup(() => { throw new Error('unavailable'); }); broken.session.nativeSessionId = 'thread-3';
    expect((await broken.runner.reconcile([broken.session]))[0]).toHaveProperty('pending');
    expect(await broken.runner.observe([broken.session])).toEqual({ sessions: [{ sessionId:'s1', state:'failed', detail:'Error: unavailable' }] });
    expect(await broken.runner.stop({sessionId:'s1',shortId:'thread-3'},'operator')).toHaveProperty('error');
    expect(await broken.runner.start(broken.action)).toHaveProperty('error');
  });

  it('maps permission modes and thread waits without guessing liveness from elapsed time', () => {
    expect(permissionOptions('auto')).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' });
    expect(permissionOptions('bypassPermissions')).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' });
    expect(permissionOptions('dontAsk')).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'never' });
    expect(threadState({type:'systemError'})).toEqual({state:'failed',detail:'Codex reported a system error.'});
    expect(threadState({type:'active',activeFlags:['waitingOnApproval']})).toEqual({state:'waiting',detail:PERMISSION_PROMPT});
    expect(threadState({type:'active',activeFlags:['waitingOnUserInput']})).toEqual({state:'waiting',detail:null});
    expect(threadState({type:'active'})).toEqual({state:'running',detail:null});
  });

  it('keeps an unconfirmed initial send pending without ever submitting it twice', async () => {
    const p=setup(method=>method==='thread/start'?{thread:{id:'thread-1'}}:method==='turn/start'?undefined:method==='thread/turns/list'?{data:[]}:{thread:{status:{type:'idle'}}});
    expect(await p.runner.start(p.action)).toMatchObject({nativeSessionId:'thread-1',pending:expect.stringContaining('unconfirmed')});
    expect((await p.runner.reconcile([p.session]))[0]).toHaveProperty('pending');
    expect(p.sent.filter(m=>m['method']==='turn/start')).toHaveLength(1);
  });

  it('does not let an optional name or skill lookup prevent a safe first send', async () => {
    const p=setup(method=>{if(method==='thread/start')return {thread:{id:'thread-1'}};if(method==='thread/name/set'||method==='skills/list')throw new Error('optional lookup failed');return {};});
    expect(await p.runner.start({...p.action,prompt:'/skill work'})).toEqual({nativeSessionId:'thread-1',shortId:'thread-1'});
    expect(p.sent.filter(m=>m['method']==='turn/start')).toHaveLength(1);
  });

  it('cancels a release when another turn started and leaves it subscribed without interrupting', async () => {
    const p=setup(()=>({thread:{status:{type:'active'}}}));
    expect(await p.runner.stop({sessionId:'s1',shortId:'thread-1'},'release')).toMatchObject({cancelled:true});
    expect(p.sent.map(m=>m['method'])).toEqual(['initialize','initialized','thread/read']);
  });

  it('continues observing other threads when one was deleted, and skips historical ended threads', async () => {
    const p=setup((method,params)=>{if(params['threadId']==='missing')throw new Error('thread not found');return {thread:{status:{type:'active'}}};});
    p.session.nativeSessionId='missing';p.session.state='running';
    const good={...p.session,id:'s2',nativeSessionId:'thread-2'};
    const ended={...good,id:'s3',nativeSessionId:'historical',state:'ended' as const};
    expect(await p.runner.observe([p.session,good,ended])).toEqual({sessions:[{sessionId:'s2',state:'running',detail:null}]});
    expect(p.sent.some(m=>object(m['params'])['threadId']==='historical')).toBe(false);
  });

  it('rechecks the last turn after reconnect instead of keeping a failure from the previous connection', async () => {
    const p=setup(method=>method==='thread/start'?{thread:{id:'thread-1'}}:method==='thread/turns/list'?{data:[{id:'new',status:'completed'}]}:{thread:{status:{type:'idle'}}});
    await p.runner.start(p.action);p.session.state='running';
    p.emit({method:'turn/completed',params:{threadId:'thread-1',turn:{status:'failed',error:{message:'old failure'}}}});
    p.disconnect();expect(await p.runner.observe([p.session])).toEqual({sessions:[{sessionId:'s1',state:'idle',detail:null}]});
    const count=p.sent.filter(m=>m['method']==='thread/turns/list').length;
    await p.runner.observe([p.session]);expect(p.sent.filter(m=>m['method']==='thread/turns/list')).toHaveLength(count);
  });

  it('injects changed developer instructions once on a loaded thread and preserves the report contract', async () => {
    const p=setup();await p.runner.start(p.action);p.session.state='idle';
    p.runner.deps.currentInstructions=()=> 'Report to Switchboard with these commands: stage s1\nUpdated persona';
    p.disconnect();
    await Promise.all([p.runner.configure(p.session),p.runner.follow(p.session)]);
    const injections=p.sent.filter(m=>m['method']==='thread/inject_items');
    expect(injections).toHaveLength(1);
    expect(object(injections[0]!['params'])['items']).toEqual([{type:'message',role:'developer',content:[{type:'input_text',text:'Report to Switchboard with these commands: stage s1\nUpdated persona'}]}]);
    const restarted = new AppServerRunner(p.runner.deps);
    await restarted.follow(p.session);
    expect(p.sent.filter(m=>m['method']==='thread/inject_items')).toHaveLength(1);
    restarted.deps.currentInstructions=()=> 'Changed after restart';
    await restarted.configure(p.session);
    expect(p.sent.filter(m=>m['method']==='thread/inject_items')).toHaveLength(2);
  });

  it('resumes an ended thread with the start\'s folder, permissions, artifact folder and model, and its changed instructions once', async () => {
    const p=setup();await p.runner.start(p.action);p.session.state='ended';
    p.runner.deps.resumeOptions=()=>({permissionMode:'auto',model:'test-model'});
    p.runner.deps.currentInstructions=()=> 'contract and rules\n\nVoice rules';
    const configured=vi.fn();p.runner.deps.configured=configured;
    await p.runner.configure(p.session);
    const resume=p.sent.filter(m=>m['method']==='thread/resume');
    expect(resume).toHaveLength(1);
    expect(resume[0]!['params']).toMatchObject({threadId:'thread-1',excludeTurns:true,cwd:p.session.cwd,approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:'workspace-write',model:'test-model',config:{'sandbox_workspace_write.network_access':true,'shell_environment_policy.set.CLAUDE_ARTIFACTS_DIR':expect.stringContaining('1')}});
    expect(p.sent.filter(m=>m['method']==='thread/inject_items').map(m=>object(m['params'])['items'])).toEqual([[{type:'message',role:'developer',content:[{type:'input_text',text:'contract and rules\n\nVoice rules'}]}]]);
    expect(configured).toHaveBeenCalledWith(p.session);
    // Joined, so the next follow reads the thread instead of resuming it again.
    await p.runner.follow(p.session);
    expect(p.sent.filter(m=>m['method']==='thread/resume')).toHaveLength(1);
    // Unchanged instructions are not given again, and an unknown mode leaves the daemon's options alone.
    p.runner.deps.resumeOptions=()=>({permissionMode:'manual',model:null});
    await p.runner.configure(p.session);
    expect(p.sent.filter(m=>m['method']==='thread/resume').at(-1)!['params']).toEqual({threadId:'thread-1',excludeTurns:true});
    expect(p.sent.filter(m=>m['method']==='thread/inject_items')).toHaveLength(1);
    p.session.nativeSessionId=null;
    await expect(p.runner.configure(p.session)).rejects.toThrow('no thread ID');
  });

  it('leaves a resumed ended thread unjoined, so the next follow rejoins it and the daemon replays pending requests', async () => {
    const p=setup();await p.runner.start(p.action);p.session.state='ended';
    await p.runner.resumeThread(p.session);
    expect(p.sent.filter(m=>m['method']==='thread/resume')).toHaveLength(1);
    p.session.state='idle';
    await p.runner.follow(p.session);
    expect(p.sent.filter(m=>m['method']==='thread/resume')).toHaveLength(2);
    await p.runner.follow(p.session);
    expect(p.sent.filter(m=>m['method']==='thread/resume')).toHaveLength(2);
  });

  it('treats an unsent socket read as a connection failure without marking running sessions failed', async () => {
    const p=setup();await p.runner.start(p.action);p.session.state='running';
    vi.spyOn(p.server,'request').mockRejectedValueOnce(new AppServerError('socket closing',false,true));
    expect(await p.runner.observe([p.session])).toEqual({error:'Error: socket closing'});
    expect(p.state).not.toHaveBeenCalled();
  });

  it('restores instructions after compaction once and detects a compaction missed during disconnection', async () => {
    let compactionId='compact-1';
    const p=setup(method=>method==='thread/start'?{thread:{id:'thread-1'}}:method==='thread/turns/list'?{data:[{items:[{type:'contextCompaction',id:compactionId}]}]}:{thread:{status:{type:'idle'}}});
    await p.runner.start(p.action);p.session.state='idle';
    p.runner.deps.currentInstructions=()=> 'contract and rules';
    p.emit({method:'item/completed',params:{threadId:'thread-1',item:{type:'contextCompaction',id:compactionId}}});
    const firstHistory=await p.runner.history('thread-1');
    await p.runner.restoreInstructions(p.session,firstHistory);
    expect(p.sent.filter(m=>m['method']==='thread/inject_items')).toHaveLength(1);
    expect(p.session.instructionsCompactionId).toBe('compact-1');
    await p.runner.restoreInstructions(p.session,await p.runner.history('thread-1'));
    expect(p.sent.filter(m=>m['method']==='thread/inject_items')).toHaveLength(1);
    compactionId='compact-2';
    const restarted=new AppServerRunner(p.runner.deps);
    await restarted.restoreInstructions(p.session,await restarted.history('thread-1'));
    expect(p.sent.filter(m=>m['method']==='thread/inject_items')).toHaveLength(2);
    expect(p.session.instructionsCompactionId).toBe('compact-2');
    await restarted.restoreInstructions(p.session,firstHistory);
    expect(p.session.instructionsCompactionId).toBe('compact-2');
    expect(p.sent.filter(m=>m['method']==='thread/inject_items')).toHaveLength(2);
    p.session.state='ended';compactionId='compact-3';
    await restarted.restoreInstructions(p.session,await restarted.history('thread-1'));
    expect(p.sent.filter(m=>m['method']==='thread/inject_items')).toHaveLength(2);
  });

  it('keeps history and Stop independent of a failed instruction refresh, then retries on rejoin', async () => {
    const p=setup(method=>{
      if(method==='thread/start')return {thread:{id:'thread-1'}};
      if(method==='thread/turns/list')return {data:[{items:[{type:'contextCompaction',id:'compact-1'}]}]};
      if(method==='thread/inject_items')throw new Error('inject refused');
      return {thread:{status:{type:'idle'}}};
    });
    await p.runner.start(p.action);p.session.state='idle';p.runner.deps.currentInstructions=()=> 'contract and rules';
    const log=vi.fn();p.runner.deps.log=log;
    const history=await p.runner.history('thread-1');
    await expect(p.runner.restoreInstructions(p.session,history)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('inject refused'));
    await expect(p.runner.history('thread-1')).resolves.toEqual(history);
    expect(await p.runner.stop({sessionId:'s1',shortId:'thread-1'},'operator')).toBeNull();
    await expect(p.runner.follow(p.session)).rejects.toThrow('inject refused');
    expect(p.sent.some(m=>m['method']==='thread/resume')).toBe(true);
  });
});
