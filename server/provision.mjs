import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync} from 'node:crypto';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function provisionOwner({dataDir,email,password}) {
 if(typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email)||email.length>254)throw new Error('Set a valid IEP_NEW_OWNER_EMAIL.');
 if(typeof password!=='string'||password.length<12||password.length>1024)throw new Error('Set IEP_NEW_OWNER_PASSWORD with 12–1024 characters.');
 const filename=path.join(dataDir,'iep.sqlite');if(!existsSync(filename))throw new Error('Database missing. Start the application once before provisioning.');
 const db=new DatabaseSync(filename);try{if(db.prepare('SELECT id FROM users WHERE email=?').get(email))throw new Error('Account already exists; no changes made.');const salt=randomBytes(16).toString('hex');db.prepare('INSERT INTO users(email,name,salt,password) VALUES(?,?,?,?)').run(email,'Restaurant owner',salt,scryptSync(password,salt,64).toString('hex'));}finally{db.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{provisionOwner({dataDir:process.env.IEP_DATA_DIR||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.local/data'),email:process.env.IEP_NEW_OWNER_EMAIL,password:process.env.IEP_NEW_OWNER_PASSWORD});console.log('Owner account created.');}catch(e){console.error(e.message);process.exitCode=1;}}
