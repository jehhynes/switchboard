import { describe, expect, it } from 'vitest';
import { Store } from '@switchboard/core';
import { ConversationLog } from '../src/log.js';
import type { ConversationChange } from '../src/conversation.js';

describe('ConversationLog native entries', () => {
  it('confirms a typed message by native client ID, preserving identity across replay and identical texts', () => {
    const store = Store.open(':memory:'); let id = 0; const changes: ConversationChange[] = [];
    const deps = { store, now: () => 1000, newId: () => String(++id), log: () => {}, onChange: (change: ConversationChange) => changes.push(change) };
    const log = new ConversationLog('s1', 1, deps);
    store.addMessage({id:'client-1',sessionId:'s1',workItemId:1,at:1,origin:'typed',text:'hello',transcriptUuid:null,provisional:true,withdrawn:false,delivery:'uncertain',error:'lost',opId:'op1',pastedAt:null});
    log.message('native-1','hello',2,'client-1');
    log.message('native-1','hello',2,'client-1');
    log.message('native-2','hello',3,null);
    expect(store.conversation('s1',null,100).items).toHaveLength(2);
    expect(store.message('client-1')).toMatchObject({delivery:'sent',error:null,transcriptUuid:'native-1',provisional:false,at:2});
    const reopened = new ConversationLog('s1',1,deps);
    reopened.message('native-1','hello',2,'client-1');
    reopened.reply('reply-1','[speak]Hello.[/speak]\n[status]\nReady.',4);
    reopened.reply('reply-1','[speak]Hello.[/speak]\n[status]\nReady.',4);
    expect(store.conversation('s1',null,100).items).toHaveLength(3);
    expect(store.latestReplies('s1',10)[0]).toMatchObject({opening:'Hello.',speak:'Hello.',source:'transcript',transcriptUuid:'reply-1'});
    expect(store.statuses('s1',null,100).statuses.map(s=>s.markdown)).toEqual(['Ready.']);
    store.close();
  });

  it('keeps another session client ID separate and updates an existing reply and status in place', () => {
    const store = Store.open(':memory:'); let id = 0;
    const log = new ConversationLog('s1',1,{store,now:()=>1000,newId:()=>String(++id),log:()=>{},onChange:()=>{}});
    store.addMessage({id:'foreign',sessionId:'s2',workItemId:2,at:1,origin:'typed',text:'secret',transcriptUuid:null,provisional:true,withdrawn:false,delivery:'open',error:null,opId:null,pastedAt:null});
    log.message('native-1','hello',2,'foreign');
    log.reply('reply-1','First.\n[status]\nWorking.',3);
    log.reply('reply-1','Revised.\n[status]\nDone.',3);
    expect(store.message('foreign')).toMatchObject({sessionId:'s2',delivery:'open'});
    expect(store.latestReplies('s1',10)).toHaveLength(1);
    expect(store.latestReplies('s1',10)[0]?.opening).toBe('Revised.');
    expect(store.statuses('s1',null,100).statuses.map(s=>s.markdown)).toEqual(['Done.']);
    store.close();
  });

  it('passes on the artifact tags of a transcript copy once per reply and tag, never those of a screen copy', () => {
    const store = Store.open(':memory:'); let id = 0; const changes: ConversationChange[] = [];
    class Screen extends ConversationLog { screen(text: string): string { return this.publish(text, 5, false, 'screen', undefined); } }
    const log = new Screen('s1', 1, { store, now: () => 1000, newId: () => String(++id), log: () => {}, onChange: (change: ConversationChange) => changes.push(change) });
    const tagged = () => changes.filter((change) => change.type === 'artifacts');

    log.screen('Done.\n[artifact: D:/r/report.md]');
    expect(tagged()).toEqual([]);
    log.reply('reply-1', 'Done.\n[artifact: D:/r/report.md]', 4);
    log.reply('reply-1', 'Done.\n[artifact: D:/r/report.md]\n[artifact: D:/r/other.md | title: Other]', 4);
    expect(tagged()).toEqual([
      { type: 'artifacts', replyId: expect.any(String), artifacts: [{ path: 'D:/r/report.md', title: null, kind: null }] },
      { type: 'artifacts', replyId: expect.any(String), artifacts: [{ path: 'D:/r/other.md', title: 'Other', kind: null }] },
    ]);
    expect(store.latestReplies('s1', 10).find((reply) => reply.transcriptUuid === 'reply-1')?.opening).toBe('Done.');
    store.close();
  });
});
