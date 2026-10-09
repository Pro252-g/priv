import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {canonicalPath,assertStorageOutsidePublic,ensurePrivateDirectory,secureSQLiteFiles,staticPathAllowed,privateFilePath} from './storage-security.mjs';

test('private storage resolves missing ancestors and rejects public symlink aliases',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'iep-paths-'));try{
  const pub=path.join(dir,'public');mkdirSync(pub);const privateDir=path.join(dir,'data');mkdirSync(privateDir);
  symlinkSync(pub,path.join(dir,'public-alias'));symlinkSync(privateDir,path.join(pub,'private-link'));
  assert.equal(canonicalPath(path.join(dir,'public-alias','new','nested')),path.join(pub,'new','nested'));
  for(const bad of [path.join(pub,'new'),path.join(dir,'public-alias','new','nested')]){
   assert.throws(()=>assertStorageOutsidePublic({dataDir:bad,mediaDir:privateDir,publicDir:pub}),/outside public/);
   assert.throws(()=>assertStorageOutsidePublic({dataDir:privateDir,mediaDir:bad,publicDir:pub}),/outside public/);
  }
  assert.doesNotThrow(()=>assertStorageOutsidePublic({dataDir:privateDir,mediaDir:path.join(privateDir,'new','nested'),publicDir:pub}));
  writeFileSync(path.join(privateDir,'iep.sqlite'),'private');writeFileSync(path.join(pub,'app.js'),'asset');
  assert.equal(staticPathAllowed(path.join(pub,'app.js'),pub),true);
  assert.equal(staticPathAllowed(path.join(pub,'private-link','iep.sqlite'),pub),false);
  assert.equal(staticPathAllowed(path.join(privateDir,'iep.sqlite'),pub),false);
  symlinkSync(path.join(dir,'gone'),path.join(dir,'dangling'));
  assert.throws(()=>canonicalPath(path.join(dir,'dangling','new')),/dangling/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('directory and SQLite modes are explicit without changing shared ancestors',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'iep-modes-'));try{
  const parent=path.join(dir,'shared');mkdirSync(parent,{mode:0o755});const initial=statSync(parent).mode&0o777;
  const sticky=path.join(dir,'shared-temporary');mkdirSync(sticky,{mode:0o1777});const originalSticky=statSync(sticky).mode&0o7777;symlinkSync(sticky,path.join(dir,'sticky-alias'));assert.throws(()=>ensurePrivateDirectory(path.join(dir,'sticky-alias')),/dedicated private/);assert.equal(statSync(sticky).mode&0o7777,originalSticky);assert.throws(()=>ensurePrivateDirectory(path.parse(dir).root),/dedicated private/);
  const data=ensurePrivateDirectory(path.join(parent,'private'));
  assert.equal(statSync(data).mode&0o777,0o700);assert.equal(statSync(parent).mode&0o777,initial);
  for(const name of ['iep.sqlite','iep.sqlite-wal','iep.sqlite-shm'])writeFileSync(path.join(data,name),'x',{mode:0o644});
  secureSQLiteFiles(data);for(const name of ['iep.sqlite','iep.sqlite-wal','iep.sqlite-shm'])assert.equal(statSync(path.join(data,name)).mode&0o777,0o600);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('tenant image directories and file symlinks cannot escape private storage',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'iep-filepath-'));try{
  const media=path.join(dir,'media'),outside=path.join(dir,'outside');mkdirSync(media);mkdirSync(outside);
  const key='t1/'+ 'a'.repeat(64);symlinkSync(outside,path.join(media,'t1'));assert.throws(()=>privateFilePath(media,key),/symbolic link/);
  rmSync(path.join(media,'t1'));mkdirSync(path.join(media,'t1'));symlinkSync(path.join(outside,'secret'),path.join(media,key));assert.throws(()=>privateFilePath(media,key),/symbolic link/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('application startup blocks unsafe roots and static routes block links to private data',async()=>{
 const {createApp}=await import('./index.mjs'),publicDir=new URL('../public/',import.meta.url).pathname;
 const dir=mkdtempSync(path.join(tmpdir(),'iep-storage-api-')),linkName=path.basename(dir)+'-private',link=path.join(publicDir,linkName);let app;
 try{
  const dataDir=path.join(dir,'data'),mediaDir=path.join(dir,'media'),alias=path.join(dir,'public-alias');symlinkSync(publicDir,alias);
  assert.throws(()=>createApp({dataDir:path.join(alias,'new-private'),mediaDir,adminPassword:'storage-test-password'}),/outside public/);
  assert.throws(()=>createApp({dataDir,mediaDir:path.join(alias,'new-private'),adminPassword:'storage-test-password'}),/outside public/);
  app=createApp({dataDir,mediaDir,adminPassword:'storage-test-password'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  for(const name of ['iep.sqlite','iep.sqlite-wal','iep.sqlite-shm'])assert.equal(statSync(path.join(dataDir,name)).mode&0o777,0o600);
  symlinkSync(dataDir,link);const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/'+linkName+'/iep.sqlite');assert.equal(response.status,404);
 }finally{if(app)await new Promise(r=>app.server.close(r));rmSync(link,{force:true});rmSync(dir,{recursive:true,force:true});}
});
