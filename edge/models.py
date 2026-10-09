"""Verified ONNX models and conservative, opt-in catalog recognition.

YOLOX official export uses raw BGR 0..255, top-left letterbox and undecoded
grids. A custom xyxy model must explicitly declare its labels and preprocessing.
Reference descriptors must be feature vectors, not guessed labels.
"""
import hashlib
import math
import pathlib
import time

from config import EdgeError

COCO_CLASSES = ['person','bicycle','car','motorcycle','airplane','bus','train','truck','boat','traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball','kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket','bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair','couch','potted plant','bed','dining table','toilet','tv','laptop','mouse','remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator','book','clock','vase','scissors','teddy bear','hair drier','toothbrush']
FOOD = {'bowl','cup','wine glass','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake'}
DRINKS = {'bottle','cup','wine glass','bowl'}
CONTAINERS = {'bowl','cup','wine glass','plate','drink_container'}


def file_sha256(filename):
    digest = hashlib.sha256()
    try:
        with open(filename, "rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        raise EdgeError("model_unreadable") from None
    return digest.hexdigest()


def verified_session(config):
    if file_sha256(config["path"]) != config["sha256"].lower():
        raise EdgeError("model_hash_mismatch")
    try:
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.intra_op_num_threads = config.get("threads", 2)
        options.inter_op_num_threads = 1
        options.log_severity_level = 4
        session = ort.InferenceSession(config["path"], sess_options=options, providers=["CPUExecutionProvider"])
        if len(session.get_inputs()) != 1:
            raise EdgeError("unsupported_model_inputs")
        return session
    except ImportError:
        raise EdgeError("onnxruntime_unavailable") from None
    except EdgeError:
        raise
    except Exception:
        raise EdgeError("model_load_failed") from None


def iou(a, b):
    overlap = max(0., min(a[0]+a[2], b[0]+b[2])-max(a[0], b[0])) * max(0., min(a[1]+a[3], b[1]+b[3])-max(a[1], b[1]))
    return overlap / max(1e-12, a[2]*a[3]+b[2]*b[3]-overlap)


def suppress_nested(predictions):
    # One served container can contain several food detections. This heuristic
    # avoids double counting; side-by-side dishes are retained. Validate at site.
    selected = []
    for p in sorted(predictions, key=lambda p: (p['class'] not in CONTAINERS, -p['score'])):
        x, y, w, h = p['bbox']
        nested = p['class'] in FOOD - CONTAINERS and any(
            q['class'] in CONTAINERS and max(0, min(x+w, q['bbox'][0]+q['bbox'][2])-max(x, q['bbox'][0])) * max(0, min(y+h, q['bbox'][1]+q['bbox'][3])-max(y, q['bbox'][1])) / max(1e-12, min(w*h, q['bbox'][2]*q['bbox'][3])) > .7
            for q in selected)
        if not nested:
            selected.append(p)
    return selected


class Detector:
    def __init__(self, config):
        self.config = config
        self.session = verified_session(config)
        self.input = self.session.get_inputs()[0].name
        self.labels = config.get('labels', COCO_CLASSES)
        if not isinstance(self.labels, list) or not self.labels or len(self.labels) > 512 or len(set(self.labels)) != len(self.labels) or any(not isinstance(s, str) or not s or len(s) > 100 for s in self.labels):
            raise EdgeError('invalid_model_labels')
        self.size = config.get('inputSize', [416, 416])
        self.last_ms = None

    def detect(self, frame):
        import cv2
        import numpy as np
        started = time.monotonic()
        height, width = frame.shape[:2]
        in_height, in_width = self.size
        ratio = min(in_height / height, in_width / width)
        resized = cv2.resize(frame, (max(1, int(width * ratio)), max(1, int(height * ratio))))
        canvas = np.full((in_height, in_width, 3), 114, dtype=np.uint8)
        canvas[:resized.shape[0], :resized.shape[1]] = resized
        if self.config.get('format', 'yolox') == 'yolox':
            tensor = canvas.transpose(2, 0, 1).astype(np.float32)[None]
        else:
            tensor = preprocess(canvas, self.config.get('preprocess', 'rgb-unit'))
        try:
            output = self.session.run(None, {self.input: tensor})[0]
        except Exception:
            raise EdgeError('inference_failed') from None
        self.last_ms = (time.monotonic() - started) * 1000
        threshold = self.config.get('scoreThreshold', .4)
        predictions = []
        if self.config.get('format', 'yolox') == 'yolox':
            data = np.asarray(output, dtype=np.float32).reshape(-1, 5 + len(self.labels)).copy()
            grids, strides = [], []
            for stride in [8, 16, 32]:
                xx, yy = np.meshgrid(np.arange(in_width // stride), np.arange(in_height // stride))
                grids.append(np.stack((xx, yy), 2).reshape(-1, 2))
                strides.append(np.full((xx.size, 1), stride))
            grid, stride = np.concatenate(grids), np.concatenate(strides)
            if len(data) != len(grid):
                raise EdgeError('yolox_output_shape_mismatch')
            if self.config.get('decoded', False) is not True:
                data[:, :2] = (data[:, :2] + grid) * stride
                data[:, 2:4] = np.exp(np.clip(data[:, 2:4], -20, 20)) * stride
            indices = np.argmax(data[:, 5:], axis=1)
            scores = data[:, 4] * data[np.arange(len(data)), 5 + indices]
            for index in np.flatnonzero(scores >= threshold):
                cx, cy, bw, bh = data[index, :4]
                predictions.append(self._box([cx-bw/2, cy-bh/2, cx+bw/2, cy+bh/2], float(scores[index]), int(indices[index]), width, height, ratio))
        else:
            data = np.asarray(output).reshape(-1, 6)
            for x1, y1, x2, y2, score, class_index in data:
                if not math.isfinite(float(score)) or score < threshold:
                    continue
                if self.config.get('boxSpace') == 'normalized':
                    x1, x2 = x1 * in_width, x2 * in_width
                    y1, y2 = y1 * in_height, y2 * in_height
                predictions.append(self._box([x1, y1, x2, y2], float(score), int(class_index), width, height, ratio))
        filtered = []
        for p in sorted((p for p in predictions if p), key=lambda p: -p['score'])[:100]:
            if not any(p['class'] == q['class'] and iou(p['bbox'], q['bbox']) > self.config.get('nmsThreshold', .45) for q in filtered):
                filtered.append(p)
        return suppress_nested(filtered)

    def _box(self, xyxy, score, class_index, width, height, ratio):
        if class_index < 0 or class_index >= len(self.labels) or not all(math.isfinite(float(n)) for n in xyxy):
            return None
        x1, y1, x2, y2 = xyxy
        x1, x2 = min(width, max(0., float(x1)/ratio)), min(width, max(0., float(x2)/ratio))
        y1, y2 = min(height, max(0., float(y1)/ratio)), min(height, max(0., float(y2)/ratio))
        if x2 <= x1 or y2 <= y1:
            return None
        return {'class': self.labels[class_index], 'score': min(1., max(0., score)), 'bbox': [x1/width, y1/height, (x2-x1)/width, (y2-y1)/height]}


def preprocess(frame, kind):
    import cv2
    import numpy as np
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB).astype(np.float32)
    if kind == 'imagenet-rgb':
        rgb = (rgb / 255. - np.array([.485, .456, .406], dtype=np.float32)) / np.array([.229, .224, .225], dtype=np.float32)
    elif kind == 'mobilenet-rgb':
        rgb = rgb / 127.5 - 1.
    elif kind == 'rgb-unit':
        rgb = rgb / 255.
    elif kind != 'rgb-raw':
        raise EdgeError('unsupported_preprocessing')
    return rgb.transpose(2, 0, 1)[None].astype(np.float32)


class Embedding:
    def __init__(self, config):
        self.config = config
        self.session = verified_session(config)
        self.input = self.session.get_inputs()[0].name
        self.size = config.get('inputSize', [224, 224])
        if config.get('featureOutput') is not True:
            raise EdgeError('embedding_feature_contract_required')

    def vector(self, frame):
        import cv2
        import numpy as np
        prepared = cv2.resize(frame, (self.size[1], self.size[0]))
        tensor = preprocess(prepared, self.config.get('preprocess', 'imagenet-rgb'))
        try:
            outputs = [self.config['outputName']] if self.config.get('outputName') else None
            vector = np.asarray(self.session.run(outputs, {self.input: tensor})[0], dtype=np.float32).reshape(-1)
        except Exception:
            raise EdgeError('embedding_inference_failed') from None
        if vector.size < 16 or vector.size > 65536 or not np.all(np.isfinite(vector)):
            raise EdgeError('embedding_output_invalid')
        norm = float(np.linalg.norm(vector))
        if norm < 1e-8:
            raise EdgeError('embedding_output_invalid')
        return vector / norm


def allowed(item, object_class, custom_reference_classes=None):
    classes = item.get('detectorClasses', [])
    if classes:
        return object_class in classes
    if item.get('recognitionMode', 'reference') == 'detector':
        return False
    kind = item.get('kind', 'dish')
    if kind == 'person':
        return object_class == 'person'
    if kind == 'object':
        return object_class != 'person'
    defaults = DRINKS if kind == 'drink' else FOOD
    custom_defaults = custom_reference_classes or {'dish': ['plate'], 'drink': ['drink_container']}
    return object_class in defaults or object_class in custom_defaults.get(kind, [])


class Recognizer:
    def __init__(self, items, references=None, embedding=None, config=None):
        self.items = items
        self.references = references or []
        self.embedding = embedding
        self.config = config or {}

    def recognize(self, prediction, frame):
        candidates = [item for item in self.items if allowed(item, prediction['class'], self.config.get('customClasses'))]
        if not candidates:
            return None  # Unselected classes are not counted or treated as orders.
        result = {**prediction, 'dishId': None, 'dishName': '', 'confidence': prediction['score'], 'reason': 'unrecognized'}
        generic = [item for item in candidates if item.get('recognitionMode', 'reference') == 'detector']
        refs = [item for item in candidates if item.get('recognitionMode', 'reference') == 'reference']
        if len(generic) > 1 or (generic and refs):
            return {**result, 'reason': 'conflicting-detector-mapping'}
        if len(generic) == 1:
            return {**result, 'dishId': generic[0]['id'], 'dishName': generic[0]['name'], 'reason': None}
        if not self.embedding:
            return {**result, 'reason': 'missing-embedding-model'}
        height, width = frame.shape[:2]
        x, y, w, h = prediction['bbox']
        crop = frame[max(0, int(y*height)):min(height, max(1, int((y+h)*height))), max(0, int(x*width)):min(width, max(1, int((x+w)*width)))]
        if not crop.size:
            return result
        vector = self.embedding.vector(crop)
        best = {}
        allowed_ids = {item['id'] for item in refs}
        for reference in self.references:
            if reference['dishId'] not in allowed_ids:
                continue
            try:
                score = float(vector @ reference['vector'])
            except (ValueError, TypeError):
                raise EdgeError('reference_vector_mismatch') from None
            item_id = reference['dishId']
            if item_id not in best or score > best[item_id]['confidence']:
                best[item_id] = {'dishId': item_id, 'dishName': reference['dishName'], 'confidence': score}
        scores = sorted(best.values(), key=lambda match: -match['confidence'])
        if not scores or scores[0]['confidence'] < self.config.get('threshold', .85):
            return {**result, 'reason': 'reference-below-threshold'}
        if len(scores) > 1 and scores[0]['confidence'] - scores[1]['confidence'] < self.config.get('margin', .025):
            return {**result, 'confidence': scores[0]['confidence'], 'reason': 'reference-ambiguous'}
        return {**result, **scores[0], 'reason': None}
