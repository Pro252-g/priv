import {randomBytes,createHash,scryptSync} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
export const ROLE_CAPABILITIES={
 owner:['restaurants.write','catalog.read','catalog.write','reports.read','pos.read','pos.write','events.write','events.manual','experiments.run','monitor.read','monitor.write','users.manage','integrations.manage','risks.read','risks.write','day.approve','audit.read'],
 manager:['catalog.read','catalog.write','reports.read','pos.read','pos.write','events.write','events.manual','experiments.run','monitor.read','monitor.write','users.manage','integrations.manage','risks.read','risks.write','day.approve','audit.read'],
 daily_operator:['catalog.read','reports.read','pos.read','pos.write','events.manual','monitor.read','risks.read','risks.write'],
 engineer:['catalog.read','catalog.write','reports.read','events.write','experiments.run','monitor.read','monitor.write','integrations.manage','risks.read','risks.write'],
 viewer:['catalog.read','reports.read','monitor.read','risks.read']
};
const KEY_SCOPES=['catalog.read','reports.read','pos.read','pos.write','events.write','monitor.read','monitor.write','experiments.run'];
export function initializeAccess(db){
 for(const col of ['owner_id INTEGER','role TEXT DEFAULT \'owner\'','disabled INTEGER DEFAULT 0'])if(!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name===col.split(' ')[0]))db.exec('ALTER TABLE users ADD COLUMN '+col);
 db.exec(`UPDATE users SET owner_id=id WHERE owner_id IS NULL;
 CREATE TABLE IF NOT EXISTS user_restaurants(user_id INTEGER REFERENCES users(id),restaurant_id INTEGER REFERENCES restaurants(id),PRIMARY KEY(user_id,restaurant_id));
 CREATE TABLE IF NOT EXISTS integration_keys(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),owner_id INTEGER,label TEXT,token_hash TEXT UNIQUE,scopes TEXT,restaurant_ids TEXT,expires_at TEXT,revoked_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY,owner_id INTEGER,actor_id INTEGER,action TEXT,resource TEXT,details TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE INDEX IF NOT EXISTS audit_owner_idx ON audit_log(owner_id,id);`);
}
export function createAccess({db,fail,text}){
 const tenantId=user=>user.owner_id||user.id;
 const audit=(user,action,resource,details={})=>db.prepare('INSERT INTO audit_log(owner_id,actor_id,action,resource,details) VALUES(?,?,?,?,?)').run(tenantId(user),user.id,action,String(resource),JSON.stringify(details));
 const enrichUser=(id,key={})=>{const user=db.prepare('SELECT id,email,name,owner_id,role,disabled FROM users WHERE id=?').get(id);if(!user||user.disabled)return null;user.owner_id||=user.id;user.restaurantIds=user.role==='owner'?db.prepare('SELECT id FROM restaurants WHERE user_id=?').all(tenantId(user)).map(r=>r.id):db.prepare('SELECT restaurant_id FROM user_restaurants WHERE user_id=?').all(user.id).map(r=>r.restaurant_id);return {...user,...key};};
 const can=(user,cap,rid)=>!!user&&!user.disabled&&(ROLE_CAPABILITIES[user.role]||[]).includes(cap)&&(!user.keyScopes||user.keyScopes.includes(cap))&&(rid===undefined||rid===null||(user.role==='owner'||user.restaurantIds.includes(Number(rid)))&&(!user.keyRestaurantIds||user.keyRestaurantIds.includes(Number(rid))));
 const demand=(user,cap,rid)=>{if(!can(user,cap,rid))fail(403,'Permission denied: '+cap);};
 const restaurant=(id,user)=>{const r=db.prepare('SELECT * FROM restaurants WHERE id=? AND user_id=?').get(Number(id),tenantId(user));if(!r||(user.role!=='owner'&&!user.restaurantIds.includes(r.id))||(user.keyRestaurantIds&&!user.keyRestaurantIds.includes(r.id)))fail(404,'Restaurant not found');return r;};
 const dish=(id,user)=>{const d=db.prepare('SELECT d.* FROM dishes d JOIN restaurants r ON r.id=d.restaurant_id WHERE d.id=? AND r.user_id=?').get(Number(id),tenantId(user));if(!d)fail(404,'Dish not found');restaurant(d.restaurant_id,user);return d;};
 const publicUser=user=>({id:user.id,email:user.email,name:user.name,role:user.role,tenantId:tenantId(user),restaurantIds:user.keyRestaurantIds||user.restaurantIds,capabilities:(ROLE_CAPABILITIES[user.role]||[]).filter(c=>!user.keyScopes||user.keyScopes.includes(c))});
 const resolveApiKey=req=>{if(!req.headers.authorization)return null;const token=/^Bearer (iep_[a-f0-9]{64})$/.exec(req.headers.authorization)?.[1];if(!token)fail(401,'Invalid API authentication');const key=db.prepare('SELECT * FROM integration_keys WHERE token_hash=? AND revoked_at IS NULL').get(digest(token));if(!key||Date.parse(key.expires_at)<=Date.now())fail(401,'API key expired or revoked');const user=enrichUser(key.user_id,{keyId:key.id,keyScopes:JSON.parse(key.scopes),keyRestaurantIds:JSON.parse(key.restaurant_ids)});if(!user)fail(401,'Account disabled');return user;};
 function requestRestaurant({p,body,url,user}){
  let m=p.match(/^\/api\/dishes\/(\d+)/);if(m)return dish(m[1],user).restaurant_id;
  for(const [pattern,table] of [[/^\/api\/experiments\/(\d+)/,'experiments'],[/^\/api\/monitor\/(\d+)/,'monitors'],[/^\/api\/events\/(\d+)/,'events'],[/^\/api\/samples\/(\d+)/,'samples']]){m=p.match(pattern);if(m){const row=table==='samples'?db.prepare('SELECT d.restaurant_id FROM samples s JOIN dishes d ON d.id=s.dish_id WHERE s.id=?').get(Number(m[1])):db.prepare(`SELECT restaurant_id FROM ${table} WHERE id=?`).get(Number(m[1]));if(!row)fail(404,'Resource not found');return restaurant(row.restaurant_id,user).id;}}
  if(body.restaurantId!==undefined||url.searchParams.has('restaurantId'))return restaurant(body.restaurantId??url.searchParams.get('restaurantId'),user).id;
 }
 function authorizeRequest(ctx){const{p,method,body,user}=ctx;if(!p.startsWith('/api/')||['/api/me','/api/access','/api/openapi','/api/status'].includes(p))return;
  if(user?.keyId&&(/^\/api\/(users|integration-keys|audit|logout|login)(\/|$)/.test(p)))fail(403,'API key cannot manage identities');
  let capability;if(p==='/api/restaurants')capability=method==='GET'?'catalog.read':'restaurants.write';
  else if(/^\/api\/(dishes|samples)(\/|$)/.test(p))capability=method==='GET'?'catalog.read':'catalog.write';
  else if(/^\/api\/reports/.test(p)||/^\/api\/events\/\d+\/snapshot$/.test(p))capability='reports.read';
  else if(p==='/api/events'){if(!Array.isArray(body.events))fail(400,'Provide an events array');for(const event of body.events||[])demand(user,event.mode==='manual'?'events.manual':'events.write');capability=(body.events||[]).every(e=>e.mode==='manual')?'events.manual':'events.write';}
  else if(/^\/api\/experiments/.test(p))capability='experiments.run';
  else if(/^\/api\/monitor/.test(p))capability=method==='GET'?'monitor.read':'monitor.write';
  else if(p==='/api/pos')capability=method==='GET'?'pos.read':'pos.write';
  else if(p==='/api/reconciliation')capability='pos.read';
  else if(/^\/api\/users/.test(p))capability='users.manage';
  else if(/^\/api\/integration-keys/.test(p))capability='integrations.manage';
  else if(p==='/api/audit')capability='audit.read';
  if(capability)demand(user,capability,requestRestaurant(ctx));
 }
 const validateRestaurants=(ids,user)=>{if(!Array.isArray(ids)||!ids.length||ids.length>100)fail(400,'Choose at least one restaurant');return [...new Set(ids.map(id=>restaurant(id,user).id))];};
 const email=value=>{if(typeof value!=='string'||value.length>254||!/^\S+@\S+\.\S+$/.test(value))fail(400,'Invalid email');return value.trim().toLowerCase();};
 const roles=user=>user.role==='owner'?['manager','daily_operator','engineer','viewer']:['daily_operator','engineer','viewer'];
 async function route({p,method,body,url,user,res,json}){
  if(p==='/api/access'){json(res,200,{user:publicUser(user),roles:ROLE_CAPABILITIES,keyScopes:KEY_SCOPES.filter(c=>can(user,c))});return true;}
  if(p==='/api/users'&&method==='GET'){demand(user,'users.manage');const users=db.prepare('SELECT id FROM users WHERE owner_id=? ORDER BY id').all(tenantId(user)).map(r=>{const row=db.prepare('SELECT id,email,name,role,disabled FROM users WHERE id=?').get(r.id);return {...row,restaurantIds:db.prepare('SELECT restaurant_id FROM user_restaurants WHERE user_id=?').all(r.id).map(x=>x.restaurant_id)};}).filter(row=>user.role==='owner'||row.id===user.id||row.restaurantIds.every(id=>user.restaurantIds.includes(id)));json(res,200,{users,assignableRoles:roles(user)});return true;}
  if(p==='/api/users'&&method==='POST'){
   demand(user,'users.manage');if(!roles(user).includes(body.role))fail(403,'Cannot assign this role');const ids=validateRestaurants(body.restaurantIds,user),mail=email(body.email);if(typeof body.password!=='string'||body.password.length<12||body.password.length>1024)fail(400,'Password requires 12–1024 characters');if(db.prepare('SELECT id FROM users WHERE email=?').get(mail))fail(409,'Email exists');const salt=randomBytes(16).toString('hex');db.exec('BEGIN');let id;try{id=Number(db.prepare('INSERT INTO users(email,name,salt,password,owner_id,role,disabled) VALUES(?,?,?,?,?,?,0)').run(mail,text(body.name),salt,scryptSync(body.password,salt,64).toString('hex'),tenantId(user),body.role).lastInsertRowid);for(const rid of ids)db.prepare('INSERT INTO user_restaurants VALUES(?,?)').run(id,rid);audit(user,'user.created',id,{role:body.role,restaurantIds:ids});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}json(res,201,{user:publicUser(enrichUser(id))});return true;
  }
  let match=p.match(/^\/api\/users\/(\d+)$/);if(match&&method==='POST'){
   demand(user,'users.manage');const target=db.prepare('SELECT id,email,name,owner_id,role,disabled FROM users WHERE id=?').get(Number(match[1]));if(target)target.restaurantIds=db.prepare('SELECT restaurant_id FROM user_restaurants WHERE user_id=?').all(target.id).map(r=>r.restaurant_id);if(!target||tenantId(target)!==tenantId(user))fail(404,'User not found');if(target.id===user.id||target.role==='owner')fail(403,'Cannot modify this account');if(user.role==='manager'&&(target.role==='manager'||!target.restaurantIds.every(id=>user.restaurantIds.includes(id))))fail(403,'Cannot modify peer account');if(body.disabled!==undefined&&typeof body.disabled!=='boolean')fail(400,'disabled must be boolean');if(body.role&&!roles(user).includes(body.role))fail(403,'Cannot assign this role');const ids=body.restaurantIds?validateRestaurants(body.restaurantIds,user):target.restaurantIds;db.exec('BEGIN');try{db.prepare('UPDATE users SET role=?,disabled=? WHERE id=?').run(body.role||target.role,body.disabled===undefined?target.disabled:Number(!!body.disabled),target.id);db.prepare('DELETE FROM user_restaurants WHERE user_id=?').run(target.id);for(const rid of ids)db.prepare('INSERT INTO user_restaurants VALUES(?,?)').run(target.id,rid);db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);db.prepare('UPDATE integration_keys SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(new Date().toISOString(),target.id);audit(user,'user.updated',target.id,{role:body.role||target.role,disabled:body.disabled===undefined?!!target.disabled:body.disabled,restaurantIds:ids,issuedKeysRevoked:true});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}json(res,200,{ok:true});return true;
  }
  if(p==='/api/integration-keys'&&method==='GET'){demand(user,'integrations.manage');const keys=db.prepare('SELECT id,user_id,label,scopes,restaurant_ids,expires_at,revoked_at,created_at FROM integration_keys WHERE owner_id=? ORDER BY id DESC').all(tenantId(user)).filter(k=>user.role==='owner'||k.user_id===user.id).map(k=>({...k,scopes:JSON.parse(k.scopes),restaurantIds:JSON.parse(k.restaurant_ids)}));json(res,200,{keys,allowedScopes:KEY_SCOPES.filter(c=>can(user,c))});return true;}
  if(p==='/api/integration-keys'&&method==='POST'){
   demand(user,'integrations.manage');const ids=validateRestaurants(body.restaurantIds,user);if(!Array.isArray(body.scopes)||!body.scopes.length||body.scopes.some(c=>!KEY_SCOPES.includes(c)||!can(user,c)))fail(403,'Invalid or unavailable key scope');const days=body.validDays??30;if(!Number.isInteger(days)||days<1||days>365)fail(400,'Key duration must be 1–365 days');const token='iep_'+randomBytes(32).toString('hex'),expires=new Date(Date.now()+days*86400000).toISOString();const id=Number(db.prepare('INSERT INTO integration_keys(user_id,owner_id,label,token_hash,scopes,restaurant_ids,expires_at) VALUES(?,?,?,?,?,?,?)').run(user.id,tenantId(user),text(body.label),digest(token),JSON.stringify([...new Set(body.scopes)]),JSON.stringify(ids),expires).lastInsertRowid);audit(user,'key.created',id,{scopes:body.scopes,restaurantIds:ids});json(res,201,{id,token,expiresAt:expires,notice:'Shown once. Store securely; never commit this key.'});return true;
  }
  match=p.match(/^\/api\/integration-keys\/(\d+)\/revoke$/);if(match&&method==='POST'){demand(user,'integrations.manage');const key=db.prepare('SELECT * FROM integration_keys WHERE id=? AND owner_id=?').get(Number(match[1]),tenantId(user));if(!key||(user.role!=='owner'&&key.user_id!==user.id))fail(404,'Key not found');db.prepare('UPDATE integration_keys SET revoked_at=? WHERE id=?').run(new Date().toISOString(),key.id);audit(user,'key.revoked',key.id);json(res,200,{ok:true});return true;}
  if(p==='/api/audit'&&method==='GET'){demand(user,'audit.read');const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||100));const entries=db.prepare('SELECT id,actor_id,action,resource,details,created_at FROM audit_log WHERE owner_id=? ORDER BY id DESC LIMIT ?').all(tenantId(user),limit).map(e=>({...e,details:JSON.parse(e.details)})).filter(e=>user.role==='owner'||e.actor_id===user.id||(e.details.restaurantId&&user.restaurantIds.includes(Number(e.details.restaurantId)))||(Array.isArray(e.details.restaurantIds)&&e.details.restaurantIds.length&&e.details.restaurantIds.every(id=>user.restaurantIds.includes(Number(id)))));json(res,200,{entries});return true;}
  return false;
 }
 return{tenantId,enrichUser,publicUser,can,demand,restaurant,dish,resolveApiKey,authorizeRequest,route,audit};
}
