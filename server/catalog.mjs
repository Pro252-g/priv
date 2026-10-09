import {objectBody,pageQuery} from './validation.mjs';
import {classAllowed} from '../public/recognition.js';
import { recognitionClasses, detectorClassNames } from './recognition-classes.mjs';
export function initializeCatalog(db) {
  db.exec("CREATE TABLE IF NOT EXISTS model_profiles(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL,name TEXT NOT NULL,model_sha256 TEXT NOT NULL,version TEXT NOT NULL,classes TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(owner_id,name,model_sha256));CREATE INDEX IF NOT EXISTS model_profile_owner_idx ON model_profiles(owner_id,id);");
  for (const [table, name, declaration] of [['dishes','kind',"TEXT NOT NULL DEFAULT 'dish'"],['dishes','recognition_mode',"TEXT NOT NULL DEFAULT 'reference'"],['dishes','detector_classes',"TEXT NOT NULL DEFAULT '[]'"],['samples','variant_label',"TEXT NOT NULL DEFAULT ''"]]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
}
export function createCatalog({ db, access, fail, text, media }) {
  const string = (value, label, max=100) => { if(typeof value !== 'string' || !value.trim() || value.length > max) fail(400,`Invalid ${label}`); return text(value); };
  function available(user){const names=new Set(detectorClassNames);for(const p of db.prepare('SELECT classes FROM model_profiles WHERE owner_id=?').all(access.tenantId(user)))for(const c of JSON.parse(p.classes))names.add(c.name);return names;}
  function classes(value,user) {
    const allowed=available(user);if(!Array.isArray(value) || value.length>256 || value.some(c=>typeof c!=='string'||!allowed.has(c))) fail(400,'Invalid detector classes');
    return [...new Set(value)];
  }
  function row(d, user) {
    let detectorClasses;
    try { detectorClasses=classes(JSON.parse(d.detector_classes),user); } catch { fail(500,'Invalid stored recognition configuration'); }
    if(!['dish','drink','object','person'].includes(d.kind)||!['reference','detector'].includes(d.recognition_mode)) fail(500,'Invalid stored recognition configuration');
    const {recognition_mode,detector_classes,...rest}=d;
    const sampleColumns = new Set(db.prepare('PRAGMA table_info(samples)').all().map(c=>c.name));
    const projection=['id','created_at','variant_label','mime','image_key','media_status'].filter(c=>sampleColumns.has(c)).join(',');
    return {...rest,recognitionMode:recognition_mode,detectorClasses,samples:db.prepare(`SELECT ${projection} FROM samples WHERE dish_id=? ORDER BY id`).all(d.id).map(s=>({id:s.id,created_at:s.created_at,variantLabel:s.variant_label,...(media?media.describeSample(s,access.tenantId(user)):{url:`/api/samples/${s.id}`,image_key:s.image_key??null,media_status:s.media_status||'legacy'})}))};
  }
  function config(body,user, previous={kind:'dish',recognition_mode:'reference',detector_classes:'[]'}) {
    if(!body || typeof body!=='object' || Array.isArray(body)) fail(400,'Invalid catalog payload');
    const allowed=new Set(['restaurantId','name','kind','recognitionMode','detectorClasses']);
    if(Object.keys(body).some(key=>!allowed.has(key))) fail(400,'Unsupported catalog field');
    const kind=body.kind===undefined?previous.kind:body.kind, mode=body.recognitionMode===undefined?previous.recognition_mode:body.recognitionMode;
    if(!['dish','drink','object','person'].includes(kind)) fail(400,'Invalid object kind');
    if(!['reference','detector'].includes(mode)) fail(400,'Invalid recognition mode');
    const detectorClasses=classes(body.detectorClasses===undefined?JSON.parse(previous.detector_classes):body.detectorClasses,user);
    if(mode==='detector'&&!detectorClasses.length) fail(400,'Detector mode requires at least one class');
    return {name:body.name===undefined?previous.name:string(body.name,'name'),kind,mode,detectorClasses};
  }
  function warnings(restaurantId, config, id=0,user) {
    const current={kind:config.kind,recognitionMode:config.mode,detectorClasses:config.detectorClasses};
    const overlap=db.prepare('SELECT * FROM dishes WHERE restaurant_id=? AND archived_at IS NULL AND id<>?').all(restaurantId,id).filter(d=>{
      if(config.mode!=='detector'&&d.recognition_mode!=='detector')return false;
      const other={kind:d.kind,recognitionMode:d.recognition_mode,detectorClasses:JSON.parse(d.detector_classes)};
      const allowed=(item,c)=>item.detectorClasses.length?item.detectorClasses.includes(c):classAllowed(item,c);return [...available(user)].some(c=>allowed(current,c)&&allowed(other,c));
    });
    return overlap.length?[{code:'ambiguous-detector-mapping',dishIds:overlap.map(d=>d.id),message:'Shared detector and reference mappings require review; never choose an arbitrary item.'}]:[];
  }
  return { row, async route({p,method,user,url,body,res,json}) {
    const profileId=p.match(/^\/api\/model-profiles\/(\d+)$/);
    if(profileId&&method==='GET'){access.demand(user,'catalog.read');const profile=db.prepare('SELECT * FROM model_profiles WHERE id=? AND owner_id=?').get(Number(profileId[1]),access.tenantId(user));if(!profile)fail(404,'Model profile not found');json(res,200,{profile:{id:profile.id,name:profile.name,modelSha256:profile.model_sha256,version:profile.version,classes:JSON.parse(profile.classes),createdAt:profile.created_at}});return true;}
    if(p==='/api/recognition/classes'&&method==='GET') { access.demand(user,'catalog.read');const classes=recognitionClasses.map(c=>({id:c.id,name:c.label,label:c.labelAr})),seen=new Set(classes.map(c=>c.name));for(const profile of db.prepare('SELECT id,classes FROM model_profiles WHERE owner_id=? ORDER BY id').all(access.tenantId(user)))for(const c of JSON.parse(profile.classes))if(!seen.has(c.name)){classes.push({id:'profile:'+profile.id+':'+c.name,name:c.name,label:c.label,modelProfileId:profile.id});seen.add(c.name);}json(res,200,{classes,model:'coco-ssd',modelVersion:'2.2.3',note:'Custom profile labels require a matching edge model; the browser COCO model does not acquire new classes.'});return true; }
    if(p==='/api/model-profiles'){
      access.demand(user,method==='GET'?'catalog.read':'integrations.manage');
      const view=p=>({id:p.id,name:p.name,modelSha256:p.model_sha256,version:p.version,classes:JSON.parse(p.classes),createdAt:p.created_at});
      if(method==='GET'){const {limit,beforeId}=pageQuery(url,{max:100,defaultLimit:50}),profiles=db.prepare('SELECT * FROM model_profiles WHERE owner_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?').all(access.tenantId(user),beforeId,beforeId,limit+1),hasMore=profiles.length>limit;if(hasMore)profiles.pop();json(res,200,{profiles:profiles.map(view),hasMore,nextBeforeId:hasMore?profiles.at(-1).id:null});return true;}
      if(method==='POST'){objectBody(body);if(Object.keys(body).some(k=>!['name','modelSha256','version','classes'].includes(k)))fail(400,'Unsupported model profile field');const name=text(body.name),version=text(body.version,100);if(typeof body.modelSha256!=='string'||!/^[a-f0-9]{64}$/.test(body.modelSha256))fail(400,'Model SHA256 required');if(!Array.isArray(body.classes)||!body.classes.length||body.classes.length>256)fail(400,'Provide1..256 model classes');const seen=new Set(),labels=body.classes.map(c=>{objectBody(c,'model class');if(Object.keys(c).some(k=>!['name','label'].includes(k))||typeof c.name!=='string'||!/^[a-z][a-z0-9 _-]{0,63}$/.test(c.name)||seen.has(c.name))fail(400,'Invalid or duplicate model class');seen.add(c.name);return{name:c.name,label:text(c.label,100)};});const prior=db.prepare('SELECT * FROM model_profiles WHERE owner_id=? AND name=? AND model_sha256=?').get(access.tenantId(user),name,body.modelSha256);if(prior){if(prior.version!==version||prior.classes!==JSON.stringify(labels))fail(409,'Model profile already exists with different metadata');json(res,200,{profile:view(prior),duplicate:true});return true;}const id=Number(db.prepare('INSERT INTO model_profiles(owner_id,name,model_sha256,version,classes,created_at) VALUES(?,?,?,?,?,?)').run(access.tenantId(user),name,body.modelSha256,version,JSON.stringify(labels),new Date().toISOString()).lastInsertRowid);access.audit(user,'model-profile.created',id,{name,modelSha256:body.modelSha256,version,classCount:labels.length});json(res,201,{profile:view(db.prepare('SELECT * FROM model_profiles WHERE id=?').get(id)),note:'Metadata registration only. Deploy and validate the matching weights on edge.'});return true;}
    }
    if(p==='/api/dishes'&&['GET','POST'].includes(method)) {
      access.demand(user,method==='GET'?'catalog.read':'catalog.write');
      const r=access.restaurant(method==='GET'?url.searchParams.get('restaurantId'):body?.restaurantId,user);
      if(method==='GET'){const dishes=db.prepare('SELECT * FROM dishes WHERE restaurant_id=? AND archived_at IS NULL ORDER BY id').all(r.id).map(d=>{const value=row(d,user);return{...value,warnings:warnings(r.id,{kind:d.kind,mode:d.recognition_mode,detectorClasses:value.detectorClasses},d.id,user)};});json(res,200,{dishes,warnings:dishes.flatMap(d=>d.warnings.map(w=>({...w,dishId:d.id})))});return true;}
      const c=config(body,user); if(!c.name) fail(400,'Name required');
      const id=Number(db.prepare('INSERT INTO dishes(restaurant_id,name,kind,recognition_mode,detector_classes) VALUES(?,?,?,?,?)').run(r.id,c.name,c.kind,c.mode,JSON.stringify(c.detectorClasses)).lastInsertRowid);
      access.audit(user,'dish.created',id,{restaurantId:r.id,name:c.name,kind:c.kind,recognitionMode:c.mode,detectorClasses:c.detectorClasses});json(res,201,{dish:row(access.dish(id,user),user),warnings:warnings(r.id,c,id,user)});return true;
    }
    const m=p.match(/^\/api\/dishes\/(\d+)$/);
    if(m&&method==='POST') {
      access.demand(user,'catalog.write'); const d=access.dish(m[1],user);if(d.archived_at) fail(409,'Dish is archived');
      if(body?.restaurantId!==undefined&&Number(body.restaurantId)!==d.restaurant_id) fail(400,'Restaurant cannot be changed');
      const c=config(body,user,d);
      db.prepare('UPDATE dishes SET name=?,kind=?,recognition_mode=?,detector_classes=? WHERE id=?').run(c.name,c.kind,c.mode,JSON.stringify(c.detectorClasses),d.id);
      access.audit(user,'dish.updated',d.id,{restaurantId:d.restaurant_id,name:c.name,kind:c.kind,recognitionMode:c.mode,detectorClasses:c.detectorClasses});json(res,200,{dish:row(access.dish(d.id,user),user),warnings:warnings(d.restaurant_id,c,d.id,user)});return true;
    }
    return false;
  }};
}
