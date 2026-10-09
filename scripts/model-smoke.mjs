import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {launchBrowser} from './browser-support.mjs';
import {createApp} from '../server/index.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),models=process.env.IEP_MODELS_DIR||path.join(root,'.local/models');
for(const name of ['mobilenet','detector']){const folder=path.join(models,name),manifest=JSON.parse(readFileSync(path.join(folder,'provenance.json'),'utf8'));assert.equal(manifest.verified_upstream_md5,true);assert.ok(manifest.source.startsWith('https://storage.googleapis.com/tfjs-models/'));for(const[file,hash]of Object.entries(manifest.sha256)){assert.equal(path.basename(file),file);assert.equal(createHash('sha256').update(readFileSync(path.join(folder,file))).digest('hex'),hash);}console.log('PASS verified local SHA256:',name);}
const dataDir=mkdtempSync(path.join(tmpdir(),'iep-model-')),app=createApp({dataDir,adminPassword:randomBytes(24).toString('hex')});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let browser;
try{browser=await launchBrowser();const page=await browser.newPage();await page.goto('http://127.0.0.1:'+app.server.address().port);const result=await page.evaluate(async()=>{await tf.setBackend('cpu');await tf.ready();const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;canvas.getContext('2d').fillRect(0,0,320,240);const model=await mobilenet.load({version:2,alpha:1,modelUrl:'/models/mobilenet/model.json',inputRange:[0,1]}),detector=await cocoSsd.load({base:'lite_mobilenet_v2',modelUrl:'/models/detector/model.json'});let dimensions=0;for(let i=0;i<3;i++){const t=model.infer(canvas,true),values=await t.data();if(!values.length||![...values].every(Number.isFinite))throw Error('Invalid embedding');dimensions=values.length;t.dispose();const predictions=await detector.detect(canvas);if(!Array.isArray(predictions))throw Error('Invalid detector result');}model.model.dispose();detector.dispose();return {backend:tf.getBackend(),frames:3,dimensions};});assert.equal(result.backend,'cpu');assert.equal(result.frames,3);console.log('PASS actual CPU model inference, 3 synthetic frames, embedding dimensions:',result.dimensions);console.log('Restaurant recognition accuracy is not measured by this test.');}finally{await browser?.close();await new Promise(r=>app.server.close(r));rmSync(dataDir,{recursive:true,force:true});}
