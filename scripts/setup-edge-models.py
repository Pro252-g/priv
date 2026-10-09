#!/usr/bin/env python3
"""Prepare verified CPU inference artifacts. Does not install packages or train a model."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import tempfile
import urllib.request

DETECTOR = {
    "filename": "yolox_tiny.onnx",
    "source": "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx",
    "sha256": "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7",
    "license": "Apache-2.0",
    "licenseUrl": "https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE",
    "artifactKind": "detector", "inputSize": [416, 416],
    "checksumOrigin": "Observed on the official HTTPS release; pinned by IEP, not a publisher signature",
}
WEIGHTS = {
    "filename": "mobilenet_v2-b0353104.pth",
    "source": "https://download.pytorch.org/models/mobilenet_v2-b0353104.pth",
    "sha256": "b03531047ffacf1e2488318dcd2aba1126cde36e3bfe1aa5cb07700aeeee9889",
    "license": "BSD-3-Clause",
    "licenseUrl": "https://github.com/pytorch/vision/blob/v0.20.1/LICENSE",
    "artifactKind": "export-input",
    "checksumOrigin": "Full digest pinned by IEP; published filename contains the b0353104 digest prefix",
}
FEATURE_SHA = "e58c623b9269fd171e6cc35ec401e0a72c69b1baad2e2e21c06b444c902fd5a9"


def sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def download(spec, target):
    if target.exists():
        if sha(target) != spec["sha256"]:
            raise RuntimeError(f"Checksum mismatch: {target}; remove the untrusted artifact explicitly")
        return
    request = urllib.request.Request(spec["source"], headers={"User-Agent": "IEP-model-setup/1.0"})
    fd, name = tempfile.mkstemp(prefix=".download-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream, urllib.request.urlopen(request, timeout=90) as response:
            while block := response.read(1024 * 1024):
                stream.write(block)
            stream.flush()
            os.fsync(stream.fileno())
        if sha(name) != spec["sha256"]:
            raise RuntimeError(f"Checksum mismatch downloading {spec['filename']}")
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)


def export_features(weights, target):
    versions = {name: importlib.metadata.version(name) for name in ("torch", "torchvision", "onnx")}
    for name, expected in (("torch", "2.5.1"), ("torchvision", "0.20.1"), ("onnx", "1.17.0")):
        if versions[name].split("+")[0] != expected:
            raise RuntimeError(f"Exporter needs {name} {expected}; found {versions[name]}")
    if target.exists():
        if sha(target) != FEATURE_SHA:
            raise RuntimeError(f"Checksum mismatch: {target}; do not accept changed exports")
        return versions
    import torch
    import torchvision
    import onnx

    torch.set_num_threads(2)
    model = torchvision.models.mobilenet_v2(weights=None)
    model.load_state_dict(torch.load(weights, weights_only=True, map_location="cpu"))
    model.eval()

    class Features(torch.nn.Module):
        def __init__(self, original):
            super().__init__()
            self.features = original.features

        def forward(self, images):
            return self.features(images).mean(dim=(2, 3))

    features = Features(model).eval()
    fd, name = tempfile.mkstemp(prefix=".features-", suffix=".onnx", dir=target.parent)
    os.close(fd)
    try:
        torch.onnx.export(features, torch.zeros(1, 3, 224, 224), name,
                          input_names=["images"], output_names=["features"],
                          opset_version=13, do_constant_folding=True)
        onnx.checker.check_model(onnx.load(name))
        if sha(name) != FEATURE_SHA:
            raise RuntimeError("Export differs from the tested artifact; keep the expected digest and investigate exporter/platform")
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)
    return versions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".local/edge-models"))
    parser.add_argument("--detector-only", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    download(DETECTOR, args.output / DETECTOR["filename"])
    specs, versions = [DETECTOR], {}
    if not args.detector_only:
        download(WEIGHTS, args.output / WEIGHTS["filename"])
        versions = export_features(args.output / WEIGHTS["filename"], args.output / "mobilenet-v2-features.onnx")
        specs.extend([WEIGHTS, {
            "filename": "mobilenet-v2-features.onnx", "sha256": FEATURE_SHA,
            "source": WEIGHTS["source"], "license": WEIGHTS["license"],
            "licenseUrl": WEIGHTS["licenseUrl"], "artifactKind": "reference-descriptor",
            "inputSize": [224, 224], "featureDimensions": 1280,
            "preprocess": "RGB /255, mean [0.485,0.456,0.406], std [0.229,0.224,0.225]",
            "checksumOrigin": "IEP reproducible feature-only ONNX export from pinned official weights",
        }])
    manifest = {"schemaVersion": 1, "models": [dict(spec, bytes=(args.output / spec["filename"]).stat().st_size) for spec in specs],
                "exportVersions": versions,
                "limitations": "General COCO detector has no plate class. Reference images do not train a detector. Restaurant accuracy requires a custom model and field validation."}
    fd, name = tempfile.mkstemp(prefix=".manifest-", dir=args.output)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(manifest, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(name, args.output / "manifest.json")
    finally:
        Path(name).unlink(missing_ok=True)
    print(json.dumps({"verified": [spec["filename"] for spec in specs], "manifest": str(args.output / "manifest.json")}))


if __name__ == "__main__":
    main()
