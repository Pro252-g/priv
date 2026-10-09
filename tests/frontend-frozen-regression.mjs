import {launchBrowser} from '../scripts/browser-support.mjs';
import assert from 'node:assert/strict';
import {createApp} from '../server/index.mjs';
import {mkdtempSync,rmSync} from 'node:fs';import {randomBytes} from 'node:crypto';
const dir=mkdtempSync('/tmp/iep-freeze-'),password=randomBytes(24).toString('hex');const {server}=createApp({dataDir:dir,adminPassword:password});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await launchBrowser();
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.fill('#email','admin@iep.local');await page.fill('#password',password);await page.click('#loginForm button');await page.waitForFunction(()=>document.querySelector('#restaurantSelect').options.length);
 await page.clock.install();
 const heartbeatPayloads=[]; page.on('request',req=>{if(req.url().includes('/heartbeat'))heartbeatPayloads.push(req.postData());});
 await page.evaluate(()=>{
  window.mobilenet.load=async()=>({infer:()=>tf.tensor1d([1,0])});window.cocoSsd.load=async()=>({detect:async()=>[]});
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;canvas.getContext('2d').fillRect(0,0,320,240);const stream=canvas.captureStream(0);setTimeout(()=>stream.getVideoTracks()[0].requestFrame(),100);window.reviewSourceCanvas=canvas;
  navigator.mediaDevices.getUserMedia=async()=>stream;
 });
 await page.click('nav [data-page="camera"]');await page.click('#startCamera');await page.waitForFunction(()=>document.querySelector('#liveStatus').textContent.includes('تعرّف تجريبي'));
 const before=await page.evaluate(()=>{const v=document.querySelector('#video');return{time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,status:document.querySelector('#liveStatus').textContent}});
 await page.clock.runFor(40000);await new Promise(r=>setTimeout(r,100));
 const after=await page.evaluate(async()=>{const v=document.querySelector('#video'),{restaurants}=await(await fetch('/api/restaurants')).json(),report=await(await fetch('/api/monitor?restaurantId='+restaurants[0].id)).json();return{time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,status:document.querySelector('#liveStatus').textContent,monitor:report.monitors[0]}});
 assert.equal(after.frames,before.frames);assert.equal(after.monitor.status,'stalled');assert(after.monitor.gaps.some(g=>g.cause==='video_stalled'));assert(heartbeatPayloads.some(p=>JSON.parse(p).status==='stalled'));console.log('PASS frozen-frame health regression (inference stubbed solely to test liveness, no accuracy claim).');
}finally{await browser.close();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
