import {isIP} from 'node:net';
const normalized=value=>value?.startsWith('::ffff:')?value.slice(7):value;
export function trustedProxies(value=''){
 const entries=value.split(',').map(v=>normalized(v.trim())).filter(Boolean);
 if(entries.some(ip=>!isIP(ip)))throw new Error('IEP_TRUSTED_PROXY_IPS must contain exact IP addresses');
 return new Set(entries);
}
export function clientAddress(req,trusted){
 const socket=normalized(req.socket.remoteAddress)||'unknown';
 if(!trusted.has(socket))return socket;
 const header=req.headers['x-forwarded-for'];if(typeof header!=='string'||header.length>2048)return socket;
 const hops=header.split(',').map(v=>normalized(v.trim()));if(hops.length>20||hops.some(ip=>!isIP(ip)))return socket;
 // Start next to the actual peer. An untrusted client-supplied prefix cannot
 // choose an identity beyond the first untrusted hop added by our proxy.
 for(let i=hops.length-1;i>=0;i--)if(!trusted.has(hops[i]))return hops[i];
 return hops[0]||socket;
}
