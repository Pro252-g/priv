import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,lstatSync,rmSync,chmodSync,openSync,readSync,closeSync,fsyncSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertStorageOutsidePublic,canonicalPath,privateFilePath,secureSQLiteFiles} from '../server/storage-security.mjs';
const publicDir=fileURLToPath(new URL('../public',import.meta.url));
const keyValid=k=>typeof k==='string'&&/^t[1-9]\d*\/[a-f0-9]{64}$/.test(k);
const privateConfiguration=(dataDir,mediaDir=dataDir)=>assertStorageOutsidePublic({dataDir,mediaDir,publicDir});
const present=f=>{try{lstatSync(f);return true;}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return false;throw e;}};
function regularFile(file){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('Expected a private regular file');return st;}
// Synchronous hashing reuses one buffer across database and image files.
const hashBuffer=Buffer.allocUnsafe(1024*1024);
export function hashFile(file){regularFile(file);const hash=createHash('sha256'),buffer=hashBuffer,fd=openSync(file,'r');try{let bytes;while((bytes=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,bytes));return hash.digest('hex');}finally{closeSync(fd);}}
function durableFile(file){const fd=openSync(file,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function durableDirectory(dir){const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function reserveDirectory(dir){if(present(dir))throw Error('Output must be a new directory');mkdirSync(path.dirname(path.resolve(dir)),{recursive:true,mode:0o700});mkdirSync(dir,{mode:0o700});}
function referenceTables(db){const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));if(!tables.has('media_objects'))return[];return ['samples','events','unknown_crossings'].filter(t=>tables.has(t)&&db.prepare(`PRAGMA table_info(${t})`).all().some(c=>c.name==='image_key'));}
function* references(db){
 const tables=referenceTables(db);if(!tables.length)return;
 const query=`SELECT refs.image_key referenced_key,m.* FROM (${tables.map(t=>`SELECT image_key FROM ${t} WHERE image_key IS NOT NULL`).join(' UNION ')}) refs LEFT JOIN media_objects m ON m.image_key=refs.image_key`;
 // SQLite deduplicates through indexes/temp pages; JS consumes a row at a time.
 for(const row of db.prepare(query).iterate()){
  if(!keyValid(row.referenced_key)||!row.image_key||row.sha256!==row.image_key.split('/')[1]||`t${row.owner_id}`!==row.image_key.split('/')[0]||!Number.isSafeInteger(row.byte_size)||row.byte_size<1)throw Error('Invalid media index');
  yield row;
 }
}
function verifiedMedia(dir,row){const file=privateFilePath(dir,row.image_key),st=regularFile(file);if(st.size!==row.byte_size||hashFile(file)!==row.sha256)throw Error('Image integrity failure');return file;}
export async function backupDataset({dataDir,mediaDir=path.join(dataDir,'media'),outputDir}){
 privateConfiguration(dataDir,mediaDir);privateConfiguration(outputDir);if(present(outputDir))throw Error('Backup output must be a new directory');regularFile(path.join(dataDir,'iep.sqlite'));reserveDirectory(outputDir);
 let complete=false;
 try{
  const target=path.join(outputDir,'iep.sqlite'),source=new DatabaseSync(path.join(dataDir,'iep.sqlite'),{readOnly:true});try{await backup(source,target);}finally{source.close();}chmodSync(target,0o600);durableFile(target);
  const db=new DatabaseSync(target,{readOnly:true}),manifest={version:1,createdAt:new Date().toISOString(),databaseSha256:hashFile(target),images:[],missing:[],complete:true};
  try{for(const row of references(db)){
   let copied;
   try{const sourceFile=verifiedMedia(mediaDir,row),file=path.join(outputDir,'media',row.image_key);mkdirSync(path.dirname(file),{recursive:true,mode:0o700});copyFileSync(sourceFile,file,constants.COPYFILE_EXCL);copied=file;chmodSync(file,0o600);if(hashFile(file)!==row.sha256)throw Error('Backup copy changed during copy');durableFile(file);durableDirectory(path.dirname(file));manifest.images.push({key:row.image_key,sha256:row.sha256,bytes:row.byte_size});}
   catch{if(copied)rmSync(copied,{force:true});manifest.missing.push(row.image_key);manifest.complete=false;}
  }}finally{db.close();}
  const manifestFile=path.join(outputDir,'manifest.json');writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});durableFile(manifestFile);durableDirectory(outputDir);complete=true;return manifest;
 }finally{if(!complete)rmSync(outputDir,{recursive:true,force:true});}
}
export function verifyBackup(dir){
 const database=path.join(dir,'iep.sqlite');regularFile(path.join(dir,'manifest.json'));const manifest=JSON.parse(readFileSync(path.join(dir,'manifest.json'),'utf8'));
 if(manifest.version!==1||!Array.isArray(manifest.images)||!Array.isArray(manifest.missing)||hashFile(database)!==manifest.databaseSha256)throw Error('Backup manifest/database integrity failed');
 const db=new DatabaseSync(database,{readOnly:true}),refs=new Map();try{if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Database integrity failed');for(const row of references(db))refs.set(row.image_key,row);}finally{db.close();}
 for(const entry of manifest.images){
  if(!keyValid(entry.key))throw Error('Invalid media manifest key');const row=refs.get(entry.key);if(!row)throw Error('Invalid/duplicate media manifest key');
  if(entry.bytes!==row.byte_size||entry.sha256!==row.sha256)throw Error('Backup image integrity failed');
  try{verifiedMedia(path.join(dir,'media'),row);}catch{throw Error('Backup image integrity failed');}refs.delete(entry.key);
 }
 for(const key of manifest.missing){if(!keyValid(key)||!refs.has(key))throw Error('Invalid/duplicate missing media key');refs.delete(key);}
 if(refs.size||manifest.complete!==!manifest.missing.length)throw Error('Backup references incomplete');return manifest;
}
function normalizeRestoredMedia(dataDir,manifest){
 const db=new DatabaseSync(path.join(dataDir,'iep.sqlite'));
 try{
  const tables=referenceTables(db);if(!tables.length)return;
  for(const table of tables)db.exec(`CREATE INDEX IF NOT EXISTS ${table}_image_key_idx ON ${table}(image_key) WHERE image_key IS NOT NULL`);
  const object=db.prepare('UPDATE media_objects SET status=?,error_code=? WHERE image_key=?'),statements=tables.map(table=>db.prepare(`UPDATE ${table} SET media_status=? WHERE image_key=? AND ${table==='samples'?'data':'snapshot'} IS NULL`));
  db.exec('BEGIN');try{
   const update=(status,key)=>{object.run(status,status==='ready'?null:'file_missing',key);for(const statement of statements)statement.run(status,key);};
   for(const image of manifest.images)update('ready',image.key);for(const key of manifest.missing)update('missing',key);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }finally{db.close();secureSQLiteFiles(dataDir);}
}
export function restoreDataset({backupDir,dataDir,mediaDir=path.join(dataDir,'media'),allowIncomplete=false}){
 const manifest=verifyBackup(backupDir);if(!manifest.complete&&!allowIncomplete)throw Error('Incomplete media backup: explicit allowIncomplete required');privateConfiguration(dataDir,mediaDir);
 if(present(dataDir)||present(mediaDir))throw Error('Restore requires new data and media directories');const data=path.resolve(dataDir),media=path.resolve(mediaDir),canonicalData=canonicalPath(data),canonicalMedia=canonicalPath(media),canonicalBackup=canonicalPath(backupDir);
 if(canonicalData===canonicalMedia||canonicalData.startsWith(canonicalMedia+path.sep))throw Error('Data and media directories must differ; media cannot contain data');
 if([canonicalData,canonicalMedia].some(dir=>dir===canonicalBackup||dir.startsWith(canonicalBackup+path.sep)))throw Error('Restore directories must be outside the backup');
 let madeData=false,madeMedia=false;
 try{
  reserveDirectory(data);madeData=true;reserveDirectory(media);madeMedia=true;const database=path.join(data,'iep.sqlite');copyFileSync(path.join(backupDir,'iep.sqlite'),database,constants.COPYFILE_EXCL);chmodSync(database,0o600);if(hashFile(database)!==manifest.databaseSha256)throw Error('Database changed during restore');
  for(const entry of manifest.images){const file=path.join(media,entry.key);mkdirSync(path.dirname(file),{recursive:true,mode:0o700});copyFileSync(privateFilePath(path.join(backupDir,'media'),entry.key),file,constants.COPYFILE_EXCL);chmodSync(file,0o600);if(hashFile(file)!==entry.sha256)throw Error('Image changed during restore');durableFile(file);durableDirectory(path.dirname(file));}
  normalizeRestoredMedia(data,manifest);durableFile(database);durableDirectory(data);durableDirectory(media);
  // A completed, private pair can now be configured and started. No running dataset is overwritten.
  return manifest;
 }catch(e){if(madeData)rmSync(data,{recursive:true,force:true});if(madeMedia&&!media.startsWith(data+path.sep))rmSync(media,{recursive:true,force:true});throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),arg=key=>{const index=args.indexOf(key),value=args[index+1];if(index<0||!value||value.startsWith('--'))throw Error(`Missing value for ${key}`);return value;};
 try{
  const modes=['--verify','--restore','--output'].filter(flag=>args.includes(flag));if(modes.length!==1)throw Error('Choose exactly one of --output, --verify or --restore');if(args.includes('--allow-incomplete')&&!args.includes('--restore'))throw Error('--allow-incomplete applies only to --restore');
  const allowed=new Set(['--verify','--restore','--output','--data-dir','--media-dir','--allow-incomplete']);for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw Error('Unknown backup option');if(args[i]!=='--allow-incomplete'){arg(args[i]);i++;}}
  const dataDir=args.includes('--data-dir')?arg('--data-dir'):process.env.IEP_DATA_DIR||'.local/data',mediaDir=args.includes('--media-dir')?arg('--media-dir'):process.env.IEP_MEDIA_DIR||path.join(dataDir,'media');
  if(args.includes('--verify')){const result=verifyBackup(arg('--verify'));console.log(JSON.stringify({verified:true,complete:result.complete,images:result.images.length,missing:result.missing.length}));if(!result.complete)process.exitCode=2;}
  else if(args.includes('--restore')){const result=restoreDataset({backupDir:arg('--restore'),dataDir,mediaDir,allowIncomplete:args.includes('--allow-incomplete')});console.log(JSON.stringify({restored:true,complete:result.complete,images:result.images.length}));}
  else if(args.includes('--output')){const result=await backupDataset({dataDir,mediaDir,outputDir:arg('--output')});console.log(JSON.stringify({backupSaved:true,complete:result.complete,images:result.images.length,missing:result.missing.length}));if(!result.complete)process.exitCode=2;}
  else throw Error('Use --output NEW_DIR, --verify BACKUP_DIR or --restore BACKUP_DIR --data-dir NEW_DIR [--media-dir NEW_DIR]');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
