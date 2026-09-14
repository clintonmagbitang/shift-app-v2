const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function client(fetch){const states=[],saved=[],window={addEventListener(){}};vm.runInNewContext(fs.readFileSync(require.resolve('../public/payroll-sync.js'),'utf8'),{window,fetch,authHeaders:v=>v,localStorage:{setItem(){}},setTimeout:()=>1,clearTimeout(){}});const draft=new window.PayrollSync.Draft({user_id:2,from:'2026-09-01',to:'2026-09-15'},(data,pending)=>saved.push({data,pending:{...pending}}),state=>states.push(state));return {draft,states,saved};}
test('opening a form never saves; automatic draft updates send only edited fields',async()=>{
 const requests=[];const h=client(async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({revision:'1'})};});
 assert.equal(requests.length,0);h.draft.edit('sss','350');h.draft.edit('sss','450');await h.draft.flush();
 assert.equal(requests.length,1);assert.equal(requests[0].url,'/admin/payroll-fields');assert.deepEqual(requests[0].body.changes,{sss:'450'});assert.equal(h.draft.dirty,false);
});
test('edits typed while saving remain queued and failure stays visible for retry',async()=>{
 let resolve;const requests=[];let fail=false;
 const h=client(async(url,options)=>{requests.push(JSON.parse(options.body));if(requests.length===1)await new Promise(r=>resolve=r);return {ok:!fail,json:async()=>fail?{error:'Offline'}:{revision:String(requests.length)}};});
 h.draft.edit('sss','350');const saving=h.draft.flush();h.draft.edit('sss','450');resolve();await saving;
 assert.equal(requests.length,2);assert.equal(h.saved[0].pending.sss,'450');assert.equal(requests[1].changes.sss,'450');
 fail=true;h.draft.edit('vale_amount','500');assert.equal(await h.draft.flush(),false);assert.equal(h.draft.dirty,true);assert.match(h.states.at(-1),/Not saved/);
 fail=false;assert.equal(await h.draft.flush(),true);assert.equal(h.draft.dirty,false);
});
