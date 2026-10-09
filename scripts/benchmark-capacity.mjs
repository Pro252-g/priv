/** Bounded, reproducible capacity probe; no production data or credentials used.
 * Uses the installed Playwright dependency and optional IEP_BROWSER_EXECUTABLE.
 * Uses actual local models on a synthetic canvas: measures latency, NOT accuracy.
 */
import {mkdtempSync,rmSync,readFileSync,statSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir,cpus,totalmem,freemem} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {launchBrowser} from './browser-support.mjs';
import {createApp} from '../server/index.mjs';
import {cairoDate,cairoDayInterval} from '../server/business-day.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=mkdtempSync(path.join(tmpdir(),'iep-capacity-'));
const password=randomBytes(24).toString('hex');
const samples=Math.max(3,Math.min(12,Number(process.env.IEP_BENCH_SAMPLES)||5));
const parseLimit=file=>{try{return readFileSync(file,'utf8').trim();}catch{return null;}};
const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,meanMs:values.reduce((a,b)=>a+b,0)/values.length,p50Ms:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)],maxMs:sorted.at(-1)};};
const report={generatedAt:new Date().toISOString(),method:'Bounded synthetic workload, real models. No restaurant accuracy, 24h endurance, mobile-device, or multi-client test implied.',resources:{node:process.version,architecture:process.arch,cpuModel:cpus()[0]?.model,visibleCpuCount:cpus().length,cgroupCpuMax:parseLimit('/sys/fs/cgroup/cpu.max'),cgroupMemoryMax:parseLimit('/sys/fs/cgroup/memory.max'),hostTotalMemoryBytes:totalmem(),hostFreeMemoryBytes:freemem()},database:[],inference:[]};
const app=createApp({dataDir,adminPassword:password});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+app.server.address().port;
let browser;
try{
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@iep.local',password})});
 if(!login.ok)throw Error('Temporary benchmark login failed');
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const user=app.db.prepare("SELECT id FROM users WHERE email='admin@iep.local'").get().id;
 const restaurant=Number(app.db.prepare('INSERT INTO restaurants(user_id,name) VALUES(?,?)').run(user,'Capacity fixture').lastInsertRowid);
 const dishes=Array.from({length:20},(_,i)=>Number(app.db.prepare('INSERT INTO dishes(restaurant_id,name) VALUES(?,?)').run(restaurant,'Fixture '+i).lastInsertRowid));
 const insert=app.db.prepare('INSERT INTO events(user_id,restaurant_id,dish_id,session_id,track_id,crossing_id,camera,occurred_at,confidence,mode) VALUES(?,?,?,?,?,?,?,?,?,?)');
 const epoch=Date.parse('2026-01-01T06:00:00Z');
 let rows=0;
 for(const target of [100000,1000000]){
  const started=performance.now();
  while(rows<target){app.db.exec('BEGIN');try{const stop=Math.min(rows+10000,target);for(;rows<stop;rows++){
   const day=Math.floor(rows/5000),within=rows%5000;
   const occurredAt=new Date(epoch+day*86400000+within*(12*3600000/5000)).toISOString();
   insert.run(user,restaurant,dishes[rows%20],'benchmark',String(rows),'one',rows%2?'drinks':'food',occurredAt,.9,rows%10?'automatic':'manual');
  }app.db.exec('COMMIT');}catch(e){app.db.exec('ROLLBACK');throw e;}}
  const insertMs=performance.now()-started;
  app.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const day=cairoDate(new Date(epoch+(Math.floor((target-1)/5000))*86400000));
  const interval=cairoDayInterval(day),timings={reconciliation:[],report:[]};
  for(let i=0;i<samples+1;i++)for(const [kind,url]of [['reconciliation',`/api/reconciliation?restaurantId=${restaurant}&businessDate=${day}`],['report',`/api/reports?restaurantId=${restaurant}&from=${encodeURIComponent(interval.from)}&to=${encodeURIComponent(interval.to)}`]]){
   const t=performance.now(),response=await fetch(base+url,{headers:{Cookie:cookie}}),result=await response.json();
   if(!response.ok)throw Error(kind+' benchmark HTTP '+response.status);
   if(kind==='report'&&result.total!==5000)throw Error('Report count changed: '+result.total);
   if(kind==='reconciliation'&&result.rows.reduce((n,row)=>n+row.observed,0)!==5000)throw Error('Reconciliation count changed');
   if(i)timings[kind].push(performance.now()-t);
  }
  const sizes={};for(const suffix of ['','-wal','-shm'])sizes[suffix||'main']=existsSync(path.join(dataDir,'iep.sqlite'+suffix))?statSync(path.join(dataDir,'iep.sqlite'+suffix)).size:0;
  report.database.push({rows,eventsPerDay:5000,catalogItems:20,days:target/5000,snapshots:false,insertedRows:target-(target===100000?0:100000),insertMs,selectedDay:day,returnedEventsLimit:1000,reconciliation:stats(timings.reconciliation),report:stats(timings.report),sqliteBytes:sizes,nodeMemory:process.memoryUsage()});
  console.log('Measured database fixture:',target,'events');
 }
 try{browser=await launchBrowser({args:['--enable-unsafe-swiftshader']});}catch(error){report.inference.push({skipped:'Browser unavailable: '+error.message});}
 if(browser){
  for(const backend of ['cpu','webgl']){
   const page=await browser.newPage();
   await page.goto(base);
   try{
    const measured=await page.evaluate(async({backend,samples})=>{
     const summary=values=>{const s=[...values].sort((a,b)=>a-b);return {samples:values.length,meanMs:values.reduce((a,b)=>a+b,0)/values.length,p50Ms:s[Math.floor(s.length/2)],p95Ms:s[Math.min(s.length-1,Math.ceil(s.length*.95)-1)],maxMs:s.at(-1)};};
     if(!await tf.setBackend(backend))throw Error('TensorFlow backend unavailable: '+backend);await tf.ready();
     const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');ctx.fillStyle='#e5e7eb';ctx.fillRect(0,0,640,360);ctx.fillStyle='#48515d';for(let i=0;i<4;i++){ctx.beginPath();ctx.ellipse(80+i*150,180,55,45,0,0,Math.PI*2);ctx.fill();}
     const rendererCanvas=document.createElement('canvas'),gl=rendererCanvas.getContext('webgl2')||rendererCanvas.getContext('webgl'),debug=gl?.getExtension('WEBGL_debug_renderer_info');
     const renderer=gl?(debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)):'unavailable';
     const loadStart=performance.now();
     const m=await mobilenet.load({version:2,alpha:1,modelUrl:'/models/mobilenet/model.json',inputRange:[0,1]});
     const d=await cocoSsd.load({base:'lite_mobilenet_v2',modelUrl:'/models/detector/model.json'});
     const modelLoadMs=performance.now()-loadStart;
     const crops=Array.from({length:4},(_,i)=>{const crop=document.createElement('canvas');crop.width=160;crop.height=160;crop.getContext('2d').drawImage(canvas,i*150,90,150,180,0,0,160,160);return crop;});
     const detect=[],one=[],four=[],combined=[];
     const memoryBefore=tf.memory();
     for(let iteration=0;iteration<samples+1;iteration++){
      let t=performance.now();await d.detect(canvas,15,.5);const det=performance.now()-t;
      t=performance.now();let vector=m.infer(crops[0],true);await vector.data();vector.dispose();const single=performance.now()-t;
      t=performance.now();for(const crop of crops){vector=m.infer(crop,true);await vector.data();vector.dispose();}const all=performance.now()-t;
      if(iteration){detect.push(det);one.push(single);four.push(all);combined.push(det+all);}
     }
     const memoryAfter=tf.memory();m.model.dispose();d.dispose();
     return {backend:tf.getBackend(),renderer,canvas:{width:640,height:360},modelLoadMs,warmupIterations:1,detector:summary(detect),oneEmbedding:summary(one),fourEmbeddings:summary(four),detectorPlusFour:summary(combined),tensorMemoryBefore:memoryBefore,tensorMemoryAfter:memoryAfter,browserJsHeap:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null,limitations:'Synthetic pixels; 4 forced crop embeddings rather than detection/classification accuracy; excludes video decode/seek, reference cosine matching, tracking, server/network writes and thermals.'};
    },{backend,samples});
    report.inference.push(measured);console.log('Measured real-model backend:',backend);
   }catch(e){report.inference.push({backend,error:e.message});console.log('Backend measurement unavailable:',backend);}
   await page.close();
  }
 }
 report.modelFiles=Object.fromEntries(['mobilenet','detector'].map(name=>{const p=path.join(root,'.local/models',name,'provenance.json');return [name,existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null];}));
 const output=process.env.IEP_BENCH_OUTPUT;
 if(output){writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log('Benchmark result saved:',output);}else console.log(JSON.stringify(report,null,2));
}finally{
 await browser?.close();
 await new Promise(resolve=>app.server.close(resolve));
 rmSync(dataDir,{recursive:true,force:true});
}
