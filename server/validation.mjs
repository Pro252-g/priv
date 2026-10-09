const invalid = message => { throw Object.assign(new Error(message), {status:400}); };
export function objectBody(value, label='payload') {
 if(!value || typeof value!=='object' || Array.isArray(value)) invalid(`Invalid ${label}: object required`);
 return value;
}
export function isoTime(value,label='event time') {
 if(typeof value!=='string') invalid(`Invalid ${label}: ISO timestamp with timezone required`);
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!m) invalid(`Invalid ${label}: ISO timestamp with timezone required`);
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
 const calendar=new Date(Date.UTC(year,month-1,day));
 if(year<1000||calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||hour>23||minute>59||second>59||(m[7]!=='Z'&&(Number(m[7].slice(1,3))>23||Number(m[7].slice(4))>59)))invalid(`Invalid ${label}`);
 const timestamp=new Date(value);if(!Number.isFinite(timestamp.getTime()))invalid(`Invalid ${label}`);
 return timestamp.toISOString();
}
export function identityPart(value,label,text) {
 if(typeof value==='number' && Number.isSafeInteger(value) && value>=0) value=String(value);
 if(typeof value!=='string')invalid(`Invalid ${label}`);
 return text(value);
}
export function pageQuery(url,{max=200,defaultLimit=100}={}) {
 const raw=url.searchParams.get('limit'),before=url.searchParams.get('beforeId');
 const limit=raw===null?defaultLimit:Number(raw),beforeId=before===null?null:Number(before);
 if(!Number.isSafeInteger(limit)||limit<1||limit>max||beforeId!==null&&(!Number.isSafeInteger(beforeId)||beforeId<1))invalid('Invalid page cursor or limit');
 return {limit,beforeId};
}
