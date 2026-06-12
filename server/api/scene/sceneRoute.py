"""
Scene video generation endpoints.

POST /api/scene/generate-video         — Start video generation for a scene (async)
POST /api/scene/generate-video/status  — Poll generation status
"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from models import StoryBoard
from api.scene.sceneService import generate_scene_videos, generate_scene_videos_apixo
from api.firestore.firestoreService import firestore_service

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/scene",
    tags=["Scene video generation"],
)

# In-memory task tracker: "{session_id}_{scene_id}" -> asyncio.Task
_scene_tasks: dict[str, asyncio.Task] = {}


# --- Request / Response models ---

class GenerateSceneRequest(BaseModel):
    session_id: str
    scene_id: str
    provider: str = "gemini"  # "gemini" | "apixo"


class SceneStatusRequest(BaseModel):
    session_id: str
    scene_id: str


class GenerateSceneResponse(BaseModel):
    status: str  # "processing", "complete", "error"
    message: str
    scene_id: str


# --- Endpoints ---

@router.post("/generate-video", response_model=GenerateSceneResponse)
async def generate_scene_video(request: GenerateSceneRequest):
    """
    Start Veo 3.1 video generation for a scene's 3 segments.
    Returns immediately; generation runs in the background.
    """
    task_key = f"{request.session_id}_{request.scene_id}"

    if request.provider not in ("gemini", "apixo"):
        raise HTTPException(
            status_code=422,
            detail=f"Invalid provider '{request.provider}'. Must be 'gemini' or 'apixo'.",
        )

    # Prevent duplicate generation
    existing_task = _scene_tasks.get(task_key)
    if existing_task and not existing_task.done():
        return GenerateSceneResponse(
            status="processing",
            message="Video generation already in progress for this scene",
            scene_id=request.scene_id,
        )

    # Look up session to get story_id
    session_data = await firestore_service.get_session(request.session_id)
    if not session_data:
        raise HTTPException(status_code=404, detail="Session not found")

    story_id = session_data.get("story_id")
    if not story_id:
        raise HTTPException(status_code=400, detail="Session has no storyboard yet")

    # Fetch storyboard
    storyboard_data = await firestore_service.get_storyboard(story_id)
    if not storyboard_data:
        raise HTTPException(status_code=404, detail="Storyboard not found")

    storyboard = StoryBoard(**storyboard_data)

    # Find the target scene
    scene = next(
        (s for s in storyboard.scenes if s.scene_id == request.scene_id), None
    )
    if not scene:
        raise HTTPException(
            status_code=404,
            detail=f"Scene '{request.scene_id}' not found in storyboard",
        )

    # Launch background task
    async def _run():
        try:
            if request.provider == "gemini":
                await generate_scene_videos(
                    session_id=request.session_id,
                    story_id=story_id,
                    scene=scene,
                    actors=storyboard.actors,
                    themes=storyboard.themes,
                )
            else:
                await generate_scene_videos_apixo(
                    session_id=request.session_id,
                    story_id=story_id,
                    scene=scene,
                    actors=storyboard.actors,
                    themes=storyboard.themes,
                )
            logger.info("Scene %s generation complete (%s)", request.scene_id, request.provider)
        except Exception:
            logger.exception("Scene %s generation failed (%s)", request.scene_id, request.provider)
            raise

    task = asyncio.create_task(_run())
    _scene_tasks[task_key] = task

    return GenerateSceneResponse(
        status="processing",
        message="Video generation started",
        scene_id=request.scene_id,
    )


@router.post("/generate-video/status", response_model=GenerateSceneResponse)
async def get_scene_generation_status(request: SceneStatusRequest):
    """Check the status of a scene video generation task."""
    task_key = f"{request.session_id}_{request.scene_id}"
    task = _scene_tasks.get(task_key)

    if task is None:
        # No in-memory task — check Firestore for already-completed videos
        session_data = await firestore_service.get_session(request.session_id)
        if not session_data or not session_data.get("story_id"):
            raise HTTPException(status_code=404, detail="Session or storyboard not found")

        storyboard_data = await firestore_service.get_storyboard(session_data["story_id"])
        if storyboard_data:
            for sc in storyboard_data.get("scenes", []):
                if sc.get("scene_id") == request.scene_id:
                    all_done = all(
                        seg.get("video_gcs_uri")
                        for seg in sc.get("segments", [])
                    )
                    if all_done:
                        return GenerateSceneResponse(
                            status="complete",
                            message="All segment videos generated",
                            scene_id=request.scene_id,
                        )

        return GenerateSceneResponse(
            status="error",
            message="No generation task found for this scene",
            scene_id=request.scene_id,
        )

    if not task.done():
        return GenerateSceneResponse(
            status="processing",
            message="Video generation in progress",
            scene_id=request.scene_id,
        )

    # Task is done — check for exceptions
    exc = task.exception() if not task.cancelled() else None
    if exc:
        return GenerateSceneResponse(
            status="error",
            message=f"Generation failed: {exc}",
            scene_id=request.scene_id,
        )

    return GenerateSceneResponse(
        status="complete",
        message="All segment videos generated",
        scene_id=request.scene_id,
    )
