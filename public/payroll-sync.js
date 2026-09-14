// Both payroll views write only edited fields; the server merges them under a row lock.
window.PayrollSync = (()=>{
  const listeners=new Set();
  function notify(){try{localStorage.setItem('payroll-update',String(Date.now()));}catch{}listeners.forEach(fn=>fn());}
  window.addEventListener('storage',e=>{if(e.key==='payroll-update')listeners.forEach(fn=>fn());});
  class Draft {
    constructor(context,onSaved,onState){this.context=context;this.onSaved=onSaved;this.onState=onState;this.pending={};this.running=null;}
    edit(key,value){this.pending[key]=value;this.onState('Saving…');clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush(),650);}
    get dirty(){return !!this.running || Object.keys(this.pending).length>0;}
    async flush(){
      clearTimeout(this.timer);
      if(this.running){await this.running;if(Object.keys(this.pending).length)return this.flush();return !this.dirty;}
      if(!Object.keys(this.pending).length)return true;
      const changes=this.pending;this.pending={};let success=false;
      this.running=(async()=>{
        try{
          const res=await fetch('/admin/payroll-fields',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({...this.context,changes})});
          const data=await res.json();if(!res.ok)throw new Error(data.error || 'Unable to save.');
          this.onSaved(data,this.pending);success=true;
        }catch(e){this.pending={...changes,...this.pending};this.onState(`Not saved: ${e.message} Use Save to retry.`);}
      })();
      await this.running;this.running=null;
      if(!success)return false;
      if(Object.keys(this.pending).length)return this.flush();
      this.onState('Saved automatically');notify();return true;
    }
  }
  return {Draft,notify,subscribe(fn){listeners.add(fn);}};
})();
