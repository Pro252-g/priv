import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from './index.mjs';

test('resource IDs retain their restaurant scope despite spoofed query and body IDs',async()=>{
 const dataDir=mkdtempSync(path.join(tmpdir(),'iep-resource-scope-'));
 const {server}=createApp({dataDir,adminPassword:'resource-scope-password'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 let cookie='',bearer='';
 const call=async(p,body,method=body?'POST':'GET')=>{
  const res=await fetch(base+p,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...(bearer?{Authorization:'Bearer '+bearer}:{})},body:body?JSON.stringify(body):undefined});
  return {status:res.status,body:res.headers.get('content-type')?.includes('json')?await res.json():await res.arrayBuffer(),cookie:res.headers.get('set-cookie')};
 };
 const login=async(email,password)=>{bearer='';cookie=(await call('/api/login',{email,password})).cookie.split(';')[0];};
 try{
  await login('admin@iep.local','resource-scope-password');
  const owner=cookie;
  const a=(await call('/api/restaurants',{name:'Allowed'})).body.restaurant;
  const b=(await call('/api/restaurants',{name:'Restricted'})).body.restaurant;
  const png='data:image/png;base64,iVBORw0KGgo=';
  const resources=[];
  for(const r of [a,b]){
   const dish=(await call('/api/dishes',{restaurantId:r.id,name:r.name+' dish'})).body.dish;
   const sample=(await call(`/api/dishes/${dish.id}/samples`,{image:png})).body.sample;
   assert.equal((await call('/api/events',{restaurantId:r.id,events:[{dishId:dish.id,sessionId:'scope-'+r.id,trackId:'one',crossingId:'one',occurredAt:'2026-10-09T10:00:00Z',confidence:1,image:png}]})).status,200);
   const event=(await call(`/api/reports?restaurantId=${r.id}`)).body.events[0];
   resources.push({sample,event});
  }
  const [allowed,restricted]=resources;
  for(const role of ['viewer','engineer'])assert.equal((await call('/api/users',{email:`scope-${role}@example.com`,name:role,password:'resource-user-password',role,restaurantIds:[a.id]})).status,201);
  const key=(await call('/api/integration-keys',{label:'Only allowed restaurant',restaurantIds:[a.id],scopes:['catalog.read','reports.read']})).body;
  for(const actor of ['viewer','key']){
   if(actor==='key'){cookie='';bearer=key.token;}else await login('scope-viewer@example.com','resource-user-password');
   assert.equal((await call(`/api/samples/${allowed.sample.id}`)).status,200);
   assert.equal((await call(`/api/events/${allowed.event.id}/snapshot`)).status,200);
   for(const suffix of ['',`?restaurantId=${a.id}`]){
    assert.equal((await call(`/api/samples/${restricted.sample.id}${suffix}`)).status,404,actor+' cannot read another restaurant sample');
    assert.equal((await call(`/api/events/${restricted.event.id}/snapshot${suffix}`)).status,404,actor+' cannot read another restaurant snapshot');
   }
  }
  await login('scope-engineer@example.com','resource-user-password');
  for(const [suffix,body] of [[`?restaurantId=${a.id}`,undefined],['',{restaurantId:a.id}]]){
   assert.equal((await call(`/api/samples/${restricted.sample.id}${suffix}`,body,'DELETE')).status,404,'spoofing cannot authorize deleting another restaurant sample');
  }
  assert.equal((await call(`/api/samples/${allowed.sample.id}`,undefined,'DELETE')).status,200,'assigned engineer can delete own restaurant sample');
  cookie=owner;bearer='';
  assert.equal((await call(`/api/samples/${restricted.sample.id}`)).status,200,'rejected delete attempts preserve sample');
 }finally{
  await new Promise(resolve=>server.close(resolve));
  rmSync(dataDir,{recursive:true,force:true});
 }
});
