#!/usr/bin/env python3
"""Fetch pinned official TensorFlow artifacts using TLS and upstream integrity hashes."""
import base64,hashlib,json,os,pathlib,re,tempfile,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
DEST=pathlib.Path(os.environ.get('IEP_MODELS_DIR',ROOT/'.local/models'))
MODELS={'mobilenet':'https://storage.googleapis.com/tfjs-models/savedmodel/mobilenet_v2_1.0_224/', 'detector':'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/'}
def fetch(url):
 with urllib.request.urlopen(url,timeout=60) as response:
  content=response.read();checks=','.join(response.headers.get_all('x-goog-hash',[]))
  md5=re.search(r'(?:^|[, ])md5=([^, ]+)',checks)
  if not md5:raise RuntimeError('Missing upstream integrity hash: '+url)
  if base64.b64encode(hashlib.md5(content).digest()).decode()!=md5.group(1):raise RuntimeError('Integrity mismatch: '+url)
  return content
for name,base in MODELS.items():
 folder=DEST/name;folder.mkdir(parents=True,exist_ok=True)
 manifest_bytes=fetch(base+'model.json');manifest=json.loads(manifest_bytes)
 paths=[p for group in manifest['weightsManifest'] for p in group['paths']]
 files={}
 for relative in paths:
  if pathlib.PurePosixPath(relative).name!=relative:raise RuntimeError('Unexpected artifact path')
  content=fetch(base+relative);files[relative]=hashlib.sha256(content).hexdigest()
  with tempfile.NamedTemporaryFile(dir=folder,delete=False) as tmp:tmp.write(content);tmpname=tmp.name
  os.replace(tmpname,folder/relative)
 # Publish manifest only after all referenced shards are verified.
 (folder/'model.json').write_bytes(manifest_bytes)
 files['model.json']=hashlib.sha256(manifest_bytes).hexdigest()
 (folder/'provenance.json').write_text(json.dumps({'source':base,'verified_upstream_md5':True,'sha256':files},indent=2)+'\n')
 print('Verified model:',name,'files:',len(files))
