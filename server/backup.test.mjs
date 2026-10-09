import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync,statSync,symlinkSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';import {createApp} from './index.mjs';import {DatabaseSync} from 'node:sqlite';import {spawnSync} from 'node:child_process';import {backupDataset,verifyBackup,restoreDataset} from '../scripts/backup-data.mjs';
test('online database/media backup verifies and restores privately without overwriting existing data',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'iep-backup-')),dataDir=path.join(dir,'source'),mediaDir=path.join(dir,'pictures'),password='backup-test-password';let app=createApp({dataDir,mediaDir,adminPassword:password});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let base='http://127.0.0.1:'+app.server.address().port;const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@iep.local',password})}),cookie=login.headers.get('set-cookie').split(';')[0];const post=async(p,b)=>(await(await fetch(base+p,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(b)})).json());try{const {restaurant}=await post('/api/restaurants',{name:'Backup'}),{dish}=await post('/api/dishes',{restaurantId:restaurant.id,name:'Soup'}),image='data:image/png;base64,iVBORw0KGgo=';const {sample}=await post('/api/dishes/'+dish.id+'/samples',{image,variantLabel:'A'});await post('/api/events',{restaurantId:restaurant.id,events:[{dishId:dish.id,sessionId:'backup',trackId:'1',crossingId:'1',occurredAt:new Date().toISOString(),confidence:.9,image}]});const outputDir=path.join(dir,'backup'),m=await backupDataset({dataDir,mediaDir,outputDir});assert.equal(m.complete,true);assert.equal(m.images.length,1);assert.equal(verifyBackup(outputDir).complete,true);assert.throws(()=>restoreDataset({backupDir:outputDir,dataDir,mediaDir}),/new data/);await new Promise(r=>app.server.close(r));const restored=path.join(dir,'restored'),restoredMedia=path.join(dir,'restored-pictures');restoreDataset({backupDir:outputDir,dataDir:restored,mediaDir:restoredMedia});app=createApp({dataDir:restored,mediaDir:restoredMedia,adminPassword:password});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;const get=await fetch(base+sample.url,{headers:{Cookie:cookie}});assert.equal(get.status,200);assert.deepEqual(Buffer.from(await get.arrayBuffer()),Buffer.from('iVBORw0KGgo=','base64'));rmSync(path.join(restoredMedia,sample.image_key));const incompleteDir=path.join(dir,'incomplete');assert.equal((await backupDataset({dataDir:restored,mediaDir:restoredMedia,outputDir:incompleteDir})).complete,false);assert.equal(verifyBackup(incompleteDir).missing.length,1);assert.throws(()=>restoreDataset({backupDir:incompleteDir,dataDir:path.join(dir,'missing-restore')}),/Incomplete/);const f=path.join(outputDir,'media',sample.image_key);writeFileSync(f,'corrupt');assert.throws(()=>verifyBackup(outputDir),/integrity/);assert.throws(()=>restoreDataset({backupDir:outputDir,dataDir:path.join(dir,'bad-restore')}),/integrity/);}finally{await new Promise(r=>app.server.close(r));rmSync(dir,{recursive:true,force:true});}});

test('restore normalizes verified pending/corrupt references before any image GET',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'iep-restore-state-')),dataDir=path.join(dir,'data'),mediaDir=path.join(dir,'pictures');const app=createApp({dataDir,mediaDir,adminPassword:'restore-state-password'});
 try{
  const owner=app.db.prepare('SELECT id FROM users').get().id;
  const restaurant=Number(app.db.prepare('INSERT INTO restaurants(user_id,name) VALUES(?,?)').run(owner,'Restore').lastInsertRowid);
  const dish=Number(app.db.prepare('INSERT INTO dishes(restaurant_id,name) VALUES(?,?)').run(restaurant,'Pizza').lastInsertRowid);
  const bytes=Buffer.from('iVBORw0KGgo=','base64'),stored=app.media.put(owner,{mime:'image/png',data:bytes});
  app.db.prepare("INSERT INTO samples(dish_id,mime,image_key,media_status) VALUES(?,'image/png',?,'pending')").run(dish,stored.key);
  app.db.prepare("UPDATE media_objects SET status='pending',error_code='storage_unavailable' WHERE image_key=?").run(stored.key);
  const outputDir=path.join(dir,'backup'),manifest=await backupDataset({dataDir,mediaDir,outputDir});assert.equal(manifest.complete,true);
  const restoredData=path.join(dir,'restored'),restoredMedia=path.join(dir,'new-images');restoreDataset({backupDir:outputDir,dataDir:restoredData,mediaDir:restoredMedia});
  const restored=createApp({dataDir:restoredData,mediaDir:restoredMedia,adminPassword:'restore-state-password'});
  try{assert.equal(restored.db.prepare('SELECT media_status FROM samples').get().media_status,'ready');assert.equal(restored.db.prepare('SELECT status,error_code FROM media_objects').get().status,'ready');assert.equal(restored.db.prepare('SELECT error_code FROM media_objects').get().error_code,null);}finally{restored.db.close();}
 }finally{app.db.close();rmSync(dir,{recursive:true,force:true});}
});


test('large database backup and verification keep memory bounded independently of database bytes',async(t)=>{
 const dir=mkdtempSync(path.join(tmpdir(),'iep-large-backup-'));try{
  const dataDir=path.join(dir,'data');mkdirSync(dataDir);const db=new DatabaseSync(path.join(dataDir,'iep.sqlite'));
  db.exec('CREATE TABLE payload(bytes BLOB); BEGIN');const insert=db.prepare('INSERT INTO payload VALUES(zeroblob(1048576))');for(let i=0;i<96;i++)insert.run();db.exec('COMMIT');db.close();
  const script=`import {backupDataset,verifyBackup} from ${JSON.stringify(new URL('../scripts/backup-data.mjs',import.meta.url).href)}; const start=performance.now();await backupDataset({dataDir:${JSON.stringify(dataDir)},outputDir:${JSON.stringify(path.join(dir,'backup'))}});verifyBackup(${JSON.stringify(path.join(dir,'backup'))});console.log(JSON.stringify({peakRssKiB:process.resourceUsage().maxRSS,elapsedMs:performance.now()-start}));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000});assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout.trim());
  const dbBytes=statSync(path.join(dataDir,'iep.sqlite')).size;t.diagnostic(JSON.stringify({dbBytes,...result}));assert.ok(dbBytes>96*1024*1024);assert.ok(result.peakRssKiB*1024<dbBytes,JSON.stringify({dbBytes,...result}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('restore failure on a separate media destination removes only its newly created data',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'iep-restore-failure-'));try{
  const source=path.join(dir,'source');mkdirSync(source);const db=new DatabaseSync(path.join(source,'iep.sqlite'));db.exec('CREATE TABLE minimal(id INTEGER)');db.close();const outputDir=path.join(dir,'backup');await backupDataset({dataDir:source,outputDir});
  const blocked=path.join(dir,'blocked');writeFileSync(blocked,'preserve');const dataDir=path.join(dir,'restored'),mediaDir=path.join(blocked,'media');
  assert.throws(()=>restoreDataset({backupDir:outputDir,dataDir,mediaDir}));assert.equal(readFileSync(blocked,'utf8'),'preserve');assert.throws(()=>statSync(dataDir),/ENOENT/);assert.equal(verifyBackup(outputDir).complete,true);
  const alias=path.join(dir,'alias');symlinkSync(path.join(dir,'not-yet-created'),alias);assert.throws(()=>restoreDataset({backupDir:outputDir,dataDir:alias}),/dangling|new data/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
