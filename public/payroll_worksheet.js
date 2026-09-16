if (window.user?.role !== 'admin') location.replace('/dashboard.html');
const fields = [['sss','SSS'],['philhealth','PhilHealth'],['pagibig','Pag-IBIG'],['withholding_tax','Tax'],['vale_amount','Vale'],['loan_amount','Loan amortization'],['other_amount','Other deduction'],['other_adjustment','Adjustment (+/−)'],['vale_ref','Vale reference'],['loan_ref','Loan reference'],['other_particulars','Other particulars'],['bank_ref','Bank reference'],['remarks','Remarks']];
const numeric = fields.slice(0,8).map(([key])=>key);
const $ = id => document.getElementById(id);
let rows = [], busy = false, loadedCutoff = '';
async function flushDrafts(){const invalid=$('rows').querySelector('input:invalid');if(invalid){invalid.reportValidity();return false;}for(const row of rows)if(row.sync && !await row.sync.flush())return false;return true;}
const money = n => Number(n || 0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
async function api(url,body) {
  const res = await fetch(url,{headers:authHeaders(body ? {'Content-Type':'application/json'} : {}),...(body ? {method:'POST',body:JSON.stringify(body)} : {})});
  const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Request failed'); return data;
}
function cell(tr,value,tag='td') { const el=document.createElement(tag); el.textContent=value;tr.append(el);return el; }
function net(row) { return Number(row.data.summary.total_income) - numeric.filter(k=>k!=='other_adjustment').reduce((s,k)=>s+Number(row.values[k] || 0),0)+Number(row.values.other_adjustment || 0); }
function totals() {
  $('totals').replaceChildren();cell($('totals'),'Totals');cell($('totals'),money(rows.reduce((s,r)=>s+Number(r.data?.summary.total_income || 0),0)));
  for(const [key] of fields) {const td=cell($('totals'),numeric.includes(key)?money(rows.reduce((s,r)=>s+Number(r.values?.[key] || 0),0)):'');if(!numeric.includes(key))td.className='extra-column';}
  cell($('totals'),money(rows.reduce((s,r)=>s+(r.data?net(r):0),0))); cell($('totals'),'');
}
function lock(value) { busy=value; for(const id of ['load','cutoff','save','finalize']) $(id).disabled=value || (['save','finalize'].includes(id) && !rows.some(r=>r.data && r.data.payroll_record?.status!=='finalized')); $('rows').querySelectorAll('input').forEach(el=>el.disabled=value || el.dataset.finalized==='true'); }
function render() {
  $('head').replaceChildren();for(const title of ['Employee','Gross pay',...fields.map(f=>f[1]),'Net pay','Status / form']) cell($('head'),title,'th');
  fields.forEach(([key],i)=>{if(!numeric.includes(key))$('head').children[i+2].className='extra-column';});
  $('rows').replaceChildren();
  for(const row of rows) {
    const tr=document.createElement('tr');$('rows').append(tr);cell(tr,row.employee.name);
    if (!row.data) {const c=cell(tr,row.error);c.colSpan=fields.length+3;c.className='error';continue;}
    const finalized=row.data.payroll_record?.status==='finalized';cell(tr,money(row.data.summary.total_income));
    for(const [key,label] of fields) {
      const td=cell(tr,'');const input=document.createElement('input');input.type=numeric.includes(key)?'number':'text';input.value=row.values[key]??(numeric.includes(key)?0:'');input.setAttribute('aria-label',`${row.employee.name} ${label}`);input.dataset.finalized=String(finalized);input.disabled=finalized;
      if(!numeric.includes(key))td.className='extra-column';
      if(input.type==='number'){input.step='0.01';if(key!=='other_adjustment')input.min='0';}else input.maxLength=500;
      input.dataset.field=key;
      input.oninput=()=>{row.values[key]=input.value;row.dirty=true;tr.classList.add('dirty');row.netCell.textContent=money(net(row));row.status.textContent='Unsaved changes';totals();if(input.validity.valid)row.sync.edit(key,input.value || (numeric.includes(key)?'0':''));};td.append(input);
      if(['vale_amount','loan_amount'].includes(key)) {const balance=document.createElement('div');balance.style.cssText='font-size:11px;color:#536276;margin-top:5px';balance.textContent=`Balance: ₱${money(row.data.balances?.[key==='vale_amount'?'advances':'loans'])}`;balance.title=`As of ${row.data.balance_as_of}; includes posted repayments`;td.append(balance);}
    }
    row.netCell=cell(tr,money(net(row)));const status=cell(tr,'');status.className='status';row.status=document.createElement('div');row.status.textContent=finalized?'Finalized — locked':'Draft';status.append(row.status);
    const [from,to]=loadedCutoff.split('|');
    row.sync=new PayrollSync.Draft({user_id:row.employee.id,from,to},(saved,pending)=>{
      row.data.revision=saved.revision;row.data.summary=saved.summary;row.data.payroll_record=saved.payroll_record;
      row.values={...saved.payroll_record,...pending};
      tr.querySelectorAll('input').forEach(input=>{if(document.activeElement!==input && !(input.dataset.field in pending))input.value=row.values[input.dataset.field]??'';});
      row.netCell.textContent=money(net(row));tr.children[1].textContent=money(saved.summary.total_income);totals();
    },message=>{row.status.textContent=message;row.dirty=message!=='Saved automatically';tr.classList.toggle('dirty',row.dirty);});
    const a=document.createElement('a');a.href=`/payroll.html?employee=${row.employee.id}&cutoff=${encodeURIComponent(loadedCutoff)}`;a.textContent='Individual form';a.onclick=async e=>{e.preventDefault();if(await flushDrafts())location.href=a.href;};status.append(a);
  }
  totals();lock(false);
}
async function load() {
  if (busy) return;
  busy=true;
  if(!await flushDrafts()){busy=false;return;}
  lock(true);rows=[];loadedCutoff=$('cutoff').value;const [from,to]=loadedCutoff.split('|');$('rows').replaceChildren();$('message').textContent='Loading payroll…';
  try {
    const employees=await api('/employees?active=true');employees.sort((a,b)=>a.name.localeCompare(b.name));
    for(const employee of employees) {
      try{const data=await api(`/admin/payroll-preview?user_id=${employee.id}&from=${from}&to=${to}`);rows.push({employee,data,values:{...data.payroll_record},dirty:false});}
      catch(e){rows.push({employee,error:e.message});}
    }
    render();$('message').textContent=`${rows.length} active employees. Changes save automatically. Finalized payroll stays locked.`;
  }catch(e){$('message').textContent=e.message;}finally{lock(false);}
}
async function save(finalize) {
  if(busy)return;
  if(!await flushDrafts())return;
  if($('cutoff').value!==loadedCutoff){$('message').textContent='Load the selected cutoff first.';return;}
  const selected=rows.filter(r=>r.data && r.data.payroll_record?.status!=='finalized' && (finalize||r.dirty));
  if(!selected.length){$('message').textContent='All edits are saved automatically.';return;}
  if(!$('rows').querySelector('input:invalid')?.reportValidity() && $('rows').querySelector('input:invalid'))return;
  if(finalize && !confirm(`Finalize ${selected.length} payrolls for ${loadedCutoff.replace('|',' to ')} and post their repayments?`))return;
  lock(true);let successes=0;const [from,to]=loadedCutoff.split('|');
  for(const row of selected) {
    try {
      const saved = await api(finalize?'/admin/payroll-finalize':'/admin/payroll-draft',{...row.values,user_id:row.employee.id,from,to,expected_revision:row.data.revision});
      row.data.revision=saved.revision;row.data.summary=saved.summary;row.netCell.textContent=money(net(row));
      row.status.closest('tr').children[1].textContent=money(saved.summary.total_income);
      row.dirty=false;successes++;row.status.textContent=finalize?'Finalized — locked':'Draft saved';row.status.closest('tr').classList.remove('dirty');
      if(finalize){row.data.payroll_record.status='finalized';row.status.closest('tr').querySelectorAll('input').forEach(el=>el.dataset.finalized='true');}
    }
    catch(e){row.status.textContent=e.message;}
  }
  $('message').textContent=`${successes} of ${selected.length} payrolls ${finalize?'finalized':'saved'}.${successes<selected.length?' Check the row messages; unsuccessful rows were not saved.':''}`;totals();lock(false);
  if(successes){PayrollSync.notify();if(finalize)await load();}
}
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today=new Date();for(let d=new Date(2026,4,1);d<=new Date(today.getFullYear(),today.getMonth()+1,1);d.setMonth(d.getMonth()+1))for(const half of [1,16]){const from=iso(new Date(d.getFullYear(),d.getMonth(),half));const to=iso(new Date(d.getFullYear(),d.getMonth()+(half===16?1:0),half===1?15:0));const opt=new Option(`${from} to ${to}`,`${from}|${to}`);$('cutoff').add(opt);if(from<=iso(today)&&to>=iso(today))opt.selected=true;}
$('load').onclick=load;$('save').onclick=()=>save(false);$('finalize').onclick=()=>save(true);
$('references').onchange=()=>document.querySelector('table').classList.toggle('show-references',$('references').checked);
$('cutoff').onchange=()=>{$('message').textContent='Click Load / refresh to open this cutoff. The displayed rows still belong to the previous cutoff.';$('save').disabled=true;$('finalize').disabled=true;};
window.addEventListener('beforeunload',e=>{if(rows.some(r=>r.dirty)){e.preventDefault();e.returnValue='';}});
if(window.user?.role==='admin')load();
$('depositSummary').onclick=async e=>{e.preventDefault();if(await flushDrafts())location.href='/payroll_summary.html?cutoff='+encodeURIComponent(loadedCutoff||$('cutoff').value);};
let checking=false;
async function checkUpdates(){
  if(checking || busy || document.hidden || !loadedCutoff || rows.some(r=>r.dirty || r.sync?.dirty) || ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName))return;
  checking=true;
  try{const [from,to]=loadedCutoff.split('|');const revisions=await api(`/admin/payroll-revisions?from=${from}&to=${to}`);if(rows.some(r=>r.data && r.data.revision!==(revisions.find(v=>Number(v.user_id)===Number(r.employee.id))?.revision??null)))await load();}catch{}finally{checking=false;}
}
PayrollSync.subscribe(checkUpdates);window.addEventListener('focus',checkUpdates);document.addEventListener('visibilitychange',checkUpdates);setInterval(checkUpdates,8000);
