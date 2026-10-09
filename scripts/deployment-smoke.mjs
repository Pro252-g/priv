// Optional Docker/Compose acceptance on loopback only, with a trusted Caddy local CA.
// Does not publish a website or validate a public domain/ACME provider.
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
const temporary=await mkdtemp(path.join(tmpdir(),'iep-deploy-check-'));
const project='iep-check-'+randomBytes(5).toString('hex'),password=randomBytes(24).toString('hex');
const docker=['--config',process.env.IEP_DOCKER_CONFIG||'/tmp/iep-root-docker'];
async function command(args){return await new Promise((resolve,reject)=>{const child=spawn('docker',[...docker,...args],{cwd:root,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Deployment command timeout'))},120000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(`Docker check failed ${code}: ${output}`));});});}
async function freePort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
const httpPort=await freePort(),tlsPort=await freePort();
await writeFile(path.join(temporary,'api.env'),`IEP_ADMIN_EMAIL=admin@iep.local\nIEP_ADMIN_PASSWORD=${password}\n`,{mode:0o600});
await writeFile(path.join(temporary,'cloud.env'),`IEP_DOMAIN=localhost\nIEP_TLS_EMAIL=acceptance@example.com\nIEP_API_ENV_FILE=${temporary}/api.env\nIEP_NETWORK_SUBNET=172.30.91.0/24\nIEP_API_IP=172.30.91.2\nIEP_PROXY_IP=172.30.91.3\n`,{mode:0o600});
await writeFile(path.join(temporary,'override.yml'),`services:\n  api:\n    healthcheck:\n      interval: 2s\n      start_period: 2s\n  proxy:\n    ports: !override\n      - "127.0.0.1:${httpPort}:8080"\n      - "127.0.0.1:${tlsPort}:8443"\n`,{mode:0o600});
const compose=['compose','-p',project,'--env-file',path.join(temporary,'cloud.env'),'-f',path.join(root,'deploy/compose.yml'),'-f',path.join(temporary,'override.yml')];
let ca,cookie='';
async function request(endpoint,body){return await new Promise((resolve,reject)=>{const data=body===undefined?undefined:Buffer.from(JSON.stringify(body));const req=https.request({hostname:'localhost',family:4,port:tlsPort,path:endpoint,ca,method:data?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie,...(data?{'Content-Length':data.length}:{})}},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,bytes:Buffer.concat(chunks)}));});req.setTimeout(10000,()=>req.destroy(Error('TLS request timeout')));req.on('error',reject);if(data)req.write(data);req.end();});}
async function api(endpoint,body){const r=await request(endpoint,body);assert.equal(r.status,200,`${endpoint}: ${r.status} ${r.bytes.toString()}`);return JSON.parse(r.bytes);}
try{
 await command([...compose,'config','--quiet']);
 await command([...compose,'up','-d','--no-build','api','proxy']);
 const proxy=(await command([...compose,'ps','-q','proxy'])).trim();assert.ok(proxy);
 // Wait only on this test stack's certificate file, with bounded small polls.
 let copied=false;for(let attempt=0;attempt<25;attempt++){try{await command(['cp',`${proxy}:/data/caddy/pki/authorities/local/root.crt`,path.join(temporary,'root.crt')]);copied=true;break;}catch{await new Promise(r=>setTimeout(r,200));}}
 assert.ok(copied,'Caddy did not issue its local certificate');ca=await readFile(path.join(temporary,'root.crt'));
 assert.equal((await api('/api/health')).ok,true);
 const page=await request('/');assert.equal(page.status,200);assert.ok(page.bytes.toString().includes('IEP'));
 assert.equal((await request('/vendor/tf.min.js')).status,200);
 const redirect=await new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:httpPort,path:'/',headers:{Host:'localhost'}},r=>{r.resume();resolve({status:r.statusCode,location:r.headers.location});}).on('error',reject);});
 assert.equal(redirect.status,301);assert.equal(redirect.location,'https://localhost/');
 const login=await request('/api/login',{email:'admin@iep.local',password});assert.equal(login.status,200);assert.ok(login.headers['set-cookie'][0].includes('Secure'));cookie=login.headers['set-cookie'][0].split(';')[0];
 const me=await api('/api/me');assert.equal(me.user.role,'owner');
 const post=async(endpoint,body)=>{const r=await request(endpoint,body);assert.ok(r.status===200||r.status===201,`${endpoint}: ${r.status} ${r.bytes.toString()}`);return JSON.parse(r.bytes);};
 const rid=(await post('/api/restaurants',{name:'Docker TLS acceptance'})).restaurant.id;
 const dish=(await post('/api/dishes',{restaurantId:rid,name:'Test output'})).dish;
 const imageBytes=await readFile(path.join(root,'.local/edge-models/dog.jpg'));
 const image='data:image/jpeg;base64,'+imageBytes.toString('base64');
 await post(`/api/dishes/${dish.id}/samples`,{image,variantLabel:'Deployment evidence'});
 const result=await api('/api/events',{restaurantId:rid,events:[{dishId:dish.id,sessionId:'docker-check',trackId:'1',crossingId:'1',occurredAt:new Date().toISOString(),confidence:1,mode:'manual',image}]});assert.equal(result.inserted,1);assert.equal(result.mediaPending??0,0);
 const report=await api(`/api/reports?restaurantId=${rid}`);assert.equal(report.total,1);
 const imageResponse=await request(report.events[0].snapshot_url);assert.equal(imageResponse.status,200);assert.equal(createHash('sha256').update(imageResponse.bytes).digest('hex'),createHash('sha256').update(imageBytes).digest('hex'));
 cookie='';assert.equal((await request(report.events[0].snapshot_url)).status,401);
 await command([...compose,'run','--rm','-e','IEP_BACKUP_ID=acceptance','backup']);
 const verification=await command([...compose,'run','--rm','backup','node','/app/scripts/backup-data.mjs','--verify','/backups/acceptance']);assert.ok(verification.includes('"complete": true')||verification.includes('"complete":true'),verification);
 const apiId=(await command([...compose,'ps','-q','api'])).trim();
 assert.equal((await command(['exec',apiId,'id','-u'])).trim(),'1000');
 const evidence={schemaVersion:1,checks:{composeStartup:true,nonrootUid1000:true,tlsVerifiedLocalCA:true,httpRedirect:true,webPageAndVendorAssets:true,secureCookie:true,authenticatedCatalogAndEvent:true,privateSnapshotAnd401Isolation:true,backupVerified:true},
 limitations:'Loopback Caddy internal CA, no public ACME/domain, VPS/Android/NVR hardware or restaurant accuracy validation.'};
 if(process.env.IEP_DEPLOY_EVIDENCE)await writeFile(process.env.IEP_DEPLOY_EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence,null,2));
}catch(error){
 const logs=await command([...compose,'logs','--no-color','--tail','40','api','proxy']).catch(()=> 'Logs unavailable');
 throw Error(error.message+'\n'+logs);
}finally{await command([...compose,'down','-v','--remove-orphans']);await rm(temporary,{recursive:true,force:true});}
