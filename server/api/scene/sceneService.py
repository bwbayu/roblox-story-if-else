"""
Scene video generation service using Veo 3.1.

Generates 3 sequential video segments per scene:
  - Segment 1: Text-to-video with actor/theme reference images
  - Segment 2: Extend from Segment 1 + reference images
  - Segment 3: Extend from Segment 2 + reference images

All videos are landscape (16:9), 720p resolution.
"""

import asyncio
import io
import logging
import os
import subprocess
import tempfile
import time

import av

from google import genai
from google.genai import types
from dotenv import load_dotenv

from models import Scene, Segment, Actor, Theme
from api.gcs.GCSService import gcs_service
from api.firestore.firestoreService import firestore_service
from api.apixo.apixoService import generate_video_reference, generate_video_text
from api.exceptions import raise_if_api_key_error

load_dotenv()

logger = logging.getLogger(__name__)

_client = None

def _get_client():
    global _client
    if _client is None:
        key = os.getenv("GEMINI_API_KEY")
        if not key:
            from api.exceptions import GeminiApiKeyError
            raise GeminiApiKeyError("No Gemini API key provided. Please set GEMINI_API_KEY in server/.env.")
        _client = genai.Client(api_key=key)
    return _client

VEO_MODEL = "veo-3.1-fast-generate-preview"
MAX_POLL_ITERATIONS = 180  # 18 minutes
POLL_INTERVAL_SECONDS = 10


def _build_segment_prompt(segment: Segment) -> str:
    """
    Combine all segment fields into a structured cinematic prompt for Veo.
    Incorporates visual description, camera work, action, dialogue, and audio design.
    """
    dialogue_lines = (
        "\n".join(segment.dialogue) if segment.dialogue else "No dialogue."
    )

    return (
        "Generate a cinematic video scene with the description below.\n\n"
        "SCENE / VISUAL\n"
        f"{segment.visual_prompt}\n\n"
        "CAMERA\n"
        f"Camera movement and framing: {segment.camera_movement}\n\n"
        "ACTION\n"
        f"{segment.action_description}\n\n"
        "DIALOGUE\n"
        "Characters speak naturally during the scene:\n"
        f"{dialogue_lines}\n\n"
        "AUDIO DESIGN\n"
        f"Background music: {segment.audio.bgm}\n"
        f"Sound effects: {segment.audio.sfx}\n\n"
        "OUTPUT\n"
        "Generate a continuous video scene that visually shows the action, "
        "includes the dialogue timing naturally, and matches the described audio atmosphere."
    )


async def _build_reference_images(
    segment: Segment,
    actors: list[Actor],
    themes: list[Theme],
) -> list[types.VideoGenerationReferenceImage]:
    """
    Download actor/theme images from GCS and wrap them as Veo reference images.
    Returns up to 3 references (max 2 actors + 1 theme).
    """
    references: list[types.VideoGenerationReferenceImage] = []

    # Actors (up to 2)
    for actor_id in segment.actor_ids[:2]:
        actor = next((a for a in actors if a.actor_id == actor_id), None)
        if actor and actor.anchor_image_gcs_uri:
            obj_path = gcs_service.object_path_from_uri(actor.anchor_image_gcs_uri)
            image_bytes = await gcs_service.download_blob_bytes(obj_path)
            image = types.Image(image_bytes=image_bytes, mime_type="image/jpeg")
            references.append(types.VideoGenerationReferenceImage(
                image=image,
                reference_type="asset",
            ))

    # Theme (max 1)
    if segment.theme_id:
        theme = next((t for t in themes if t.theme_id == segment.theme_id), None)
        if theme and theme.reference_image_gcs_uri:
            obj_path = gcs_service.object_path_from_uri(theme.reference_image_gcs_uri)
            image_bytes = await gcs_service.download_blob_bytes(obj_path)
            image = types.Image(image_bytes=image_bytes, mime_type="image/jpeg")
            references.append(types.VideoGenerationReferenceImage(
                image=image,
                reference_type="asset",
            ))

    return references


async def _poll_operation(operation, client):
    """Poll a Veo operation until done. Runs blocking poll in executor."""
    loop = asyncio.get_running_loop()

    def _sync_poll(op):
        polls = 0
        while not op.done:
            if polls >= MAX_POLL_ITERATIONS:
                raise TimeoutError(
                    f"Veo operation timed out after {MAX_POLL_ITERATIONS * POLL_INTERVAL_SECONDS}s"
                )
            time.sleep(POLL_INTERVAL_SECONDS)
            op = client.operations.get(op)
            polls += 1
        return op

    return await loop.run_in_executor(None, _sync_poll, operation)


async def _upload_segment_video(
    session_id: str, scene_id: str, segment_index: int, video_bytes: bytes
) -> str:
    """Upload generated video bytes to GCS and return the gs:// URI."""
    object_path = (
        gcs_service.segment_output_prefix(session_id, scene_id, segment_index)
        + "video.mp4"
    )
    await gcs_service._upload_bytes(object_path, video_bytes, "video/mp4")
    return gcs_service.to_gcs_uri(object_path)


def _extract_first_frame_jpeg(video_bytes: bytes) -> bytes:
    """
    Extract the first keyframe from in-memory MP4 bytes and return as JPEG bytes.
    Uses PyAV for decoding (no temp file, no system ffmpeg required).
    """
    buf = io.BytesIO(video_bytes)
    with av.open(buf, format="mp4") as container:
        video_stream = next((s for s in container.streams if s.type == "video"), None)
        if video_stream is None:
            raise RuntimeError("No video stream found in segment bytes")
        video_stream.codec_context.skip_frame = "NONKEY"
        for frame in container.decode(video_stream):
            pil_image = frame.to_image()
            output = io.BytesIO()
            pil_image.save(output, format="JPEG", quality=85)
            return output.getvalue()
    raise RuntimeError("No frames could be decoded from segment video bytes")


async def _save_scene_thumbnail(
    session_id: str,
    story_id: str,
    scene: Scene,
    video_bytes: bytes,
) -> None:
    """
    Extract the first keyframe from video_bytes, upload it as the scene thumbnail,
    and persist the GCS URI + public URL to Firestore. Errors are logged and swallowed.
    """
    try:
        loop = asyncio.get_running_loop()
        thumbnail_jpeg = await loop.run_in_executor(
            None, _extract_first_frame_jpeg, video_bytes
        )
        thumbnail_gcs_uri = await gcs_service.upload_scene_thumbnail(
            session_id=session_id,
            scene_id=scene.scene_id,
            image_bytes=thumbnail_jpeg,
        )
        thumbnail_url = gcs_service.get_public_url_from_gcs_uri(thumbnail_gcs_uri)
        scene.thumbnail_gcs_uri = thumbnail_gcs_uri
        scene.thumbnail_url = thumbnail_url
        await firestore_service.update_scene_thumbnail(
            story_id=story_id,
            scene_id=scene.scene_id,
            gcs_uri=thumbnail_gcs_uri,
            public_url=thumbnail_url,
        )
        logger.info("Scene %s thumbnail: %s", scene.scene_id, thumbnail_gcs_uri)
    except Exception:
        logger.exception(
            "Failed to generate thumbnail for scene %s; skipping", scene.scene_id
        )


def _merge_segment_videos(video_bytes_list: list[bytes]) -> bytes:
    """
    Merge a list of MP4 video byte segments into a single MP4 using FFmpeg concat demuxer.
    """
    temp_inputs: list[str] = []
    list_path: str | None = None
    out_path: str | None = None
    try:
        # Write each segment bytes to a named temp file
        for vb in video_bytes_list:
            fd, path = tempfile.mkstemp(suffix=".mp4")
            with os.fdopen(fd, "wb") as f:
                f.write(vb)
            temp_inputs.append(path)

        # Write the FFmpeg concat list file
        fd, list_path = tempfile.mkstemp(suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for p in temp_inputs:
                abs_path = os.path.abspath(p).replace("\\", "/")
                f.write(f"file '{abs_path}'\n")

        # Create empty output temp file
        fd, out_path = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)

        command = [
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", list_path,
            "-c", "copy",
            out_path,
        ]
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"FFmpeg merge failed (exit {result.returncode}):\n{result.stderr.decode()}"
            )

        with open(out_path, "rb") as f:
            return f.read()
    finally:
        for p in temp_inputs:
            try:
                os.remove(p)
            except Exception:
                pass
        for p in [list_path, out_path]:
            if p:
                try:
                    os.remove(p)
                except Exception:
                    pass


async def _save_scene_video(
    session_id: str,
    story_id: str,
    scene: Scene,
    video_bytes_list: list[bytes],
) -> None:
    """
    Merge all segment videos, upload as the scene video, and persist to Firestore.
    Errors are logged and swallowed so a merge failure never blocks the pipeline.
    """
    try:
        loop = asyncio.get_running_loop()
        merged_bytes = await loop.run_in_executor(
            None, _merge_segment_videos, video_bytes_list
        )
        gcs_uri = await gcs_service.upload_scene_video(session_id, scene.scene_id, merged_bytes)
        video_url = gcs_service.get_public_url_from_gcs_uri(gcs_uri)
        scene.video_gcs_uri = gcs_uri
        scene.video_url = video_url
        await firestore_service.update_scene_video(
            story_id=story_id,
            scene_id=scene.scene_id,
            gcs_uri=gcs_uri,
            public_url=video_url,
        )
        logger.info("Scene %s merged video: %s", scene.scene_id, gcs_uri)
    except Exception:
        logger.exception(
            "Failed to merge/upload scene video for scene %s; skipping", scene.scene_id
        )


async def generate_scene_videos(
    session_id: str,
    story_id: str,
    scene: Scene,
    actors: list[Actor],
    themes: list[Theme],
) -> None:
    """
    Generate videos for all 3 segments of a scene sequentially.

    Segment 1: text-to-video with reference images.
    Segments 2-3: extend from previous segment's video + reference images.
    Persists each video_gcs_uri to Firestore after generation.
    """
    # Create a single client for the entire scene generation to avoid
    # "client has been closed" errors from ephemeral client instances.
    client = _get_client()

    previous_video = None
    seg1_video_bytes: bytes | None = None

    for segment in sorted(scene.segments, key=lambda s: s.segment_index):
        logger.info(
            "Generating segment %d of scene %s...",
            segment.segment_index, scene.scene_id,
        )

        reference_images = await _build_reference_images(segment, actors, themes)
        logger.info(
            "Segment %d references: actor_ids=%s theme_id=%s total=%d",
            segment.segment_index, segment.actor_ids, segment.theme_id, len(reference_images),
        )

        if segment.segment_index == 1:
            # Text-to-video (first segment) — reference images only supported here
            config = types.GenerateVideosConfig(
                aspect_ratio="16:9",
                resolution="720p",
                duration_seconds=8,
                number_of_videos=1,
                reference_images=reference_images if reference_images else None,
            )
            try:
                operation = client.models.generate_videos(
                    model=VEO_MODEL,
                    source=types.GenerateVideosSource(
                        prompt=_build_segment_prompt(segment),
                    ),
                    config=config,
                )
            except Exception as exc:
                raise_if_api_key_error(exc)
                raise
        else:
            # Extend from previous segment's video
            # NOTE: reference_images cannot be combined with video extension
            if previous_video is None:
                raise RuntimeError(
                    f"Cannot extend segment {segment.segment_index}: "
                    f"previous segment has no generated video"
                )

            config = types.GenerateVideosConfig(
                aspect_ratio="16:9",
                resolution="720p",
                number_of_videos=1,
                duration_seconds=8,
            )
            try:
                operation = client.models.generate_videos(
                    model=VEO_MODEL,
                    source=types.GenerateVideosSource(
                        video=previous_video,
                        prompt=_build_segment_prompt(segment),
                    ),
                    config=config,
                )
            except Exception as exc:
                raise_if_api_key_error(exc)
                raise

        # Poll until done
        operation = await _poll_operation(operation, client)

        if not operation.response or not operation.response.generated_videos:
            rai_count = (
                getattr(operation.response, "rai_media_filtered_count", None)
                if operation.response else None
            )
            rai_reasons = (
                getattr(operation.response, "rai_media_filtered_reasons", None)
                if operation.response else None
            )
            logger.error(
                "Veo returned no video for segment %d — rai_filtered=%s reasons=%s",
                segment.segment_index, rai_count, rai_reasons,
            )
            reason = f" (RAI filtered: {rai_count}, reasons: {rai_reasons})" if rai_count else ""
            raise RuntimeError(
                f"Veo returned no video for segment {segment.segment_index}{reason}"
            )

        # Download video bytes from Veo server
        generated_video = operation.response.generated_videos[0]
        client.files.download(file=generated_video.video)
        video_bytes = generated_video.video.video_bytes

        # Capture segment 1 bytes in-memory for thumbnail extraction later
        if segment.segment_index == 1:
            seg1_video_bytes = video_bytes

        # Upload to our GCS bucket
        gcs_uri = await _upload_segment_video(
            session_id, scene.scene_id, segment.segment_index, video_bytes
        )

        # Persist to Firestore
        video_url = gcs_service.get_public_url_from_gcs_uri(gcs_uri)
        segment.video_gcs_uri = gcs_uri
        segment.video_url = video_url
        await firestore_service.update_segment_video(
            story_id=story_id,
            scene_id=scene.scene_id,
            segment_index=segment.segment_index,
            gcs_uri=gcs_uri,
            public_url=video_url,
        )

        # Keep video reference for next segment's extension
        previous_video = generated_video.video

        logger.info(
            "Segment %d of scene %s generated: %s",
            segment.segment_index, scene.scene_id, gcs_uri,
        )

    if seg1_video_bytes is not None:
        await _save_scene_thumbnail(session_id, story_id, scene, seg1_video_bytes)

    # Segment 3 is the full concatenated video (each segment extends the previous).
    # Store it as the scene-level video so callers have a single playback URI.
    last_segment = sorted(scene.segments, key=lambda s: s.segment_index)[-1]
    if last_segment.video_gcs_uri and last_segment.video_url:
        scene.video_gcs_uri = last_segment.video_gcs_uri
        scene.video_url = last_segment.video_url
        await firestore_service.update_scene_video(
            story_id=story_id,
            scene_id=scene.scene_id,
            gcs_uri=last_segment.video_gcs_uri,
            public_url=last_segment.video_url,
        )
        logger.info(
            "Scene %s video (segment 3 = full scene): %s",
            scene.scene_id, last_segment.video_gcs_uri,
        )


# ---------------------------------------------------------------------------
# Apixo-based video generation
# ---------------------------------------------------------------------------

def _build_reference_urls(
    segment: Segment,
    actors: list[Actor],
    themes: list[Theme],
) -> list[str]:
    """
    Build a list of public HTTPS URLs from the GCS URIs of actor/theme images
    referenced by this segment. Max 3 (2 actors + 1 theme).
    Objects are publicly readable via bucket-level IAM.
    """
    urls: list[str] = []

    for actor_id in segment.actor_ids[:2]:
        actor = next((a for a in actors if a.actor_id == actor_id), None)
        if actor and actor.anchor_image_gcs_uri:
            urls.append(gcs_service.get_public_url_from_gcs_uri(actor.anchor_image_gcs_uri))

    if segment.theme_id:
        theme = next((t for t in themes if t.theme_id == segment.theme_id), None)
        if theme and theme.reference_image_gcs_uri:
            urls.append(gcs_service.get_public_url_from_gcs_uri(theme.reference_image_gcs_uri))

    return urls


async def generate_scene_videos_apixo(
    session_id: str,
    story_id: str,
    scene: Scene,
    actors: list[Actor],
    themes: list[Theme],
) -> None:
    """
    Generate videos for all 3 segments of a scene sequentially using Apixo Veo 3.1.

    All segments: REFERENCE_2_VIDEO with actor/theme reference URLs (max 2 actors + 1 theme).
    Falls back to TEXT_2_VIDEO if no reference images are available.
    Persists each video_gcs_uri to Firestore after generation.
    """
    seg1_video_bytes: bytes | None = None
    all_segment_bytes: list[bytes] = []

    for segment in sorted(scene.segments, key=lambda s: s.segment_index):
        logger.info(
            "Apixo: generating segment %d of scene %s...",
            segment.segment_index, scene.scene_id,
        )

        prompt = _build_segment_prompt(segment)
        reference_urls = _build_reference_urls(segment, actors, themes)

        logger.info(
            "Apixo: segment %d references: actor_ids=%s theme_id=%s total=%d",
            segment.segment_index, segment.actor_ids, segment.theme_id, len(reference_urls),
        )

        if reference_urls:
            video_bytes = await generate_video_reference(prompt, reference_urls)
        else:
            video_bytes = await generate_video_text(prompt)

        if segment.segment_index == 1:
            seg1_video_bytes = video_bytes

        all_segment_bytes.append(video_bytes)

        gcs_uri = await _upload_segment_video(
            session_id, scene.scene_id, segment.segment_index, video_bytes
        )

        video_url = gcs_service.get_public_url_from_gcs_uri(gcs_uri)
        segment.video_gcs_uri = gcs_uri
        segment.video_url = video_url
        await firestore_service.update_segment_video(
            story_id=story_id,
            scene_id=scene.scene_id,
            segment_index=segment.segment_index,
            gcs_uri=gcs_uri,
            public_url=video_url,
        )

        logger.info(
            "Apixo: segment %d of scene %s generated: %s",
            segment.segment_index, scene.scene_id, gcs_uri,
        )

    if seg1_video_bytes is not None:
        await _save_scene_thumbnail(session_id, story_id, scene, seg1_video_bytes)

    if all_segment_bytes:
        await _save_scene_video(session_id, story_id, scene, all_segment_bytes)