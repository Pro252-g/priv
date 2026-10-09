import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from './index.mjs';
import {clientAddress,trustedProxies} from './client-address.mjs';
import {initializeEventIdentity} from './event-identity.mjs';
async function fixture(options={}){
 const dataDir=mkdtempSync(path.join(tmpdir(),'iep-api-repairs-')),{server,db}=createApp({dataDir,adminPassword:'api-repairs-password',...options});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;let cookie='',bearer='';
 const call=async(p,body,method=body===undefined?'GET':'POST',headers={})=>{const response=await fetch(base+p,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...(bearer?{Authorization:'Bearer '+bearer}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};};
 cookie=(await call('/api/login',{email:'admin@iep.local',password:'api-repairs-password'})).cookie.split(';')[0];const rid=(await call('/api/restaurants',{name:'Test restaurant'})).body.restaurant.id,dish=(await call('/api/dishes',{restaurantId:rid,name:'Original dish'})).body.dish;
 return{db,call,rid,dish,setBearer:t=>{bearer=t;cookie='';},close:async()=>{await new Promise(r=>server.close(r));rmSync(dataDir,{recursive:true,force:true});}};
}
const at='2026-10-09T10:00:00Z';
const crossing=(dish,id,extra={})=>({dishId:dish.id,sessionId:'session-'+id,trackId:'track',crossingId:'crossing',occurredAt:at,confidence:.9,...extra});
const unknown=e=>{const{dishId,confidence,...rest}=e;return rest;};
test('known and unknown identify one crossing in either arrival order and after manual confirmation',async()=>{
 const f=await fixture();try{
  for(const order of ['known-first','unknown-first','review-first']){
   const e=crossing(f.dish,order);
   if(order==='known-first')assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[e]})).body.inserted,1);
   assert.equal((await f.call('/api/unknown-events',{restaurantId:f.rid,events:[unknown(e)]})).status,200);
   let row=(await f.call(`/api/unknown-events?restaurantId=${f.rid}`)).body.records.find(r=>r.session_id===e.sessionId);
   if(order==='review-first')assert.equal((await f.call(`/api/unknown-events/${row.id}/resolve`,{action:'confirm',dishId:f.dish.id,reason:'Verified image'})).status,200);
   if(order!=='known-first')assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[e]})).body.inserted,order==='review-first'?0:1);
   assert.equal((await f.call(`/api/unknown-events/${row.id}/resolve`,{action:'confirm',dishId:f.dish.id,reason:'Verified image'})).body.duplicate,true);
   assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[e]})).body.duplicates,1);
  }
  assert.equal((await f.call(`/api/reports?restaurantId=${f.rid}`)).body.total,3);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n,3);
 }finally{await f.close();}
});
test('typed namespace prevents reserved-string collisions and stable retries reject changed payload',async()=>{
 const f=await fixture();try{
  const experiment=(await f.call('/api/experiments',{restaurantId:f.rid,name:'Recorded',videoName:'local.mp4',durationSec:10})).body.experiment;
  const live=crossing(f.dish,'unused',{sessionId:`experiment:${experiment.id}:reserved`}),recorded={...live,sessionId:'reserved',experimentId:experiment.id,mediaTimeSec:1};
  assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[live]})).body.inserted,1);
  assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[recorded]})).body.inserted,1);
  assert.equal((await f.call(`/api/reports?restaurantId=${f.rid}&experimentId=${experiment.id}`)).body.total,1);
  for(const fields of [{camera:'Changed'},{occurredAt:'2026-10-09T11:00:00Z'},{confidence:.7},{mode:'manual'}])assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[{...live,...fields}]})).status,409);
  assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[live]})).body.duplicates,1);
  const unresolved=unknown(crossing(f.dish,'unknown'));assert.equal((await f.call('/api/unknown-events',{restaurantId:f.rid,events:[unresolved]})).status,200);
  assert.equal((await f.call('/api/unknown-events',{restaurantId:f.rid,events:[{...unresolved,reason:'Changed'}]})).status,409);
 }finally{await f.close();}
});
test('invalid body shapes and timezone-free or null timestamps return400 without recording anything',async()=>{
 const f=await fixture();try{
  for(const body of [null,[],42,'text'])assert.equal((await f.call('/api/events',body)).status,400);
  for(const value of [null,[],42])for(const route of ['/api/events','/api/unknown-events'])assert.equal((await f.call(route,{restaurantId:f.rid,events:[value]})).status,400);
  for(const occurredAt of [null,0,'2026-10-09','2026-10-09T10:00:00','2026-02-30T10:00:00Z','2026-10-09T25:00:00Z'])for(const route of ['/api/events','/api/unknown-events']){const e=crossing(f.dish,'invalid',{occurredAt});assert.equal((await f.call(route,{restaurantId:f.rid,events:[route.endsWith('unknown-events')?unknown(e):e]})).status,400);}
  assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[crossing(f.dish,'valid',{occurredAt:'2026-10-09T12:00:00+02:00'})]})).status,200);
  assert.equal((await f.call(`/api/reports?restaurantId=${f.rid}`)).body.total,1);
 }finally{await f.close();}
});
test('reference mutations are audited, names remain historical and archive policy is consistent',async()=>{
 const f=await fixture();try{
  const image='data:image/png;base64,iVBORw0KGgo=',sample=(await f.call(`/api/dishes/${f.dish.id}/samples`,{image,variantLabel:'Variant'})).body.sample;
  await f.call(`/api/samples/${sample.id}`,undefined,'DELETE');
  const audit=(await f.call('/api/audit')).body.entries;for(const action of ['reference.created','reference.deleted'])assert.ok(audit.some(e=>e.action===action&&e.details.sha256&&e.details.restaurantId===f.rid));
  await f.call('/api/events',{restaurantId:f.rid,events:[crossing(f.dish,'historical')]});await f.call(`/api/dishes/${f.dish.id}`,{name:'Renamed dish'});
  const report=(await f.call(`/api/reports?restaurantId=${f.rid}`)).body;assert.equal(report.events[0].dish_name,'Original dish');assert.equal(report.totals[0].dishName,'Original dish');
  f.db.prepare('UPDATE dishes SET archived_at=? WHERE id=?').run('2026-10-09T09:00:00.000Z',f.dish.id);
  const e=unknown(crossing(f.dish,'archive'));await f.call('/api/unknown-events',{restaurantId:f.rid,events:[e]});const row=(await f.call(`/api/unknown-events?restaurantId=${f.rid}`)).body.records[0];assert.equal((await f.call(`/api/unknown-events/${row.id}/resolve`,{action:'confirm',dishId:f.dish.id,reason:'Archive policy'})).status,409);
 }finally{await f.close();}
});
test('history pages retain old days and monitoring filters SQL before limiting newer sessions',async()=>{
 const f=await fixture();try{
  for(let i=0;i<230;i+=100)assert.equal((await f.call('/api/unknown-events',{restaurantId:f.rid,events:Array.from({length:Math.min(100,230-i)},(_,j)=>unknown(crossing(f.dish,'old-'+(i+j))))})).status,200);
  let cursor='',ids=[];do{const page=(await f.call(`/api/unknown-events?restaurantId=${f.rid}&businessDate=2026-10-09&limit=75${cursor}`)).body;ids.push(...page.records.map(r=>r.id));cursor=page.hasMore?`&beforeId=${page.nextBeforeId}`:'';}while(cursor);assert.equal(new Set(ids).size,230);
  f.db.prepare('INSERT INTO monitors(user_id,restaurant_id,session_id,camera,started_at,last_heartbeat,ended_at) VALUES(1,?,?,?,?,?,?)').run(f.rid,'old-monitor','Old camera','2026-10-09T10:00:00.000Z','2026-10-09T10:00:10.000Z','2026-10-09T11:00:00.000Z');
  const insert=f.db.prepare('INSERT INTO monitors(user_id,restaurant_id,session_id,camera,started_at,last_heartbeat,ended_at) VALUES(1,?,?,?,?,?,?)');for(let i=0;i<1010;i++)insert.run(f.rid,'new-monitor-'+i,'New camera','2026-11-09T10:00:00.000Z','2026-11-09T10:00:10.000Z','2026-11-09T11:00:00.000Z');
  const old=(await f.call(`/api/reconciliation?restaurantId=${f.rid}&businessDate=2026-10-09`)).body.coverage.sessions;assert.equal(old.length,1);assert.equal(old[0].session_id,'old-monitor');
  const create=f.db.prepare('INSERT INTO experiments(user_id,restaurant_id,name,video_name,duration_sec,created_at) VALUES(1,?,?,?,?,?)');for(let i=0;i<115;i++)create.run(f.rid,'E'+i,'local.mp4',1,'2026-10-09T10:00:00.000Z');const first=(await f.call(`/api/experiments?restaurantId=${f.rid}&businessDate=2026-10-09&limit=100`)).body;assert.equal(first.experiments.length,100);assert.equal((await f.call(`/api/experiments?restaurantId=${f.rid}&beforeId=${first.nextBeforeId}&limit=100`)).body.experiments.length,15);
 }finally{await f.close();}
});
test('sources, custom model profiles, diagnostics and gaps enforce scoped credentials-free contracts',async()=>{
 const f=await fixture();try{
  const profile=(await f.call('/api/model-profiles',{name:'Restaurant detector',version:'1',modelSha256:'a'.repeat(64),classes:[{name:'plate',label:'طبق'}]})).body.profile;assert.ok(profile?.id);
  const create={restaurantId:f.rid,sourceId:'plates-window',name:'نافذة الأطباق',kind:'rtsp',config:{modelProfileId:profile.id,roi:[0,0,1,1],line:{orientation:'horizontal',position:.5,direction:'down'},targetFps:5,maxObjects:4}};
  assert.equal((await f.call('/api/sources',{...create,config:{url:'rtsp://user:password@host'}})).status,400);
  const source=(await f.call('/api/sources',create)).body.source;assert.ok(source.id);
  const plate=(await f.call('/api/dishes',{restaurantId:f.rid,name:'All plates',kind:'object',recognitionMode:'detector',detectorClasses:['plate']})).body.dish;assert.ok(plate.id);
  const classes=(await f.call('/api/recognition/classes')).body.classes;assert.ok(classes.some(c=>c.name==='plate'&&c.modelProfileId===profile.id));
  const key=(await f.call('/api/integration-keys',{label:'Edge',restaurantIds:[f.rid],scopes:['catalog.read','events.write','monitor.read','monitor.write']})).body.token;f.setBearer(key);
  const diagnostic={status:'running',bootId:'boot1',sequence:1,observedAt:at,metrics:{fps:5,frameAgeSec:0,queueDepth:0,inferenceMs:120},errorCode:'none'};assert.equal((await f.call(`/api/sources/${source.id}/health`,diagnostic)).status,200);assert.equal((await f.call(`/api/sources/${source.id}/health`,diagnostic)).body.duplicate,true);assert.equal((await f.call(`/api/sources/${source.id}/health`,{...diagnostic,metrics:{fps:3}})).status,409);assert.equal((await f.call(`/api/sources/${source.id}/health`,{...diagnostic,message:'password'})).status,400);
  assert.equal((await f.call('/api/sources',{...create,sourceId:'forbidden'})).status,403);
  const gap={gapId:'power-gap',startAt:'2026-10-09T09:00:00Z',endAt:'2026-10-09T09:05:00Z',cause:'power_loss',recoverable:false};assert.equal((await f.call(`/api/sources/${source.id}/gaps`,gap)).status,201);assert.equal((await f.call(`/api/sources/${source.id}/gaps`,gap)).body.duplicate,true);
  const lease=(await f.call(`/api/sources/${source.id}/lease`,{bootId:'boot1',ttlSec:45})).body;assert.ok(lease.leaseId);assert.equal((await f.call(`/api/sources/${source.id}/lease`,{bootId:'boot2',ttlSec:45})).status,409);assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[crossing(plate,'edge',{sourceId:source.sourceId,sourceLeaseId:lease.leaseId,occurredAt:new Date().toISOString()})]})).status,200);
  const health=(await f.call(`/api/sources?restaurantId=${f.rid}`)).body.sources[0].health;assert.equal(health.metrics.fps,5);assert.equal(JSON.stringify(health).includes('password'),false);
 }finally{await f.close();}
});
test('trusted proxy resolution ignores forged forwarded headers from untrusted peers',()=>{
 const req=(peer,forwarded)=>({socket:{remoteAddress:peer},headers:{'x-forwarded-for':forwarded}}),trusted=trustedProxies('127.0.0.1,::1');
 assert.equal(clientAddress(req('198.51.100.20','203.0.113.1'),trusted),'198.51.100.20');
 assert.equal(clientAddress(req('127.0.0.1','203.0.113.9, 198.51.100.20'),trusted),'198.51.100.20');
 assert.equal(clientAddress(req('::ffff:127.0.0.1','203.0.113.9'),trusted),'203.0.113.9');
 assert.equal(clientAddress(req('127.0.0.1','invalid'),trusted),'127.0.0.1');
 assert.throws(()=>trustedProxies('0.0.0.0/0'));
});
test('legacy crossing migration preserves IDs and evidence while removing an older reviewed double count',async()=>{
 const f=await fixture();try{
  const time='2026-10-09T10:00:00.000Z',uid=Number(f.db.prepare('INSERT INTO unknown_crossings(owner_id,restaurant_id,session_id,track_id,crossing_id,occurred_at,reason,resolved_at,resolution,resolved_dish_id) VALUES(1,?,?,?,?,?,?,?,?,?)').run(f.rid,'legacy','track','cross',time,'uncertain',time,'confirm',f.dish.id).lastInsertRowid);
  const insert=f.db.prepare('INSERT INTO events(user_id,restaurant_id,dish_id,session_id,track_id,crossing_id,camera,occurred_at,confidence,mode) VALUES(1,?,?,?,?,?,?,?,?,?)');
  const direct=Number(insert.run(f.rid,f.dish.id,'legacy','track','cross','Mobile',time,.9,'automatic').lastInsertRowid),review=Number(insert.run(f.rid,f.dish.id,'unknown:'+uid,'review','review','Reviewed unknown',time,0,'manual').lastInsertRowid);
  initializeEventIdentity(f.db);initializeEventIdentity(f.db);
  assert.equal(f.db.prepare('SELECT duplicate_of FROM events WHERE id=?').get(review).duplicate_of,direct);assert.equal(f.db.prepare('SELECT confirmed_event_id FROM unknown_crossings WHERE id=?').get(uid).confirmed_event_id,direct);
  assert.equal((await f.call(`/api/reports?restaurantId=${f.rid}`)).body.total,1);
  assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[{dishId:f.dish.id,sessionId:'legacy',trackId:'track',crossingId:'cross',camera:'Mobile',occurredAt:at,confidence:.9}]})).body.duplicates,1);
  assert.deepEqual(f.db.prepare('SELECT id FROM events ORDER BY id').all().map(r=>r.id),[direct,review]);
 }finally{await f.close();}
});
test('exclusive producer leases fence live sources while valid older queued events still commit',async()=>{
 const f=await fixture();try{
  const source=(await f.call('/api/sources',{restaurantId:f.rid,sourceId:'leased-camera',name:'Fixed camera',kind:'rtsp'})).body.source;
  const a=(await f.call(`/api/sources/${source.id}/lease`,{bootId:'producer-A',ttlSec:45})).body;
  assert.equal((await f.call(`/api/sources/${source.id}/lease`,{bootId:'producer-B',ttlSec:45})).status,409);
  assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[crossing(f.dish,'unleased',{sourceId:source.sourceId,occurredAt:new Date().toISOString()})]})).status,409);
  const current=Date.now(),from=new Date(current-10000).toISOString(),until=new Date(current-5000).toISOString(),captured=new Date(current-7000).toISOString();f.db.prepare('UPDATE source_producer_leases SET valid_from=?,valid_until=? WHERE id=?').run(from,until,a.leaseId);
  const b=(await f.call(`/api/sources/${source.id}/lease`,{bootId:'producer-B',ttlSec:45})).body;assert.notEqual(a.leaseId,b.leaseId);
  const original=crossing(f.dish,'offline-queue',{sourceId:source.sourceId,sourceLeaseId:a.leaseId,occurredAt:captured});assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[original]})).body.inserted,1);assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[original]})).body.duplicates,1);
  assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[crossing(f.dish,'expired',{sourceId:source.sourceId,sourceLeaseId:a.leaseId,occurredAt:new Date().toISOString()})]})).status,409);
  assert.equal((await f.call('/api/unknown-events',{restaurantId:f.rid,events:[unknown(crossing(f.dish,'expired-unknown',{sourceId:source.sourceId,sourceLeaseId:a.leaseId,occurredAt:new Date().toISOString()}))]})).status,409);
  assert.equal((await f.call('/api/events',{restaurantId:f.rid,events:[crossing(f.dish,'new-producer',{sourceId:source.sourceId,sourceLeaseId:b.leaseId,occurredAt:new Date().toISOString()})]})).body.inserted,1);
 }finally{await f.close();}
});
test('file experiment bindings are immutable on concurrent first claim and survive summary replacement',async()=>{
 const f=await fixture();try{
  const e=(await f.call('/api/experiments',{restaurantId:f.rid,name:'File analysis',videoName:'source.mp4',durationSec:10})).body.experiment,binding={fileSha256:'a'.repeat(64),fingerprint:'b'.repeat(64),experimentId:e.id,catalogFingerprint:'e'.repeat(64)};
  const attempts=await Promise.all([f.call(`/api/experiments/${e.id}`,{status:'running',summary:{edgeBinding:binding}}),f.call(`/api/experiments/${e.id}`,{status:'running',summary:{edgeBinding:{...binding,fingerprint:'c'.repeat(64)}}})]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  const saved=(await f.call(`/api/experiments/${e.id}`)).body.experiment.summary.edgeBinding;const update=await f.call(`/api/experiments/${e.id}`,{status:'completed',summary:{other:'information'}});assert.equal(update.status,200);assert.deepEqual(update.body.experiment.summary.edgeBinding,saved);
  assert.equal((await f.call(`/api/experiments/${e.id}`,{status:'completed',summary:{edgeBinding:{...saved,fileSha256:'d'.repeat(64)}}})).status,409);
 }finally{await f.close();}
});
test('configured trusted proxy separates client login limits while forged headers without trust do not',async()=>{
 for(const trustedProxyIps of ['127.0.0.1','']){
  const f=await fixture({trustedProxyIps});try{const statuses=[];for(let i=1;i<=11;i++)statuses.push((await f.call('/api/login',{email:`invalid${i}@example.com`,password:'invalid-password'},'POST',{'X-Forwarded-For':'198.51.100.'+i})).status);if(trustedProxyIps)assert.ok(statuses.every(s=>s===401));else assert.equal(statuses.at(-1),429);}finally{await f.close();}
 }
});
