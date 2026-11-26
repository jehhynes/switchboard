import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appServerDebriefRange, runAppServerDebrief } from '../src/appServerDebrief.js';
import { AppServerRunner, codexInput, notMaterialized } from '../src/appServerRunner.js';
import { AppServerError } from '../src/appServer.js';
import type { AppServer, Json } from '../src/appServer.js';

const clean:Array<()=>void>=[];afterEach(()=>clean.splice(0).forEach(f=>f()));
describe('Codex structured inputs and debriefs',()=>{
  it('attaches existing image mentions once, including quoted paths, while keeping ordinary text and file mentions',()=>{
    const dir=mkdtempSync(join(tmpdir(),'sb-input-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));
    mkdirSync(join(dir,'with space'));writeFileSync(join(dir,'with space','image.png'),'image');writeFileSync(join(dir,'note.txt'),'note');
    const text='Look at @"with space/image.png" and @"with space/image.png" with @note.txt and @missing.png';
    expect(codexInput(text,dir)).toEqual([{type:'text',text},{type:'localImage',path:join(dir,'with space','image.png')}]);
    expect(codexInput('plain text',dir)).toEqual([{type:'text',text:'plain text'}]);
  });
  it('counts native tool items after the last debrief through the last completed turn, without rollout files',()=>{
    const turns=[{id:'old',status:'completed',completedAt:1,items:[{type:'commandExecution'}]},{id:'new',status:'completed',completedAt:2,items:[{type:'userMessage',content:[{type:'text',text:'Next work'}]},{type:'commandExecution'},{type:'mcpToolCall'},{type:'agentMessage',text:'Done'}]},{id:'working',status:'inProgress',items:[{type:'commandExecution'}]}];
    expect(appServerDebriefRange(turns,'old')).toEqual({writtenAt:2000,range:{throughTurnId:'new',toolCalls:2,fromPrompt:'Next work'}});
    expect(appServerDebriefRange(turns,null)).toMatchObject({range:{toolCalls:3,fromPrompt:null}});
    expect(appServerDebriefRange(turns,'new')).toBeNull();
    expect(appServerDebriefRange([{id:'bad',status:'completed'}],null)).toBeNull();
  });
  it('runs an ephemeral read-only fork, returns its final answer, and never unsubscribes or interrupts the parent',async()=>{
    let event=(_event:Json):void=>{};
    const request=vi.fn(async(method:string,params:Json)=>{
      if(method==='thread/fork')return {thread:{id:'fork-1'}};
      if(method==='turn/start'){
        queueMicrotask(()=>{event({method:'item/completed',params:{threadId:'parent',item:{type:'agentMessage',text:'ignore'}}});event({method:'item/completed',params:{threadId:'fork-1',item:{type:'agentMessage',text:'{"friction":[]}'}}});event({method:'turn/completed',params:{threadId:'fork-1',turn:{status:'completed'}}});});
        return {turn:{id:'fork-turn'}};
      }
      return {};
    });
    const unlisten=vi.fn();const server={request,listen:(listener:typeof event)=>{event=listener;return unlisten;}} as unknown as AppServer;
    expect(await runAppServerDebrief(server,'parent','Report friction',1000)).toEqual({text:'{"friction":[]}'});
    expect(request).toHaveBeenCalledWith('thread/fork',{threadId:'parent',ephemeral:true,excludeTurns:true,sandbox:'read-only',approvalPolicy:'never',approvalsReviewer:'user',developerInstructions:'This is a read-only debrief. Do not send Switchboard reports. Return the requested JSON.'});
    expect(request).toHaveBeenCalledWith('thread/unsubscribe',{threadId:'fork-1'});expect(unlisten).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter(([method,params])=>method==='turn/interrupt'&&params['threadId']==='parent')).toEqual([]);
  });
  it('reports a failed or timed-out fork and cleans it up',async()=>{
    let event=(_event:Json):void=>{};
    let complete=true;
    const server={listen:(listener:typeof event)=>{event=listener;return ()=>{};},request:vi.fn(async(method:string)=>{
      if(method==='thread/fork')return {thread:{id:'fork-1'}};
      if(method==='turn/start'){
        if(complete)queueMicrotask(()=>event({method:'turn/completed',params:{threadId:'fork-1',turn:{status:'failed',error:{message:'failure'}}}}));
        return {turn:{id:'turn-1'}};
      }return {};
    })} as unknown as AppServer;
    expect(await runAppServerDebrief(server,'parent','prompt',20)).toEqual({error:'failure'});
    complete=false;expect(await runAppServerDebrief(server,'parent','prompt',20)).toEqual({error:'The Codex debrief timed out.'});
    const broken={request:async()=>{throw new Error('unavailable');}} as unknown as AppServer;
    expect(await runAppServerDebrief(broken,'parent','prompt',20)).toEqual({error:'Error: unavailable'});
  });
});

describe('whether a thread has a turn (mechanics M108)', () => {
  function runner(answer: (params: Json) => Json) {
    const request = vi.fn(async (_method: string, params: Json) => answer(params));
    const server = { request, listen: () => () => {}, generation: 0 } as unknown as AppServer;
    return { request, runner: new AppServerRunner({ server, session: () => null, sessions: () => [], created: () => {}, instructions: () => '', state: () => {}, now: () => 0 }) };
  }

  it('reads one turn without its items, and counts a thread Codex has not materialized as having none', async () => {
    const one = runner(() => ({ data: [{ id: 't1' }] }));
    expect(await one.runner.hasTurns('thread-1')).toBe(true);
    expect(one.request).toHaveBeenCalledWith('thread/turns/list', { threadId: 'thread-1', limit: 1, itemsView: 'notLoaded' });
    expect(await runner(() => ({ data: [] })).runner.hasTurns('thread-1')).toBe(false);
    expect(await runner(() => { throw new AppServerError('thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message', true); }).runner.hasTurns('thread-1')).toBe(false);
    await expect(runner(() => { throw new AppServerError('The connection to Codex closed.'); }).runner.hasTurns('thread-1')).rejects.toThrow('The connection to Codex closed.');
  });

  it("reads no history for a thread Codex has not materialized, as before its first user message, and still fails for any other error", async () => {
    expect(await runner(() => { throw new AppServerError('thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message', true); }).runner.history('thread-1')).toEqual([]);
    expect(await runner(() => ({ data: [{ id: 't1' }] })).runner.history('thread-1')).toEqual([{ id: 't1' }]);
    await expect(runner(() => { throw new AppServerError('Codex refused the request.', true); }).runner.history('thread-1')).rejects.toThrow('Codex refused the request.');
    // A refusal names it; the same words from anything but Codex's answer do not.
    expect(notMaterialized(new AppServerError('thread/resume failed: no rollout found for thread id thread-1', true))).toBe(true);
    expect(notMaterialized(new AppServerError('thread thread-1 is not materialized yet'))).toBe(false);
    expect(notMaterialized(new Error('thread thread-1 is not materialized yet'))).toBe(false);
  });
});

describe("a thread's start settings (mechanics M108)", () => {
  it("keeps the daemon's first answer for the thread, not a later resume's, and falls back to the session's options", async () => {
    const answers: Record<string, Json> = {
      'thread/start': { thread: { id: 'thread-1' }, model: 'gpt-a', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } },
      'thread/resume': { thread: { id: 'thread-1' }, model: 'gpt-b', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } },
    };
    const request = vi.fn(async (method: string) => answers[method] ?? {});
    const server = { request, listen: () => () => {}, generation: 0 } as unknown as AppServer;
    const session = { id: 's1', workItemId: 1, cwd: 'D:/repo', nativeSessionId: 'thread-1', state: 'idle' } as never;
    const runner = new AppServerRunner({ server, session: () => session, sessions: () => [session], created: () => {}, instructions: () => '', state: () => {}, now: () => 0, resumeOptions: () => ({ permissionMode: 'auto', model: null }) });
    expect(runner.startSettings({ ...(session as object), nativeSessionId: 'thread-9' } as never)).toEqual({ model: null, effort: null, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', network: null, mode: 'default' });
    await runner.start({ sessionId: 's1', workItemId: 1, cwd: mkdtempSync(join(tmpdir(), 'sb-start-')), permissionMode: 'bypassPermissions', model: null, prompt: '', name: 'n' } as never);
    await runner.configure(session);
    expect(runner.startSettings(session)).toEqual({ model: 'gpt-a', effort: null, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', network: null, mode: 'default' });
  });
});
