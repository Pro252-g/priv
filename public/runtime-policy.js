// Shared immutable analysis contracts: item IDs are identities; names are labels.
export function analysisSnapshot(context, references = []) {
 return structuredClone({restaurantId:context.restaurantId,ownerId:context.ownerId,settings:context.settings,dishes:context.dishes,references});
}
export function provenanceFor(context, manifests = []) {
 return {model:'mobilenet-v2-alpha1+coco-lite-mobilenet-v2-local',modelManifests:structuredClone(manifests),config:structuredClone(context.settings),catalog:context.dishes.map(d=>({id:d.id,name:d.name,kind:d.kind||'dish',modelProfileId:d.modelProfileId||null,recognitionMode:d.recognitionMode||'reference',detectorClasses:[...(d.detectorClasses||[])],references:(d.samples||[]).map(s=>({id:s.id,imageKey:s.image_key||s.imageKey||null,sha256:s.sha256||(s.image_key||s.imageKey||'').split('/').at(-1)||(context.references||[]).find(r=>String(r.dishId)===String(d.id)&&String(r.sampleId)===String(s.id))?.sampleSha||null,variantLabel:s.variantLabel||s.variant_label||''}))}))};
}
export function addCount(counts, item) {
 const key=String(item.dishId), current=counts.get(key);
 counts.set(key,{dishId:item.dishId,dishName:item.dishName,count:(current?.count||0)+1});
}
export function countRows(counts) { return [...counts.values()]; }
export function summaryRows(summary) {
 if(Array.isArray(summary?.detectedItems))return summary.detectedItems;
 return Object.entries(summary?.detectedCounts||{}).map(([dishName,count])=>({dishId:null,dishName,count}));
}
// Tracker expires a live identity after 1.6 seconds. Do not count across missing
// observations by extending that timeout; report inadequate coverage instead.
export function cadenceSafe(elapsedMs) { return Number.isFinite(elapsedMs)&&elapsedMs<=1200; }
