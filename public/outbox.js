// Event payloads are immutable, owner/tenant scoped, and contain no credentials.
let database;
function openDatabase(){
 if(!database)database=new Promise((resolve,reject)=>{const request=indexedDB.open('iep-event-outbox',1);request.onupgradeneeded=()=>request.result.createObjectStore('events',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 return database;
}
async function transaction(mode,operation){const db=await openDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction('events',mode),store=tx.objectStore('events');let result;const request=operation(store);if(request)request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function size(entry){return new TextEncoder().encode(JSON.stringify(entry)).byteLength;}
export const outbox={enqueueBounded:async(entry,maxEvents,maxBytes)=>{const db=await openDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction('events','readwrite'),store=tx.objectStore('events'),request=store.getAll();let result;request.onsuccess=()=>{const entries=request.result.filter(e=>String(e.owner)===String(entry.owner));if(entries.some(e=>e.key===entry.key)){result={queued:true,key:entry.key};return;}const bytes=entries.reduce((n,e)=>n+size(e),0)+size(entry);if(entries.length>=maxEvents||bytes>maxBytes){tx.abort();reject(Error('امتلأت قائمة الإرسال المحلية. أرسل الأحداث قبل الاستكمال.'));return;}store.put(entry);result={queued:true,key:entry.key};};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('تعذر حفظ الحدث محليًا'));});},put:entry=>transaction('readwrite',store=>store.put(entry)),remove:key=>transaction('readwrite',store=>store.delete(key)),list:async owner=>(await transaction('readonly',store=>store.getAll())).filter(e=>String(e.owner)===String(owner))};
export class DurableSender{
 constructor({send,onSaved=()=>{},onHealth=()=>{},storage=outbox}){this.send=send;this.onSaved=onSaved;this.onHealth=onHealth;this.storage=storage;this.owner=null;this.busy=false;this.timer=null;this.retry=new Map();this.maxEvents=1000;this.maxBytes=64*1024*1024;this.enqueueTail=Promise.resolve();this.retryBlocked=false;}
 async activate(owner){this.owner=owner;clearTimeout(this.timer);this.retry.clear();const entries=await this.storage.list(owner);this.onHealth({pending:entries.length,blocked:entries.filter(e=>e.blocked).length,bytes:entries.reduce((n,e)=>n+size(e),0)});this.kick();return entries;}
 deactivate(){this.owner=null;clearTimeout(this.timer);}
 async enqueue(entry){
  const operation=async()=>{if(this.storage.enqueueBounded)await this.storage.enqueueBounded(entry,this.maxEvents,this.maxBytes);else{const entries=await this.storage.list(entry.owner);if(!entries.some(e=>e.key===entry.key)){const bytes=entries.reduce((n,e)=>n+size(e),0)+size(entry);if(entries.length>=this.maxEvents||bytes>this.maxBytes)throw Error('امتلأت قائمة الإرسال المحلية. أرسل الأحداث قبل الاستكمال.');await this.storage.put(entry);}}
   const entries=await this.storage.list(entry.owner);this.onHealth({pending:entries.length,blocked:entries.filter(e=>e.blocked).length,bytes:entries.reduce((n,e)=>n+size(e),0)});this.kick();return {queued:true,key:entry.key};};
  const pending=this.enqueueTail.then(operation);this.enqueueTail=pending.catch(()=>{});return pending;
 }
 kick(force=false){if(force){this.retry.clear();this.retryBlocked=true;}clearTimeout(this.timer);this.timer=setTimeout(()=>this.drain(),0);}
 async drain(){
  if(this.busy||this.owner===null)return;
  this.busy=true;const owner=this.owner, retryBlocked=this.retryBlocked;this.retryBlocked=false;let wait=1500;
  try{
   for(const entry of await this.storage.list(owner)){
    if(this.owner!==owner)break;
    if(entry.blocked&&!retryBlocked)continue;
    if(entry.blocked){delete entry.blocked;await this.storage.put(entry);}
    const state=this.retry.get(entry.key);
    if(state&&state.next>Date.now()){wait=Math.min(wait,state.next-Date.now());continue;}
    try{
     const result=await this.send(entry);
     // Metadata may commit while a snapshot write fails. Keep the original image
     // and accumulated insert acknowledgement durable until both have committed.
     const inserted=(entry.delivery?.inserted||0)+(state?.unpersistedInserted||0)+(result.inserted||0);
     const mediaPending=result.mediaPending??0;
     const nextEntry={...entry,delivery:{...entry.delivery,inserted,mediaPending}};
     // Persist the acknowledgement before removing the queue entry, including
     // final delivery, so a failed local delete can safely replay a duplicate.
     this.retry.set(entry.key,{...state,unpersistedInserted:inserted-(entry.delivery?.inserted||0)});
     await this.storage.put(nextEntry);
     this.retry.set(entry.key,{...state,unpersistedInserted:0});
     if(mediaPending>0){
      const attempts=(state?.attempts||0)+1,delay=Math.min(60000,1000*2**Math.min(attempts,6));
      this.retry.set(entry.key,{attempts,next:Date.now()+delay});
      this.onHealth({error:'سجل الحدث محفوظ على الخادم؛ حفظ اللقطة مؤجل وستُعاد محاولة إرسال الصورة الأصلية.',mediaPending,pendingMedia:true});
      wait=Math.min(wait,delay);
      continue;
     }
     await this.storage.remove(entry.key);
     this.retry.delete(entry.key);
     if(this.owner===owner)this.onSaved(nextEntry,{...result,inserted,mediaPending:0});
    }catch(err){
     if(Number.isInteger(err.status)&&err.status>=400&&err.status<500&&![408,425,429].includes(err.status)){const blocked={...entry,blocked:{status:err.status,message:err.message,at:new Date().toISOString()}};await this.storage.put(blocked);this.retry.delete(entry.key);this.onHealth({error:err.message,blockedError:true});continue;}
     const current=this.retry.get(entry.key),attempts=(state?.attempts||0)+1,delay=Math.min(60000,1000*2**Math.min(attempts,6));
     this.retry.set(entry.key,{...current,attempts,next:Date.now()+delay});
     this.onHealth({error:err.message});wait=Math.min(wait,delay);
    }
   }
  }catch(err){this.onHealth({error:err.message});}
  finally{
   this.busy=false;
   if(this.owner!==null){
    try{const entries=await this.storage.list(this.owner);this.onHealth({pending:entries.length,blocked:entries.filter(e=>e.blocked).length,bytes:entries.reduce((n,e)=>n+size(e),0)});if(entries.some(e=>!e.blocked)||this.retryBlocked)this.timer=setTimeout(()=>this.drain(),wait);}
    catch(err){this.onHealth({error:err.message});}
   }
  }
 }
}
