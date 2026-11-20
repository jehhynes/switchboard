import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appServerDebriefRange, runAppServerDebrief } from '../src/appServerDebrief.js';
import { codexInput } from '../src/appServerRunner.js';
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
