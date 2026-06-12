"""
SceneStudio API — FastAPI server for the multi-agent storyboard generation pipeline.

Endpoints:
  POST /api/session/start          — submit a raw script, begin clarification
  POST /api/session/{id}/answer    — answer the Director's questions, continue pipeline
  GET  /api/session/{id}           — retrieve current session state
"""

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
load_dotenv()

# Google ADK agents authenticate via GOOGLE_API_KEY. Mirror the single env key
# (GEMINI_API_KEY) into GOOGLE_API_KEY at startup so all agents pick it up.
if os.getenv("GEMINI_API_KEY") and not os.getenv("GOOGLE_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = os.environ["GEMINI_API_KEY"]

# When true, the API rejects all mutating (non-GET) requests and hides the docs.
# Used for public read-only gallery deployments. Defaults to false so local dev
# and full deployments are unaffected.
READ_ONLY = os.getenv("READ_ONLY", "false").lower() in ("true", "1", "yes")

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.story_board.storyBoardRoute import _pipeline_tasks, router as storyBoardRoute
from api.story_board.storyBoardConsumerRoute import router as storyBoardConsumerRoute
from api.actor.actorRoute import router as actorRoute
from api.scene.sceneRoute import _scene_tasks, router as sceneRoute
from api.theme.themeRoute import router as themeRoute
from api.pipeline.pipelineRoute import _pipeline_tasks as _full_pipeline_tasks, router as pipelineRoute

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # Cancel any running pipeline/scene tasks on shutdown
    for task in _pipeline_tasks.values():
        task.cancel()
    for task in _scene_tasks.values():
        task.cancel()
    for task in _full_pipeline_tasks.values():
        task.cancel()


app = FastAPI(
    title="SceneStudio API",
    description="AI-powered interactive storyboard generation using multi-agent orchestration",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None if READ_ONLY else "/docs",
    redoc_url=None if READ_ONLY else "/redoc",
    openapi_url=None if READ_ONLY else "/openapi.json",
)


# Reject all mutating requests when running in read-only mode. Declared before the
# CORS middleware so that CORS stays the outermost layer (Starlette runs the
# last-registered middleware first) and still attaches CORS headers to the 403.
# GET/HEAD are reads; OPTIONS must pass through for CORS preflight.
@app.middleware("http")
async def enforce_read_only(request: Request, call_next):
    if READ_ONLY and request.method not in ("GET", "HEAD", "OPTIONS"):
        return JSONResponse(
            status_code=403,
            content={"detail": "Server is running in read-only mode."},
        )
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# register route
app.include_router(storyBoardRoute, prefix="/api")
app.include_router(storyBoardConsumerRoute, prefix="/api")
app.include_router(actorRoute, prefix="/api")
app.include_router(sceneRoute, prefix="/api")
app.include_router(themeRoute, prefix="/api")
app.include_router(pipelineRoute, prefix="/api")

@app.get("/health")
async def health():
    return {"status": "ok"}
