"""Private configuration. Secrets stay in the process environment, never diagnostics."""
import datetime as dt
import json
import math
import os
import pathlib
import re
import stat
import urllib.parse


class EdgeError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utc_seconds(value):
    if not isinstance(value, str) or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", value):
        raise EdgeError("timestamp_timezone_required")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.timestamp()
    except (ValueError, OverflowError):
        raise EdgeError("invalid_timestamp") from None


def seconds_utc(seconds):
    return dt.datetime.fromtimestamp(seconds, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def number(value, lo, hi, code):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not lo <= value <= hi:
        raise EdgeError(code)
    return value


def identifier(value, code="invalid_identifier"):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", value):
        raise EdgeError(code)
    return value


def model_config(model):
    if not isinstance(model, dict) or not pathlib.Path(model.get("path", "")).is_absolute():
        raise EdgeError("invalid_model_path")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", model.get("sha256", "")):
        raise EdgeError("model_hash_required")
    size = model.get("inputSize", [416, 416])
    if not isinstance(size, list) or len(size) != 2 or any(not isinstance(n, int) or isinstance(n, bool) or not 32 <= n <= 2048 for n in size):
        raise EdgeError("invalid_model_size")


def load_config(filename, environ=None):
    environ = os.environ if environ is None else environ
    try:
        filename = pathlib.Path(filename)
        mode = filename.stat().st_mode
        if not stat.S_ISREG(mode) or mode & 0o022:
            raise EdgeError("config_permissions_unsafe")
        config = json.loads(filename.read_text())
    except (OSError, ValueError):
        raise EdgeError("config_unreadable") from None
    if not isinstance(config, dict):
        raise EdgeError("invalid_config")
    api = config.get("api", {})
    if not isinstance(api, dict):
        raise EdgeError("invalid_api_config")
    parsed = urllib.parse.urlsplit(api.get("baseUrl", ""))
    insecure_local = api.get("allowInsecureLocal") is True and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and insecure_local)) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise EdgeError("https_origin_required")
    api["baseUrl"] = api["baseUrl"].rstrip("/")
    identifier(api.get("apiKeyEnv", "IEP_API_KEY"), "invalid_key_environment")
    key = environ.get(api.get("apiKeyEnv", "IEP_API_KEY"), "")
    if not re.fullmatch(r"iep_[a-f0-9]{64}", key):
        raise EdgeError("api_key_missing")
    number(api.get("restaurantId"), 1, 2**53 - 1, "invalid_restaurant_id")
    if not isinstance(api["restaurantId"], int):
        raise EdgeError("invalid_restaurant_id")
    source = config.get("source", {})
    if not isinstance(source, dict):
        raise EdgeError("invalid_source_config")
    identifier(source.get("sourceId"), "invalid_source_id")
    number(source.get("id"), 1, 2**53 - 1, "invalid_source_registry_id")
    if not isinstance(source["id"], int):
        raise EdgeError("invalid_source_registry_id")
    kind = source.get("kind")
    if kind == "rtsp":
        identifier(source.get("urlEnv", "IEP_SOURCE_URL"), "invalid_source_environment")
        url = environ.get(source.get("urlEnv", "IEP_SOURCE_URL"), "")
        target = urllib.parse.urlsplit(url)
        if target.scheme not in {"rtsp", "rtsps"} or not target.hostname:
            raise EdgeError("rtsp_url_missing")
        source["resolvedInput"] = url
    elif kind == "usb":
        number(source.get("device", 0), 0, 64, "invalid_usb_device")
        if not isinstance(source.get("device", 0), int):
            raise EdgeError("invalid_usb_device")
        source["resolvedInput"] = source.get("device", 0)
    elif kind == "file":
        if not pathlib.Path(source.get("path", "")).is_absolute():
            raise EdgeError("file_path_absolute_required")
        source["resolvedInput"] = source["path"]
        source["startSeconds"] = utc_seconds(source.get("startTime"))
        if not isinstance(source.get("experimentId"), int) or source["experimentId"] < 1:
            raise EdgeError("file_experiment_required")
        # Immutable source identity pins replays to the same test; changing the file
        # or parameters requires a new experiment, never inserts live counts.
        if not re.fullmatch(r"[a-fA-F0-9]{64}", source.get("sha256", "")):
            raise EdgeError("file_hash_required")
    else:
        raise EdgeError("unsupported_source_kind")
    detector = config.get("detector", {})
    model_config(detector)
    if detector.get("format", "yolox") not in {"yolox", "xyxy"}:
        raise EdgeError("unsupported_detector_format")
    number(detector.get("scoreThreshold", .4), .05, .99, "invalid_score_threshold")
    if config.get("embedding"):
        model_config(config["embedding"])
        if config["embedding"].get("featureOutput") is not True or config["embedding"].get("preprocess") not in {"imagenet-rgb", "mobilenet-rgb"}:
            raise EdgeError("embedding_feature_contract_required")
    if not pathlib.Path(config.get("stateDir", "")).is_absolute():
        raise EdgeError("state_directory_absolute_required")
    number(config.get("targetFps", 5), .2, 30, "invalid_target_fps")
    number(config.get("maxObjects", 4), 1, 100, "invalid_max_objects")
    number(config.get("sourceTimeoutSec", 5), 1, 60, "invalid_source_timeout")
    number(config.get("unchangedReviewSec", 60), 5, 600, "invalid_unchanged_review_time")
    number(config.get("heartbeatSec", 15), 2, 30, "invalid_heartbeat_interval")
    number(config.get("catalogRefreshSec", 300), 10, 86400, "invalid_catalog_refresh_interval")
    roi = config.get("roi", [0, 0, 1, 1])
    if not isinstance(roi, list) or len(roi) != 4:
        raise EdgeError("invalid_roi")
    for n in roi:
        number(n, 0, 1, "invalid_roi")
    if roi[2] <= 0 or roi[3] <= 0 or roi[0] + roi[2] > 1.000001 or roi[1] + roi[3] > 1.000001:
        raise EdgeError("invalid_roi")
    config["roi"] = roi
    line = config.get("line", {})
    orientation = line.get("orientation", "horizontal")
    if orientation not in {"horizontal", "vertical"} or line.get("direction", "down") not in ({"up", "down", "both"} if orientation == "horizontal" else {"left", "right", "both"}):
        raise EdgeError("invalid_count_line")
    position = number(line.get("position", .5), 0, 1, "invalid_count_line")
    axis = 1 if orientation == "horizontal" else 0
    if not roi[axis] < position < roi[axis] + roi[axis + 2]:
        raise EdgeError("line_outside_roi")
    config["line"] = {"orientation": orientation, "direction": line.get("direction", "down"), "position": position}
    tracking = config.get("tracking", {})
    for field, default, lo, hi in [("minObservations", 3, 2, 20), ("maxMissingSec", 1.5, .2, 10), ("confirmationSec", 1.5, .2, 10), ("maxDistance", .18, .01, .5), ("hysteresis", .015, .001, .1)]:
        number(tracking.get(field, default), lo, hi, "invalid_tracking_setting")
    storage = config.get("storage", {})
    for field, default in [("maxQueueBytes", 2**31), ("maxQueueRows", 100000), ("reserveFreeBytes", 512 * 2**20)]:
        number(storage.get(field, default), 1, 2**50, "invalid_storage_limit")
    reference = config.get("reference", {})
    number(reference.get("threshold", .85), 0, 1, "invalid_reference_threshold")
    number(reference.get("margin", .025), 0, 1, "invalid_reference_margin")
    return config
