"""
Full end-to-end generation pipeline service.

Orchestrates the complete flow:
  1. Director agent Q&A + multi-agent storyboard assembly (via storyBoardService)
  2. Actor and theme image generation in parallel (via actorService / themeService)
  3. Scene video generation for all scenes in parallel (via sceneService)
"""

import asyncio

from models import SessionState, SessionResponse
from api.story_board.storyBoardService import storyBoardService
from api.actor.actorService import generate_and_save_actor_images
from api.theme.themeService import generate_and_save_theme_images
from api.firestore.firestoreService import firestore_service
from api.exceptions import GeminiApiKeyError
from api.utils import _to_response


class PipelineService:
    """
    Orchestrates the full end-to-end generation pipeline.

    Uses storyBoardService for the agent pipeline phases, then continues
    with image generation (actors + themes in parallel) followed by
    scene video generation (all scenes in parallel).
    """

    def __init__(self):
        self._storyboard_service = storyBoardService()

    async def run_full_pipeline(
        self,
        session: SessionState,
        pipeline_tasks: dict[str, asyncio.Task],
    ) -> SessionResponse:
        """
        Run the director agent Q&A loop.

        - If the director asks questions, update session status and return them.
        - If the director is satisfied, kick off the full background pipeline
          (storyboard assembly → image generation → video generation) and
          return immediately with status='processing'.
        """
        # Phase 1: Director agent
        try:
            director_output = await self._storyboard_service._run_director_agent(
                session.script, session.qa_history
            )
        except GeminiApiKeyError as e:
            session.status = "error"
            session.error = f"api_key_error: {e}"
            await firestore_service.update_session_status(
                session.session_id, "error", error=session.error
            )
            return _to_response(session)
        except Exception as e:
            session.status = "error"
            session.error = f"Director agent failed: {e}"
            await firestore_service.update_session_status(
                session.session_id, "error", error=str(e)
            )
            return _to_response(session)

        # Director still has questions — return them to the caller
        if director_output.status == "questions" and director_output.questions:
            session.status = "clarifying"
            await firestore_service.update_session_status(session.session_id, "clarifying")
            return SessionResponse(
                session_id=session.session_id,
                status="questions",
                questions=director_output.questions,
            )

        # Director satisfied but no analysis — treat as error
        if director_output.analysis is None:
            session.status = "error"
            session.error = "Director returned 'ready' but provided no analysis."
            await firestore_service.update_session_status(
                session.session_id, "error", error=session.error
            )
            return _to_response(session)

        session.status = "processing_agents"
        analysis = director_output.analysis
        await firestore_service.update_session_status(session.session_id, "processing_agents")

        async def _full_background_pipeline():
            """
            Background coroutine that runs the complete asset generation pipeline:
              1. Multi-agent storyboard assembly
              2. Actor + theme image generation (parallel)
              3. Scene video generation (all scenes in parallel)
            """
            try:
                # ── Phase 1: Storyboard assembly ──────────────────────────────
                storyboard = await self._storyboard_service._run_multi_agent(session, analysis)
                session.storyboard = storyboard
                # _run_multi_agent leaves session.status as "processing_assets"
                # and storyboard.status as "generating" in Firestore.
                # Mark storyboard structure as ready, then advance to images phase.
                await firestore_service.update_storyboard_status(storyboard.story_id, "ready")

                # ── Phase 2: Image generation (actors + themes in parallel) ───
                session.status = "generating_images"
                await firestore_service.update_session_status(
                    session.session_id, "generating_images"
                )
                await firestore_service.update_storyboard_status(
                    storyboard.story_id, "generating_images"
                )

                await asyncio.gather(
                    generate_and_save_actor_images(
                        session_id=session.session_id,
                        story_id=storyboard.story_id,
                        actors=storyboard.actors,
                    ),
                    generate_and_save_theme_images(
                        session_id=session.session_id,
                        story_id=storyboard.story_id,
                        themes=storyboard.themes,
                    ),
                )
                # After gather, storyboard.actors[*].anchor_image_gcs_uri and
                # storyboard.themes[*].reference_image_gcs_uri are populated in-memory.

                # ── Done ──────────────────────────────────────────────────────
                session.status = "storyboard_complete"
                await firestore_service.update_session_status(
                    session.session_id, "storyboard_complete"
                )
                await firestore_service.update_storyboard_status(
                    storyboard.story_id, "storyboard_complete"
                )

            except GeminiApiKeyError as e:
                session.status = "error"
                session.error = f"api_key_error: {e}"
                await firestore_service.update_session_status(
                    session.session_id, "error", error=session.error
                )
            except Exception as e:
                session.status = "error"
                session.error = f"Full pipeline failed: {e}"
                await firestore_service.update_session_status(
                    session.session_id, "error", error=str(e)
                )

        task = asyncio.create_task(_full_background_pipeline())
        pipeline_tasks[session.session_id] = task

        return SessionResponse(
            session_id=session.session_id,
            status="processing",
        )
