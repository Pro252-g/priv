#!/usr/bin/env python3
"""Optional local RTSP transport/decode outage/recovery test, not Hikvision acceptance."""
import argparse
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'edge'))
from source import Source
from config import EdgeError
from models import Detector

IMAGE='bluenviron/mediamtx:1.9.3@sha256:e3e9cd157344567a1a67f6c6606dcc7772b4ff589c23131832ffba3f92b97ca6'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image',required=True,type=Path)
    parser.add_argument('--models',type=Path,default=Path('.local/edge-models'))
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    if not args.image.is_file():
        parser.error('input image missing')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    name='iep-rtsp-smoke-'+uuid.uuid4().hex[:10]
    docker=['docker','--config','/tmp/iep-root-docker']
    subprocess.run(docker+['run','--rm','-d','--name',name,'-p',f'127.0.0.1:{port}:8554',
                          '-e','MTX_RTSPTRANSPORTS=tcp','-e','MTX_RTMP=no','-e','MTX_HLS=no','-e','MTX_WEBRTC=no','-e','MTX_SRT=no',IMAGE],check=True,stdout=subprocess.DEVNULL)
    source=None;publisher=None
    url=f'rtsp://127.0.0.1:{port}/general-fixture'
    def publish():
        return subprocess.Popen(['ffmpeg','-nostdin','-loglevel','error','-re','-loop','1','-i',str(args.image.resolve()),
                                 '-vf','scale=640:480','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-r','10','-g','10',
                                 '-pix_fmt','yuv420p','-f','rtsp','-rtsp_transport','tcp',url],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        deadline=time.monotonic()+5
        while True:
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=1):break
            except OSError:
                if time.monotonic()>deadline:raise RuntimeError('RTSP test server did not start')
                time.sleep(.1)
        publisher=publish();time.sleep(1)
        assert publisher.poll() is None,'RTSP publisher failed'
        source=Source({'source':{'kind':'rtsp','resolvedInput':url},'targetFps':5,'sourceTimeoutSec':2,'captureMaxWidth':640})
        source.start();frames=[source.get() for _ in range(5)]
        assert all(b['receivedSeconds']>a['receivedSeconds'] for a,b in zip(frames,frames[1:]))
        detector=Detector({'path':str(args.models.resolve()/'yolox_tiny.onnx'),'sha256':'427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7','format':'yolox','inputSize':[416,416]})
        predictions=detector.detect(frames[-1]['frame']);assert any(p['class']=='dog' for p in predictions)
        publisher.terminate();publisher.wait(timeout=5);publisher=None
        outage=None
        for _ in range(15):
            try:source.get(timeout=3)
            except EdgeError as error:outage=error.code;break
        assert outage in {'source_unreachable','source_read_failed','frame_stale'},outage
        publisher=publish();time.sleep(1);source.start();recovered=source.get()
        assert recovered['receivedSeconds']>frames[-1]['receivedSeconds']
        evidence={'schemaVersion':1,'transport':'Loopback H264 RTSP/TCP via pinned MediaMTX image','imageDigest':IMAGE.split('@')[1],
                  'checks':{'fiveFreshDecodedFrames':True,'realOnnxDogDetection':True,'publisherDisconnectDiagnosed':outage,'decoderRestartRecovered':True},
                  'limitations':'Emulated RTSP transport. No real NVR, credential/ONVIF/channel/clock test and no 24-hour or restaurant accuracy acceptance.'}
        args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(evidence,indent=2)+'\n')
        print(json.dumps(evidence))
    finally:
        if source:source.close()
        if publisher:
            publisher.terminate();publisher.wait(timeout=5)
        subprocess.run(docker+['rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


if __name__=='__main__':main()
