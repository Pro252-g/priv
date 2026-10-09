#!/usr/bin/env python3
"""IEP edge runtime: verified inference -> fixed-view tracking -> durable API.

Run one service/state directory per fixed source. This does not download or
duplicate NVR video. File imports are isolated experiments, never live backfill.
"""
import argparse
import base64
import copy
import fcntl
import hashlib
import json
import os
import pathlib
import signal
import socket
import sys
import threading
import time
import urllib.parse
import uuid

from client import ApiClient, ApiError
from config import EdgeError, load_config, seconds_utc, utc_now, utc_seconds
from models import COCO_CLASSES, Detector, Embedding, Recognizer, file_sha256
from outbox import Outbox, atomic_json, private_directory
from source import Source
from tracking import Tracker


def log(code, **fields):
    # Only known codes and safe numeric/boolean fields are emitted. Never dump a
    # config, exception message, request, key, source URL or model input.
    safe = {key: value for key, value in fields.items() if isinstance(value, (int, float, bool)) and not isinstance(value, str)}
    print(json.dumps({'at': utc_now(), 'code': code, **safe}, separators=(',', ':')), flush=True)


def fingerprint_config(config):
    fields = {key: config.get(key) for key in ('roi', 'line', 'targetFps', 'maxObjects', 'tracking', 'reference')}
    fields.update(source={key: config['source'].get(key) for key in ('id', 'sourceId', 'kind', 'sha256', 'experimentId', 'startTime')},
                  detector={key: config['detector'].get(key) for key in ('sha256','format','inputSize','preprocess','labels','decoded','boxSpace','scoreThreshold','nmsThreshold')},
                  embedding={key: config.get('embedding', {}).get(key) for key in ('sha256','inputSize','preprocess','featureOutput','outputName')})
    return hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def catalog_fingerprint(items):
    snapshot = [{'id':item['id'],'name':item.get('name'),'kind':item.get('kind'), 'recognitionMode':item.get('recognitionMode'),
                 'detectorClasses':item.get('detectorClasses'), 'samples':[{'id':s['id'],'imageKey':s.get('image_key'),'variantLabel':s.get('variantLabel')} for s in item.get('samples',[])]}
                for item in sorted(items, key=lambda i:i['id'])]
    return hashlib.sha256(json.dumps(snapshot,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def verify_registry(config, registry, profiles):
    source = config['source']
    registered = next((row for row in registry.get('sources', []) if row.get('id') == source['id']), None)
    if not registered or registered.get('sourceId') != source['sourceId'] or registered.get('kind') != source['kind'] or registered.get('enabled') is False:
        raise EdgeError('source_registry_mismatch')
    calibration = registered.get('config', {})
    for key in ('roi', 'line', 'targetFps', 'maxObjects'):
        local = config.get(key, {'targetFps': 5, 'maxObjects': 4}.get(key))
        if calibration.get(key) != local:
            raise EdgeError('calibration_mismatch')
    profile_id = calibration.get('modelProfileId')
    custom = config['detector'].get('format', 'yolox') != 'yolox' or config['detector'].get('labels', COCO_CLASSES) != COCO_CLASSES
    if custom and not profile_id:
        raise EdgeError('custom_model_profile_required')
    if profile_id:
        profile = next((row for row in profiles.get('profiles', []) if row.get('id') == profile_id), None)
        if not profile or profile.get('modelSha256', '').lower() != config['detector']['sha256'].lower() or [c.get('name') for c in profile.get('classes', [])] != config['detector'].get('labels', COCO_CLASSES):
            raise EdgeError('model_profile_mismatch')
    return registered


def load_catalog(config, client, embedding, directory, allow_cache=True):
    import cv2
    import numpy as np
    cache_path = pathlib.Path(directory) / 'catalog-cache.json'
    try:
        rid = config['api']['restaurantId']
        registry = client.request('/api/sources?restaurantId=' + str(rid))
        registered_source = next((r for r in registry.get('sources', []) if r.get('id')==config['source']['id']),{})
        profile_id = registered_source.get('config',{}).get('modelProfileId')
        profiles = {'profiles':[client.request('/api/model-profiles/'+str(profile_id)).get('profile',{})]} if profile_id else {'profiles':[]}
        registered = verify_registry(config, registry, profiles)
        items = client.request('/api/dishes?restaurantId=' + str(rid)).get('dishes')
        if not isinstance(items, list):
            raise EdgeError('catalog_invalid')
        references = []
        if embedding:
            for item in items:
                if item.get('recognitionMode', 'reference') != 'reference':
                    continue
                for sample in item.get('samples', []):
                    if sample.get('media_status') not in ('ready', 'legacy'):
                        continue
                    location = sample.get('url', '')
                    if not location.startswith('/api/samples/') or not location[len('/api/samples/'):].isdigit():
                        raise EdgeError('sample_url_invalid')
                    image = client.request(location, binary=True)
                    if len(image) > 2*1024*1024:
                        raise EdgeError('sample_too_large')
                    frame = cv2.imdecode(np.frombuffer(image, dtype=np.uint8), cv2.IMREAD_COLOR)
                    if frame is None:
                        raise EdgeError('sample_decode_failed')
                    vector = embedding.vector(frame)
                    references.append({'dishId': item['id'], 'dishName': item['name'], 'sampleId': sample['id'], 'vector': vector})
        cache = {'fingerprint': fingerprint_config(config), 'createdAt': utc_now(), 'registered': registered, 'items': items,
                 'references': [{**r, 'vector': r['vector'].tolist()} for r in references]}
        atomic_json(cache_path, cache)
        return registered, items, references, False
    except ApiError as error:
        # An invalid/revoked key must not silently keep using cached permission.
        if error.status in (401, 403) or not allow_cache:
            raise
        try:
            cache = json.loads(cache_path.read_text())
            if cache.get('fingerprint') != fingerprint_config(config) or time.time() - utc_seconds(cache['createdAt']) > config.get('catalogCacheMaxAgeSec', 86400):
                raise EdgeError('catalog_cache_stale')
            references = [{**r, 'vector': np.asarray(r['vector'], dtype=np.float32)} for r in cache['references']]
            for ref in references:
                if ref['vector'].ndim != 1 or not np.all(np.isfinite(ref['vector'])):
                    raise ValueError()
            return cache['registered'], cache['items'], references, True
        except (OSError, ValueError, KeyError):
            raise EdgeError('catalog_unavailable') from None


def snapshot(frame, bbox):
    import cv2
    height, width = frame.shape[:2]
    x, y, w, h = bbox
    # A small border preserves evidence of the object without uploading the full
    # stream. Private image retention remains a restaurant policy.
    padding = .03
    crop = frame[max(0, int((y-padding)*height)):min(height, max(1, int((y+h+padding)*height))),
                 max(0, int((x-padding)*width)):min(width, max(1, int((x+w+padding)*width)))]
    if not crop.size:
        raise EdgeError('snapshot_crop_invalid')
    maximum = max(crop.shape[:2])
    if maximum > 640:
        crop = cv2.resize(crop, (max(1, int(crop.shape[1]*640/maximum)), max(1, int(crop.shape[0]*640/maximum))))
    for quality in (80, 65, 45):
        ok, encoded = cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ok and len(encoded) <= 512*1024:
            return 'data:image/jpeg;base64,' + base64.b64encode(encoded).decode('ascii')
    raise EdgeError('snapshot_encode_failed')


class Worker:
    def __init__(self, config):
        self.config = config
        self.stop = threading.Event()
        directory = private_directory(config['stateDir'])
        self.process_lock = open(directory / 'worker.lock', 'a', opener=lambda p,f: os.open(p, f, 0o600))
        try:
            fcntl.flock(self.process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.process_lock.close()
            raise EdgeError('worker_already_running') from None
        self.box = Outbox(config['stateDir'], config.get('storage'))
        identity = {'restaurantId': config['api']['restaurantId'], 'sourceId': config['source']['sourceId'], 'sourceRegistryId': config['source']['id'], 'apiOrigin': config['api']['baseUrl']}
        old_identity = self.box.state('source_binding')
        if old_identity and old_identity != identity:
            self.box.close()
            self.process_lock.close()
            raise EdgeError('state_identity_mismatch')
        self.box.set_state('source_binding', identity)
        self.boot_id = str(uuid.uuid4())
        self.sequence = 0
        self.monitor_id = None
        self.lease_id = None
        self.lease_deadline = 0.
        self.lease_valid_from = 0.
        self.lease_valid_until = 0.
        self.lease_changed = False
        self.lock = threading.RLock()
        self.health = {'schemaVersion': 1, 'bootId': self.boot_id, 'observedAt': utc_now(), 'status': 'starting', 'errorCode': 'none',
                       'sourceId': config['source']['sourceId'], 'sourceKind': config['source']['kind'], 'modelSha256': config['detector']['sha256'],
                       'components': {'source': 'starting', 'model': 'starting', 'frame': 'waiting', 'cloud': 'starting', 'auth': 'unknown', 'storage': 'starting', 'queue': 'starting'},
                       'metrics': {'fps': 0., 'frameAgeSec': 0., 'inferenceMs': 0., 'droppedFrames': 0, 'processedFrames': 0, 'countedCrossings': 0, 'unknownCrossings': 0}}
        self.last_frame = None
        self.gap_start = None
        self.gap_cause = None
        self.unsaved = []
        self.source = Source(config)
        if config['source']['kind'] == 'file':
            # Pin both the experiment and exact source/analysis configuration so
            # repeat imports deduplicate, and a different setup cannot pollute it.
            seed = hashlib.sha256((config['source']['sha256'].lower()+fingerprint_config(config)).encode()).hexdigest()[:32]
            source_prefix = hashlib.sha256(config['source']['sourceId'].encode()).hexdigest()[:16]
            session = f"edge-file:{source_prefix}:{seed}"
        else:
            source_prefix = hashlib.sha256(config['source']['sourceId'].encode()).hexdigest()[:16]
            session = f"edge:{source_prefix}:{self.boot_id}"
        if len(session) > 120:
            raise EdgeError('source_id_too_long_for_session')
        self.tracker = Tracker(config['source']['sourceId'], session, config['line'], config.get('tracking'))
        self.client = ApiClient(config['api'])
        self.detector = None
        self.embedding = None
        self.recognizer = None
        self.registered = None
        self.refresh_needed = False
        self.catalog_changed = False
        self.upload_thread = None

    def update_health(self, **changes):
        with self.lock:
            self.health.update(changes)
            self.health['observedAt'] = utc_now()
            stats = self.box.stats()
            self.health['metrics'].update(stats)
            self.health['components']['storage'] = 'ready' if stats['capacityAvailable'] else 'full'
            self.health['components']['queue'] = 'blocked' if stats['blockedRows'] else 'pending' if stats['queueDepth'] else 'empty'
            if self.last_frame:
                self.health['metrics']['frameAgeSec'] = max(0., time.time()-self.last_frame['receivedSeconds'])
            atomic_json(pathlib.Path(self.config['stateDir']) / 'health.json', self.health)
        return self.health

    def initialize(self):
        self.detector = Detector(self.config['detector'])
        if self.config.get('embedding'):
            self.embedding = Embedding(self.config['embedding'])
        with self.lock:
            self.health['components']['model'] = 'ready' if self.embedding else 'detector-only'
            self.health['embeddingAvailable'] = self.embedding is not None
        if self.config['source']['kind'] == 'file' and file_sha256(self.config['source']['resolvedInput']) != self.config['source']['sha256'].lower():
            raise EdgeError('file_hash_mismatch')
        self.registered, items, references, cached = load_catalog(self.config, self.client, self.embedding, self.config['stateDir'])
        self.recognizer = Recognizer(items, references, self.embedding, self.config.get('reference'))
        if not items:
            raise EdgeError('catalog_empty')
        if self.config.get('calibrated') is not True:
            raise EdgeError('calibration_required')
        if self.config['source']['kind'] == 'file':
            experiment = self.client.request('/api/experiments/' + str(self.config['source']['experimentId'])).get('experiment', {})
            if experiment.get('restaurant_id') != self.config['api']['restaurantId']:
                raise EdgeError('experiment_restaurant_mismatch')
            binding = self.box.state('file_binding')
            expected = {'experimentId': self.config['source']['experimentId'], 'fileSha256': self.config['source']['sha256'].lower(), 'fingerprint': fingerprint_config(self.config), 'catalogFingerprint': catalog_fingerprint(items)}
            if binding and binding != expected:
                raise EdgeError('file_experiment_configuration_changed')
            previous_binding = experiment.get('summary', {}).get('edgeBinding')
            if previous_binding and previous_binding != expected:
                raise EdgeError('file_experiment_configuration_changed')
            self.client.request('/api/experiments/' + str(self.config['source']['experimentId']), {'status': 'running', 'summary': {**experiment.get('summary', {}), 'edgeBinding': expected}})
            self.box.set_state('file_binding', expected)
        else:
            self.renew_lease(self.client)
            if previous := self.box.state('last_observed'):
                self.enqueue_gap(previous, utc_now(), 'process_restart')
        with self.lock:
            self.health['components']['cloud'] = 'cached-offline' if cached else 'ready'
            self.health['components']['auth'] = 'cached' if cached else 'ready'
        self.upload_thread = threading.Thread(target=self.upload_loop, daemon=True, name='iep-upload')
        self.upload_thread.start()
        self.source.start()
        self.update_health(status='starting')

    def renew_lease(self, client):
        request_started = time.monotonic()
        request_utc_started = time.time()
        reply = client.request('/api/sources/'+str(self.config['source']['id'])+'/lease', {'bootId':self.boot_id,'ttlSec':45})
        received_utc = time.time()
        server_seconds = utc_seconds(reply['serverTime'])
        expiry_seconds = utc_seconds(reply['expiresAt'])
        duration = expiry_seconds-server_seconds
        if not 0 < duration <= 45.1 or not isinstance(reply.get('leaseId'),int):
            raise EdgeError('source_lease_invalid')
        # Server timestamp must plausibly lie within the request's UTC interval.
        # NTP errors must stop counting before they produce permanent409 rows.
        if not request_utc_started-1. <= server_seconds <= received_utc+1.:
            raise EdgeError('time_sync_required')
        with self.lock:
            if self.lease_id is not None and self.lease_id != reply['leaseId']:
                self.lease_changed = True
            if self.lease_id != reply['leaseId']:
                self.lease_valid_from = server_seconds
            self.lease_id = reply['leaseId']
            self.lease_valid_until = expiry_seconds
            # Charge the full request RTT against TTL. A delayed successful
            # response never extends local counting beyond server expiry.
            self.lease_deadline = request_started+max(0.,duration-1.)
            self.health['sourceLeaseId'] = self.lease_id

    def enqueue_gap(self, start, end, cause):
        if self.config['source']['kind'] == 'file' or utc_seconds(end) <= utc_seconds(start):
            return
        identity = hashlib.sha256((self.config['source']['sourceId']+'|'+start+'|'+end+'|'+cause).encode()).hexdigest()
        endpoint = '/api/sources/' + str(self.config['source']['id']) + '/gaps'
        payload = {'gapId': identity, 'startAt': start, 'endAt': end, 'cause': cause, 'recoverable': self.config['source']['kind'] == 'rtsp'}
        self.box.enqueue('gap:'+identity, endpoint, payload)

    def open_gap(self, cause, start=None):
        if self.gap_start is None:
            self.gap_start = start or (seconds_utc(self.last_frame['timestamp']) if self.last_frame else utc_now())
            self.gap_cause = cause
        self.persist_events(self.tracker.reset(cause))

    def close_gap(self, end=None):
        if self.gap_start:
            self.enqueue_gap(self.gap_start, end or utc_now(), self.gap_cause or 'unknown')
            self.gap_start = None
            self.gap_cause = None

    def event_entry(self, event):
        payload = {'sessionId': event['sessionId'], 'trackId': event['trackId'], 'crossingId': event['crossingId'],
                   'occurredAt': seconds_utc(event['timestamp']), 'sourceId': self.config['source']['sourceId'], 'image': event.get('image')}
        if self.config['source']['kind'] == 'file':
            payload.update(experimentId=self.config['source']['experimentId'], mediaTimeSec=max(0., event['timestamp']-self.config['source']['startSeconds']))
        else:
            payload['sourceLeaseId'] = event.get('sourceLeaseId') or self.lease_id
        if event.get('dishId'):
            endpoint = '/api/events'
            payload.update(dishId=event['dishId'], confidence=event['confidence'], mode='automatic', camera=self.registered.get('name', self.config['source']['sourceId']))
            category = 'countedCrossings'
        else:
            endpoint = '/api/unknown-events'
            payload.update(reason=event.get('reason') or 'unrecognized')
            category = 'unknownCrossings'
        return {'entry': (event['key'], endpoint, {'restaurantId': self.config['api']['restaurantId'], 'events': [payload]}), 'category': category}

    def flush_unsaved(self):
        while self.unsaved:
            pending = self.unsaved[0]
            self.box.enqueue(*pending['entry'])
            self.unsaved.pop(0)
            with self.lock:
                self.health['metrics'][pending['category']] += 1

    def persist_events(self, events):
        # Retain every already-consumed crossing before the first disk write.
        # A failure on one of four plates must not discard the remaining three.
        entries = [self.event_entry(event) for event in events]
        for entry in entries:
            if not any(existing['entry'][0] == entry['entry'][0] for existing in self.unsaved):
                self.unsaved.append(entry)
        self.flush_unsaved()

    def persist_event(self, event):
        self.persist_events([event])

    def heartbeat_payload(self):
        with self.lock:
            self.sequence += 1
            metrics = self.health['metrics']
            accepted = {key: metrics.get(key, 0) for key in ('fps', 'frameAgeSec', 'queueDepth', 'oldestQueueAgeSec', 'freeDiskBytes', 'inferenceMs')}
            error = self.health['errorCode']
            if error not in {'decoder_unavailable','source_unreachable','auth_failed','inference_failed','storage_full','upload_failed','calibration_required','none'}:
                error = 'inference_failed' if error.startswith(('model_', 'embedding_')) else 'source_unreachable'
            return {'status': self.health['status'], 'bootId': self.boot_id, 'sequence': self.sequence, 'observedAt': utc_now(), 'metrics': accepted, 'errorCode': error}

    def upload_loop(self):
        client = ApiClient(self.config['api'])
        next_health, next_catalog = 0., time.monotonic()+self.config.get('catalogRefreshSec', 300)
        while not self.stop.is_set():
            now = time.monotonic()
            try:
                row = self.box.due()
                if row:
                    try:
                        result = client.request(row['endpoint'], json.loads(row['payload']))
                        if result.get('mediaPending', 0):
                            self.box.fail(row['key'], 'image_pending')
                        else:
                            self.box.ack(row['key'])
                        with self.lock:
                            self.health['components']['cloud'] = 'ready'
                            self.health['components']['auth'] = 'ready'
                    except ApiError as error:
                        retry = error.status not in (400, 401, 403, 404, 409, 413, 422)
                        self.box.fail(row['key'], error.code, retry=retry)
                        with self.lock:
                            self.health['components']['cloud'] = error.code
                            self.health['components']['auth'] = 'failed' if error.status in (401,403) else self.health['components']['auth']
                        log(error.code, status=error.status or 0)
                if now >= next_health:
                    next_health = now + self.config.get('heartbeatSec', 15)
                    self.update_health()
                    if self.config['source']['kind'] != 'file':
                        self.renew_lease(client)
                    if not self.monitor_id and self.config['source']['kind'] != 'file':
                        reply = client.request('/api/monitor/start', {'restaurantId': self.config['api']['restaurantId'], 'sessionId': self.tracker.session_id,
                                                                      'camera': self.registered.get('name', self.config['source']['sourceId']), 'sourceId': self.config['source']['sourceId']})
                        self.monitor_id = reply['monitor']['id']
                    client.request('/api/sources/'+str(self.config['source']['id'])+'/health', self.heartbeat_payload())
                    if self.monitor_id:
                        client.request('/api/monitor/'+str(self.monitor_id)+'/heartbeat', {'status': 'running' if self.health['status']=='running' else 'stalled'})
                    with self.lock:
                        self.health['components']['cloud'] = 'ready'
                        self.health['components']['auth'] = 'ready'
                if now >= next_catalog:
                    next_catalog = now + self.config.get('catalogRefreshSec', 300)
                    # Download/encode references outside the inference thread;
                    # atomic replacement avoids half-updated recognition state.
                    registered, items, refs, _ = load_catalog(self.config, client, self.embedding, self.config['stateDir'], allow_cache=False)
                    if self.config['source']['kind'] == 'file':
                        if catalog_fingerprint(items) != self.box.state('file_binding')['catalogFingerprint']:
                            raise EdgeError('file_catalog_changed')
                        continue
                    with self.lock:
                        self.registered = registered
                        old_items = self.recognizer.items
                        old_refs = [(r['dishId'], r.get('sampleId')) for r in self.recognizer.references]
                        new_refs = [(r['dishId'], r.get('sampleId')) for r in refs]
                        if old_items != items or old_refs != new_refs:
                            self.catalog_changed = True
                        self.recognizer = Recognizer(items, refs, self.embedding, self.config.get('reference'))
            except ApiError as error:
                with self.lock:
                    self.health['components']['cloud'] = error.code
                    self.health['components']['auth'] = 'failed' if error.status in (401,403) else self.health['components']['auth']
                log(error.code, status=error.status or 0)
            except EdgeError as error:
                with self.lock:
                    self.health['status'] = 'error'
                    self.health['errorCode'] = 'calibration_required' if error.code in ('calibration_mismatch', 'model_profile_mismatch', 'source_registry_mismatch') else 'inference_failed'
                    self.refresh_needed = True
                log(error.code)
            except Exception:
                log('upload_internal_error')
            self.stop.wait(.2)

    def run(self, max_frames=None):
        self.initialize()
        processed_times = []
        unchanged_since, last_fingerprint = None, None
        previous_timestamp = None
        while not self.stop.is_set():
            try:
                if self.health['components']['auth'] == 'failed':
                    self.open_gap('upload_failed')
                    self.update_health(status='error', errorCode='auth_failed')
                    self.stop.wait(1)
                    continue
                if self.config['source']['kind'] != 'file' and (time.monotonic() >= self.lease_deadline or self.lease_changed):
                    self.open_gap('upload_failed')
                    if self.lease_changed:
                        self.lease_changed = False
                    self.update_health(status='stalled', errorCode='upload_failed')
                    self.stop.wait(1)
                    continue
                if self.refresh_needed:
                    self.open_gap('inference_failed')
                    self.update_health(status='error')
                    self.stop.wait(1)
                    continue
                if self.box.stats()['blockedRows']:
                    self.open_gap('upload_failed')
                    self.update_health(status='error', errorCode='upload_failed')
                    self.stop.wait(1)
                    continue
                if self.catalog_changed:
                    self.persist_events(self.tracker.reset('catalog-changed'))
                    self.catalog_changed = False
                self.flush_unsaved()
                if not self.box.stats()['capacityAvailable']:
                    raise EdgeError('storage_full')
                value = self.source.get()
                is_file = self.config['source']['kind'] == 'file'
                with self.lock:
                    frame_lease_id, frame_lease_deadline, frame_lease_from, frame_lease_until = self.lease_id, self.lease_deadline, self.lease_valid_from, self.lease_valid_until
                if not is_file and time.monotonic() >= frame_lease_deadline:
                    continue
                if not is_file and not frame_lease_from <= value['timestamp'] <= frame_lease_until:
                    # A queued pre-lease frame after takeover cannot be safely
                    # attributed to the new producer. Wait for a fresh frame.
                    continue
                # Pin the frame to the lease that covered its capture receipt.
                # A concurrent renewal must not attach a new lease to an older
                # pending crossing; its original lease remains on the candidate.
                if previous_timestamp is not None and value['timestamp'] - previous_timestamp > self.tracker.options['maxMissingSec']:
                    self.open_gap('inference_failed', seconds_utc(previous_timestamp))
                previous_timestamp = value['timestamp']
                self.last_frame = value
                if value['fingerprint'] != last_fingerprint:
                    unchanged_since = value['receivedSeconds']
                    last_fingerprint = value['fingerprint']
                elif not is_file and value['receivedSeconds'] - unchanged_since >= self.config.get('unchangedReviewSec', 60):
                    # Identical frames might be a static scene. Mark uncertainty,
                    # do not pretend pixel equality proves an NVR/decoder freeze.
                    self.open_gap('video_stalled')
                    self.update_health(status='stalled', errorCode='source_unreachable')
                    continue
                started = time.monotonic()
                predictions = self.detector.detect(value['frame'])
                roi = self.config['roi']
                selected = []
                with self.lock:
                    recognizer = self.recognizer
                for prediction in predictions:
                    x,y,w,h = prediction['bbox']
                    if not roi[0] <= x+w/2 <= roi[0]+roi[2] or not roi[1] <= y+h/2 <= roi[1]+roi[3]:
                        continue
                    match = recognizer.recognize(prediction, value['frame'])
                    if match:
                        match['sourceLeaseId'] = frame_lease_id
                        selected.append(match)
                if len(selected) > self.config.get('maxObjects', 4):
                    self.open_gap('inference_failed')
                    self.update_health(status='stalled', errorCode='calibration_required')
                    log('too_many_objects', objects=len(selected))
                    continue
                elapsed_ms = (time.monotonic()-started)*1000
                self.close_gap(seconds_utc(value['timestamp']) if not is_file else utc_now())
                events = self.tracker.update(selected, value['timestamp'], lambda bbox: snapshot(value['frame'], bbox))
                self.persist_events(events)
                self.box.set_state('last_observed', seconds_utc(value['timestamp']))
                processed_times.append(time.monotonic())
                processed_times = [stamp for stamp in processed_times if stamp >= time.monotonic()-10]
                actual_fps = (len(processed_times)-1) / (processed_times[-1]-processed_times[0]) if len(processed_times)>1 and processed_times[-1]>processed_times[0] else 0.
                with self.lock:
                    self.health['components']['source'] = 'ready'
                    self.health['components']['frame'] = 'fresh'
                    self.health['metrics'].update(fps=actual_fps, inferenceMs=elapsed_ms, droppedFrames=value['droppedFrames'], processedFrames=self.health['metrics']['processedFrames']+1)
                self.update_health(status='running', errorCode='none')
                if max_frames is not None and self.health['metrics']['processedFrames'] >= max_frames:
                    break
            except EdgeError as error:
                if error.code == 'file_end':
                    self.persist_events(self.tracker.reset('file-end-before-confirmation'))
                    self.update_health(status='offline', errorCode='none', completed=True)
                    experiment_id = self.config['source']['experimentId']
                    self.box.enqueue('experiment-complete:'+self.tracker.session_id, '/api/experiments/'+str(experiment_id),
                                     {'status': 'completed', 'summary': {'edgeBinding': self.box.state('file_binding'),
                                       'source': 'exported-file-experiment', 'operationalCounts': False,
                                       'processedFrames': self.health['metrics']['processedFrames'], 'detectorSha256': self.config['detector']['sha256'],
                                       'countedCrossingsThisRun': self.health['metrics']['countedCrossings'], 'unknownCrossingsThisRun': self.health['metrics']['unknownCrossings']}})
                    break
                cause = 'source_unreachable' if error.code in ('source_unreachable','source_read_failed','frame_stale','decoder_unavailable') else 'inference_failed'
                if error.code.startswith('storage_'):
                    cause = 'unknown'
                try:
                    self.open_gap(cause)
                    with self.lock:
                        self.health['components']['source'] = error.code if cause == 'source_unreachable' else self.health['components']['source']
                        self.health['components']['frame'] = 'uncertain'
                    self.update_health(status='stalled', errorCode='storage_full' if error.code.startswith('storage_') else 'inference_failed' if cause == 'inference_failed' else 'source_unreachable')
                except (EdgeError, OSError):
                    log('health_storage_unavailable')
                log(error.code)
                if cause == 'source_unreachable':
                    self.source.start()
                self.stop.wait(2)
            except Exception:
                self.open_gap('inference_failed')
                self.update_health(status='error', errorCode='inference_failed')
                log('inference_internal_error')
                self.stop.wait(2)

    def shutdown(self, drain_seconds=2):
        self.source.close()
        try:
            self.open_gap('unknown')
            self.close_gap()
        except (EdgeError, OSError):
            log('shutdown_gap_unpersisted')
        # Give already persisted events a bounded chance to leave, then leave the
        # queue untouched for the next boot. No waiting forever on WAN outage.
        deadline = time.monotonic()+drain_seconds
        while self.upload_thread and self.box.stats()['queueDepth'] and time.monotonic()<deadline:
            time.sleep(.1)
        self.stop.set()
        if self.upload_thread:
            self.upload_thread.join(timeout=self.config['api'].get('timeoutSec', 8)+1)
        try:
            if self.monitor_id:
                self.client.request('/api/monitor/'+str(self.monitor_id)+'/end', {'reason': 'worker_stopped'})
            self.update_health(status='offline')
            self.client.request('/api/sources/'+str(self.config['source']['id'])+'/health', self.heartbeat_payload())
        except (EdgeError, OSError):
            pass
        self.box.close()
        self.process_lock.close()


def diagnose(config):
    path = pathlib.Path(config['stateDir']) / 'health.json'
    try:
        value = json.loads(path.read_text())
        value['healthAgeSec'] = max(0., time.time()-utc_seconds(value['observedAt']))
        if value['healthAgeSec'] > max(45, config.get('heartbeatSec',15)*3):
            value['status'] = 'offline'
            value['errorCode'] = 'worker_not_reporting'
        return value
    except (OSError, ValueError, KeyError):
        return {'status': 'offline', 'errorCode': 'health_unavailable'}


def check(config):
    checks = {}
    source = None
    try:
        box = Outbox(config['stateDir'], config.get('storage'))
        checks['storage'] = {'ok': box.stats()['capacityAvailable'], **box.stats()}
        box.close()
    except (OSError, EdgeError):
        checks['storage'] = {'ok': False, 'code': 'storage_unavailable'}
    try:
        detector = Detector(config['detector'])
        checks['model'] = {'ok': True, 'sha256': config['detector']['sha256'], 'labels': len(detector.labels), 'provider': 'CPUExecutionProvider'}
        embedding = Embedding(config['embedding']) if config.get('embedding') else None
        checks['referenceModel'] = {'ok': bool(embedding), 'code': 'ready' if embedding else 'missing_embedding_model'}
    except EdgeError as error:
        checks['model'] = {'ok': False, 'code': error.code}
        embedding = None
    if config['source']['kind'] == 'rtsp':
        target = urllib.parse.urlsplit(config['source']['resolvedInput'])
        try:
            with socket.create_connection((target.hostname, target.port or 554), timeout=config.get('sourceTimeoutSec', 5)):
                checks['lan'] = {'ok': True, 'code': 'rtsp_tcp_reachable'}
        except OSError:
            checks['lan'] = {'ok': False, 'code': 'rtsp_tcp_unreachable'}
    else:
        checks['lan'] = {'ok': True, 'code': 'local_source'}
    try:
        client = ApiClient(config['api'])
        registry, items, references, _ = load_catalog(config, client, embedding, config['stateDir'], allow_cache=False)
        checks['cloud'] = {'ok': True, 'code': 'https_api_reachable' if config['api']['baseUrl'].startswith('https://') else 'local_http_api_reachable'}
        checks['auth'] = {'ok': True, 'code': 'required_scopes_valid'}
        checks['catalog'] = {'ok': bool(items), 'items': len(items), 'referenceVectors': len(references)}
        checks['calibration'] = {'ok': config.get('calibrated') is True, 'code': 'approved' if config.get('calibrated') is True else 'calibration_required'}
    except ApiError as error:
        checks['cloud'] = {'ok': error.status is not None, 'code': error.code}
        checks['auth'] = {'ok': False, 'code': error.code}
    except EdgeError as error:
        checks['calibration'] = {'ok': False, 'code': error.code}
    try:
        source = Source(config)
        source.start()
        value = source.get()
        checks['source'] = {'ok': True, 'code': 'frame_decoded'}
        checks['frame'] = {'ok': True, 'width': value['frame'].shape[1], 'height': value['frame'].shape[0],
                           'ageSec': max(0.,time.time()-value['receivedSeconds']), 'timestampOrigin': 'declared-file-start-plus-source-PTS' if config['source']['kind']=='file' else 'edge-decoder-receipt-UTC'}
        if checks.get('model', {}).get('ok'):
            predictions = detector.detect(value['frame'])
            checks['inference'] = {'ok': True, 'detections': len(predictions), 'elapsedMs': detector.last_ms}
    except EdgeError as error:
        checks['source'] = {'ok': False, 'code': error.code}
    finally:
        if source:
            source.close()
    required = ('storage','model','lan','cloud','auth','catalog','calibration','source','frame','inference')
    return {'ok': all(checks.get(k, {}).get('ok') for k in required), 'checks': checks}


def main():
    parser = argparse.ArgumentParser(description='IEP edge worker; pass only private config path, never credentials in arguments')
    parser.add_argument('command', choices=('run','check','diagnose','retry-blocked'))
    parser.add_argument('--config', required=True)
    parser.add_argument('--max-frames', type=int, help='bounded commissioning run; not a production option')
    arguments = parser.parse_args()
    worker = None
    try:
        config = load_config(arguments.config)
        if arguments.command == 'diagnose':
            result = diagnose(config)
            print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
            return 0 if result.get('status') == 'running' else 2
        if arguments.command == 'check':
            result = check(config)
            print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
            return 0 if result['ok'] else 2
        if arguments.command == 'retry-blocked':
            box = Outbox(config['stateDir'], config.get('storage'))
            box.retry_blocked()
            box.close()
            log('blocked_retry_requested')
            return 0
        worker = Worker(config)
        signal.signal(signal.SIGTERM, lambda *_: worker.stop.set())
        signal.signal(signal.SIGINT, lambda *_: worker.stop.set())
        worker.run(arguments.max_frames)
        return 0
    except EdgeError as error:
        log(error.code, status=getattr(error,'status',None) or 0)
        if worker:
            try:
                worker.update_health(status='error', errorCode=error.code)
            except Exception:
                pass
        return 2
    except Exception:
        log('worker_internal_error')
        return 2
    finally:
        if worker:
            worker.shutdown()


if __name__ == '__main__':
    sys.exit(main())
