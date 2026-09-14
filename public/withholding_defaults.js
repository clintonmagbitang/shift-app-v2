if(window.user?.role!=='admin')location.replace('/dashboard.html');
const $=id=>document.getElementById(id);let records=[],loaded='',busy=false;
async function api(path,body){const res=await fetch('/api/v2/withholding-defaults'+path,{headers:authHeaders(body?{'Content-Type':'application/json'}:{}),...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await res.json();if(!res.ok)throw new Error(data.error||'Request failed');return data;}
function lock(value){busy=value;for(const id of ['cutoff','load','save'])$(id).disabled=value;document.querySelectorAll('#rows input,#rows select').forEach(el=>el.disabled=value);}
async function load(){
  if(busy || (records.some(r=>r.dirty)&&!confirm('Discard unsaved default changes?')))return;
  lock(true);loaded=$('cutoff').value;
  try{records=await api('?from='+loaded);$('rows').replaceChildren();
    for(const record of records){const tr=document.createElement('tr');$('rows').append(tr);const name=document.createElement('td');name.textContent=record.name;tr.append(name);
      for(const key of ['sss','philhealth','pagibig']){const td=document.createElement('td'),input=document.createElement('input'),select=document.createElement('select');input.type='number';input.min=0;input.max='999999999.99';input.step='.01';input.value=record[key];input.setAttribute('aria-label',record.name+' '+key+' amount');select.setAttribute('aria-label',record.name+' '+key+' deduction half');
        for(const [value,label] of [['first','First half'],['second','Second half'],['both','Both halves']])select.add(new Option(label,value));select.value=record[key+'_half'];
        input.oninput=()=>{record[key]=input.value;record.dirty=true;tr.classList.add('dirty');record.status.textContent='Unsaved changes';};select.onchange=()=>{record[key+'_half']=select.value;record.dirty=true;tr.classList.add('dirty');record.status.textContent='Unsaved changes';};td.append(input,select);tr.append(td);
      }record.status=document.createElement('td');record.status.textContent=record.effective_from||'No default yet';tr.append(record.status);
    }$('message').textContent=`Defaults effective for ${loaded}. Edit only employees whose defaults should change.`;
  }catch(e){$('message').textContent=e.message;}finally{lock(false);}
}
$('load').onclick=load;$('save').onclick=async()=>{
  if(busy)return;if(loaded!==$('cutoff').value){$('message').textContent='Load the selected cutoff first.';return;}
  const invalid=document.querySelector('#rows input:invalid');if(invalid){invalid.reportValidity();return;}
  lock(true);let count=0;for(const record of records.filter(r=>r.dirty)){try{await api('/'+record.id,{...record,effective_from:loaded,status:undefined});record.dirty=false;record.status.textContent='Saved from '+loaded;record.status.parentElement.classList.remove('dirty');count++;}catch(e){record.status.textContent=e.message;}}
  $('message').textContent=`${count} employee defaults saved. These apply to new payroll drafts from this cutoff onward.`;lock(false);
};
$('cutoff').onchange=()=>{$('save').disabled=true;$('message').textContent='Load defaults for the selected cutoff before editing.';};
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;const today=new Date();
for(let date=new Date(2026,8,1);date<=new Date(today.getFullYear()+1,today.getMonth(),1);date.setMonth(date.getMonth()+1))for(const day of [1,16]){const value=iso(new Date(date.getFullYear(),date.getMonth(),day));const option=new Option(`${value} — ${day===1?'first':'second'} half`,value);$('cutoff').add(option);if(value<=iso(today))option.selected=true;}
window.addEventListener('beforeunload',e=>{if(records.some(r=>r.dirty)){e.preventDefault();e.returnValue='';}});
if(window.user?.role==='admin')load();
