"""Isolated OpenCV/FFmpeg decoding, latest-frame live queue and RTSP TCP.

Credentials never occur in CLI arguments or logs. Decoder stderr is suppressed
inside a child process. A watchdog can terminate a blocked native decoder.
No source video is written by this worker.
"""
import hashlib
import multiprocessing as mp
import os
import queue
import time

from config import EdgeError


def _latest(channel, value):
    discarded = 0
    try:
        channel.put_nowait(value)
        return discarded
    except queue.Full:
        try:
            channel.get(timeout=.02)
            discarded = 1
        except queue.Empty:
            pass
        try:
            channel.put_nowait(value)
        except queue.Full:
            discarded += 1
        return discarded


def _capture(config, frames, commands, status):
    # Suppress native decoder errors which may include credential-bearing URLs.
    null = os.open(os.devnull, os.O_WRONLY)
    os.dup2(null, 2)
    os.close(null)
    os.environ['OPENCV_LOG_LEVEL'] = 'SILENT'
    os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'
    try:
        import cv2
        cv2.setLogLevel(0)
    except ImportError:
        status.put({'code': 'decoder_unavailable'})
        return
    capture = None
    source = config['source']
    timeout_ms = int(config.get('sourceTimeoutSec', 5)*1000)
    try:
        if source['kind'] == 'usb':
            capture = cv2.VideoCapture(source['resolvedInput'])
        else:
            capture = cv2.VideoCapture(source['resolvedInput'], cv2.CAP_FFMPEG,
                                       [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, timeout_ms, cv2.CAP_PROP_READ_TIMEOUT_MSEC, timeout_ms])
        if not capture.isOpened():
            status.put({'code': 'source_unreachable'})
            return
        is_file = source['kind'] == 'file'
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        if is_file and not 0 < fps <= 1000:
            status.put({'code': 'file_timebase_unavailable'})
            return
        duration = capture.get(cv2.CAP_PROP_FRAME_COUNT) / fps if is_file else None
        status.put({'code': 'source_open', 'videoFps': fps if fps > 0 else None, 'durationSec': duration})
        discarded, decoded_index, last_emit, next_media, previous_pts = 0, 0, 0., 0., None
        while True:
            if is_file:
                try:
                    command = commands.get(timeout=1)
                except queue.Empty:
                    continue
                if command == 'stop':
                    break
            else:
                try:
                    if commands.get_nowait() == 'stop':
                        break
                except queue.Empty:
                    pass
            ok, frame = capture.read()
            received = time.time()
            if not ok or frame is None:
                status.put({'code': 'file_end' if is_file else 'source_unreachable'})
                break
            media_time = float(capture.get(cv2.CAP_PROP_POS_MSEC)) / 1000 if is_file else None
            if is_file and (not 0 <= media_time < 10**9 or previous_pts is not None and media_time <= previous_pts):
                status.put({'code': 'file_timebase_unavailable'})
                return
            previous_pts = media_time if is_file else None
            decoded_index += 1
            if is_file:
                while media_time + 1e-8 < next_media:
                    ok, frame = capture.read()
                    if not ok or frame is None:
                        status.put({'code': 'file_end'})
                        return
                    media_time = float(capture.get(cv2.CAP_PROP_POS_MSEC)) / 1000
                    if not 0 <= media_time < 10**9 or media_time <= previous_pts:
                        status.put({'code': 'file_timebase_unavailable'})
                        return
                    previous_pts = media_time
                    decoded_index += 1
                received = time.time()
                next_media = media_time + 1 / config.get('targetFps', 5)
            elif time.monotonic() - last_emit < 1 / config.get('targetFps', 5):
                # Deliberate sampling, separate from queued-frame loss.
                continue
            last_emit = time.monotonic()
            maximum_width = config.get('captureMaxWidth', 1280)
            if frame.shape[1] > maximum_width:
                frame = cv2.resize(frame, (maximum_width, max(1, int(frame.shape[0]*maximum_width/frame.shape[1]))))
            fingerprint = hashlib.sha256(cv2.resize(frame, (32, 18)).tobytes()).hexdigest()
            value = {'frame': frame, 'receivedSeconds': received, 'mediaTimeSec': media_time,
                     'timestamp': source['startSeconds']+media_time if is_file else received,
                     'decodedFrames': decoded_index, 'droppedFrames': discarded, 'fingerprint': fingerprint,
                     'timestampOrigin': 'source-presentation-timestamp' if is_file else 'edge-decoder-receipt-UTC'}
            if is_file:
                frames.put(value, timeout=timeout_ms / 1000)
            else:
                discarded += _latest(frames, value)
    except Exception:
        status.put({'code': 'source_read_failed'})
    finally:
        if capture is not None:
            capture.release()


class Source:
    def __init__(self, config):
        self.config = config
        self.context = mp.get_context('spawn')
        self.process = None
        self.info = {'code': 'not_started'}

    def start(self):
        self.close()
        self.frames = self.context.Queue(maxsize=1)
        self.commands = self.context.Queue(maxsize=2)
        self.status = self.context.Queue(maxsize=8)
        self.process = self.context.Process(target=_capture, args=(self.config, self.frames, self.commands, self.status), daemon=True)
        self.process.start()
        self.info = {'code': 'starting'}
        self.waiting = False

    def poll_status(self):
        if self.process:
            while True:
                try:
                    self.info = {**self.info, **self.status.get_nowait()}
                except queue.Empty:
                    break
        return self.info

    def get(self, timeout=None):
        if not self.process:
            self.start()
        if self.config['source']['kind'] == 'file' and not self.waiting:
            self.commands.put('next')
            self.waiting = True
        try:
            value = self.frames.get(timeout=timeout if timeout is not None else self.config.get('sourceTimeoutSec', 5) + 1)
            self.waiting = False
        except queue.Empty:
            self.poll_status()
            if self.info['code'] == 'file_end':
                raise EdgeError('file_end') from None
            raise EdgeError(self.info['code'] if self.info['code'] not in {'source_open', 'starting'} else 'source_unreachable') from None
        self.poll_status()
        if self.config['source']['kind'] != 'file' and time.time() - value['receivedSeconds'] > self.config.get('sourceTimeoutSec', 5):
            raise EdgeError('frame_stale')
        return value

    def close(self):
        if self.process:
            try:
                self.commands.put_nowait('stop')
            except queue.Full:
                pass
            self.process.join(timeout=.2)
            if self.process.is_alive():
                self.process.terminate()
                self.process.join(timeout=1)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=1)
            for channel in (self.frames, self.commands, self.status):
                channel.cancel_join_thread()
                channel.close()
            self.process = None
