import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { heldSlots } from '../src/queue.js';
import { Harness, settings } from './flowHarness.js';

function start(h: Harness) {
  const action = h.act({type:'adhoc',prompt:'Do work',repoRoot:'D:/scratch',start:true})[0] as Extract<FlowAction,{type:'start-session'}>;
  h.act({type:'session-started',sessionId:action.sessionId,nativeSessionId:'thread-1',shortId:'thread-1'});
  return action;
}
describe('Codex app-server sessions', () => {
  it('cancels a release on new work without setting a failure or declaring the thread released',()=>{
    const h=new Harness({settings:settings({sessions:{provider:'codex'}})});start(h);
    h.act({type:'marker',sessionId:'s1',state:'idle',detail:null});
    h.act({type:'mark-done',workItemId:1});
    expect(h.store.session('s1')).toMatchObject({releasing:true,released:false});
    const error = h.item(1).error;
    h.act({type:'release-cancelled',sessionId:'s1'});
    expect(h.store.session('s1')).toMatchObject({releasing:false,released:false});
    expect(h.item(1).error).toBe(error);h.store.close();
  });
  it('keeps an idle task available for follow-ups and releases it when its work item is done', () => {
    const h = new Harness({settings:settings({sessions:{provider:'codex',installHooks:false}})});
    const action = start(h);
    expect(action).toMatchObject({provider:'codex',execution:'app-server'});
    expect(h.store.session('s1')).toMatchObject({execution:'app-server',launchId:'uuid-1',codeMode:false});
    expect(h.act({type:'marker',sessionId:'s1',state:'idle',detail:null})).toEqual([]);
    expect(h.store.session('s1')).toMatchObject({state:'idle',released:false});
    expect(h.act({type:'mark-done',workItemId:1})).toContainEqual({type:'stop-session',sessionId:'s1',shortId:'thread-1',provider:'codex',execution:'app-server',reason:'release'});
    h.act({type:'stop-succeeded',sessionId:'s1',shortId:'thread-1',reason:'release'});
    expect(h.store.session('s1')).toMatchObject({state:'ended',released:true});
    h.store.close();
  });
  it('releases an idle thread at the idle limit after its turn, never during one or while it waits on a usage limit (PRD R107, R111)', () => {
    const h = new Harness({settings:settings({sessions:{provider:'codex',installHooks:false}})}); start(h);
    expect(h.act({type:'held-idle',sessionId:'s1'})).toEqual([]);
    h.act({type:'marker',sessionId:'s1',state:'failed',detail:'rate_limit',limit:{kind:'usage',window:null,resetsAt:h.now+3_600_000,exact:true,cli:false,message:null}});
    expect(h.act({type:'held-idle',sessionId:'s1'})).toEqual([]);
    h.act({type:'marker',sessionId:'s1',state:'running',detail:null});
    h.act({type:'marker',sessionId:'s1',state:'idle',detail:null});
    expect(h.act({type:'held-idle',sessionId:'s1'})).toEqual([{type:'stop-session',sessionId:'s1',shortId:'thread-1',provider:'codex',execution:'app-server',reason:'release'}]);
    expect(h.store.session('s1')).toMatchObject({releasing:true});
    h.store.close();
  });
  it('starts hosted Codex conversations without Code Mode or hooks, and counts slots only during a turn', () => {
    const h = new Harness({settings:settings({sessions:{provider:'codex',codeMode:false,installHooks:false}})});
    const action = h.act({type:'new-conversation',hostWindow:'D:/folder',folder:'D:/folder'})[0] as Extract<FlowAction,{type:'start-session'}>;
    expect(action).toMatchObject({provider:'codex',execution:'app-server',prompt:''});
    expect(action.contract).not.toContain(' report done ');
    h.act({type:'session-started',sessionId:'s1',nativeSessionId:'thread-1',shortId:'thread-1'});
    expect(heldSlots(h.store)).toBe(0);
    h.act({type:'marker',sessionId:'s1',state:'running',detail:null});expect(heldSlots(h.store)).toBe(1);
    h.act({type:'marker',sessionId:'s1',state:'idle',detail:null});expect(heldSlots(h.store)).toBe(0);
    expect(h.item(1).status).toBe('running');h.store.close();
  });
  it('holds a stopped thread again under a new launch when it resumes, keeping its outcome and work item status until a turn', () => {
    const h = new Harness({settings:settings({sessions:{provider:'codex'}})}); start(h);
    h.act({type:'stop-succeeded',sessionId:'s1',reason:'operator'});
    const stopped = h.item(1).status;
    expect(h.store.session('s1')).toMatchObject({state:'ended',released:true});
    h.act({type:'held-resumed',sessionId:'s1',launchId:'launch-2'});
    expect(h.store.session('s1')).toMatchObject({state:'idle',released:false,releasing:false,endedAt:null,launchId:'launch-2',outcome:'stopped'});
    expect(h.item(1).status).toBe(stopped);
    h.act({type:'marker',sessionId:'s1',state:'running',detail:null});
    expect(h.item(1).status).toBe('running');
    // A live session is not resumed again.
    h.act({type:'held-resumed',sessionId:'s1',launchId:'launch-3'});
    expect(h.store.session('s1')?.launchId).toBe('launch-2');
    h.store.close();
  });
  it('carries the execution method through Delete and revives a stopped thread only when observed active', () => {
    const h = new Harness({settings:settings({sessions:{provider:'codex'}})}); start(h);
    h.act({type:'stop-succeeded',sessionId:'s1',reason:'operator'});
    h.act({type:'roster',checked:['s1'],sessions:[{sessionId:'s1',state:'running',detail:null}]});
    expect(h.store.session('s1')).toMatchObject({state:'running',released:false,launchId:'uuid-2'});
    expect(h.act({type:'delete',workItemId:1})).toEqual([{type:'stop-session',sessionId:'s1',provider:'codex',shortId:'thread-1',reason:'operator',execution:'app-server'}]);
    expect(h.store.session('s1')).toBeNull();h.store.close();
  });
});
