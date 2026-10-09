import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=process.argv[2]||'/app/.local/models';
const sources={mobilenet:'https://storage.googleapis.com/tfjs-models/savedmodel/mobilenet_v2_1.0_224/',detector:'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/'};
for(const [name,source]of Object.entries(sources)){
 const directory=path.join(root,name),provenance=JSON.parse(readFileSync(path.join(directory,'provenance.json'),'utf8'));
 if(provenance.source!==source||provenance.verified_upstream_md5!==true)throw Error('Unverified upstream model: '+name);
 const model=JSON.parse(readFileSync(path.join(directory,'model.json'),'utf8'));
 const files=['model.json',...model.weightsManifest.flatMap(group=>group.paths)];
 for(const file of files){if(path.basename(file)!==file)throw Error('Unexpected model path');const expected=provenance.sha256[file];if(!/^[a-f0-9]{64}$/.test(expected||'')||createHash('sha256').update(readFileSync(path.join(directory,file))).digest('hex')!==expected)throw Error('Model integrity mismatch: '+name+'/'+file);}
 console.log('Verified local model:',name);
}
