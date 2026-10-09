const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'});
export const cairoDate=value=>formatter.format(new Date(value));
const cache=new Map();
export function cairoDayInterval(day){
 if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw Object.assign(new Error('Invalid business date'),{status:400});
 if(cache.has(day))return cache.get(day);
 const boundary=target=>{const center=Date.parse(target+'T00:00:00Z');let low=center-36*3600000,high=center+36*3600000;while(low<high){const mid=Math.floor((low+high)/2);if(cairoDate(mid)<target)low=mid+1;else high=mid;}return low;};
 const next=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10);const result={businessDate:day,timeZone:'Africa/Cairo',from:new Date(boundary(day)).toISOString(),to:new Date(boundary(next)).toISOString()};if(cache.size>1000)cache.clear();cache.set(day,result);return result;
}
