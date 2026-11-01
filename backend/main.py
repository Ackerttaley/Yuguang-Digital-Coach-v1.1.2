from __future__ import annotations

import importlib
import json
import hashlib
import math
import mimetypes
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Iterator

import numpy as np

try:
    import torch
except ImportError:
    torch = None

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


PLATFORM_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = PLATFORM_DIR
DIST_DIR = Path(os.getenv("YUGUANG_FRONTEND_DIR", str(PLATFORM_DIR / "frontend" / "dist")))
VIDEO_DIR = Path(
    os.getenv("YUGUANG_VIDEO_DIR", str(PROJECT_DIR / "videos"))
).resolve()
DATA_DIR = Path(
    os.getenv("YUGUANG_DATA_DIR", str(PLATFORM_DIR / "data"))
).resolve()
RESULT_DIR = DATA_DIR / "analyses"
POSE_DIR = DATA_DIR / "poses"
DB_PATH = DATA_DIR / "yuguang.db"
MODEL_VERSION = "pose-foot-court-2.0"
RULE_VERSION = "movement-rules-1.1"
SCHEMA_VERSION = "3"
POSE_CACHE_VERSION = "3"
POSE_MODEL_OPTIONS = {"mediapipe", "rtmpose"}
SHUTTLE_MODEL_OPTIONS = {"opencv-motion-v2"}
MIN_ANALYSIS_SEGMENT_SECONDS = 5.0
MAX_ANALYSIS_SEGMENT_SECONDS = 30.0 * 60.0

DATA_DIR.mkdir(parents=True, exist_ok=True)
RESULT_DIR.mkdir(parents=True, exist_ok=True)
POSE_DIR.mkdir(parents=True, exist_ok=True)

DB_LOCK = threading.Lock()


RESOURCE_DIRS = (DIST_DIR, PLATFORM_DIR / "frontend" / "public")


def resource_exists(*relative: str) -> bool:
    return any((root.joinpath(*relative)).exists() for root in RESOURCE_DIRS)


def resource_dir(*relative: str) -> str | None:
    for root in RESOURCE_DIRS:
        candidate = root.joinpath(*relative)
        if candidate.exists():
            return str(candidate)
    return None


POSE_AVAILABLE = resource_exists("vision", "pose_landmarker_full.task")
POSE_ERROR = None
POSE_RESOURCE_DIR = resource_dir("vision", "pose_landmarker_full.task")
RTMPOSE_AVAILABLE = resource_exists("models", "yolo11n.onnx") and resource_exists("models", "rtmpose-m.onnx")
SHUTTLE_AVAILABLE = resource_exists("vision", "opencv.js")


def db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    return connection


def ensure_column(
    connection: sqlite3.Connection, table: str, column: str, definition: str
) -> None:
    columns = {
        row["name"] for row in connection.execute(f"PRAGMA table_info({table})")
    }
    if column not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


# 初始化数据库及必要的数据表。
def init_db() -> None:
    with db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS calibrations (
                video_id TEXT PRIMARY KEY,
                points_json TEXT NOT NULL,
                player_side TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                player_side TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL DEFAULT 0,
                message TEXT NOT NULL,
                analysis_id TEXT,
                error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS analyses (
                id TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                result_json TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS video_names (
                video_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            """
        )
        migrations = {
            "calibrations": {
                "calibration_id": "TEXT",
                "version": "INTEGER NOT NULL DEFAULT 1",
                "created_at": "REAL",
            },
            "jobs": {
                "source": "TEXT NOT NULL DEFAULT 'computed'",
                "start": "REAL NOT NULL DEFAULT 0",
                "duration": "REAL",
            },
            "analyses": {
                "model_version": "TEXT",
                "rule_version": "TEXT",
                "source": "TEXT NOT NULL DEFAULT 'computed'",
                "schema_version": "TEXT",
                "file_fingerprint": "TEXT",
                "player_side": "TEXT",
                "calibration_id": "TEXT",
                "segment_start": "REAL NOT NULL DEFAULT 0",
                "segment_duration": "REAL",
                "cache_valid": "INTEGER NOT NULL DEFAULT 1",
                "pose_model": "TEXT",
                "shuttle_model": "TEXT",
            },
        }
        for table, columns in migrations.items():
            for column, definition in columns.items():
                ensure_column(connection, table, column, definition)
        connection.executescript(
            """
            CREATE INDEX IF NOT EXISTS analyses_video_created_idx
            ON analyses(video_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS analyses_cache_lookup_idx
            ON analyses(
                video_id, file_fingerprint, player_side, calibration_id,
                segment_start, segment_duration, model_version, rule_version,
                schema_version, cache_valid
            );
            UPDATE jobs
            SET status='failed',
                progress=100,
                message='服务重启，原分析任务已中止',
                error='analysis_worker_restarted',
                updated_at=strftime('%s','now')
            WHERE status IN ('queued', 'running');
            """
        )


init_db()

app = FastAPI(title="羽光智教本地分析服务", version="1.1.2")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_origin_regex=r"^http://(?:localhost|127\.0\.0\.1):\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 接口请求的数据结构。
class CalibrationPayload(BaseModel):
    points: list[list[float]] = Field(min_length=4, max_length=4)
    player_side: str = "near"


class AnalysisPayload(BaseModel):
    video_id: str
    player_side: str = "near"
    calibration_id: str | None = None
    start: float = Field(default=0, ge=0)
    duration: float | None = Field(
        default=None,
        ge=MIN_ANALYSIS_SEGMENT_SECONDS,
        le=MAX_ANALYSIS_SEGMENT_SECONDS,
    )
    force_recompute: bool = False
    tracks: list[dict[str, Any]] = []
    sampled_frames: int = 0
    pose_model: str = "mediapipe"
    shuttle_model: str = "opencv-motion-v2"
    shuttle_tracks: list[dict[str, Any]] = []


class VideoRenamePayload(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)


def video_path(video_id: str) -> Path:
    matches = [path for path in VIDEO_DIR.glob("*.mp4") if path.stem == video_id]
    if not matches:
        raise HTTPException(status_code=404, detail="视频不存在")
    return matches[0]


def available_video_path(filename: str) -> Path:
    raw_name = Path(filename).name.strip()
    if Path(raw_name).suffix.lower() != ".mp4":
        raise HTTPException(status_code=400, detail="当前仅支持 MP4 视频")
    forbidden = '<>:"/\\|?*'
    stem = "".join(
        character
        for character in Path(raw_name).stem
        if character not in forbidden and ord(character) >= 32
    ).strip(" .")
    if not stem:
        stem = f"训练视频-{uuid.uuid4().hex[:8]}"
    stem = stem[:100].rstrip(" .")
    destination = VIDEO_DIR / f"{stem}.mp4"
    suffix = 2
    while destination.exists():
        destination = VIDEO_DIR / f"{stem} ({suffix}).mp4"
        suffix += 1
    return destination


def file_fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    size = path.stat().st_size
    digest.update(str(size).encode("ascii"))
    with path.open("rb") as source:
        digest.update(source.read(1024 * 1024))
        if size > 1024 * 1024:
            source.seek(max(0, size - 1024 * 1024))
            digest.update(source.read(1024 * 1024))
    return digest.hexdigest()


def video_display_name(video_id: str, fallback: str) -> str:
    with db() as connection:
        row = connection.execute(
            "SELECT display_name FROM video_names WHERE video_id = ?",
            (video_id,),
        ).fetchone()
    return row["display_name"] if row else fallback


# 读取视频的基础信息。
def probe_video(path: Path) -> dict[str, Any]:
    metadata_path = DATA_DIR / "video-metadata" / (hashlib.sha256(path.name.encode("utf-8")).hexdigest() + ".json")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}
    fps = 0.0
    width = int(metadata.get("width", 0))
    height = int(metadata.get("height", 0))
    duration = float(metadata.get("duration", 0))
    return {
        "id": path.stem,
        "name": path.name,
        "display_name": video_display_name(
            path.stem,
            f"单打训练案例 {path.stem[:4].upper()}",
        ),
        "duration": round(duration, 2),
        "fps": round(fps, 2),
        "width": width,
        "height": height,
        "size": path.stat().st_size,
        "file_fingerprint": file_fingerprint(path),
    }


def latest_analysis(video_id: str) -> str | None:
    with db() as connection:
        row = connection.execute(
            "SELECT id FROM analyses WHERE video_id = ? ORDER BY created_at DESC LIMIT 1",
            (video_id,),
        ).fetchone()
    return row["id"] if row else None


# 健康状态与运行资源检查。
@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "yuguang-digital-coach-static",
        "service_version": app.version,
        "gpu_available": bool(torch is not None and torch.cuda.is_available()),
        "gpu_name": torch.cuda.get_device_name(0) if torch is not None and torch.cuda.is_available() else None,
        "engine": "MediaPipe Tasks Vision · RTMPose-M (ONNX Runtime Web) · OpenCV.js",
        "pose_model_available": POSE_AVAILABLE,
        "pose_available": POSE_AVAILABLE or RTMPOSE_AVAILABLE,
        "pose_error": POSE_ERROR,
        "resource_dir": POSE_RESOURCE_DIR,
        "model_version": MODEL_VERSION,
        "rule_version": RULE_VERSION,
        "schema_version": SCHEMA_VERSION,
        "pose_models": [
            {
                "id": "mediapipe",
                "label": "MediaPipe BlazePose",
                "available": POSE_AVAILABLE,
                "resource": "vision/pose_landmarker_full.task",
                "version": "web",
            },
            {
                "id": "rtmpose",
                "label": "RTMPose-M",
                "available": RTMPOSE_AVAILABLE,
                "resource": "models/rtmpose-m.onnx",
                "version": "yolo11n + rtmpose-m_simcc-body7_256x192",
            },
        ],
        "shuttle_models": [
            {
                "id": "opencv-motion-v2",
                "label": "OpenCV Motion Tracker v2",
                "available": SHUTTLE_AVAILABLE,
                "resource": "vision/opencv.js",
                "version": "opencv-js-motion-kalman-2.0",
            },
            {
                "id": "tracknetv3",
                "label": "TrackNetV3",
                "available": False,
                "resource": None,
                "version": None,
            },
        ],
        "shuttle_tracking_enabled": SHUTTLE_AVAILABLE,
    }


# 视频列表、导入和元数据接口。
@app.get("/api/videos")
def list_videos() -> list[dict[str, Any]]:
    videos = []
    for path in sorted(VIDEO_DIR.glob("*.mp4")):
        item = probe_video(path)
        item["latest_analysis_id"] = latest_analysis(path.stem)
        videos.append(item)
    return videos


@app.post("/api/videos/{video_id}/metadata")
def save_video_metadata(video_id: str, metadata: dict[str, float]) -> dict[str, Any]:
    path = video_path(video_id)
    metadata_dir = DATA_DIR / "video-metadata"
    metadata_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = metadata_dir / (hashlib.sha256(path.name.encode("utf-8")).hexdigest() + ".json")
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    item = probe_video(path)
    item["latest_analysis_id"] = latest_analysis(video_id)
    return item


@app.post("/api/videos/import", status_code=201)
async def import_video(request: Request, filename: str, duration: float, width: int, height: int) -> dict[str, Any]:
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    destination = available_video_path(filename)
    temporary = DATA_DIR / f"upload-{uuid.uuid4().hex}.mp4"
    written = 0
    try:
        with temporary.open("xb") as target:
            async for chunk in request.stream():
                if not chunk:
                    continue
                target.write(chunk)
                written += len(chunk)
        if written == 0:
            raise HTTPException(status_code=400, detail="所选视频为空")

        if duration <= 0 or width <= 0 or height <= 0:
            raise HTTPException(status_code=400, detail="浏览器无法读取视频信息")
        temporary.replace(destination)
        metadata_dir = DATA_DIR / "video-metadata"
        metadata_dir.mkdir(parents=True, exist_ok=True)
        metadata_path = metadata_dir / (hashlib.sha256(destination.name.encode("utf-8")).hexdigest() + ".json")
        metadata_path.write_text(json.dumps({"duration": duration, "width": width, "height": height}), encoding="utf-8")
        item = probe_video(destination)
        item["latest_analysis_id"] = None
        return item
    finally:
        temporary.unlink(missing_ok=True)


@app.patch("/api/videos/{video_id}")
def rename_video(video_id: str, payload: VideoRenamePayload) -> dict[str, Any]:
    path = video_path(video_id)
    display_name = payload.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="视频名称不能为空")
    if any(ord(character) < 32 for character in display_name):
        raise HTTPException(status_code=400, detail="视频名称包含不可用字符")

    with DB_LOCK:
        with db() as connection:
            connection.execute(
                """
                INSERT INTO video_names(video_id, display_name, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(video_id) DO UPDATE SET
                    display_name=excluded.display_name,
                    updated_at=excluded.updated_at
                """,
                (video_id, display_name, time.time()),
            )

    item = probe_video(path)
    item["latest_analysis_id"] = latest_analysis(video_id)
    return item


# 按字节范围读取视频，支持浏览器拖动播放。
def ranged_file(path: Path, start: int, end: int) -> Iterator[bytes]:
    with path.open("rb") as file:
        file.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = file.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@app.get("/api/videos/{video_id}/stream")
def stream_video(video_id: str, request: Request):
    path = video_path(video_id)
    file_size = path.stat().st_size
    range_header = request.headers.get("range")
    if not range_header:
        return StreamingResponse(
            ranged_file(path, 0, file_size - 1),
            media_type="video/mp4",
            headers={"Accept-Ranges": "bytes", "Content-Length": str(file_size)},
        )

    try:
        byte_range = range_header.replace("bytes=", "").split("-")
        start = int(byte_range[0]) if byte_range[0] else 0
        end = int(byte_range[1]) if len(byte_range) > 1 and byte_range[1] else min(start + 8 * 1024 * 1024, file_size - 1)
        end = min(end, file_size - 1)
        if start < 0 or start >= file_size or end < start:
            raise ValueError
    except ValueError as exc:
        raise HTTPException(status_code=416, detail="无效的视频范围请求") from exc

    return StreamingResponse(
        ranged_file(path, start, end),
        status_code=206,
        media_type="video/mp4",
        headers={
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(end - start + 1),
        },
    )


def cross(a: list[float], b: list[float], c: list[float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_intersect(
    a: list[float], b: list[float], c: list[float], d: list[float]
) -> bool:
    return cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0


# 检查场地标定点和球员所在半场。
def validate_calibration(points: list[list[float]], player_side: str) -> None:
    if player_side not in {"near", "far"}:
        raise HTTPException(status_code=400, detail="球员侧必须是 near 或 far")
    for point in points:
        if len(point) != 2 or not all(math.isfinite(value) and -0.1 <= value <= 1.1 for value in point):
            raise HTTPException(status_code=400, detail="标定点最多可超出视频画面边缘 10%")
    near_left, near_right, far_right, far_left = points
    if near_left[0] >= near_right[0] or far_left[0] >= far_right[0]:
        raise HTTPException(status_code=400, detail="标定点左右顺序错误")
    if (near_left[1] + near_right[1]) / 2 <= (far_left[1] + far_right[1]) / 2:
        raise HTTPException(status_code=400, detail="标定点远近顺序错误")
    if segments_intersect(near_left, near_right, far_right, far_left) or segments_intersect(
        near_right, far_right, far_left, near_left
    ):
        raise HTTPException(status_code=400, detail="标定四边形存在自交")
    area = abs(
        sum(
            points[index][0] * points[(index + 1) % 4][1]
            - points[(index + 1) % 4][0] * points[index][1]
            for index in range(4)
        )
        / 2
    )
    if area < 0.025:
        raise HTTPException(status_code=400, detail="标定区域过小，请重新选择球场四角")


# 场地标定的读取与保存。
@app.get("/api/videos/{video_id}/calibration")
def get_calibration(video_id: str) -> dict[str, Any]:
    video_path(video_id)
    return calibration_for(video_id)


@app.post("/api/videos/{video_id}/calibration")
def save_calibration(video_id: str, payload: CalibrationPayload) -> dict[str, Any]:
    video_path(video_id)
    validate_calibration(payload.points, payload.player_side)
    now = time.time()
    with DB_LOCK, db() as connection:
        existing = connection.execute(
            "SELECT * FROM calibrations WHERE video_id = ?", (video_id,)
        ).fetchone()
        if (
            existing
            and json.loads(existing["points_json"]) == payload.points
            and existing["player_side"] == payload.player_side
            and existing["calibration_id"]
        ):
            return {
                "video_id": video_id,
                "calibration_id": existing["calibration_id"],
                "version": existing["version"],
                "points": payload.points,
                "player_side": payload.player_side,
                "source": "existing",
            }
        calibration_id = uuid.uuid4().hex
        version = int(existing["version"] or 0) + 1 if existing else 1
        connection.execute(
            """
            INSERT INTO calibrations(
                video_id, points_json, player_side, updated_at,
                calibration_id, version, created_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
              points_json=excluded.points_json,
              player_side=excluded.player_side,
              updated_at=excluded.updated_at,
              calibration_id=excluded.calibration_id,
              version=excluded.version,
              created_at=excluded.created_at
            """,
            (
                video_id,
                json.dumps(payload.points),
                payload.player_side,
                now,
                calibration_id,
                version,
                now,
            ),
        )
    return {
        "video_id": video_id,
        "calibration_id": calibration_id,
        "version": version,
        "points": payload.points,
        "player_side": payload.player_side,
        "source": "computed",
    }


# 分析任务状态及场地坐标转换。
def update_job(job_id: str, **values: Any) -> None:
    values["updated_at"] = time.time()
    columns = ", ".join(f"{key} = ?" for key in values)
    params = list(values.values()) + [job_id]
    with DB_LOCK, db() as connection:
        connection.execute(f"UPDATE jobs SET {columns} WHERE id = ?", params)


def calibration_for(video_id: str) -> dict[str, Any]:
    with db() as connection:
        row = connection.execute(
            "SELECT * FROM calibrations WHERE video_id = ?", (video_id,)
        ).fetchone()
    if row:
        calibration_id = row["calibration_id"] or f"legacy-{video_id}"
        return {
            "video_id": video_id,
            "calibration_id": calibration_id,
            "version": int(row["version"] or 1),
            "points": json.loads(row["points_json"]),
            "player_side": row["player_side"],
            "source": "existing",
        }
    return {
        "video_id": video_id,
        "calibration_id": None,
        "version": 0,
        "points": [[0.18, 0.88], [0.82, 0.88], [0.62, 0.22], [0.38, 0.22]],
        "player_side": "near",
        "source": "template",
    }


def transform_point(matrix: np.ndarray, x: float, y: float) -> tuple[float, float]:
    vector = np.array([x, y, 1.0], dtype=np.float32)
    projected = matrix @ vector
    if abs(float(projected[2])) < 1e-6:
        return 3.05, 6.7
    return float(projected[0] / projected[2]), float(projected[1] / projected[2])


def candidate_matches_player_side(
    matrix: np.ndarray,
    pixel: tuple[float, float],
    player_side: str,
) -> bool:
    """在校准后的场地坐标中判断运动候选点，而不是在图像坐标中判断。"""
    court_x, court_y = transform_point(matrix, pixel[0], pixel[1])
    if not (-0.8 <= court_x <= 6.9 and -1.5 <= court_y <= 14.9):
        return False
    return court_y >= 6.7 if player_side == "near" else court_y < 6.7


def compress_tracks(tracks: list[dict[str, float]], limit: int = 420) -> list[dict[str, float]]:
    if len(tracks) <= limit:
        return tracks
    stride = max(1, math.ceil(len(tracks) / limit))
    return tracks[::stride]


SHUTTLE_MAX_SPEED_MS = 45.0
SHUTTLE_FLIGHT_GAP_SECONDS = 2.0


def normalise_model(value: str, options: set[str], fallback: str) -> str:
    return value if value in options else fallback


# 清洗羽毛球轨迹并计算相关指标。
def clean_shuttle_tracks(raw: list[dict[str, float]] | None) -> list[dict[str, float]]:
    cleaned: list[dict[str, float]] = []
    for item in raw or []:
        try:
            t = float(item.get("t", 0))
            x = float(item.get("x", 0))
            y = float(item.get("y", 0))
            confidence = float(item.get("confidence", 0))
            speed = float(item.get("speed", 0) or 0)
        except (TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in (t, x, y, confidence, speed)):
            continue
        if not (0.0 <= x <= 6.1 and 0.0 <= y <= 13.4 and 0.0 <= confidence <= 1.0):
            continue
        cleaned.append(
            {
                "t": round(t, 2),
                "x": round(x, 2),
                "y": round(y, 2),
                "confidence": round(confidence, 2),
                "speed": round(max(0.0, min(SHUTTLE_MAX_SPEED_MS, speed)), 2),
                "source": str(item.get("source") or "fusion")[:24],
            }
        )
    cleaned.sort(key=lambda item: item["t"])
    return cleaned


def shuttle_metrics(
    tracks: list[dict[str, float]], effective_duration: float
) -> dict[str, Any]:
    expected = max(1, int(math.ceil(effective_duration / 0.5)))
    metrics: dict[str, Any] = {
        "enabled": bool(tracks),
        "tracked_frames": len(tracks),
        "valid_ratio": round(min(100.0, len(tracks) / expected * 100) if expected else 0.0, 1),
        "max_speed_ms": 0.0,
        "avg_speed_ms": 0.0,
        "flight_distance_m": 0.0,
        "span_x_m": 0.0,
        "span_y_m": 0.0,
        "estimated_rallies": 0,
    }
    if not tracks:
        return metrics
    speeds: list[float] = []
    distance = 0.0
    rallies = 1
    previous = tracks[0]
    for current in tracks[1:]:
        gap = current["t"] - previous["t"]
        if gap > SHUTTLE_FLIGHT_GAP_SECONDS:
            rallies += 1
        if 0 < gap <= 2.0:
            step = math.dist((previous["x"], previous["y"]), (current["x"], current["y"]))
            speed = step / gap
            if speed <= SHUTTLE_MAX_SPEED_MS:
                distance += step
                speeds.append(speed)
        previous = current
    metrics.update(
        {
            "max_speed_ms": round(max(speeds), 1) if speeds else 0.0,
            "avg_speed_ms": round(float(np.mean(speeds)), 1) if speeds else 0.0,
            "flight_distance_m": round(distance, 1),
            "span_x_m": round(max(item["x"] for item in tracks) - min(item["x"] for item in tracks), 2),
            "span_y_m": round(max(item["y"] for item in tracks) - min(item["y"] for item in tracks), 2),
            "estimated_rallies": rallies,
        }
    )
    return metrics


# 根据分析指标生成训练建议。
def build_advice(metrics: dict[str, float], tracks: list[dict[str, float]]) -> list[dict[str, Any]]:
    if not tracks:
        evidence = 0.0
    else:
        evidence = max(tracks, key=lambda item: abs(item["x"] - 3.05) + abs(item["y"] - 6.7))["t"]

    dominant_side = "左侧" if metrics["left_ratio"] > metrics["right_ratio"] else "右侧"
    weaker_side = "右侧" if dominant_side == "左侧" else "左侧"
    balance_delta = abs(metrics["left_ratio"] - metrics["right_ratio"])
    advice: list[dict[str, Any]] = []
    if metrics["return_efficiency"] < 55:
        advice.append({
            "title": "击球后更快回到可衔接位置",
            "observation": f"平均回中效率为 {metrics['return_efficiency']:.0f} 分，离开中心后的恢复仍有压缩空间。",
            "action": "完成击球后先做小幅并步回收，再以分腿垫步进入下一拍准备；进行6组30秒“击球—回中—启动”循环。",
            "evidence_time": round(evidence, 1),

            "metric": "return_efficiency",
            "operator": "<",
            "threshold": 55,
            "evidence": {"timestamp": round(evidence, 1), "value": metrics["return_efficiency"]},
            "recommendation": "击球—回中—启动循环",
            "rule_version": RULE_VERSION,
            "source": "rule",
            "knowledge_source": "BWF Coach Education Level 1 · Movement principles",
        })
    if balance_delta > 20:
        advice.append({
            "title": f"降低{dominant_side}移动依赖，补足{weaker_side}覆盖",
            "observation": f"左右场活动占比为 {metrics['left_ratio']:.0f}% / {metrics['right_ratio']:.0f}%，差值 {balance_delta:.0f} 个百分点。",
            "action": "用六码点多球练习补足低覆盖侧，要求每次触点后回到中线附近，再由同伴随机给出下一点。",
            "evidence_time": round(tracks[len(tracks) // 2]["t"], 1) if tracks else 0,

            "metric": "balance_delta",
            "operator": ">",
            "threshold": 20,
            "evidence": {
                "timestamp": round(tracks[len(tracks) // 2]["t"], 1) if tracks else 0,
                "left_ratio": metrics["left_ratio"],
                "right_ratio": metrics["right_ratio"],
            },
            "recommendation": "低覆盖侧六码点多球",
            "rule_version": RULE_VERSION,
            "source": "rule",
            "knowledge_source": "BWF Coach Education Level 1 · Court movement",
        })
    if metrics["coverage"] < 40:
        advice.append({
            "title": "扩大有效覆盖而非增加无效跑动",
            "observation": f"本段覆盖 {metrics['coverage']:.0f}% 的球场网格，估算移动距离 {metrics['distance']:.1f} 米。",
            "action": "训练时把注意力放在启动时机与到位后的身体稳定，使用前后场四点组合练习，每组8拍并记录是否能在击球前完成制动。",
            "evidence_time": round(tracks[-1]["t"] * 0.7, 1) if tracks else 0,

            "metric": "coverage",
            "operator": "<",
            "threshold": 40,
            "evidence": {
                "timestamp": round(tracks[-1]["t"] * 0.7, 1) if tracks else 0,
                "value": metrics["coverage"],
                "distance": metrics["distance"],
            },
            "recommendation": "前后场四点组合",
            "rule_version": RULE_VERSION,
            "source": "rule",
            "knowledge_source": "BWF Coach Education Level 1 · Technical and tactical elements",
        })
    if not advice:
        advice.append({
            "title": "保持当前移动平衡并提高稳定复现率",
            "observation": "本段回中、左右平衡和覆盖率均未触发纠偏阈值。",
            "action": "维持当前训练强度，用相同片段条件复测三次，确认指标能够稳定复现。",
            "evidence_time": round(evidence, 1),

            "metric": "all_movement_rules",
            "operator": "pass",
            "threshold": None,
            "evidence": {"timestamp": round(evidence, 1)},
            "recommendation": "同条件重复测试",
            "rule_version": RULE_VERSION,
            "source": "rule",
            "knowledge_source": "Yuguang movement baseline",
        })
    return advice


# 执行视频分析并保存结果。
def analyse_video(
    job_id: str,
    video_id: str,
    player_side: str,
    segment_start: float,
    segment_duration: float | None,
    fingerprint: str,
    calibration_id: str | None,
    browser_tracks: list[dict[str, float]],
    sampled_frames: int,
    pose_model: str = "mediapipe",
    shuttle_model: str = "opencv-motion-v2",
    browser_shuttle: list[dict[str, float]] | None = None,
) -> None:
    try:
        path = video_path(video_id)
        meta = probe_video(path)
        update_job(job_id, status="running", progress=84, message="正在计算移动指标与证据片段")
        calibration = calibration_for(video_id)
        if calibration_id and calibration["calibration_id"] != calibration_id:
            raise RuntimeError("标定版本已变化，请重新提交分析")
        points = calibration["points"]
        segment_start = min(max(0.0, segment_start), max(meta["duration"], 0))
        effective_duration = min(segment_duration, max(0.0, meta["duration"] - segment_start)) if segment_duration is not None else max(0.0, meta["duration"] - segment_start)
        if effective_duration <= 0:
            raise RuntimeError("分析片段为空，请重新设置起止时间")
        segment_end = segment_start + effective_duration
        expected_samples = max(1, int(math.ceil(effective_duration / 0.5)))
        tracks = browser_tracks
        sampled = sampled_frames
        if len(tracks) < 8:
            raise RuntimeError("有效运动轨迹不足，请重新标定球场或切换近/远场球员")

        shuttle_tracks = clean_shuttle_tracks(browser_shuttle)
        shuttle = shuttle_metrics(shuttle_tracks, effective_duration)
        shuttle["model"] = shuttle_model

        update_job(job_id, progress=84, message="正在计算移动指标与证据片段")
        distance = 0.0
        valid_steps = 0
        for first, second in zip(tracks, tracks[1:]):
            step = math.dist((first["x"], first["y"]), (second["x"], second["y"]))
            if step <= 3.2:
                distance += step
                valid_steps += 1

        left_count = sum(item["x"] < 3.05 for item in tracks)
        left_ratio = left_count / len(tracks) * 100
        center_distances = [math.dist((item["x"], item["y"]), (3.05, 6.7)) for item in tracks]
        return_efficiency = max(12.0, min(96.0, 100 - np.mean(center_distances) / 7.2 * 100))
        occupied = {(min(5, int(item["x"] / 6.1 * 6)), min(7, int(item["y"] / 13.4 * 8))) for item in tracks}
        coverage = min(100.0, len(occupied) / 48 * 100)
        duration_minutes = max(effective_duration / 60, 0.1)
        metrics = {
            "distance": round(distance, 1),
            "coverage": round(coverage, 1),
            "left_ratio": round(left_ratio, 1),
            "right_ratio": round(100 - left_ratio, 1),
            "return_efficiency": round(float(return_efficiency), 1),
            "movement_pace": round(distance / duration_minutes, 1),
            "valid_track_ratio": round(min(100, len(tracks) / max(expected_samples, 1) * 100), 1),
        }

        heatmap = [[0 for _ in range(6)] for _ in range(8)]
        for item in tracks:
            column = min(5, int(item["x"] / 6.1 * 6))
            row = min(7, int(item["y"] / 13.4 * 8))
            heatmap[row][column] += 1

        rallies = []
        segment = 30
        for index, start in enumerate(np.arange(segment_start, segment_end, segment)):
            end = min(segment_end, start + segment)
            rallies.append(
                {
                    "id": index + 1,
                    "start": round(float(start), 1),
                    "end": round(float(end), 1),
                    "label": f"训练片段 {index + 1:02d}",
                }
            )

        slim_tracks = compress_tracks(tracks)
        result = {
            "id": uuid.uuid4().hex,
            "analysis_id": None,
            "video_id": video_id,
            "video": meta,
            "player_side": player_side,
            "calibration": points,
            "calibration_id": calibration["calibration_id"],
            "calibration_version": calibration["version"],
            "tracks": slim_tracks,
            "heatmap": heatmap,
            "rallies": rallies,
            "metrics": metrics,
            "advice": build_advice(metrics, slim_tracks),
            "shuttle": shuttle,
            "shuttle_tracks": compress_tracks(shuttle_tracks),
            "quality": {
                "label": "视觉基线分析",
                "sampled_frames": sampled,
                "accepted_frames": len(tracks),
                "failure_reason": None,
                "note": (
                    "跑位轨迹由人体脚部关键点和球场标定计算；"
                    f"姿态关键点由浏览器 {pose_model} 生成；"
                    f"羽球轨迹由 {shuttle_model} 提供，共 {shuttle['tracked_frames']} 个有效点。"
                ),
            },
            "runtime": {
                "engine": MODEL_VERSION,
                "gpu_available": bool(torch is not None and torch.cuda.is_available()),
                "gpu_name": torch.cuda.get_device_name(0) if torch is not None and torch.cuda.is_available() else None,
                "sample_interval": 0.5,
                "pose_model": pose_model,
                "shuttle_model": shuttle_model,
            },
            "segment": {
                "start": round(segment_start, 3),
                "duration": round(effective_duration, 3),
                "end": round(segment_end, 3),
            },
            "source": "computed",
            "model_version": MODEL_VERSION,
            "rule_version": RULE_VERSION,
            "schema_version": SCHEMA_VERSION,
            "pose_model": pose_model,
            "shuttle_model": shuttle_model,
            "file_fingerprint": fingerprint,
            "created_at": time.time(),
        }

        analysis_id = result["id"]
        result["analysis_id"] = analysis_id
        result_path = RESULT_DIR / f"{analysis_id}.json"
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        with DB_LOCK, db() as connection:
            connection.execute(
                """
                INSERT INTO analyses(
                    id, video_id, result_json, created_at, model_version,
                    rule_version, source, schema_version, file_fingerprint,
                    player_side, calibration_id, segment_start,
                    segment_duration, cache_valid, pose_model, shuttle_model
                )
                VALUES(?, ?, ?, ?, ?, ?, 'computed', ?, ?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    analysis_id,
                    video_id,
                    json.dumps(result, ensure_ascii=False),
                    result["created_at"],
                    MODEL_VERSION,
                    RULE_VERSION,
                    SCHEMA_VERSION,
                    fingerprint,
                    player_side,
                    calibration["calibration_id"],
                    segment_start,
                    effective_duration,
                    pose_model,
                    shuttle_model,
                ),
            )
        update_job(
            job_id,
            status="completed",
            progress=100,
            message="分析完成",
            analysis_id=analysis_id,
            source="computed",
        )
    except Exception as exc:
        update_job(
            job_id,
            status="failed",
            progress=100,
            message="分析失败",
            error=str(exc),
        )


# 创建分析任务及查询分析结果。
@app.post("/api/analyses")
def create_analysis(payload: AnalysisPayload) -> dict[str, Any]:
    path = video_path(payload.video_id)
    if payload.player_side not in {"near", "far"}:
        raise HTTPException(status_code=400, detail="球员侧必须是 near 或 far")
    meta = probe_video(path)
    segment_start = min(payload.start, max(meta["duration"], 0))
    segment_duration = (
        min(payload.duration, max(0.0, meta["duration"] - segment_start))
        if payload.duration is not None and meta["duration"] > 0
        else max(0.0, meta["duration"] - segment_start)
    )
    if segment_duration < MIN_ANALYSIS_SEGMENT_SECONDS:
        raise HTTPException(status_code=400, detail="分析片段不能短于 5 秒")
    if segment_duration > MAX_ANALYSIS_SEGMENT_SECONDS:
        raise HTTPException(status_code=400, detail="分析片段不能超过 30 分钟")
    calibration = calibration_for(payload.video_id)
    if payload.calibration_id and payload.calibration_id != calibration["calibration_id"]:
        raise HTTPException(status_code=409, detail="标定版本已变化，请刷新后重试")
    fingerprint = meta["file_fingerprint"]
    pose_model = normalise_model(payload.pose_model, POSE_MODEL_OPTIONS, "mediapipe")
    shuttle_model = normalise_model(payload.shuttle_model, SHUTTLE_MODEL_OPTIONS, "opencv-motion-v2")
    job_id = uuid.uuid4().hex
    now = time.time()
    with DB_LOCK, db() as connection:
        video_path(payload.video_id)  # 与删除操作共用锁，避免已删除的视频启动新任务。
        cached = None
        if not payload.force_recompute:
            cached = connection.execute(
                """
                SELECT id FROM analyses
                WHERE video_id = ?
                  AND file_fingerprint = ?
                  AND player_side = ?
                  AND COALESCE(calibration_id, '') = COALESCE(?, '')
                  AND ABS(segment_start - ?) < 0.001
                  AND ABS(segment_duration - ?) < 0.001
                  AND model_version = ?
                  AND rule_version = ?
                  AND schema_version = ?
                  AND COALESCE(pose_model, '') = ?
                  AND COALESCE(shuttle_model, '') = ?
                  AND cache_valid = 1
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (
                    payload.video_id,
                    fingerprint,
                    payload.player_side,
                    calibration["calibration_id"],
                    segment_start,
                    segment_duration,
                    MODEL_VERSION,
                    RULE_VERSION,
                    SCHEMA_VERSION,
                    pose_model,
                    shuttle_model,
                ),
            ).fetchone()
        connection.execute(
            """
            INSERT INTO jobs(
                id, video_id, player_side, status, progress, message,
                analysis_id, created_at, updated_at, source, start, duration
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                payload.video_id,
                payload.player_side,
                "completed" if cached else "queued",
                100 if cached else 1,
                "使用缓存分析结果" if cached else "正在启动分析",
                cached["id"] if cached else None,
                now,
                now,
                "cache" if cached else "computed",
                segment_start,
                segment_duration,
            ),
        )
    if cached:
        return {
            "job_id": job_id,
            "analysis_id": cached["id"],
            "status": "completed",
            "source": "cache",
        }
    worker = threading.Thread(
        target=analyse_video,
        args=(
            job_id,
            payload.video_id,
            payload.player_side,
            segment_start,
            segment_duration,
            fingerprint,
            calibration["calibration_id"],
            payload.tracks,
            payload.sampled_frames,
            pose_model,
            shuttle_model,
            payload.shuttle_tracks,
        ),
        daemon=True,
        name=f"analysis-{job_id[:6]}",
    )
    worker.start()
    return {
        "job_id": job_id,
        "analysis_id": None,
        "status": "queued",
        "source": "computed",
    }


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with db() as connection:
        row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    return dict(row)


@app.get("/api/analyses/{analysis_id}")
def get_analysis(analysis_id: str) -> JSONResponse:
    with db() as connection:
        row = connection.execute(
            "SELECT * FROM analyses WHERE id = ?", (analysis_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="分析结果不存在")
    result = json.loads(row["result_json"])
    result["id"] = analysis_id
    result["analysis_id"] = analysis_id
    result["video_id"] = row["video_id"]
    result.setdefault("source", row["source"] or "computed")
    result.setdefault("model_version", row["model_version"] or "legacy")
    result.setdefault("rule_version", row["rule_version"] or "legacy")
    result.setdefault("schema_version", row["schema_version"] or "1")
    result.setdefault("pose_model", "mediapipe")
    result.setdefault("shuttle_model", "opencv-motion-v2")
    result.setdefault("shuttle_tracks", [])
    result.setdefault("shuttle", {"enabled": False, "tracked_frames": 0})
    return JSONResponse(result)


# 删除平台视频及关联记录；运行中的任务结束后才允许删除。
@app.delete("/api/videos/{video_id}")
def delete_video(video_id: str) -> dict[str, Any]:
    with DB_LOCK, db() as connection:
        path = video_path(video_id)
        if path.is_symlink() or path.resolve().parent != VIDEO_DIR.resolve():
            raise HTTPException(status_code=400, detail="视频不在平台视频目录内")
        active = connection.execute(
            "SELECT 1 FROM jobs WHERE video_id = ? AND status IN ('queued', 'running')",
            (video_id,),
        ).fetchone()
        if active:
            raise HTTPException(status_code=409, detail="该视频正在分析，请等待分析结束后删除")
        result_ids = [row["id"] for row in connection.execute(
            "SELECT id FROM analyses WHERE video_id = ?", (video_id,)
        )]
        try:
            path.unlink()
        except PermissionError:
            raise HTTPException(status_code=409, detail="视频正在被占用，请关闭播放后重试")
        for table in ("jobs", "analyses", "calibrations", "video_names"):
            connection.execute(f"DELETE FROM {table} WHERE video_id = ?", (video_id,))

    # 清除对应缓存，不触碰其他视频的数据。
    metadata = DATA_DIR / "video-metadata" / (hashlib.sha256(path.name.encode("utf-8")).hexdigest() + ".json")
    cache_files = [metadata]
    for result_id in result_ids:
        result_file = RESULT_DIR / f"{result_id}.json"
        if result_file.resolve().parent == RESULT_DIR.resolve():
            cache_files.append(result_file)
    for pose_file in POSE_DIR.glob("*.json"):
        try:
            if json.loads(pose_file.read_text(encoding="utf-8")).get("video_id") == video_id:
                cache_files.append(pose_file)
        except (OSError, json.JSONDecodeError):
            continue
    for cache_file in cache_files:
        try:
            cache_file.unlink(missing_ok=True)
        except OSError:
            # 缓存清理失败不应把已经成功删除的视频报告为失败。
            pass
    return {"video_id": video_id, "deleted": True}


# 清理指定视频的分析缓存。
@app.delete("/api/videos/{video_id}/cache")
def clear_video_cache(video_id: str) -> dict[str, Any]:
    video_path(video_id)
    pose_files_removed = 0
    for cache_path in POSE_DIR.glob("*.json"):
        try:
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
            if payload.get("video_id") == video_id:
                cache_path.unlink()
                pose_files_removed += 1
        except (OSError, json.JSONDecodeError):
            continue
    with DB_LOCK, db() as connection:
        cursor = connection.execute(
            "UPDATE analyses SET cache_valid = 0 WHERE video_id = ? AND cache_valid = 1",
            (video_id,),
        )
    return {
        "video_id": video_id,
        "pose_files_removed": pose_files_removed,
        "analysis_results_invalidated": cursor.rowcount,
        "historical_reports_preserved": True,
    }


# 客户端心跳：页面关闭后若长时间没有新的心跳且没有运行中的分析任务，服务自动退出。
# 设置 YUGUANG_IDLE_TIMEOUT_SECONDS=0 可关闭该行为。
CLIENT_IDLE_TIMEOUT = float(os.getenv("YUGUANG_IDLE_TIMEOUT_SECONDS", "180"))
last_client_seen: float | None = None
last_client_seen_lock = threading.Lock()


@app.get("/api/heartbeat")
def client_heartbeat() -> dict[str, Any]:
    global last_client_seen
    with last_client_seen_lock:
        last_client_seen = time.time()
    return {"ok": True}


def has_active_jobs() -> bool:
    with db() as connection:
        row = connection.execute(
            "SELECT 1 FROM jobs WHERE status IN ('queued', 'running') LIMIT 1"
        ).fetchone()
    return row is not None


# 监测客户端活动和后台任务。
def watch_client_activity() -> None:
    global last_client_seen
    while True:
        time.sleep(5)
        with last_client_seen_lock:
            seen = last_client_seen
        if seen is None or time.time() - seen < CLIENT_IDLE_TIMEOUT:
            continue
        try:
            if has_active_jobs():
                with last_client_seen_lock:
                    last_client_seen = time.time()
                continue
        except Exception:
            continue
        print("客户端已断开，羽光智教本地服务自动退出。", flush=True)
        os._exit(0)


if CLIENT_IDLE_TIMEOUT > 0:
    threading.Thread(target=watch_client_activity, daemon=True).start()


# ONNX Runtime Web 以 ES Module 加载 .mjs，必须返回 JS 类型，否则 Worker 动态导入会失败。
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")


@app.middleware("http")
async def runtime_module_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.endswith(".mjs"):
        response.headers["Content-Type"] = "text/javascript; charset=utf-8"
        response.headers["Cache-Control"] = "no-store"
    elif path.endswith(".wasm"):
        response.headers["Content-Type"] = "application/wasm"
    return response

# Register after API routes so /api requests continue to reach the backend.
app.mount("/", StaticFiles(directory=DIST_DIR, html=True, check_dir=False), name="web")
