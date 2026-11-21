const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const vscode = require('vscode');

describe('New Conversation… provider choice', () => {
  it('preselects the default, sends the explicit choice once on a lost response, and creates nothing on cancel', async () => {
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const realRecord = extension.hub();
    const realKey = extension.windowKey();
    const requests = [];
    const streams = [];
    let sends = 0;
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const scope = { kind:'folder', key:'provider-choice', folder, title:'Provider test', scopeGen:1, conversations:[], workItemId:null, cwd:null, sessionId:null };
    const server = createServer((request,response) => {
      if (request.url.startsWith('/v1/conversation/events')) {
        response.writeHead(200,{'Content-Type':'text/event-stream'});
        response.write(`event: hello\ndata: ${JSON.stringify({type:'hello',scope,sessions:[],items:[],more:false,status:null,unread:0,artifactsDir:null,artifacts:[]})}\n\n`);
        streams.push(response);return;
      }
      let text='';request.on('data',chunk=>text+=chunk);request.on('end',()=>{
        const body=JSON.parse(text);requests.push({path:request.url,body});
        if (request.url==='/v1/conversation/new-conversation' && ++sends===1) { response.destroy();return; }
        response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify(request.url==='/v1/conversation/providers'?{defaultProvider:'codex'}:{workItemId:31}));
      });
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const saved = vscode.window.showQuickPick;
    let cancelled=false;
    let releaseChoice;
    let picks=0;
    vscode.window.showQuickPick=async choices=>{
      picks++;
      assert.deepEqual(choices.map(c=>[c.label,c.provider,c.picked]),[['Codex','codex',true],['Claude','claude',false]]);
      if(picks===1)return new Promise(resolve=>{releaseChoice=()=>resolve(choices[1]);});
      return cancelled?undefined:choices[1];
    };
    try {
      extension.connectConversation({port:server.address().port,token:'test-token',pid:98765},'provider-choice');
      const until=Date.now()+10000;
      while(extension.conversation().scope?.key!=='provider-choice') { assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,20)); }
      const first=vscode.commands.executeCommand('switchboard.newSession');
      const pickedBy=Date.now()+10000;
      while(!releaseChoice){assert.ok(Date.now()<pickedBy);await new Promise(resolve=>setTimeout(resolve,20));}
      await vscode.commands.executeCommand('switchboard.newSession');
      assert.equal(picks,1);
      assert.equal(requests.filter(r=>r.path==='/v1/conversation/providers').length,1);
      releaseChoice();await first;
      const made=requests.filter(r=>r.path==='/v1/conversation/new-conversation');
      assert.equal(made.length,2);
      assert.equal(made[0].body.provider,'claude');
      assert.deepEqual(made[0].body,made[1].body);
      cancelled=true;
      await vscode.commands.executeCommand('switchboard.newSession');
      assert.equal(requests.filter(r=>r.path==='/v1/conversation/new-conversation').length,2);
    } finally {
      vscode.window.showQuickPick=saved;
      if(realRecord&&realKey) extension.connectConversation(realRecord,realKey);
      for(const stream of streams)stream.end();
      server.closeAllConnections();
      await new Promise(resolve=>server.close(resolve));
      const until=Date.now()+10000;
      while(realKey && extension.conversation().scope?.key!==realKey) { assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,20)); }
    }
  });
});
