"""One consumed crossing identity per observed track, shared by known/unknown.

This is motion tracking within a fixed view, not physical identity across cameras,
occlusion, returns, restarts, or exported NVR files. Gaps invalidate that claim.
"""
import math
import uuid

from models import iou


def center(box):
    return [box[0] + box[2] / 2, box[1] + box[3] / 2]


class Tracker:
    def __init__(self, source_id, session_id=None, line=None, options=None):
        self.source_id = source_id
        self.session_id = session_id or f"edge:{source_id}:{uuid.uuid4()}"
        self.line = line or {'orientation': 'horizontal', 'position': .5, 'direction': 'down'}
        self.options = {'minObservations': 3, 'maxMissingSec': 1.5, 'confirmationSec': 1.5, 'maxDistance': .18, 'hysteresis': .015, **(options or {})}
        self.serial = 0
        self.tracks = []
        self.last_timestamp = None

    def reset(self, reason='tracking-gap'):
        events = []
        for track in self.tracks:
            if track.get('pending') and not track['consumed']:
                events.append(self.consume(track, reason))
        self.tracks = []
        self.last_timestamp = None
        # Serial never resets during one session; identity remains unique.
        return events

    def consume(self, track, reason=None):
        candidate = track['pending']
        track['pending'] = None
        track['consumed'] = True
        key = f"{self.session_id}:{track['id']}:crossing"
        return {**candidate, 'sessionId': self.session_id, 'trackId': str(track['id']), 'crossingId': '1', 'key': key,
                'dishId': None if reason else candidate['dishId'], 'reason': reason or candidate.get('reason'),
                'confidence': max(0, min(1, min(candidate['confidence'], track['confidence']))) }

    def update(self, detections, timestamp, snapshot_factory=None):
        if not math.isfinite(timestamp):
            raise ValueError('invalid tracking timestamp')
        if self.last_timestamp is not None and timestamp < self.last_timestamp:
            raise ValueError('tracking timestamp went backwards')
        self.last_timestamp = timestamp
        events = []
        retained = []
        for track in self.tracks:
            expired = timestamp - track['lastSeen'] > self.options['maxMissingSec']
            confirmation_expired = track.get('pending') and timestamp - track['pending']['timestamp'] >= self.options['confirmationSec']
            if (expired or confirmation_expired) and track.get('pending') and not track['consumed']:
                events.append(self.consume(track, 'visibility-lost' if expired else 'confirmation-timeout'))
            if not expired:
                retained.append(track)
        self.tracks = retained
        valid = [d for d in detections if len(d.get('bbox', [])) == 4 and all(math.isfinite(n) for n in d['bbox']) and d['bbox'][2] > 0 and d['bbox'][3] > 0]
        candidates = []
        for ti, track in enumerate(self.tracks):
            previous = center(track['bbox'])
            delta = min(.5, max(0, timestamp - track['lastSeen']))
            predicted = [previous[0] + track['velocity'][0] * delta, previous[1] + track['velocity'][1] * delta]
            for di, detection in enumerate(valid):
                current = center(detection['bbox'])
                distance = min(math.dist(current, previous), math.dist(current, predicted))
                overlap = iou(track['bbox'], detection['bbox'])
                if distance <= self.options['maxDistance'] or overlap > .1:
                    penalty = .25 if track['dishId'] and detection.get('dishId') and track['dishId'] != detection['dishId'] else 0
                    candidates.append((overlap + 1 - distance/self.options['maxDistance'] - penalty, ti, di))
        matched_tracks, matched_detections = set(), set()
        for _, ti, di in sorted(candidates, reverse=True):
            if ti in matched_tracks or di in matched_detections:
                continue
            matched_tracks.add(ti)
            matched_detections.add(di)
            self.observe(self.tracks[ti], valid[di], timestamp, events, snapshot_factory)
        for di, detection in enumerate(valid):
            if di in matched_detections:
                continue
            self.serial += 1
            track = {'id': self.serial, 'bbox': detection['bbox'][:], 'lastSeen': timestamp, 'velocity': [0, 0], 'stable': 0, 'observations': 0,
                     'consumed': False, 'pending': None, 'side': None, 'dishId': None, 'confidence': 0}
            self.tracks.append(track)
            self.observe(track, detection, timestamp, events, snapshot_factory)
        return events

    def observe(self, track, detection, timestamp, events, snapshot_factory):
        old_center, new_center = center(track['bbox']), center(detection['bbox'])
        delta = timestamp - track['lastSeen']
        if delta > 0:
            track['velocity'] = [(new_center[n] - old_center[n]) / delta for n in (0, 1)]
        previous_dish = track['dishId']
        dish_id = detection.get('dishId')
        track['stable'] = track['stable'] + 1 if dish_id and dish_id == previous_dish else 1 if dish_id else 0
        track.update(bbox=detection['bbox'][:], lastSeen=timestamp, dishId=dish_id, confidence=detection.get('confidence', 0), observations=track['observations'] + 1)
        axis = 1 if self.line['orientation'] == 'horizontal' else 0
        difference = new_center[axis] - self.line['position']
        side = -1 if difference < -self.options['hysteresis'] else 1 if difference > self.options['hysteresis'] else None
        if side is not None:
            if track['side'] is not None and side != track['side']:
                direction = ('down' if side == 1 else 'up') if axis == 1 else ('right' if side == 1 else 'left')
                if track.get('pending') and not track['consumed']:
                    events.append(self.consume(track, 'returned-before-confirmation'))
                if not track['consumed'] and (self.line['direction'] == 'both' or direction == self.line['direction']):
                    track['pending'] = {'dishId': dish_id if previous_dish == dish_id else None, 'dishName': detection.get('dishName', ''),
                                        'confidence': detection.get('confidence', 0), 'reason': detection.get('reason'), 'bbox': detection['bbox'][:],
                                        'sourceLeaseId': detection.get('sourceLeaseId'),
                                        'timestamp': timestamp, 'direction': direction, 'image': snapshot_factory(detection['bbox']) if snapshot_factory else None}
            track['side'] = side
        candidate = track.get('pending')
        if not candidate or track['consumed']:
            return
        if candidate['dishId'] != dish_id:
            events.append(self.consume(track, 'classification-changed'))
        elif not candidate['dishId']:
            # A crossed but unidentified object is persisted once for review.
            events.append(self.consume(track, candidate.get('reason') or 'unrecognized'))
        elif track['stable'] >= self.options['minObservations']:
            events.append(self.consume(track))
