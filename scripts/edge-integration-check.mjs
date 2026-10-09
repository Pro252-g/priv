// Genuine ONNX inference and file->private API->report integration.
// Input is a public general-object image; this does not measure restaurant accuracy.
import {createApp} from '../server/index.mjs';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),python=process.env.IEP_EDGE_PYTHON||path.join(root,'.local/edge-venv/bin/python');
const input=process.argv[2];if(!input)throw Error('Provide path to official YOLOX dog.jpg fixture; do not substitute a restaurant accuracy claim');
const directory=await mkdtemp(path.join(tmpdir(),'iep-native-integration-'));
const password=randomBytes(24).toString('hex');
const app=createApp({dataDir:path.join(directory,'data'),mediaDir:path.join(directory,'media'),adminPassword:password});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
async function api(endpoint,body){const response=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});const payload=await response.json();assert.ok(response.ok,`${endpoint}: ${response.status} ${JSON.stringify(payload)}`);return{payload,cookie:response.headers.get('set-cookie')};}
async function command(args,extraEnv={}){return await new Promise((resolve,reject)=>{const child=spawn(python,args,{cwd:root,env:{...process.env,OPENBLAS_NUM_THREADS:'1',...extraEnv},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',c=>{output+=c});child.stderr.on('data',c=>{output+=c});const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Native integration command timed out'))},90000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code===0)resolve(output);else reject(Error(`Native command failed ${code}: ${output}`));});});}
try{
 cookie=(await api('/api/login',{email:'admin@iep.local',password})).cookie.split(';')[0];
 const rid=(await api('/api/restaurants',{name:'Native integration fixture'})).payload.restaurant.id;
 const dish=(await api('/api/dishes',{restaurantId:rid,name:'General dog fixture',kind:'object',recognitionMode:'detector',detectorClasses:['dog']})).payload.dish;
 const calibration={roi:[0,0,1,1],line:{orientation:'horizontal',position:.5,direction:'down'},targetFps:5,maxObjects:4};
 const source=(await api('/api/sources',{restaurantId:rid,sourceId:'fixture-file',name:'General file fixture',kind:'file',config:calibration})).payload.source;
 const experiment=(await api('/api/experiments',{restaurantId:rid,name:'Real ONNX file pipeline',videoName:'generated-general-object.avi',durationSec:5})).payload.experiment;
 const keyResult=(await api('/api/integration-keys',{label:'Ephemeral edge fixture',restaurantIds:[rid],scopes:['catalog.read','events.write','monitor.read','monitor.write','experiments.run'],validDays:1})).payload;
 const key=keyResult.key||keyResult.token;assert.match(key,/^iep_[a-f0-9]{64}$/);
 const video=path.join(directory,'fixture.avi');
 await command(['-c',`import cv2,numpy as np,sys
image=cv2.imread(sys.argv[1]);assert image is not None
image=cv2.resize(image,(320,240));writer=cv2.VideoWriter(sys.argv[2],cv2.VideoWriter_fourcc(*'MJPG'),10,(640,480));assert writer.isOpened()
for i in range(50):
 frame=np.full((480,640,3),114,dtype=np.uint8);y=int(i*220/49);frame[y:y+240,160:480]=image;writer.write(frame)
writer.release()`,path.resolve(input),video]);
 const videoSha=createHash('sha256').update(await readFile(video)).digest('hex');
 const config={api:{baseUrl:base,restaurantId:rid,apiKeyEnv:'IEP_TEST_EDGE_KEY',allowInsecureLocal:true,timeoutSec:2},source:{id:source.id,sourceId:source.sourceId,kind:'file',path:video,sha256:videoSha,experimentId:experiment.id,startTime:'2026-10-09T10:00:00Z'},
 detector:{path:path.join(root,'.local/edge-models/yolox_tiny.onnx'),sha256:'427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7',format:'yolox',inputSize:[416,416],scoreThreshold:.4},stateDir:path.join(directory,'state'),calibrated:true,...calibration,
 storage:{maxQueueBytes:64*1024*1024,maxQueueRows:1000,reserveFreeBytes:1024*1024},heartbeatSec:2,catalogRefreshSec:300};
 const configPath=path.join(directory,'edge.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 const environment={IEP_TEST_EDGE_KEY:key};
 const check=JSON.parse(await command(['edge/worker.py','check','--config',configPath],environment));assert.equal(check.ok,true);
 const output=await command(['edge/worker.py','run','--config',configPath],environment);
 let report=(await api(`/api/reports?restaurantId=${rid}&experimentId=${experiment.id}`)).payload;
 assert.equal(report.total,1,`Expected the genuine model dog fixture to cross once: ${output}`);
 assert.equal(report.events[0].dish_id,dish.id);assert.ok(report.events[0].snapshot_url);
 const imageResponse=await fetch(base+report.events[0].snapshot_url,{headers:{Cookie:cookie}});assert.equal(imageResponse.status,200);assert.ok((await imageResponse.arrayBuffer()).byteLength>100);
 assert.equal((await api(`/api/reports?restaurantId=${rid}`)).payload.total,0);
 // Replaying the identical file/config/catalog must keep immutable identities.
 await command(['edge/worker.py','run','--config',configPath],environment);
 report=(await api(`/api/reports?restaurantId=${rid}&experimentId=${experiment.id}`)).payload;assert.equal(report.total,1);
 const health=JSON.parse(await readFile(path.join(directory,'state','health.json')));assert.equal(health.metrics.blockedRows,0);
 const evidence={schemaVersion:1,checks:{realOnnxFilePipeline:true,privateCropRetrieval:true,operationalCountsUnchanged:true,identicalReplayCountOnce:true,blockedQueueRows:0},experimentCount:report.total,
 fixture:'Public YOLOX dog photograph composited into a moving CFR AVI; not restaurant dish recognition or NVR hardware',sourceChecks:check.checks};
 if(process.env.IEP_EDGE_EVIDENCE)await writeFile(process.env.IEP_EDGE_EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence,null,2));
}finally{await new Promise(r=>app.server.close(r));await rm(directory,{recursive:true,force:true});}
