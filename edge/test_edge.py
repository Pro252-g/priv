import copy
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

from config import EdgeError, load_config
from client import ApiClient, ApiError, NoRedirect
from models import COCO_CLASSES, Detector, Embedding, Recognizer, file_sha256
from outbox import Outbox
from source import Source
from tracking import Tracker
from worker import Worker, catalog_fingerprint, fingerprint_config, verify_registry


def sample_config(directory):
    return {'api': {'baseUrl': 'http://127.0.0.1:9', 'allowInsecureLocal': True, 'apiKeyEnv': 'IEP_TEST_API_KEY', 'restaurantId': 1, 'timeoutSec': .1},
            'source': {'id': 1, 'sourceId': 'food-pass', 'kind': 'usb', 'device': 0, 'resolvedInput': 0},
            'stateDir': str(directory), 'detector': {'path': '/not-installed/model.onnx', 'sha256': 'a'*64, 'format': 'yolox', 'inputSize': [416,416]},
            'calibrated': True, 'targetFps': 5, 'maxObjects': 4, 'roi': [0,0,1,1], 'line': {'orientation': 'horizontal', 'position': .5, 'direction': 'down'},
            'storage': {'reserveFreeBytes': 1, 'maxQueueBytes': 1048576, 'maxQueueRows': 100}}


def detection(x, y, dish=1):
    return {'bbox': [x,y,.12,.08], 'dishId': dish, 'dishName': 'item', 'confidence': .94, 'reason': 'unrecognized' if dish is None else None}


class TrackingTests(unittest.TestCase):
    def test_four_simultaneous_crossings_keep_distinct_single_identities(self):
        tracker = Tracker('window', 'boot-one')
        events = []
        for frame, y in enumerate([.28,.37,.51,.62,.40,.51]):
            events.extend(tracker.update([detection(x,y) for x in [.04,.27,.50,.73]], frame*.2))
        self.assertEqual(len(events), 4)
        self.assertEqual(len({e['key'] for e in events}), 4)
        self.assertTrue(all(e['dishId']==1 for e in events))

    def test_unknown_then_known_never_counts_same_track_again(self):
        tracker = Tracker('window', 'boot-two')
        events = []
        for index, (y, dish) in enumerate([(.28,None),(.37,None),(.51,None),(.62,1),(.37,1),(.51,1),(.62,1)]):
            events.extend(tracker.update([detection(.4,y,dish)], index*.2))
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]['dishId'])
        self.assertEqual(events[0]['crossingId'], '1')

    def test_candidate_class_change_yields_one_unknown_not_two_records(self):
        tracker = Tracker('window', 'boot-three', options={'minObservations': 4})
        events = []
        for index, (y, dish) in enumerate([(.36,1),(.51,1),(.58,2),(.62,2),(.68,2)]):
            events.extend(tracker.update([detection(.4,y,dish)], index*.2))
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]['dishId'])
        self.assertEqual(events[0]['reason'], 'classification-changed')

    def test_reset_reviews_pending_without_reusing_track_id(self):
        tracker = Tracker('window', 'boot-four', options={'minObservations': 4})
        tracker.update([detection(.3,.36)], 0)
        tracker.update([detection(.3,.51)], .2)
        events = tracker.reset('tracking-gap')
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]['dishId'])
        tracker.update([detection(.3,.36)], 1)
        self.assertEqual(tracker.tracks[0]['id'], 2)

    def test_pending_crossing_retains_original_lease_during_renewal(self):
        tracker = Tracker('window', 'boot-five', options={'minObservations':4})
        events = []
        for index,y in enumerate([.28,.37,.51,.62]):
            item = detection(.4,y)
            item['sourceLeaseId'] = 7 if index < 3 else 8
            events.extend(tracker.update([item], index*.2))
        self.assertEqual(events[0]['sourceLeaseId'],7)


class StorageTests(unittest.TestCase):
    def test_retry_keeps_original_snapshot_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            box = Outbox(folder, {'reserveFreeBytes':1})
            payload = {'image':'data:image/jpeg;base64,evidence'}
            box.enqueue('crossing', '/api/events', payload)
            box.fail('crossing','image_pending',immediate=True)
            box.close()
            box = Outbox(folder, {'reserveFreeBytes':1})
            row = box.db.execute('SELECT * FROM outbox').fetchone()
            self.assertEqual(json.loads(row['payload'])['image'], payload['image'])
            self.assertEqual(row['attempts'], 1)
            with self.assertRaisesRegex(EdgeError,'outbox_identity_conflict'):
                box.enqueue('crossing','/api/events',{'image':'different'})
            box.ack('crossing')
            self.assertEqual(box.stats()['queueDepth'],0)
            box.close()

    def test_capacity_fails_before_losing_existing_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            box = Outbox(folder, {'reserveFreeBytes':1, 'maxQueueRows':1})
            box.enqueue('one','/api/events',{'image':'one'})
            with self.assertRaisesRegex(EdgeError,'storage_full'):
                box.enqueue('two','/api/events',{'image':'two'})
            self.assertEqual(box.stats()['queueDepth'],1)
            self.assertEqual(box.due()['key'],'one')
            box.close()

    def test_batch_retains_all_four_consumed_events_when_first_write_fails(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ, {'IEP_TEST_API_KEY':'iep_'+'a'*64}):
            worker = Worker(sample_config(folder))
            worker.registered = {'name':'Food pass'}
            events = [{'key':f'boot:track-{i}', 'sessionId':'boot','trackId':str(i),'crossingId':'1', 'timestamp':1700000000+i/10,
                       'dishId':1,'confidence':.9,'image':'data:image/jpeg;base64,evidence'} for i in range(4)]
            original = worker.box.enqueue
            with mock.patch.object(worker.box, 'enqueue', side_effect=EdgeError('storage_full')):
                with self.assertRaisesRegex(EdgeError, 'storage_full'):
                    worker.persist_events(events)
            self.assertEqual(len(worker.unsaved),4)
            worker.flush_unsaved()
            self.assertEqual(worker.box.stats()['queueDepth'],4)
            self.assertEqual(worker.health['metrics']['countedCrossings'],4)
            worker.box.close()
            worker.process_lock.close()

    def test_second_process_same_state_cannot_start(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ, {'IEP_TEST_API_KEY':'iep_'+'a'*64}):
            worker = Worker(sample_config(folder))
            with self.assertRaisesRegex(EdgeError,'worker_already_running'):
                Worker(sample_config(folder))
            worker.box.close()
            worker.process_lock.close()


class RecognitionTests(unittest.TestCase):
    def test_generic_conflict_never_selects_arbitrary_item(self):
        items = [{'id':1,'name':'A','recognitionMode':'detector','detectorClasses':['cup']}, {'id':2,'name':'B','recognitionMode':'detector','detectorClasses':['cup']}]
        result = Recognizer(items).recognize({'class':'cup','score':.95,'bbox':[0,0,1,1]}, None)
        self.assertIsNone(result['dishId'])
        self.assertEqual(result['reason'],'conflicting-detector-mapping')

    def test_custom_plate_reaches_reference_stage_and_missing_model_is_unknown(self):
        result = Recognizer([{'id':1,'name':'Meal','kind':'dish','recognitionMode':'reference'}]).recognize({'class':'plate','score':.95,'bbox':[0,0,1,1]}, None)
        self.assertIsNone(result['dishId'])
        self.assertEqual(result['reason'],'missing-embedding-model')

    def test_model_profile_must_match_model_hash_labels_and_calibration(self):
        config = sample_config('/tmp/example')
        config['detector'].update(format='xyxy',labels=['plate'])
        calibration = {key: config[key] for key in ('roi','line','targetFps','maxObjects')}
        calibration['modelProfileId'] = 2
        registry = {'sources':[{'id':1,'sourceId':'food-pass','kind':'usb','enabled':True,'config':calibration}]}
        profiles = {'profiles':[{'id':2,'modelSha256':'a'*64,'classes':[{'name':'plate'}]}]}
        self.assertEqual(verify_registry(config,registry,profiles)['id'],1)
        profiles['profiles'][0]['modelSha256'] = 'b'*64
        with self.assertRaisesRegex(EdgeError,'model_profile_mismatch'):
            verify_registry(config,registry,profiles)

    def test_adapter_and_label_change_changes_replay_binding(self):
        config = sample_config('/tmp/example')
        prior = fingerprint_config(config)
        config['detector']['labels'] = ['plate']
        self.assertNotEqual(prior, fingerprint_config(config))

    def test_reference_variant_or_catalog_change_changes_replay_binding(self):
        items = [{'id':1,'name':'Meal','samples':[{'id':2,'image_key':'t1/hash','variantLabel':'plate'}]}]
        previous = catalog_fingerprint(items)
        items[0]['samples'][0]['variantLabel'] = 'tray'
        self.assertNotEqual(previous,catalog_fingerprint(items))


class TransportTests(unittest.TestCase):
    def test_query_string_get_is_accepted_and_redirects_are_rejected(self):
        with mock.patch.dict(os.environ, {'IEP_TEST_API_KEY':'iep_'+'a'*64}):
            client = ApiClient({'baseUrl':'http://127.0.0.1:9','apiKeyEnv':'IEP_TEST_API_KEY'})
            reply = mock.MagicMock()
            reply.__enter__.return_value.read.return_value = b'{"sources":[]}'
            with mock.patch.object(client.opener,'open',return_value=reply) as opened:
                self.assertEqual(client.request('/api/sources?restaurantId=1'),{'sources':[]})
                self.assertEqual(opened.call_args.args[0].full_url,'http://127.0.0.1:9/api/sources?restaurantId=1')
            with self.assertRaisesRegex(ApiError,'api_redirect_refused'):
                NoRedirect().redirect_request(None,None,302,'',{},'https://other.example')

    def test_lease_uses_server_duration_with_safety_and_marks_changed_generation(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ, {'IEP_TEST_API_KEY':'iep_'+'a'*64}):
            worker = Worker(sample_config(folder))
            fake = mock.Mock()
            fake.request.return_value = {'leaseId':1,'serverTime':'2026-10-09T10:00:00Z','expiresAt':'2026-10-09T10:00:45Z'}
            with mock.patch('worker.time.monotonic',return_value=100), mock.patch('worker.time.time',return_value=1791540000):
                worker.renew_lease(fake)
            self.assertEqual(worker.lease_deadline,144)
            self.assertEqual(worker.lease_id,1)
            fake.request.return_value['leaseId'] = 2
            with mock.patch('worker.time.time',return_value=1791540000):
                worker.renew_lease(fake)
            self.assertTrue(worker.lease_changed)
            worker.box.close()
            worker.process_lock.close()


class ConfigTests(unittest.TestCase):
    def test_credentials_not_accepted_as_cli_or_public_api_url(self):
        with tempfile.TemporaryDirectory() as folder:
            config = sample_config(folder)
            config['api']['baseUrl'] = 'https://password:secret@example.com'
            filename = pathlib.Path(folder)/'private.json'
            filename.write_text(json.dumps(config))
            filename.chmod(0o600)
            with self.assertRaisesRegex(EdgeError,'https_origin_required'):
                load_config(filename, {'IEP_TEST_API_KEY':'iep_'+'a'*64})


class RealRuntimeTests(unittest.TestCase):
    def test_actual_pinned_models_infer_finite_outputs(self):
        import numpy as np
        root = pathlib.Path(__file__).resolve().parents[1]
        detector_path = root/'.local/edge-models/yolox_tiny.onnx'
        feature_path = root/'.local/edge-models/mobilenet-v2-features.onnx'
        if not detector_path.exists() or not feature_path.exists():
            self.skipTest('Run verified model installer first; production model smoke is separate from synthetic logic tests')
        detector = Detector({'path':str(detector_path),'sha256':'427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7','format':'yolox','inputSize':[416,416]})
        embedding = Embedding({'path':str(feature_path),'sha256':'e58c623b9269fd171e6cc35ec401e0a72c69b1baad2e2e21c06b444c902fd5a9','inputSize':[224,224],'preprocess':'imagenet-rgb','featureOutput':True})
        frame = np.zeros((360,640,3),dtype=np.uint8)
        predictions = detector.detect(frame)
        self.assertIsInstance(predictions,list)
        vector = embedding.vector(frame)
        self.assertEqual(vector.shape,(1280,))
        self.assertTrue(np.isfinite(vector).all())
        self.assertAlmostEqual(float(np.linalg.norm(vector)),1.,places=5)

    def test_actual_decoder_uses_source_pts_and_does_not_store_video(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as folder:
            video = pathlib.Path(folder)/'fixture.mp4'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10','-t','0.7','-c:v','mpeg4','-y',str(video)],check=True)
            config = sample_config(pathlib.Path(folder)/'state')
            config['source'] = {'id':1,'sourceId':'test-file','kind':'file','resolvedInput':str(video),'startSeconds':1700000000}
            config['sourceTimeoutSec'] = 1
            source = Source(config)
            try:
                source.start()
                first = source.get()
                second = source.get()
                self.assertAlmostEqual(first['mediaTimeSec'],0,places=4)
                self.assertAlmostEqual(second['mediaTimeSec'],.2,places=4)
                self.assertAlmostEqual(second['timestamp'],1700000000.2,places=4)
                self.assertEqual(second['timestampOrigin'],'source-presentation-timestamp')
                self.assertEqual(len(list(pathlib.Path(folder).rglob('*.mp4'))),1)
            finally:
                source.close()


if __name__ == '__main__':
    unittest.main()
