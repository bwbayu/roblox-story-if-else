# SceneStudio

![Architecture Diagram](assets/thumbnail.jpg)

> AI-powered cinematic visual novel studio — build interactive stories with AI-generated scripts, character art, and cinematic video scenes.

Demo : https://www.youtube.com/watch?v=WtlUJYufBNU

Live App : https://scene-studio-499213.web.app/

**Gemini Hackathon — Creative Storyteller**

![Architecture Diagram](assets/architecture_diagram.png)

---

## Overview

SceneStudio is a creative platform that allows anyone to build cinematic visual novel experiences using AI-generated assets. Instead of manually creating scripts, artwork, and animations, creators describe their story and the system generates complete scenes combining narrative text, character portraits, location art, and video.

Inspired by game creation platforms like **Roblox Studio** and **visual novel engines**, SceneStudio dramatically lowers the barrier to producing narrative-driven interactive games. Creators define characters, themes, and story ideas — the AI handles the rest.

The platform uses **Gemini's multimodal capabilities** through a multi-agent pipeline: specialized AI agents collaboratively produce structured story scenes rather than isolated AI responses. Video scenes are built from three sequential 8-second Veo segments with video extension, giving each scene a cinematic ~24-second runtime.

| Dashboard | Scene Editor |
|-----------|--------------|
| ![Dashboard](assets/dashboard.png) | ![Scene Editor](assets/scene_dashboard.png) |

---

## Features

- **Multi-agent AI pipeline** — 7 specialized Google ADK agents (Director, Screenwriter, Casting, Production Designer, Segment Engineer, Scene Director, Scene Writer) collaborate to produce a complete storyboard
- **Interactive story refinement** — the Director Agent asks clarifying questions before production begins, so your vision is captured precisely
- **AI-generated characters & locations** — portrait images for all actors and concept art for all locations, generated with Gemini Image or Apixo
- **Cinematic video generation** — each scene is composed of 3 × 8-second Veo video segments with video extension, producing ~24 seconds of cinematic content per scene
- **Reference-based visual consistency** — actor and theme images are passed as ingredient references to Veo to maintain character/location consistency across scenes
- **Branching narrative** — scenes connect via choices, enabling interactive visual-novel-style gameplay
- **Dynamic scene addition** — add new scenes to an existing storyboard at any time via a dedicated sub-pipeline
- **Visual storyboard editor** — interactive canvas with pan/zoom, scene nodes, and a collapsible asset sidebar

---

## Tech Stack

### Frontend
| Technology | Version | Purpose |
|-----------|---------|---------|
| React | 19 | UI framework |
| TypeScript | 5.9 | Type safety |
| Vite | 7 | Build tool |
| TailwindCSS | 4 | Styling |
| TanStack React Query | 5 | Server state & polling |
| React Router DOM | 7 | Client-side routing |
| Axios | 1.13 | HTTP client |

### Backend
| Technology | Purpose |
|-----------|---------|
| Python 3.11 | Runtime |
| FastAPI | REST API framework |
| Uvicorn | ASGI server |
| Google ADK (`google-adk`) | Multi-agent orchestration |
| `google-genai` SDK | Gemini + Veo API calls |
| Pydantic | Data validation & models |
| PyAV (`av`) | Video frame extraction |
| FFmpeg | Video segment merging |
| Pillow | Image processing |
| `httpx` | Async HTTP client |

### AI Models (Google Gemini)
| Model | Role |
|-------|------|
| `gemini-3-flash-preview` | Text reasoning — all 7 ADK agents |
| `gemini-3.1-flash-image-preview` | Actor portraits + location images + thumbnails |
| `veo-3.1-fast-generate-preview` | Cinematic video generation |

### Google Cloud Infrastructure
| Service | Purpose |
|---------|---------|
| Firestore | NoSQL database — sessions + storyboards |
| Google Cloud Storage (GCS) | Actor/theme images, scene videos |
| Cloud Run | Backend container hosting |
| Firebase Hosting | Frontend CDN |
| Secret Manager | Service account credentials (production) |

---

## Project Structure

```
gemini-hackathon/
├── assets/                     # Screenshots and architecture diagrams
│
├── client/                     # React frontend (Vite + TypeScript)
│   └── src/
│       ├── api/                # Axios client, API service methods, TypeScript types
│       ├── components/         # Reusable UI components (modals, navbar, cards, overlays)
│       ├── hooks/              # Custom React Query hooks (pipeline, scene generation, storyboards)
│       └── pages/
│           ├── Dashboard.tsx   # Story listing and creation
│           └── SceneEditor.tsx # Interactive storyboard canvas + video generation
│
└── server/                     # Python FastAPI backend
    ├── agents/                 # 7 Google ADK LlmAgent implementations
    │   ├── director.py         # Phase 1: Script analysis + clarifying Q&A
    │   ├── screenwriter.py     # Phase 2: 5–7 scene structure with branching choices
    │   ├── casting.py          # Phase 2: Character visual profiles
    │   ├── production_designer.py  # Phase 2: Location/theme profiles
    │   ├── segment_engineer.py # Phase 3: 3 Veo segment prompts per scene
    │   ├── scene_director.py   # Add-scene sub-pipeline: Q&A for new scenes
    │   └── scene_writer.py     # Add-scene sub-pipeline: title + summary
    ├── api/
    │   ├── pipeline/           # End-to-end pipeline routes + orchestration service
    │   ├── story_board/        # Storyboard CRUD + add-scene sub-pipeline
    │   ├── scene/              # Video generation routes + Veo service
    │   ├── actor/              # Character management
    │   ├── theme/              # Location management
    │   ├── firestore/          # Firestore async service
    │   ├── gcs/                # Google Cloud Storage service
    │   └── apixo/              # Apixo fallback provider service
    ├── utils/
    │   └── merge_videos_ffmpeg.py  # FFmpeg video segment merging
    ├── models.py               # Pydantic data models (StoryBoard, Scene, Segment, Actor, Theme, …)
    ├── main.py                 # FastAPI app entry point
    ├── requirements.txt        # Python dependencies
    └── .env.example            # Environment variable template
```

---

## Multi-Agent Architecture

SceneStudio is built around a **multi-agent pipeline** rather than a single monolithic prompt. Each agent is a specialized [Google ADK](https://google.github.io/adk-docs/) `LlmAgent` with its own role, system instruction, structured Pydantic output schema, and tuned reasoning budget. The orchestrator ([`storyBoardService`](server/api/story_board/storyBoardService.py)) runs agents in parallel where their work is independent and sequentially where one depends on another's output, passing structured JSON between stages.

### The Crew — Main Story Pipeline

The pipeline models a real film production studio. Seven agents collaborate, each "hired" for one job:

| Agent | Role | Job | Reasoning |
|-------|------|-----|-----------|
| **Director** ([`director.py`](server/agents/director.py)) | Pre-production lead | Reads the raw story idea and decides if the brief is complete. If genre, characters, settings, conflict, or mood are ambiguous, it returns **2–4 multiple-choice clarifying questions** to the user. Once satisfied, it emits a structured `DirectorAnalysis` (title, genre, tone, setting, characters, mood, narrative summary) that briefs the rest of the crew. | `high` |
| **Screenwriter** ([`screenwriter.py`](server/agents/screenwriter.py)) | Story structure | Turns the Director's brief into a **branching structure of 5–7 scenes**. Every non-ending scene has exactly 2 choices that point to valid scene IDs; 2–3 scenes are endings. Produces the narrative graph (setup → branching tension → diverging resolutions). | `low` |
| **Casting Director** ([`casting.py`](server/agents/casting.py)) | Characters & costume | Creates a precise visual `Actor` profile for every named character — age, build, hair, eyes, distinguishing features, and outfit — written specifically to drive consistent image and video generation. | `low` |
| **Production Designer** ([`production_designer.py`](server/agents/production_designer.py)) | Locations | Creates a `Theme` profile for each distinct location — atmosphere, architecture, and detailed lighting (time of day, sources, color temperature, weather). | `low` |
| **Segment Engineer** ([`segment_engineer.py`](server/agents/segment_engineer.py)) | Cinematography | Breaks **each scene into exactly 3 sequential ~8-second video segments**, emitting a Veo-ready `visual_prompt`, camera movement, action, dialogue lines, and audio design (BGM + SFX) per segment. Segment 1 establishes, segment 2 peaks, segment 3 resolves into the player's choice. | `medium` |
| **Scene Director** ([`scene_director.py`](server/agents/scene_director.py)) | Add-scene Q&A | Sub-pipeline counterpart to the Director, used when a creator adds a new scene to an existing storyboard. Reviews the new scene against existing actors/themes/neighbors and asks 1–3 clarifying questions before producing a per-scene brief. | `medium` |
| **Scene Writer** ([`scene_writer.py`](server/agents/scene_writer.py)) | Add-scene writing | Writes the title, summary, and player choice labels for a single new scene so it fits seamlessly into the existing narrative graph. | `low` |

### How the Agents Communicate

Agents do **not** talk to each other directly or share conversational memory — the orchestrator passes **structured JSON** between them, which keeps each stage independently testable and validated:

```
User story idea
       │
       ▼
┌──────────────┐   questions ?
│  DIRECTOR    │ ───────────────► ask user → loop back with Q&A history
│ (high think) │
└──────┬───────┘ DirectorAnalysis (JSON brief)
       │
       ▼   ── runs in PARALLEL (asyncio.gather) ──
┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐
│ SCREENWRITER │  │   CASTING    │  │ PRODUCTION DESIGNER │
│   scenes[]   │  │   actors[]   │  │      themes[]       │
└──────┬───────┘  └──────┬───────┘  └──────────┬──────────┘
       └─────────────────┼─────────────────────┘
                         ▼   ── runs in PARALLEL ──
              ┌────────────────────┐   ┌─────────────────────┐
              │  SEGMENT ENGINEER  │   │ Thumbnail generation│
              │  3 segments/scene  │   │  (Gemini Flash Image)│
              └─────────┬──────────┘   └──────────┬──────────┘
                        └──────────────┬──────────┘
                                       ▼
                         Assemble StoryBoard → persist to Firestore
```

1. **Director loop (sequential, stateful via the user).** The Director runs first. If it returns `questions`, the API surfaces them to the UI and the session pauses in `clarifying` state; the user's answers are appended to a `qa_history` and the Director is re-invoked until it returns `ready` + an analysis.
2. **Specialist fan-out (parallel).** The analysis brief is sent simultaneously to the Screenwriter, Casting, and Production Designer via `asyncio.gather` — they have no dependency on each other.
3. **Engineering + thumbnail (parallel).** Their combined output (scenes + actors + themes) feeds the Segment Engineer, which runs in parallel with cinematic thumbnail generation.
4. **Assembly.** The orchestrator validates every agent's JSON against a Pydantic schema, assembles the final `StoryBoard`, and persists it to Firestore. Image and video generation then run as background phases.

### Add-Scene Sub-Pipeline

Adding a scene to an existing storyboard reuses the same pattern at smaller scale: **Scene Director** (clarifying Q&A) → **Scene Writer** (title/summary/choices) → **Segment Engineer** (3 segments) → image/video generation, wired into the existing narrative graph.

---

## Generative Models

SceneStudio uses three distinct Gemini-family models, each matched to a modality:

### 1. Text generation — `gemini-3-flash-preview`
Powers **all seven ADK agents**. Each agent is configured with `output_schema=<PydanticModel>` so the model returns strictly-typed JSON, and with a per-agent `ThinkingConfig` (`thinking_level` high → low) so reasoning budget is spent where it matters — the Director reasons hard about story completeness, while structured emitters like Casting run lean.

### 2. Image generation — `gemini-3.1-flash-image-preview`
Generates every still asset from the agents' text profiles:
- **Actor portraits** ([`actorService.py`](server/api/actor/actorService.py)) from each Casting profile
- **Location/theme art** ([`themeService.py`](server/api/theme/themeService.py)) from each Production Design profile
- **Story thumbnail** ([`storyBoardService.py`](server/api/story_board/storyBoardService.py)) — a 16:9 cinematic poster combining the lead actor and primary location

These images are not just display art — they become the **visual anchors** that keep characters and locations consistent in the video stage.

### 3. Video generation — `veo-3.1-fast-generate-preview`
Each scene is rendered as **three sequential 8-second segments** ([`sceneService.py`](server/api/scene/sceneService.py)), merged with FFmpeg into one ~24-second cinematic clip:

- **Segment 1 — text-to-video with reference images.** The Segment Engineer's prompt plus up to **3 reference images** (≤2 actor portraits + 1 theme image) are passed to Veo as `asset` reference images, anchoring character and location appearance.
- **Segments 2 & 3 — video extension.** Each subsequent segment is generated by **extending the previous segment's video**, so motion, lighting, and composition flow continuously across the full scene. (Veo's reference-image conditioning and video-extension modes are mutually exclusive, so segments 2–3 rely on the inherited frames of segment 1 for consistency.)
- Generation is asynchronous: the service submits a long-running Veo operation and **polls** until completion (up to 18 min), downloads the bytes, uploads to GCS, extracts the first frame as the scene thumbnail, and records URIs in Firestore.

An **Apixo** provider ([`apixoService.py`](server/api/apixo/apixoService.py)) mirrors the same image and video generation paths as a fallback when Veo quota is exhausted.

---

## Architecture Diagrams

### Main Generation Pipeline

![Pipeline Flowchart](assets/flowchart-pipeline.png)

### Add Scene Sub-Pipeline

![Add Scene Flowchart](assets/flowchart-add-scene.png)

---

## Inspiration

Our inspiration came from two worlds: **game creation platforms like Roblox Studio** and **narrative-driven visual novel engines**. Creating visual novels traditionally requires a large number of assets — artwork, scripts, animations — which can be extremely time-consuming and expensive.

We designed a system where anyone can become a storyteller without a full production team. Using Gemini's multimodal capabilities, the platform produces scenes where storytelling and visual elements are generated together, dramatically reducing the time and resources needed to produce visual storytelling content.

---

## How We Built It

SceneStudio is built on **Google Cloud and Gemini's multimodal capabilities**, combining several AI components into a structured creative pipeline:

1. **Multi-agent orchestration** — Different agents handle specific tasks (story generation, asset generation, scene assembly) producing structured outputs instead of isolated AI responses.

2. **Reference-based video generation** — Actor and location reference images are passed as ingredient inputs to Veo, maintaining visual consistency across scenes.

3. **Video extension** — Base video segments (~8 sec) are extended sequentially, producing longer cinematic sequences beyond the initial generation length.

4. **Gemini's interleaved multimodal output** — Text, visuals, and video are generated together as a cohesive storytelling experience.

---

## License

This project was built for the **Google Gemini Hackathon**.
