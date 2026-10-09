#!/usr/bin/env python3
"""Measured inference capacity; synthetic four-crop workload, NOT restaurant accuracy."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'edge'))
from models import Detector, Embedding
from tracking import Tracker


def percentile(values, fraction):
    return sorted(values)[min(len(values)-1, int((len(values)-1)*fraction))]


def main():
    import cv2
    import numpy as np
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path, default=Path('.local/edge-models'))
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--iterations', type=int, default=20)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.iterations < 5 or args.iterations > 1000:
        parser.error('iterations must be 5..1000')
    cv2.setNumThreads(1)
    image = cv2.imread(str(args.image))
    if image is None:
        parser.error('image cannot be decoded')
    frame = cv2.resize(image, (640, 360))
    crops = [frame[y:y+180, x:x+320].copy() for x,y in [(0,0),(320,0),(0,180),(320,180)]]
    manifest = json.loads((args.models / 'manifest.json').read_text())
    models = {m['filename']: m for m in manifest['models']}
    def workload(worker):
        detector = Detector({'path': str(args.models/'yolox_tiny.onnx'), 'sha256': models['yolox_tiny.onnx']['sha256'], 'format':'yolox','inputSize':[416,416]})
        embed = Embedding({'path': str(args.models/'mobilenet-v2-features.onnx'), 'sha256': models['mobilenet-v2-features.onnx']['sha256'], 'inputSize':[224,224], 'preprocess':'imagenet-rgb','featureOutput':True})
        # 60 cached vectors approximate 10 catalog entries *6 presentation samples.
        references = np.stack([embed.vector(crops[i%4]) for i in range(60)])
        tracker = Tracker('benchmark-'+str(worker))
        real_predictions = detector.detect(frame)
        samples = []
        for iteration in range(args.iterations+2):
            started = time.perf_counter()
            detector.detect(frame)
            vectors = [embed.vector(crop) for crop in crops]
            scores = [references @ vector for vector in vectors]
            tracker.update([{'bbox':[i*.24,.3,.2,.2], 'dishId':i+1, 'confidence':float(max(scores[i]))} for i in range(4)], iteration*.2)
            # Encoding an image for every object, every frame is stricter than
            # production which encodes at crossing only. No disk/network here.
            for crop in crops:
                cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY,80])
            elapsed = (time.perf_counter()-started)*1000
            if iteration >= 2:
                samples.append(elapsed)
        return {'meanMs':statistics.mean(samples),'p95Ms':percentile(samples,.95),'maxMs':max(samples),'samplesMs':samples,
                'actualGeneralDetections':[{'class':p['class'],'score':p['score']} for p in real_predictions]}
    single = workload(0)
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=2) as executor:
        concurrent = list(executor.map(workload, [1,2]))
    duration = time.perf_counter()-started
    result = {'schemaVersion':1,'environment':{'platform':platform.platform(),'python':platform.python_version(),'logicalCpu':os.cpu_count(),
              'cgroupCpuMax':Path('/sys/fs/cgroup/cpu.max').read_text().strip() if Path('/sys/fs/cgroup/cpu.max').exists() else None},
              'workload':'640x360 real general image: YOLOXtiny +4 forced crops MobileNet1280 +60 cached vectors +tracking +4 JPEG encodes; no RTSP/decode/disk/HTTPS',
              'iterationsPerWorker':args.iterations,'modelHashes':{k:v['sha256'] for k,v in models.items()},
              'inputSha256':hashlib.sha256(args.image.read_bytes()).hexdigest(),'singleWorker':single,
              'twoConcurrentWorkers':concurrent,'twoWorkerWallSecIncludingStartup':duration,
              'limitations':'No plate/restaurant accuracy measurement; no actual N100/i5 hardware or 24-hour run; shared cloud CPU. Queue, decoding and API measured separately.'}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'singleMeanMs':single['meanMs'],'twoConcurrentMeanMs':[r['meanMs'] for r in concurrent],'output':str(args.output)}))


if __name__ == '__main__':
    main()
