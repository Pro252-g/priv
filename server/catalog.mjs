import {classAllowed} from '../public/recognition.js';
import { recognitionClasses, detectorClassNames } from './recognition-classes.mjs';
export function initializeCatalog(db) {
  for (const [table, name, declaration] of [['dishes','kind',"TEXT NOT NULL DEFAULT 'dish'"],['dishes','recognition_mode',"TEXT NOT NULL DEFAULT 'reference'"],['dishes','detector_classes',"TEXT NOT NULL DEFAULT '[]'"],['samples','variant_label',"TEXT NOT NULL DEFAULT ''"]]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
}
export function createCatalog({ db, access, fail, text, media }) {
  const string = (value, label, max=100) => { if(typeof value !== 'string' || !value.trim() || value.length > max) fail(400,`Invalid ${label}`); return text(value); };
  function classes(value) {
    if(!Array.isArray(value) || value.length>80 || value.some(c=>typeof c!=='string'||!detectorClassNames.has(c))) fail(400,'Invalid detector classes');
    return [...new Set(value)];
  }
  function row(d, user) {
    let detectorClasses;
    try { detectorClasses=classes(JSON.parse(d.detector_classes)); } catch { fail(500,'Invalid stored recognition configuration'); }
    if(!['dish','drink','object','person'].includes(d.kind)||!['reference','detector'].includes(d.recognition_mode)) fail(500,'Invalid stored recognition configuration');
    const {recognition_mode,detector_classes,...rest}=d;
    const sampleColumns = new Set(db.prepare('PRAGMA table_info(samples)').all().map(c=>c.name));
    const projection=['id','created_at','variant_label','mime','image_key','media_status'].filter(c=>sampleColumns.has(c)).join(',');
    return {...rest,recognitionMode:recognition_mode,detectorClasses,samples:db.prepare(`SELECT ${projection} FROM samples WHERE dish_id=? ORDER BY id`).all(d.id).map(s=>({id:s.id,created_at:s.created_at,variantLabel:s.variant_label,...(media?media.describeSample(s,access.tenantId(user)):{url:`/api/samples/${s.id}`,image_key:s.image_key??null,media_status:s.media_status||'legacy'})}))};
  }
  function config(body, previous={kind:'dish',recognition_mode:'reference',detector_classes:'[]'}) {
    if(!body || typeof body!=='object' || Array.isArray(body)) fail(400,'Invalid catalog payload');
    const allowed=new Set(['restaurantId','name','kind','recognitionMode','detectorClasses']);
    if(Object.keys(body).some(key=>!allowed.has(key))) fail(400,'Unsupported catalog field');
    const kind=body.kind===undefined?previous.kind:body.kind, mode=body.recognitionMode===undefined?previous.recognition_mode:body.recognitionMode;
    if(!['dish','drink','object','person'].includes(kind)) fail(400,'Invalid object kind');
    if(!['reference','detector'].includes(mode)) fail(400,'Invalid recognition mode');
    const detectorClasses=classes(body.detectorClasses===undefined?JSON.parse(previous.detector_classes):body.detectorClasses);
    if(mode==='detector'&&!detectorClasses.length) fail(400,'Detector mode requires at least one class');
    return {name:body.name===undefined?previous.name:string(body.name,'name'),kind,mode,detectorClasses};
  }
  function warnings(restaurantId, config, id=0) {
    const current={kind:config.kind,recognitionMode:config.mode,detectorClasses:config.detectorClasses};
    const overlap=db.prepare('SELECT * FROM dishes WHERE restaurant_id=? AND archived_at IS NULL AND id<>?').all(restaurantId,id).filter(d=>{
      if(config.mode!=='detector'&&d.recognition_mode!=='detector')return false;
      const other={kind:d.kind,recognitionMode:d.recognition_mode,detectorClasses:JSON.parse(d.detector_classes)};
      return [...detectorClassNames].some(c=>classAllowed(current,c)&&classAllowed(other,c));
    });
    return overlap.length?[{code:'ambiguous-detector-mapping',dishIds:overlap.map(d=>d.id),message:'Shared detector and reference mappings require review; never choose an arbitrary item.'}]:[];
  }
  return { row, async route({p,method,user,url,body,res,json}) {
    if(p==='/api/recognition/classes'&&method==='GET') { access.demand(user,'catalog.read');json(res,200,{classes:recognitionClasses.map(c=>({id:c.id,name:c.label,label:c.labelAr})),model:'coco-ssd',modelVersion:'2.2.3'});return true; }
    if(p==='/api/dishes'&&['GET','POST'].includes(method)) {
      access.demand(user,method==='GET'?'catalog.read':'catalog.write');
      const r=access.restaurant(method==='GET'?url.searchParams.get('restaurantId'):body?.restaurantId,user);
      if(method==='GET'){json(res,200,{dishes:db.prepare('SELECT * FROM dishes WHERE restaurant_id=? AND archived_at IS NULL ORDER BY id').all(r.id).map(d=>row(d,user))});return true;}
      const c=config(body); if(!c.name) fail(400,'Name required');
      const id=Number(db.prepare('INSERT INTO dishes(restaurant_id,name,kind,recognition_mode,detector_classes) VALUES(?,?,?,?,?)').run(r.id,c.name,c.kind,c.mode,JSON.stringify(c.detectorClasses)).lastInsertRowid);
      access.audit(user,'dish.created',id,{restaurantId:r.id,name:c.name,kind:c.kind,recognitionMode:c.mode,detectorClasses:c.detectorClasses});json(res,201,{dish:row(access.dish(id,user),user),warnings:warnings(r.id,c,id)});return true;
    }
    const m=p.match(/^\/api\/dishes\/(\d+)$/);
    if(m&&method==='POST') {
      access.demand(user,'catalog.write'); const d=access.dish(m[1],user);if(d.archived_at) fail(409,'Dish is archived');
      if(body?.restaurantId!==undefined&&Number(body.restaurantId)!==d.restaurant_id) fail(400,'Restaurant cannot be changed');
      const c=config(body,d);
      db.prepare('UPDATE dishes SET name=?,kind=?,recognition_mode=?,detector_classes=? WHERE id=?').run(c.name,c.kind,c.mode,JSON.stringify(c.detectorClasses),d.id);
      access.audit(user,'dish.updated',d.id,{restaurantId:d.restaurant_id,name:c.name,kind:c.kind,recognitionMode:c.mode,detectorClasses:c.detectorClasses});json(res,200,{dish:row(access.dish(d.id,user),user),warnings:warnings(d.restaurant_id,c,d.id)});return true;
    }
    return false;
  }};
}
