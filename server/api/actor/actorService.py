import asyncio
import os
from pathlib import Path
from typing import Optional

from google import genai
from dotenv import load_dotenv
from PIL import Image

from models import Actor
from api.gcs.GCSService import gcs_service
from api.firestore.firestoreService import firestore_service
from api.apixo.apixoService import generate_image as apixo_generate_image
from api.exceptions import raise_if_api_key_error

load_dotenv()

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


async def generate_and_save_actor_images(
    session_id: str,
    story_id: str,
    actors: list[Actor],
    template_image_path: Optional[Path] = None,
) -> list[Actor]:
    """
    Generate actor reference images using Gemini Flash Image,
    upload to GCS, and update Firestore with GCS URIs.
    """
    template_img = None
    if template_image_path and template_image_path.exists():
        template_img = Image.open(template_image_path)

    reference_instruction = ""
    if template_img:
        reference_instruction = (
            "IMPORTANT: Use the attached image as a style and lighting reference. "
            "Maintain the same atmospheric mood and cinematic quality "
            "while generating the specific character described below."
        )

    async def process_actor(actor: Actor) -> None:
        prompt_text = f"""
            {reference_instruction}

            Cinematic character portrait of {actor.name}.
            Physical description: {actor.physical_description}.
            Outfit: {actor.outfit_description}.
            style: Cinematic, Gritty Realism, Detailed Textures, Split Screen Studio Reference Sheet.
            Add character name {actor.name} on bottom left image
        """

        contents = [prompt_text]
        if template_img:
            contents.append(template_img)

        try:
            response = await _get_client().aio.models.generate_content(
                model="gemini-3.1-flash-image-preview",
                contents=contents,
            )
        except Exception as exc:
            raise_if_api_key_error(exc)
            raise

        for part in response.parts:
            if part.inline_data is not None:
                image_bytes = part.inline_data.data
                content_type = part.inline_data.mime_type or "image/png"

                # Upload to GCS
                gcs_uri = await gcs_service.upload_actor_image(
                    session_id=session_id,
                    actor_id=actor.actor_id,
                    image_bytes=image_bytes,
                    content_type=content_type,
                )

                # Update in-memory model
                public_url = gcs_service.get_public_url_from_gcs_uri(gcs_uri)
                actor.anchor_image_gcs_uri = gcs_uri
                actor.anchor_image_url = public_url

                # Persist GCS URI and public URL to Firestore
                await firestore_service.update_actor_image(
                    story_id=story_id,
                    actor_id=actor.actor_id,
                    gcs_uri=gcs_uri,
                    public_url=public_url,
                )
                break  # Only need the first image part

    await asyncio.gather(*[process_actor(actor) for actor in actors])

    return actors


async def generate_and_save_actor_images_apixo(
    session_id: str,
    story_id: str,
    actors: list[Actor],
    template_image_path: Optional[Path] = None,
) -> list[Actor]:
    """
    Generate actor reference images using Apixo Nano Banana 2,
    upload to GCS, and update Firestore with GCS URIs.
    """
    template_url: Optional[str] = None
    reference_instruction = ""

    if template_image_path and template_image_path.exists():
        content_type = "image/png" if template_image_path.suffix.lower() == ".png" else "image/jpeg"
        template_bytes = template_image_path.read_bytes()
        template_url = await gcs_service.upload_template_image(
            session_id=session_id,
            filename=template_image_path.name,
            image_bytes=template_bytes,
            content_type=content_type,
        )
        reference_instruction = (
            "IMPORTANT: Use the attached image as a style and lighting reference. "
            "Maintain the same atmospheric mood and cinematic quality "
            "while generating the specific character described below."
        )

    async def process_actor(actor: Actor) -> None:
        prompt_text = f"""
            {reference_instruction}

            Cinematic character portrait of {actor.name}.
            Physical description: {actor.physical_description}.
            Outfit: {actor.outfit_description}.
            style: Cinematic, Gritty Realism, Detailed Textures, Split Screen Studio Reference Sheet.
            Add character name {actor.name} on bottom left image
        """

        image_urls = [template_url] if template_url else None
        image_bytes = await apixo_generate_image(prompt_text, image_urls)

        gcs_uri = await gcs_service.upload_actor_image(
            session_id=session_id,
            actor_id=actor.actor_id,
            image_bytes=image_bytes,
            content_type="image/jpeg",
        )

        public_url = gcs_service.get_public_url_from_gcs_uri(gcs_uri)
        actor.anchor_image_gcs_uri = gcs_uri
        actor.anchor_image_url = public_url

        await firestore_service.update_actor_image(
            story_id=story_id,
            actor_id=actor.actor_id,
            gcs_uri=gcs_uri,
            public_url=public_url,
        )

    await asyncio.gather(*[process_actor(actor) for actor in actors])

    return actors
