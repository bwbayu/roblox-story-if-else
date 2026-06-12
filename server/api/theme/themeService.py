import asyncio
import os
from pathlib import Path
from typing import Optional

from google import genai
from dotenv import load_dotenv
from PIL import Image

from models import Theme
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


async def generate_and_save_theme_images(
    session_id: str,
    story_id: str,
    themes: list[Theme],
    template_image_path: Optional[Path] = None,
) -> list[Theme]:
    """
    Generate theme reference images using Gemini Flash Image,
    upload to GCS, and update Firestore with GCS URIs.
    """
    template_img = None
    if template_image_path and template_image_path.exists():
        template_img = Image.open(template_image_path)

    reference_instruction = ""
    if template_img:
        reference_instruction = (
            "IMPORTANT: Use the attached image as a visual reference for overall style, "
            "color grading, and cinematic texture. The new image should feel like it "
            "belongs in the same movie world."
        )

    async def process_theme(theme: Theme) -> None:
        prompt_text = f"""
            {reference_instruction}
            
            Cinematic environment concept art for: {theme.location_name}.
            Atmosphere: {theme.atmosphere}. 
            Lighting: {theme.lighting}.
            Visual Style: 4K resolution, Hyper-realistic, Highly detailed, wide shot, no people.
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
                gcs_uri = await gcs_service.upload_theme_image(
                    session_id=session_id,
                    theme_id=theme.theme_id,
                    image_bytes=image_bytes,
                    content_type=content_type,
                )

                # Update in-memory model
                public_url = gcs_service.get_public_url_from_gcs_uri(gcs_uri)
                theme.reference_image_gcs_uri = gcs_uri
                theme.reference_image_url = public_url

                # Persist GCS URI and public URL to Firestore
                await firestore_service.update_theme_image(
                    story_id=story_id,
                    theme_id=theme.theme_id,
                    gcs_uri=gcs_uri,
                    public_url=public_url,
                )
                break  # Only need the first image part

    await asyncio.gather(*[process_theme(theme) for theme in themes])

    return themes


async def generate_and_save_theme_images_apixo(
    session_id: str,
    story_id: str,
    themes: list[Theme],
    template_image_path: Optional[Path] = None,
) -> list[Theme]:
    """
    Generate theme reference images using Apixo Nano Banana 2,
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
            "IMPORTANT: Use the attached image as a visual reference for overall style, "
            "color grading, and cinematic texture. The new image should feel like it "
            "belongs in the same movie world."
        )

    async def process_theme(theme: Theme) -> None:
        prompt_text = f"""
            {reference_instruction}

            Cinematic environment concept art for: {theme.location_name}.
            Atmosphere: {theme.atmosphere}.
            Lighting: {theme.lighting}.
            Visual Style: 4K resolution, Hyper-realistic, Highly detailed, wide shot, no people.
        """

        image_urls = [template_url] if template_url else None
        image_bytes = await apixo_generate_image(prompt_text, image_urls)

        gcs_uri = await gcs_service.upload_theme_image(
            session_id=session_id,
            theme_id=theme.theme_id,
            image_bytes=image_bytes,
            content_type="image/jpeg",
        )

        public_url = gcs_service.get_public_url_from_gcs_uri(gcs_uri)
        theme.reference_image_gcs_uri = gcs_uri
        theme.reference_image_url = public_url

        await firestore_service.update_theme_image(
            story_id=story_id,
            theme_id=theme.theme_id,
            gcs_uri=gcs_uri,
            public_url=public_url,
        )

    await asyncio.gather(*[process_theme(theme) for theme in themes])

    return themes
