import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Store } from '@switchboard/core';
import { AppServerError } from '@switchboard/codex';
import type { AppServer, AppServerRunner, Json } from '@switchboard/codex';
import { CodexConversationAdapter } from '../src/codexConversation.js';
import { ConversationService, sessionView } from '../src/conversation.js';
import { WindowScopes } from '../src/windows.js';
import { windowOf } from '../src/dock.js';
import { item, session, snapshot } from './views.js';

const recorded = JSON.parse(readFileSync(new URL('../../codex/test/fixtures/app-server.json', import.meta.url), 'utf8')) as { user: Json; reply: Json; question: Json };
const closes: Array<() => void> = [];
afterEach(() => closes.splice(0).forEach(close => close()));

function setup(resume?: (sessionId: string) => Promise<string | null>) {
  const store = Store.open(':memory:'); let id=0; let keys=0; let now=1_000;
  const first = item(1,{sessions:[session({provider:'codex',execution:'app-server',nativeSessionId:'thread-1',shortId:'thread-1',launchId:'launch-1'})]});
  const second = item(2,{sessions:[session({id:'s2',workItemId:2,provider:'codex',execution:'app-server',nativeSessionId:'thread-2',shortId:'thread-2',launchId:'launch-2',cwd:'D:/other'})]});
  for (const one of [first,second]) {
    store.insertTicket(one.ticket as never); store.insertWorkItem({ticketId:one.ticketId,playbook:null,status:'running',createdAt:1_000} as never); store.insertSession(one.sessions[0]!);
  }
  const scopes=new WindowScopes({store,windows:'C:/sb/windows',now:()=>now,newKey:()=>`key-${++keys}`});
  const view=snapshot([first,second]);
  const key=scopes.open(windowOf(first,'C:/sb/windows')!.file!,view);
  const other=scopes.open(windowOf(second,'C:/sb/windows')!.file!,view);
  let receive=(_event:Json):void=>{};
  const server={generation:1,listen:(listener:(event:Json)=>void)=>{receive=listener;return ()=>{};},request:vi.fn(async()=>({data:[]})),respond:vi.fn(async()=>{})};
  let turns:Json[]=[];
  let start:Json|null={model:null,approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access',mode:'default'};
  const runner={startSettings:()=>start,subscription:()=>0,configure:vi.fn(async()=>{}),restoreInstructions:vi.fn(async()=>{}),follow:vi.fn(async()=>({status:{type:'idle'}})),history:vi.fn(async(threadId:string)=>threadId==='thread-1'?turns:[]),send:vi.fn(async()=>{})};
  const frames:Json[]=[];const others:Json[]=[];let adapter:CodexConversationAdapter;
  const service=new ConversationService({store,windows:scopes,projectsDir:'/unused',claudeConfig:'/unused',screen:async()=>{throw new Error('Codex must not read a screen');},input:{reserve:async()=>{throw new Error('Codex must not reserve terminal input');},write:async()=>{throw new Error('Codex must not type');},cannotType:()=> 'holder unavailable'},hooks:()=>false,now:()=>now,newId:()=>String(++id),log:()=>{},...(resume===undefined?{}:{resume}),adapters:changed=>[adapter=new CodexConversationAdapter({store,server:server as unknown as AppServer,runner:runner as unknown as AppServerRunner,now:()=>now,newId:()=>String(++id),log:()=>{},requestsChanged:()=>service.sessionsChanged()},changed)]});
  service.open(key,frame=>frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!)));
  service.open(other,frame=>others.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!)));
  closes.push(()=>{service.stop();store.close();});
  const body={window:key,scopeGen:scopes.scope(key)!.scopeGen,sessionId:'s1',launch:'launch-1',opId:'op-1',text:'hello'};
  return {store,service,adapter:()=>adapter,server,runner,key,other,body,frames,others,emit:(event:Json)=>receive(event),turns:(value:Json[])=>{turns=value;},advance:()=>{now+=6_000;},start:(value:Json|null)=>{start=value;}};
}

describe('Codex conversation adapter and shared service',()=>{
  it('resumes an ended thread before sending a message typed to it, under its new launch, and gives the message back when it cannot',async()=>{
    let refuse:string|null=null;
    const resume=vi.fn(async(sessionId:string)=>{if(refuse===null)p.store.updateSession(sessionId,{state:'idle',endedAt:null,released:false,launchId:'launch-2'});return refuse;});
    const p=setup(resume);await p.service.poll();
    p.store.updateSession('s1',{state:'ended',endedAt:1_000,released:true});
    expect(sessionView(p.store.session('s1')!,true,false)).toMatchObject({conversation:'full',reason:null,state:'ended'});
    const result=p.service.send(p.body);expect(result.status).toBe(200);
    const id=(result.body as {message:{id:string}}).message.id;
    await vi.waitFor(()=>expect(p.runner.send).toHaveBeenCalledWith('thread-1',id,'hello',[]));
    expect(resume).toHaveBeenCalledWith('s1');
    expect(p.store.message(id)?.delivery).toBe('sent');

    p.store.updateSession('s1',{state:'ended',endedAt:2_000,released:true});refuse='A newer session of this work item started; this one cannot resume.';
    const refused=p.service.send({...p.body,launch:'launch-2',opId:'op-2'});
    const gone=(refused.body as {message:{id:string}}).message.id;
    await vi.waitFor(()=>expect(p.store.message(gone)).toBeNull());
    expect(p.frames.some(f=>f['type']==='message'&&(f['message'] as Json)['id']===gone&&(f['message'] as Json)['delivery']==='not-sent'&&(f['message'] as Json)['error']===refuse)).toBe(true);
    expect(p.runner.send).toHaveBeenCalledTimes(1);
    // A session that never got a thread ID has nothing to resume.
    expect(sessionView({...p.store.session('s1')!,nativeSessionId:null},true,false)).toMatchObject({conversation:'read-only',reason:expect.stringContaining('Open it in the terminal')});
  });
  it('resumes an ended thread whose last follow failed, rather than refusing with that failure',async()=>{
    const resume=vi.fn(async(sessionId:string)=>{p.store.updateSession(sessionId,{state:'idle',endedAt:null,released:false,launchId:'launch-2'});return null;});
    const p=setup(resume);
    p.runner.follow.mockRejectedValueOnce(new Error('daemon gone'));
    await p.service.poll();
    expect(p.adapter().cannotSend(p.store.session('s1')!)).toContain('daemon gone');
    p.store.updateSession('s1',{state:'ended',endedAt:1_000,released:true});
    expect(p.service.send(p.body).status).toBe(200);
    await vi.waitFor(()=>expect(p.runner.send).toHaveBeenCalledTimes(1));
    expect(resume).toHaveBeenCalledWith('s1');
  });
  it('refuses a message to an ended thread when the hub cannot resume it',async()=>{
    const p=setup();await p.service.poll();
    p.store.updateSession('s1',{state:'ended',endedAt:1_000,released:true});
    const id=(p.service.send(p.body).body as {message:{id:string}}).message.id;
    await vi.waitFor(()=>expect(p.store.message(id)).toBeNull());
    expect(p.runner.send).not.toHaveBeenCalled();
  });
  it('buffers a live reply until older history is imported, so it answers the right message',async()=>{
    const p=setup();
    p.runner.history.mockImplementationOnce(async()=>{p.emit(recorded.reply);return [{items:[(recorded.user['params'] as Json)['item']]}];});
    await p.service.poll();
    const ordered=p.store.conversation('s1',null,100).items;
    expect(ordered.map(i=>i.type)).toEqual(['message','reply']);
    expect(p.store.latestReplies('s1',10)[0]?.answers).toBe(ordered[0]!.id);
  });
  it('holds back a turn end while a thread is not followed or live items wait, and catches up on request (PRD R103)',async()=>{
    const p=setup();
    const s1=()=>p.store.session('s1')!;
    expect(p.adapter().pending(s1())).toBe(true);
    expect(p.service.catchUp('s1')).not.toBeNull();
    await p.service.catchUp('s1');
    expect(p.adapter().pending(s1())).toBe(false);
    expect(p.service.catchUp('s1')).toBeNull();
    expect(p.service.catchUp('forged')).toBeNull();
    // A new subscription holds it back again, and its catch-up stores the reply its history holds.
    p.runner.subscription=()=>1;
    p.turns([{items:[(recorded.reply['params'] as Json)['item']]}]);
    expect(p.adapter().pending(s1())).toBe(true);
    await p.service.catchUp('s1');
    expect(p.store.conversation('s1',null,10).items.map(i=>i.type)).toEqual(['reply']);
    expect(p.adapter().pending(s1())).toBe(false);
  });
  it('reads recorded native entries once, filters tool output, and scopes every event without Claude hooks or screens',async()=>{
    const p=setup();
    expect(sessionView(p.store.session('s1')!,true,false).conversation).toBe('full');
    p.turns([{items:[(recorded.user['params'] as Json)['item'],(recorded.reply['params'] as Json)['item'],{type:'commandExecution',id:'tool-1',aggregatedOutput:'secret tool output'}]}]);
    await p.service.poll(); await p.service.poll();
    p.emit(recorded.reply);p.emit(recorded.reply);
    expect(p.store.conversation('s1',null,100).items.map(i=>i.type)).toEqual(['message','reply']);
    expect(p.store.latestReplies('s1',10)[0]?.opening).toBe('OSPREY HERON');
    expect(p.others.some(e=>e['type']==='reply'||e['type']==='message')).toBe(false);
    expect(p.frames.filter(e=>e['type']==='reply')).toHaveLength(1);
  });

  it('confirms sends by client ID, returns a repeated opId without a second send, and refuses stale scope or another window',async()=>{
    const p=setup(); await p.service.poll();
    const result=p.service.send(p.body);expect(result.status).toBe(200);
    const message=(result.body as {message:{id:string}}).message;
    await vi.waitFor(()=>expect(p.runner.send).toHaveBeenCalledWith('thread-1',message.id,'hello',[]));
    const event=structuredClone(recorded.user);const raw=(event['params'] as Json)['item'] as Json;raw['clientId']=message.id;raw['content']=[{type:'text',text:'hello'}];
    p.emit(event);p.emit(event);
    expect(p.store.message(message.id)).toMatchObject({delivery:'sent',provisional:false,transcriptUuid:'native-message'});
    expect(p.service.send(p.body).status).toBe(200);expect(p.runner.send).toHaveBeenCalledTimes(1);
    expect(p.service.send({...p.body,window:p.other,opId:'op-other'}).status).toBe(403);
    expect(p.service.send({...p.body,scopeGen:99,opId:'op-stale'}).status).toBe(409);
    expect(p.service.send({...p.body,launch:'old',opId:'op-old'}).status).toBe(409);
  });

  it('retains uncertain delivery after a lost response and reconciles it from history without resending',async()=>{
    const p=setup();await p.service.poll();p.runner.send.mockRejectedValueOnce(new Error('lost connection'));
    const result=p.service.send(p.body);const id=(result.body as {message:{id:string}}).message.id;
    await vi.waitFor(()=>expect(p.store.message(id)?.delivery).toBe('uncertain'));
    expect(p.store.message(id)?.error).toContain('before resending');
    const user=structuredClone((recorded.user['params'] as Json)['item']) as Json;user['clientId']=id;
    p.turns([{items:[user]}]);p.advance();++p.server.generation;await p.service.poll();
    expect(p.store.message(id)).toMatchObject({delivery:'sent',error:null,provisional:false});
    expect(p.runner.send).toHaveBeenCalledTimes(1);
  });

  it.each([new AppServerError('refused',true),new AppServerError('socket closing',false,true)])('gives a refused or unsent message back and runs compact through the API: %s',async(error)=>{
    const p=setup();await p.service.poll();p.runner.send.mockRejectedValueOnce(error);
    const result=p.service.send(p.body);const id=(result.body as {message:{id:string}}).message.id;
    await vi.waitFor(()=>expect(p.store.message(id)).toBeNull());
    expect(p.service.send(p.body).status).toBe(409);
    expect(p.service.commands(p.body)).toEqual({status:200,body:{commands:[{name:'compact',description:'Compact the conversation'}]}});
    expect(p.service.send({...p.body,opId:'compact',text:'/compact',command:true}).status).toBe(200);
    await vi.waitFor(()=>expect(p.server.request).toHaveBeenCalledWith('thread/compact/start',{threadId:'thread-1'}));
  });

  it('replays native question cards and answers only a pending request in the current window and connection',async()=>{
    const p=setup();await p.service.poll();p.emit(recorded.question);
    const requests=p.adapter().requests(p.store.session('s1')!);
    expect(requests).toEqual([{id:'1:0',kind:'question',title:'Codex has a question',questions:[{id:'color',question:'Which color do you choose?',options:['Red','Blue']}],decisions:['accept','decline','cancel']}]);
    const answer={...p.body,requestId:'1:0',answer:{color:'Red'}};
    expect((await p.service.answer({...answer,window:p.other})).status).toBe(403);
    expect((await p.service.answer({...answer,scopeGen:99})).status).toBe(409);
    expect((await p.service.answer({...answer,answer:{}})).status).toBe(409);
    expect((await p.service.answer(answer)).status).toBe(200);
    expect(p.server.respond).toHaveBeenCalledWith(0,{answers:{color:{answers:['Red']}}});
    expect((await p.service.answer(answer)).status).toBe(409);
    p.emit(recorded.question);++p.server.generation;
    expect((await p.service.answer(answer)).status).toBe(409);
  });

  it('validates permission decisions, leaves unsupported requests visible for the terminal, and removes resolved requests',async()=>{
    const p=setup();await p.service.poll();
    p.emit({method:'item/commandExecution/requestApproval',id:4,params:{threadId:'thread-1',command:'test command',availableDecisions:['accept','decline']}});
    expect((await p.service.answer({...p.body,requestId:'1:4',answer:'acceptForSession'})).status).toBe(409);
    expect((await p.service.answer({...p.body,requestId:'1:4',answer:'decline'})).status).toBe(200);
    expect(p.server.respond).toHaveBeenCalledWith(4,{decision:'decline'});
    p.emit({method:'mcpServer/elicitation/request',id:5,params:{threadId:'thread-1',reason:'Choose in terminal'}});
    expect(p.adapter().requests(p.store.session('s1')!)[0]?.kind).toBe('unsupported');
    expect((await p.service.answer({...p.body,requestId:'1:5',answer:'accept'})).status).toBe(409);
    p.emit({method:'serverRequest/resolved',params:{threadId:'thread-1',requestId:5}});
    expect(p.adapter().requests(p.store.session('s1')!)).toEqual([]);
  });

  it('bounds automatic checks for unknown delivery and refuses sends during release',async()=>{
    const p=setup();await p.service.poll();p.runner.send.mockRejectedValueOnce(new Error('lost'));
    p.service.send(p.body);await vi.waitFor(()=>expect(p.store.openMessages()[0]?.delivery).toBe('uncertain'));
    for(let n=0;n<5;n++){p.advance();await p.service.poll();}
    const calls=p.runner.history.mock.calls.length;
    p.advance();await p.service.poll();expect(p.runner.history).toHaveBeenCalledTimes(calls);
    p.store.updateSession('s1',{releasing:true});
    const result=p.service.send({...p.body,opId:'while-releasing'});const id=(result.body as {message:{id:string}}).message.id;
    await vi.waitFor(()=>expect(p.store.message(id)).toBeNull());
    expect(p.runner.send).toHaveBeenCalledTimes(1);
  });
  it('sends the window its thread\'s context size from Codex\'s token usage, and nothing to another window (architecture.md § Context meter)',async()=>{
    const p=setup();await p.service.poll();
    expect(p.frames[0]).toMatchObject({type:'hello',sessions:[{id:'s1',context:null}]});
    p.emit({method:'thread/tokenUsage/updated',params:{threadId:'thread-1',turnId:'t1',tokenUsage:{total:{inputTokens:900_000,cachedInputTokens:0,outputTokens:1,reasoningOutputTokens:0,totalTokens:900_001},last:{inputTokens:60_000,cachedInputTokens:50_000,outputTokens:2_000,reasoningOutputTokens:500,totalTokens:62_000},modelContextWindow:258_400}}});
    await p.service.poll();
    expect(p.frames.filter(f=>f['type']==='session').at(-1)).toMatchObject({session:{id:'s1',context:{used:62_000,window:258_400,compactAt:null}}});
    expect(p.others.some(f=>f['type']==='session'&&(f['session'] as Json)['id']==='s1')).toBe(false);
    // An event of an unknown thread changes nothing.
    const sent=p.frames.length;
    p.emit({method:'thread/tokenUsage/updated',params:{threadId:'thread-9',turnId:'t1',tokenUsage:{total:{},last:{totalTokens:5}}}});
    await p.service.poll();
    expect(p.frames.length).toBe(sent);
  });
});

describe("Codex settings changed outside Switchboard (mechanics M108)",()=>{
  const update=(patch:Json={}):Json=>({method:'thread/settings/updated',params:{threadId:'thread-1',threadSettings:{model:'gpt-a',approvalPolicy:'never',approvalsReviewer:'user',sandboxPolicy:{type:'dangerFullAccess'},collaborationMode:{mode:'default',settings:{developer_instructions:'# Collaboration Mode: Default'}},serviceTier:'default',...patch}}});
  const notes=(p:ReturnType<typeof setup>)=>p.store.latestReplies('s1',50).filter(r=>r.kind==='note').map(r=>r.opening).reverse();

  it("notes a model, sandbox, approvals or Plan mode change once, and their return, but not a terminal turn's own instructions",async()=>{
    const p=setup();await p.service.poll();
    // The first turn typed in the terminal sets Codex's Default-mode text and service tier: nothing to note.
    p.emit(update());
    expect(notes(p)).toEqual([]);
    p.emit(update({model:'gpt-b'}));
    expect(notes(p)).toEqual(["The session's Codex settings changed outside Switchboard: model gpt-b (was gpt-a). Every later turn uses them, messages sent from here included."]);
    p.emit(update({model:'gpt-b'}));
    expect(notes(p)).toHaveLength(1);
    p.emit(update({model:'gpt-b',sandboxPolicy:{type:'workspaceWrite'},approvalPolicy:'on-request',collaborationMode:{mode:'plan',settings:{}}}));
    expect(notes(p).at(-1)).toBe("The session's Codex settings changed outside Switchboard: model gpt-b (was gpt-a); approvals on-request, reviewed by user (started with never, reviewed by user); sandbox workspace-write (started with danger-full-access); Plan mode. Every later turn uses them, messages sent from here included.");
    p.emit(update());
    expect(notes(p).at(-1)).toBe("The session's Codex settings are back to those Switchboard started it with.");
    // Another session's thread is noted in its own conversation only; an ended session and a runner that cannot tell the start's settings note nothing.
    p.emit({method:'thread/settings/updated',params:{threadId:'thread-2',threadSettings:{model:'gpt-z',approvalPolicy:'untrusted',sandboxPolicy:{type:'dangerFullAccess'}}}});
    expect(p.store.latestReplies('s2',50).filter(r=>r.kind==='note').map(r=>r.opening)).toEqual(["The session's Codex settings changed outside Switchboard: approvals untrusted, reviewed by user (started with never, reviewed by user). Every later turn uses them, messages sent from here included."]);
    expect(notes(p)).toHaveLength(3);
    p.start(null);
    p.emit(update({sandboxPolicy:{type:'readOnly'}}));
    p.start({model:'gpt-a',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access',mode:'default'});
    p.store.updateSession('s1',{state:'ended'});
    p.emit(update({sandboxPolicy:{type:'readOnly'}}));
    expect(notes(p)).toHaveLength(3);
  });

  it('compares the model with the one Switchboard set',async()=>{
    const p=setup();await p.service.poll();
    p.start({model:'gpt-a',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access',mode:'default'});
    p.emit(update({model:'gpt-c'}));
    expect(notes(p)).toEqual(["The session's Codex settings changed outside Switchboard: model gpt-c (started with gpt-a). Every later turn uses them, messages sent from here included."]);
  });
});
