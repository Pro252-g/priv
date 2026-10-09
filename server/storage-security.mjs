import {mkdirSync,chmodSync,lstatSync,statSync,realpathSync} from 'node:fs';
import path from 'node:path';

const contained=(candidate,root)=>candidate===root||candidate.startsWith(root+path.sep);
// Resolve links even when the leaf (or several parent directories) does not exist yet.
export function canonicalPath(filename){
 let current=path.resolve(filename);const missing=[];
 while(true){try{return path.resolve(realpathSync(current),...missing.reverse());}catch(error){
  if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;
  // A dangling symlink is not a safe future storage root.
  try{if(lstatSync(current).isSymbolicLink())throw new Error('Storage path contains a dangling symbolic link');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}
  const parent=path.dirname(current);if(parent===current)throw error;missing.push(path.basename(current));current=parent;
 }}
}
export function assertStorageOutsidePublic({dataDir,mediaDir,publicDir}){
 const publiclyServed=canonicalPath(publicDir);
 for(const [name,dir] of [['IEP_DATA_DIR',dataDir],['IEP_MEDIA_DIR',mediaDir]])if(contained(canonicalPath(dir),publiclyServed))throw new Error(`${name} must be outside public assets, including symbolic links`);
}
export function ensurePrivateDirectory(dir){
 if(canonicalPath(dir)===path.parse(canonicalPath(dir)).root)throw new Error('Use a dedicated private storage directory');
 try{if(statSync(dir).mode&0o1000)throw new Error('Use a dedicated private storage directory, not a shared temporary directory');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}
 mkdirSync(dir,{recursive:true,mode:0o700});
 if(!lstatSync(dir).isDirectory()&&!lstatSync(dir).isSymbolicLink())throw new Error('Private storage path must be a directory');
 // Change the configured endpoint only; preserve permissions of shared parent directories.
 chmodSync(dir,0o700);
 return path.resolve(dir);
}
export function secureSQLiteFiles(dataDir){
 for(const name of ['iep.sqlite','iep.sqlite-wal','iep.sqlite-shm']){
  const f=path.join(dataDir,name);let st;try{st=lstatSync(f);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!st.isFile()||st.isSymbolicLink())throw new Error('SQLite files must be private regular files');
  chmodSync(f,0o600);
 }
}
export function staticPathAllowed(filename,publicDir){
 try{const root=canonicalPath(publicDir),target=canonicalPath(filename);return target!==root&&contained(target,root);}catch{return false;}
}
export function privateFilePath(directory,key){
 if(!/^t[1-9]\d*\/[a-f0-9]{64}$/.test(key))throw new Error('Invalid private image key');
 const root=canonicalPath(directory),file=path.join(path.resolve(directory),key),parent=path.dirname(file);
 // Tenant directories are created by this process; links in that layer are never accepted.
 try{if(lstatSync(parent).isSymbolicLink())throw new Error('Private media directory cannot be a symbolic link');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}
 if(!contained(canonicalPath(parent),root))throw new Error('Private image path escapes storage');
 try{if(lstatSync(file).isSymbolicLink())throw new Error('Private media file cannot be a symbolic link');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}
 return file;
}
