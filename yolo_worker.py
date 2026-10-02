import json
import os
import sys
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO, YOLOWorld

PROJECT_DIR = Path(__file__).resolve().parent
MODEL_DIRECTORY = PROJECT_DIR / ".yolo-models"
MODEL_DIRECTORY.mkdir(exist_ok=True)
MODEL_PATH = MODEL_DIRECTORY / "yolov8s-world.pt"
POTHOLE_MODEL_PATH = MODEL_DIRECTORY / "yolov8n-pothole-seg.pt"
POTHOLE_MODEL_URL = (
    "https://huggingface.co/keremberke/yolov8n-pothole-segmentation/"
    "resolve/main/best.pt"
)

if not POTHOLE_MODEL_PATH.is_file():
    urllib.request.urlretrieve(POTHOLE_MODEL_URL, POTHOLE_MODEL_PATH)

os.chdir(MODEL_DIRECTORY)

CLASS_PROMPTS = [
    "person",
    "car",
    "motorcycle",
    "bus",
    "truck",
    "bicycle",
    "pothole",
    "cracked pavement",
    "broken pavement",
    "fallen tree",
    "fallen tree branch",
    "road debris",
    "construction debris",
    "garbage pile",
    "obstacle blocking sidewalk",
    "blocked sidewalk",
    "construction barrier",
    "traffic cone",
    "open manhole",
    "flooded road",
    "exposed wire",
    "damaged guardrail",
    "sinkhole",
    "fallen sign",
    "fire",
    "smoke",
]
VEHICLE_LABELS = {"car", "motorcycle", "bus", "truck", "bicycle"}
HAZARD_LABELS = set(CLASS_PROMPTS) - VEHICLE_LABELS - {"person"}

try:
    confidence_threshold = float(os.environ.get("YOLO_CONFIDENCE", "0.2"))
    if not 0 <= confidence_threshold <= 1:
        raise ValueError("YOLO_CONFIDENCE must be between 0 and 1.")

    with redirect_stdout(sys.stderr):
        model = YOLOWorld(str(MODEL_PATH))
        model.set_classes(CLASS_PROMPTS)
        pothole_model = YOLO(str(POTHOLE_MODEL_PATH))
except Exception as error:
    print(f"YOLO model startup failed: {error}", file=sys.stderr, flush=True)
    print(
        json.dumps({
            "type": "startup_error",
            "error": "The YOLO model could not be started. Check the Python environment and model download."
        }),
        flush=True
    )
    sys.exit(1)

for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        image_path = Path(request["imagePath"])
        if not image_path.is_file():
            raise ValueError("Image file is unavailable.")

        image = cv2.imdecode(
            np.fromfile(str(image_path), dtype=np.uint8),
            cv2.IMREAD_COLOR
        )
        if image is None:
            raise ValueError("Image format could not be decoded.")

        with redirect_stdout(sys.stderr):
            results = model.predict(
                source=image,
                conf=confidence_threshold,
                verbose=False
            )
            pothole_results = pothole_model.predict(
                source=image,
                conf=max(confidence_threshold, 0.3),
                verbose=False
            )

        detections = []
        for result in results:
            for box in result.boxes:
                class_id = int(box.cls.item())
                label = result.names[class_id]
                detections.append({
                    "label": label,
                    "confidence": round(float(box.conf.item()), 3)
                })

        for result in pothole_results:
            for box in result.boxes:
                detections.append({
                    "label": "pothole",
                    "confidence": round(float(box.conf.item()), 3)
                })

        detections.sort(key=lambda item: (
            item["label"] in VEHICLE_LABELS,
            -item["confidence"]
        ))
        response = {
            "id": request["id"],
            "result": {
                "detections": detections[:20],
                "personDetected": any(
                    item["label"] == "person" for item in detections
                ),
                "vehicleDetected": any(
                    item["label"] in VEHICLE_LABELS for item in detections
                ),
                "hazardDetected": any(
                    item["label"] in HAZARD_LABELS for item in detections
                ),
            }
        }
    except Exception as error:
        print(f"YOLO image analysis failed: {error}", file=sys.stderr, flush=True)
        response = {
            "id": request.get("id") if isinstance(request, dict) else None,
            "error": "This image could not be analyzed. Try another image."
        }

    print(json.dumps(response, separators=(",", ":")), flush=True)
