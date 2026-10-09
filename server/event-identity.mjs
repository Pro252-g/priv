import {createHash} from 'node:crypto';
import {cairoDate} from './business-day.mjs';
export const payloadHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function crossingIdentity({owner,restaurantId,experimentId=null,session,track,crossing}) {
 const encoded=JSON.stringify(['iep-crossing-v2',Number(owner),experimentId===null?'live':'experiment',Number(restaurantId),experimentId===null?null:Number(experimentId),session,track,crossing]);
 return {key:payloadHash(encoded),session:'iep:v2:'+payloadHash(encoded)};
}
export function knownPayload(e,rid){return payloadHash([Number(rid),e.dishId,e.camera,e.at,e.confidence,e.mode,e.experimentId,e.mediaTime,e.sourceId||null,e.sourceLeaseId||null]);}
export function unknownPayload(e,rid){return payloadHash([Number(rid),e.at,e.experimentId,e.mediaTime,e.reason,e.sourceId||null,e.sourceLeaseId||null]);}
function columns(db,table,definitions){const current=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));for(const[name,type]of definitions)if(!current.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);}
export function initializeEventIdentity(db){
 columns(db,'events',[['identity_key','TEXT'],['original_session_id','TEXT'],['duplicate_of','INTEGER'],['dish_name_snapshot','TEXT'],['source_id','TEXT'],['source_lease_id','INTEGER']]);
 columns(db,'unknown_crossings',[['identity_key','TEXT'],['original_session_id','TEXT'],['confirmed_event_id','INTEGER'],['source_id','TEXT'],['source_lease_id','INTEGER']]);
 columns(db,'event_corrections',[['dish_name_snapshot','TEXT']]);
 db.exec(`CREATE TABLE IF NOT EXISTS crossing_identities(identity_key TEXT PRIMARY KEY,owner_id INTEGER NOT NULL,restaurant_id INTEGER NOT NULL,namespace TEXT NOT NULL,experiment_id INTEGER,session_id TEXT NOT NULL,track_id TEXT NOT NULL,crossing_id TEXT NOT NULL,occurred_at TEXT NOT NULL,media_time_sec REAL,event_id INTEGER,unknown_id INTEGER,known_payload TEXT,unknown_payload TEXT);
 CREATE INDEX IF NOT EXISTS crossing_owner_idx ON crossing_identities(owner_id,restaurant_id,namespace,occurred_at);`);
 // Preserve all numeric IDs and media links. Existing reviewed rows are aliases of
 // their original crossing; an older double count becomes explicitly duplicate.
 const legacySession=(row)=>row.experiment_id&&row.session_id.startsWith('experiment:'+row.experiment_id+':')?row.session_id.slice(('experiment:'+row.experiment_id+':').length):row.session_id;
 db.exec('BEGIN');try{
  for(const row of db.prepare('SELECT * FROM unknown_crossings WHERE identity_key IS NULL ORDER BY id').iterate()){
   const session=legacySession(row),identity=crossingIdentity({owner:row.owner_id,restaurantId:row.restaurant_id,experimentId:row.experiment_id,session,track:row.track_id,crossing:row.crossing_id});
   db.prepare('UPDATE unknown_crossings SET identity_key=?,original_session_id=? WHERE id=?').run(identity.key,session,row.id);
   db.prepare('INSERT OR IGNORE INTO crossing_identities(identity_key,owner_id,restaurant_id,namespace,experiment_id,session_id,track_id,crossing_id,occurred_at,media_time_sec,unknown_id,unknown_payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(identity.key,row.owner_id,row.restaurant_id,row.experiment_id?'experiment':'live',row.experiment_id,session,row.track_id,row.crossing_id,row.occurred_at,row.media_time_sec,row.id,unknownPayload({at:row.occurred_at,experimentId:row.experiment_id,mediaTime:row.media_time_sec,reason:row.reason,sourceId:row.source_id},row.restaurant_id));
  }
  const migrate=row=>{
   let unknown=null;if(/^unknown:\d+$/.test(row.session_id)&&row.track_id==='review'&&row.crossing_id==='review')unknown=db.prepare('SELECT * FROM unknown_crossings WHERE id=? AND owner_id=?').get(Number(row.session_id.slice(8)),row.user_id);
   const session=unknown?.original_session_id??legacySession(row),track=unknown?.track_id??row.track_id,crossing=unknown?.crossing_id??row.crossing_id,identity=unknown?{key:unknown.identity_key}:crossingIdentity({owner:row.user_id,restaurantId:row.restaurant_id,experimentId:row.experiment_id,session,track,crossing});
   const prior=db.prepare('SELECT event_id FROM crossing_identities WHERE identity_key=?').get(identity.key);
   db.prepare('UPDATE events SET identity_key=?,original_session_id=?,dish_name_snapshot=COALESCE(dish_name_snapshot,(SELECT name FROM dishes WHERE id=events.dish_id)),duplicate_of=? WHERE id=?').run(identity.key,session,prior?.event_id||null,row.id);
   if(prior?.event_id){
    db.prepare('INSERT INTO audit_log(owner_id,actor_id,action,resource,details) VALUES(?,NULL,?,?,?)').run(row.user_id,'migration.crossing-deduplicated',String(row.id),JSON.stringify({restaurantId:row.restaurant_id,eventId:row.id,canonicalEventId:prior.event_id,requiresReview:unknown?.resolved_dish_id!==undefined&&unknown.resolved_dish_id!==row.dish_id}));
    if(!row.experiment_id)db.prepare("UPDATE day_reviews SET status='needs_review',updated_at=? WHERE owner_id=? AND restaurant_id=? AND business_date=? AND status='approved'").run(new Date().toISOString(),row.user_id,row.restaurant_id,cairoDate(row.occurred_at));
   }
   const digest=unknown?null:knownPayload({dishId:row.dish_id,camera:row.camera,at:row.occurred_at,confidence:row.confidence,mode:row.mode,experimentId:row.experiment_id,mediaTime:row.media_time_sec,sourceId:row.source_id},row.restaurant_id);
   db.prepare('INSERT INTO crossing_identities(identity_key,owner_id,restaurant_id,namespace,experiment_id,session_id,track_id,crossing_id,occurred_at,media_time_sec,event_id,known_payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(identity_key) DO UPDATE SET event_id=COALESCE(crossing_identities.event_id,excluded.event_id),known_payload=COALESCE(crossing_identities.known_payload,excluded.known_payload)').run(identity.key,row.user_id,row.restaurant_id,row.experiment_id?'experiment':'live',row.experiment_id,session,track,crossing,row.occurred_at,row.media_time_sec,row.id,digest);
   if(unknown)db.prepare('UPDATE unknown_crossings SET confirmed_event_id=? WHERE id=?').run(prior?.event_id||row.id,unknown.id);
  };
  for(const row of db.prepare("SELECT * FROM events WHERE identity_key IS NULL ORDER BY CASE WHEN session_id GLOB 'unknown:[0-9]*' AND track_id='review' THEN 1 ELSE 0 END,id").iterate())migrate(row);
  db.exec(`CREATE INDEX IF NOT EXISTS events_identity_idx ON events(identity_key);CREATE INDEX IF NOT EXISTS unknown_identity_idx ON unknown_crossings(identity_key);DROP VIEW IF EXISTS effective_events;CREATE VIEW effective_events AS SELECT e.*,COALESCE(c.new_dish_id,e.dish_id) effective_dish_id,COALESCE(c.dish_name_snapshot,e.dish_name_snapshot,(SELECT name FROM dishes WHERE id=COALESCE(c.new_dish_id,e.dish_id))) effective_dish_name,CASE WHEN c.action='void' OR e.duplicate_of IS NOT NULL THEN 1 ELSE 0 END effective_void,c.id correction_id FROM events e LEFT JOIN event_corrections c ON c.id=(SELECT MAX(c2.id) FROM event_corrections c2 WHERE c2.event_id=e.id);`);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function ensureCrossing(db,e,{owner,restaurantId,kind,fail}) {
 const identity=crossingIdentity({owner,restaurantId,experimentId:e.experimentId,session:e.session,track:e.track,crossing:e.crossing});
 let row=db.prepare('SELECT * FROM crossing_identities WHERE identity_key=?').get(identity.key);
 const digest=kind==='known'?knownPayload(e,restaurantId):unknownPayload(e,restaurantId),field=kind==='known'?'known_payload':'unknown_payload';
 if(row&&(row.occurred_at!==e.at||row.media_time_sec!==e.mediaTime||row[field]&&row[field]!==digest))fail(409,'Crossing identity has different immutable data');
 if(!row){db.prepare('INSERT INTO crossing_identities(identity_key,owner_id,restaurant_id,namespace,experiment_id,session_id,track_id,crossing_id,occurred_at,media_time_sec) VALUES(?,?,?,?,?,?,?,?,?,?)').run(identity.key,owner,restaurantId,e.experimentId===null?'live':'experiment',e.experimentId,e.session,e.track,e.crossing,e.at,e.mediaTime);}
 db.prepare(`UPDATE crossing_identities SET ${field}=COALESCE(${field},?) WHERE identity_key=?`).run(digest,identity.key);
 return {...db.prepare('SELECT * FROM crossing_identities WHERE identity_key=?').get(identity.key),storageSession:identity.session};
}
