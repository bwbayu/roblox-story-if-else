import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronDownIcon,
  XIcon,
  ListIcon,
  PlusIcon,
} from '../components/Icons';
import ProviderSelectionModal from '../components/ProviderSelectionModal';
import ImagePreviewModal from '../components/ImagePreviewModal';
import AddSceneModal from '../components/AddSceneModal';
import QuestionnaireModal from '../components/QuestionnaireModal';
import { useStoryboard } from '../hooks/useStoryboards';
import { useGenerateSceneVideo, useSceneGenerationStatus } from '../hooks/useSceneGeneration';
import { useStartAddScene, useAnswerAddSceneQuestions, useAddSceneStatus } from '../hooks/useAddScene';
import { fetchSceneGenerationStatus } from '../api/services';
import type { Scene as ApiScene, ClarificationQuestion, AddSceneRequest } from '../api';

// Helper: build a tree structure from flat scene list using choices
function buildSceneTree(scenes: ApiScene[]) {
  if (scenes.length === 0) return { levels: [], connections: [] };

  // Find root scene (not targeted by any choice)
  const targetIds = new Set(scenes.flatMap(s => s.choices.map(c => c.target_scene_id)));
  const root = scenes.find(s => !targetIds.has(s.scene_id)) || scenes[0];

  // BFS to group scenes by level
  const levels: ApiScene[][] = [];
  const connections: { fromId: string; toId: string }[] = [];
  const visited = new Set<string>();
  let currentLevel = [root];

  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    currentLevel.forEach(s => visited.add(s.scene_id));

    const nextLevel: ApiScene[] = [];
    for (const scene of currentLevel) {
      for (const choice of scene.choices) {
        const target = scenes.find(s => s.scene_id === choice.target_scene_id);
        if (target) {
          connections.push({ fromId: scene.scene_id, toId: target.scene_id });
          if (!visited.has(target.scene_id)) {
            nextLevel.push(target);
            visited.add(target.scene_id);
          }
        }
      }
    }
    currentLevel = nextLevel;
  }

  return { levels, connections };
}

function Connection({ fromId, toId, isActive, containerRef }: { fromId: string, toId: string, isActive: boolean, containerRef: React.RefObject<HTMLDivElement | null> }) {
  const [coords, setCoords] = useState<{ x1: number, y1: number, x2: number, y2: number } | null>(null);

  useEffect(() => {
    const updatePath = () => {
      const fromEl = document.querySelector(`[data-scene-id="${fromId}"]`);
      const toEl = document.querySelector(`[data-scene-id="${toId}"]`);
      const container = containerRef.current;

      if (fromEl && toEl && container) {
        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        setCoords({
          x1: fromRect.right - containerRect.left + container.scrollLeft,
          y1: fromRect.top + fromRect.height / 2 - containerRect.top + container.scrollTop,
          x2: toRect.left - containerRect.left + container.scrollLeft,
          y2: toRect.top + toRect.height / 2 - containerRect.top + container.scrollTop
        });
      }
    };

    updatePath();
    window.addEventListener('resize', updatePath);

    const container = containerRef.current;
    if (container) {
      container.addEventListener('scroll', updatePath);
    }

    const observer = new MutationObserver(updatePath);
    if (container) {
      observer.observe(container, { childList: true, subtree: true });
    }

    return () => {
      window.removeEventListener('resize', updatePath);
      if (container) {
        container.removeEventListener('scroll', updatePath);
        observer.disconnect();
      }
    };
  }, [fromId, toId, containerRef]);

  if (!coords) return null;

  const dx = coords.x2 - coords.x1;
  const path = `M ${coords.x1} ${coords.y1} C ${coords.x1 + dx * 0.4} ${coords.y1}, ${coords.x2 - dx * 0.4} ${coords.y2}, ${coords.x2} ${coords.y2}`;

  return (
    <g>
      {isActive && (
        <path d={path} stroke="#ef4444" strokeWidth="6" fill="none" className="opacity-20 blur-md transition-all duration-500" />
      )}
      <path d={path} stroke={isActive ? '#ef4444' : 'var(--color-border-default)'} strokeWidth="2" fill="none" strokeLinecap="round" className="transition-all duration-500" />
      <circle cx={coords.x2} cy={coords.y2} r="3" fill={isActive ? '#ef4444' : 'var(--color-border-default)'} className="transition-all duration-500" />
    </g>
  );
}

function SceneNode({ scene, isActive, isGenerating, hasVideo, showGenerateFeatures, onClick, onSelect, onGenerate }: {
  scene: ApiScene, isActive: boolean, isGenerating: boolean, hasVideo: boolean, showGenerateFeatures: boolean,
  onClick: () => void, onSelect: () => void, onGenerate: () => void
}) {
  return (
    <div
      data-scene-id={scene.scene_id}
      onClick={() => { if (!isGenerating) onSelect(); }}
      className={`group relative flex flex-col items-center animate-[card-enter] ${isGenerating ? 'cursor-default' : 'cursor-pointer'}`}
    >
<div className={`absolute -inset-4 rounded-2xl blur-xl transition-all duration-500 ${isActive ? 'bg-(--color-accent-primary)/20' : 'bg-transparent'}`} />
      <div
        onClick={(e) => { e.stopPropagation(); if (!isGenerating) onSelect(); }}
        className={`relative w-48 overflow-hidden rounded-xl border p-4 transition-all duration-300 ${isActive
          ? 'border-(--color-accent-primary) bg-bg-card'
          : 'border-border-default bg-bg-secondary hover:border-border-hover'
          }`}
      >
        {/* Thumbnail area */}
        <div className="group/thumb relative mb-3 aspect-4/3 w-full overflow-hidden rounded-lg bg-white">
          <div
            onClick={(e) => { e.stopPropagation(); if (!isGenerating && hasVideo) onClick(); }}
            className={`flex h-full w-full items-center justify-center p-4 text-center transition-transform ${!isGenerating ? 'hover:scale-[1.03] active:scale-[0.98] cursor-pointer' : 'cursor-default'}`}
          >
            {scene.thumbnail_url ? (
              <img
                src={scene.thumbnail_url}
                alt={scene.title}
                className="h-full w-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                  (e.currentTarget.nextElementSibling as HTMLElement)?.classList.remove('hidden');
                }}
              />
            ) : null}
            <span className={`text-sm font-black whitespace-pre-line text-black ${scene.thumbnail_url ? 'hidden' : ''}`} style={{ fontFamily: "'Sora', sans-serif" }}>
              {scene.title}
            </span>
          </div>

          {/* Play indicator when video exists */}
          {hasVideo && !isGenerating && (
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity bg-black/30 rounded-lg pointer-events-none">
              <svg className="h-8 w-8 text-white drop-shadow-lg" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          )}

          {/* Generate button — show when no video and not generating (dev only) */}
          {showGenerateFeatures && !isGenerating && !hasVideo && (
            <button
              onClick={(e) => { e.stopPropagation(); onGenerate(); }}
              className="absolute right-2 top-2 z-10 rounded-lg bg-black/70 px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-white opacity-0 transition-all group-hover/thumb:opacity-100 hover:bg-(--color-accent-primary) hover:text-black backdrop-blur-sm"
            >
              Generate
            </button>
          )}

        </div>

        <p className={`text-center text-xs font-black uppercase tracking-widest ${isActive ? 'text-(--color-accent-secondary)' : 'text-text-primary'}`}>
          {scene.title}
        </p>

        {/* Full-card generating overlay */}
        {isGenerating && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-xl bg-black/75 backdrop-blur-sm">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-(--color-accent-primary) border-t-transparent" />
            <span className="text-[9px] font-bold uppercase tracking-widest text-(--color-accent-primary) animate-pulse">Generating...</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SceneEditor() {
  const showGenerateFeatures = import.meta.env.DEV;
  const { storyId = null } = useParams<{ storyId: string }>();
  const navigate = useNavigate();
  const { data: storyboard, isLoading: isLoadingStoryboard } = useStoryboard(storyId);
  const sessionId = storyboard?.session_id ?? null;
  const storyTitle = storyboard?.title ?? 'Untitled';
  const generateSceneVideo = useGenerateSceneVideo();

  const scenes = useMemo(() => storyboard?.scenes ?? [], [storyboard]);
  const actors = useMemo(() => storyboard?.actors ?? [], [storyboard]);
  const themes = useMemo(() => storyboard?.themes ?? [], [storyboard]);

  // Debug: log all image/video URLs
  useEffect(() => {
    if (!storyboard) return;
    console.log('[SceneEditor] Actors:', actors.map(a => ({ name: a.name, anchor_image_url: a.anchor_image_url })));
    console.log('[SceneEditor] Themes:', themes.map(t => ({ location_name: t.location_name, reference_image_url: t.reference_image_url })));
    console.log('[SceneEditor] Scenes:', scenes.map(s => ({ title: s.title, thumbnail_url: s.thumbnail_url, video_url: s.video_url })));
  }, [storyboard, actors, themes, scenes]);

  const firstSceneId = scenes[0]?.scene_id ?? '';

  const [activeSceneIdRaw, setActiveSceneId] = useState<string>('');
  const [selectedPathIdsRaw, setSelectedPathIds] = useState<string[]>([]);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [showChoices, setShowChoices] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    actor: true,
    theme: true,
    script: true
  });

  // Derive effective values: use firstSceneId as default until user navigates
  const activeSceneId = activeSceneIdRaw || firstSceneId;
  const selectedPathIds = selectedPathIdsRaw.length > 0 ? selectedPathIdsRaw : (firstSceneId ? [firstSceneId] : []);
  const { levels, connections } = useMemo(() => buildSceneTree(scenes), [scenes]);

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const handleHorizontalWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      container.scrollLeft += e.deltaY;
    }
  };

  // Panning States
  const canvasRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [startY, setStartY] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  // Image Preview Modal State
  const [previewImage, setPreviewImage] = useState<{ url: string; alt: string } | null>(null);

  // Provider Selection Modal States
  const [isProviderModalOpen, setIsProviderModalOpen] = useState(false);
  const [pendingGenerateSceneId, setPendingGenerateSceneId] = useState<string | null>(null);

  // Add Scene States
  const [isAddSceneModalOpen, setIsAddSceneModalOpen] = useState(false);
  const [addSceneQuestions, setAddSceneQuestions] = useState<ClarificationQuestion[] | null>(null);
  const [isAddScenePolling, setIsAddScenePolling] = useState(false);
  const startAddScene = useStartAddScene();
  const answerAddScene = useAnswerAddSceneQuestions();
  useAddSceneStatus(
    isAddScenePolling ? sessionId : null,
    isAddScenePolling,
    storyId,
    (data) => {
      if (data.status === 'complete' || data.status === 'error') {
        setIsAddScenePolling(false);
      }
    }
  );
  const [generatingSceneIds, setGeneratingSceneIds] = useState<Set<string>>(new Set());
  const [sceneGenError, setSceneGenError] = useState<string | null>(null);

  // Restore polling on page load: check scenes without video_url
  useEffect(() => {
    if (!storyboard || !sessionId) return;
    const scenesWithoutVideo = storyboard.scenes.filter(s => !s.video_url);
    for (const scene of scenesWithoutVideo) {
      fetchSceneGenerationStatus({ session_id: sessionId, scene_id: scene.scene_id })
        .then(res => {
          if (res.status === 'processing') {
            setGeneratingSceneIds(prev => new Set(prev).add(scene.scene_id));
          }
        })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyboard?.story_id]);

  // Scene generation polling — poll the first generating scene
  const pollingSceneId = generatingSceneIds.size > 0 ? Array.from(generatingSceneIds)[0] : null;
  const handleSceneGenChange = useCallback((data: { status: string; message?: string }) => {
    // On error: remove immediately (no video will ever come)
    // On complete: storyboard invalidation triggers refetch; cleanup useEffect handles removal
    if (data.status === 'error') {
      setGeneratingSceneIds(prev => {
        const next = new Set(prev);
        if (pollingSceneId) next.delete(pollingSceneId);
        return next;
      });
      setSceneGenError(data.message || 'Scene generation failed.');
    }
  }, [pollingSceneId]);

  // Remove from generatingSceneIds once video_url is confirmed in storyboard data
  useEffect(() => {
    if (!storyboard) return;
    setGeneratingSceneIds(prev => {
      const next = new Set(prev);
      for (const scene of storyboard.scenes) {
        if (scene.video_url) next.delete(scene.scene_id);
      }
      return next;
    });
  }, [storyboard]);
  useSceneGenerationStatus(
    pollingSceneId ? sessionId : null,
    pollingSceneId,
    handleSceneGenChange
  );

  // Auto-hide scrollbar logic
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const showScrollbar = () => {
      document.documentElement.style.setProperty('--scrollbar-opacity', '1');
      clearTimeout(timer);
      timer = setTimeout(() => {
        document.documentElement.style.setProperty('--scrollbar-opacity', '0');
      }, 1000);
    };

    window.addEventListener('scroll', showScrollbar, true);
    window.addEventListener('wheel', showScrollbar, true);
    window.addEventListener('mousemove', showScrollbar, true);

    return () => {
      window.removeEventListener('scroll', showScrollbar, true);
      window.removeEventListener('wheel', showScrollbar, true);
      window.removeEventListener('mousemove', showScrollbar, true);
      clearTimeout(timer);
    };
  }, []);

  // Panning Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('input')) return;

    setIsDragging(true);
    if (canvasRef.current) {
      setStartX(e.pageX - canvasRef.current.offsetLeft);
      setStartY(e.pageY - canvasRef.current.offsetTop);
      setScrollLeft(canvasRef.current.scrollLeft);
      setScrollTop(canvasRef.current.scrollTop);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !canvasRef.current) return;
    e.preventDefault();
    const x = e.pageX - canvasRef.current.offsetLeft;
    const y = e.pageY - canvasRef.current.offsetTop;
    const walkX = (x - startX) * 1.5;
    const walkY = (y - startY) * 1.5;
    canvasRef.current.scrollLeft = scrollLeft - walkX;
    canvasRef.current.scrollTop = scrollTop - walkY;
  };

  const stopDragging = () => {
    setIsDragging(false);
  };

  const activeScene = scenes.find(s => s.scene_id === activeSceneId) || scenes[0];

  const handleOpenProviderModal = (sceneId: string) => {
    setPendingGenerateSceneId(sceneId);
    setIsProviderModalOpen(true);
  };

  const handleConfirmProvider = (provider: 'apixo' | 'gemini') => {
    if (!pendingGenerateSceneId || !sessionId) return;
    setIsProviderModalOpen(false);
    setGeneratingSceneIds(prev => new Set(prev).add(pendingGenerateSceneId));

    generateSceneVideo.mutate(
      {
        session_id: sessionId,
        scene_id: pendingGenerateSceneId,
        provider,
      },
      {
        onError: () => {
          // Remove from generating set on error
          setGeneratingSceneIds(prev => {
            const next = new Set(prev);
            next.delete(pendingGenerateSceneId);
            return next;
          });
        },
      }
    );

    setPendingGenerateSceneId(null);
  };

  const handleSelectScene = (sceneId: string) => {
    setActiveSceneId(sceneId);
    setShowChoices(false);

    // Find parent scene (one whose choices include this scene)
    const parentScene = scenes.find(s => s.choices.some(c => c.target_scene_id === sceneId));

    if (!parentScene) {
      if (sceneId === firstSceneId) setSelectedPathIds([firstSceneId]);
      return;
    }

    const parentIdx = selectedPathIds.indexOf(parentScene.scene_id);
    if (parentIdx !== -1) {
      setSelectedPathIds([...selectedPathIds.slice(0, parentIdx + 1), sceneId]);
    }
  };

  const isPathActive = (fromId: string, toId: string) => {
    const idx = selectedPathIds.indexOf(fromId);
    return idx !== -1 && selectedPathIds[idx + 1] === toId;
  };

  // Get script text for a scene from its segments
  const getSceneScript = (scene: ApiScene) => {
    return scene.segments
      .map(seg => seg.action_description)
      .join(' ');
  };

  // Add Scene handlers
  const handleAddSceneSubmit = (data: AddSceneRequest) => {
    if (!sessionId) return;
    setIsAddSceneModalOpen(false);
    startAddScene.mutate(
      { sessionId, body: data },
      {
        onSuccess: (res) => {
          if (res.status === 'questions' && res.questions) {
            setAddSceneQuestions(res.questions);
          } else if (res.status === 'processing') {
            setIsAddScenePolling(true);
          }
        },
      }
    );
  };

  const handleAddSceneAnswer = (rawAnswers: Record<number, { selected: string[]; otherInput: string }>) => {
    if (!sessionId || !addSceneQuestions) return;
    const answers = addSceneQuestions.map((q, idx) => {
      const ans = rawAnswers[idx] ?? { selected: [], otherInput: '' };
      const selected = ans.otherInput.trim()
        ? [...ans.selected.filter(s => s !== 'Other'), ans.otherInput.trim()]
        : ans.selected;
      return { question: q.question, selected_options: selected };
    });
    setAddSceneQuestions(null);
    answerAddScene.mutate(
      { sessionId, answers },
      {
        onSuccess: (res) => {
          if (res.status === 'questions' && res.questions) {
            setAddSceneQuestions(res.questions);
          } else if (res.status === 'processing') {
            setIsAddScenePolling(true);
          }
        },
      }
    );
  };

  return (
    <div className="relative flex h-[calc(100vh-64px)] w-full overflow-hidden bg-bg-primary">

      {/* Scene generation error banner */}
      {sceneGenError && (
        <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between bg-red-900/90 px-6 py-3 text-sm text-red-100 backdrop-blur">
          <span>{sceneGenError}</span>
          <button onClick={() => setSceneGenError(null)} className="ml-4 text-red-300 hover:text-white transition-colors">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Mobile Sidebar Overlay */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden animate-[fade-in]"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar Toggle Button */}
      <button
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
        className={`absolute top-6 z-60 flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-bg-secondary text-white backdrop-blur-md transition-all duration-500 hover:scale-[1.15] active:scale-90 shadow-2xl ${isSidebarOpen ? 'lg:left-107.5 left-[calc(85vw-50px)]' : 'left-6'
          }`}
      >
        {isSidebarOpen ? (
          <XIcon className="h-5 w-5 text-accent-rose" />
        ) : (
          <ListIcon className="h-5 w-5 text-(--color-accent-primary)" />
        )}
      </button>

      {/* ============================
          LEFT SIDEBAR (ASSET)
          ============================ */}
      <aside className={`absolute inset-y-0 left-0 z-50 w-120 max-w-[85vw] shrink-0 border-r border-border-default bg-bg-secondary flex flex-col h-full transition-all duration-500 cubic-bezier(0.4, 0, 0.2, 1) ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } lg:relative lg:translate-x-0 ${isSidebarOpen ? 'lg:w-120' : 'lg:w-0 lg:opacity-0 lg:pointer-events-none'}`}>
        <div className="px-6 py-8 border-b border-border-default">
          <h2 className="text-xl font-bold text-white" style={{ fontFamily: "'Sora', sans-serif" }}>Asset</h2>
        </div>

        <div className="flex-1 flex flex-col px-4 py-6 gap-3 min-h-0 overflow-hidden">

          {/* Actor Section */}
          <section className="rounded-xl border border-border-default bg-white/5 overflow-hidden flex flex-col transition-all duration-300">
            <button
              onClick={() => toggleSection('actor')}
              className="flex items-center justify-between p-4 hover:bg-white/5 transition-colors"
            >
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-text-secondary">Actor</h3>
              <div className={`transition-transform duration-300 ${expandedSections.actor ? 'rotate-180' : 'rotate-0'}`}>
                <ChevronDownIcon className="h-4 w-4 text-text-muted" />
              </div>
            </button>
            <div className={`grid overflow-hidden transition-all duration-300 ease-in-out ${expandedSections.actor ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="min-h-0">
                <div className="p-4 pt-0">
                  <div
                    onWheel={handleHorizontalWheel}
                    className="flex flex-nowrap gap-3 overflow-x-auto pb-2 scrollbar-none hover:scrollbar-thin scrollbar-thumb-[var(--color-border-hover)] scrollbar-track-transparent"
                  >
                    {actors.length > 0 ? actors.map(actor => (
                      <div
                        key={actor.actor_id}
                        className={`relative shrink-0 overflow-hidden rounded-lg border border-white/10 shadow-lg ${actor.anchor_image_url ? 'cursor-pointer hover:border-white/30 transition-colors' : ''}`}
                        onClick={() => actor.anchor_image_url && setPreviewImage({ url: actor.anchor_image_url, alt: actor.name })}
                      >
                        {actor.anchor_image_url ? (
                          <img
                            src={actor.anchor_image_url}
                            alt={actor.name}
                            className="h-16 w-16 object-cover"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                              (e.currentTarget.nextElementSibling as HTMLElement)?.classList.remove('hidden');
                            }}
                          />
                        ) : null}
                        <div className={`flex h-16 w-16 items-center justify-center bg-white/5 text-text-muted text-[10px] font-bold ${actor.anchor_image_url ? 'hidden' : ''}`}>
                          {actor.name.charAt(0)}
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-center">
                          <span className="text-[8px] font-bold text-white truncate block">{actor.name}</span>
                        </div>
                      </div>
                    )) : (
                      <p className="text-[10px] text-text-muted">No actors yet</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Theme Section */}
          <section className="rounded-xl border border-border-default bg-white/5 overflow-hidden flex flex-col transition-all duration-300">
            <button
              onClick={() => toggleSection('theme')}
              className="flex items-center justify-between p-4 hover:bg-white/5 transition-colors"
            >
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-text-secondary">Theme</h3>
              <div className={`transition-transform duration-300 ${expandedSections.theme ? 'rotate-180' : 'rotate-0'}`}>
                <ChevronDownIcon className="h-4 w-4 text-text-muted" />
              </div>
            </button>
            <div className={`grid overflow-hidden transition-all duration-300 ease-in-out ${expandedSections.theme ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="min-h-0">
                <div className="p-0 border-t border-white/5">
                  <div
                    onWheel={handleHorizontalWheel}
                    className="flex flex-nowrap overflow-x-auto scrollbar-none hover:scrollbar-thin"
                  >
                    {themes.length > 0 ? themes.map(theme => (
                      <div
                        key={theme.theme_id}
                        className={`relative aspect-video w-full shrink-0 overflow-hidden ${theme.reference_image_url ? 'cursor-pointer' : ''}`}
                        onClick={() => theme.reference_image_url && setPreviewImage({ url: theme.reference_image_url, alt: theme.location_name })}
                      >
                        {theme.reference_image_url ? (
                          <img
                            src={theme.reference_image_url}
                            alt={theme.location_name}
                            className="h-full w-full object-cover"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                              (e.currentTarget.nextElementSibling as HTMLElement)?.classList.remove('hidden');
                            }}
                          />
                        ) : null}
                        <div className={`flex h-full w-full items-center justify-center bg-white/5 text-text-muted text-[10px] uppercase tracking-widest font-bold ${theme.reference_image_url ? 'hidden' : ''}`}>
                          {theme.location_name}
                        </div>
                      </div>
                    )) : (
                      <div className="flex aspect-video w-full items-center justify-center bg-white/5 text-text-muted text-[10px] uppercase tracking-widest font-bold">
                        No Theme Selected
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Script Section */}
          <section className={`rounded-xl border border-border-default bg-white/5 overflow-hidden flex flex-col transition-all duration-300 min-h-0 ${expandedSections.script ? 'flex-1' : 'flex-none'}`}>
            <button
              onClick={() => toggleSection('script')}
              className="flex items-center justify-between p-4 hover:bg-white/5 transition-colors"
            >
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-text-secondary">Script</h3>
              <div className={`transition-transform duration-300 ${expandedSections.script ? 'rotate-180' : 'rotate-0'}`}>
                <ChevronDownIcon className="h-4 w-4 text-text-muted" />
              </div>
            </button>
            <div className={`grid transition-all duration-300 ease-in-out min-h-0 ${expandedSections.script ? 'grid-rows-[1fr] opacity-100 flex-1 border-t border-white/5' : 'grid-rows-[0fr] opacity-0 invisible'}`}>
              <div className="overflow-hidden">
                <div className="h-full flex flex-col p-4 pt-0">
                  <div className="mb-4 flex items-center justify-end px-1 gap-2 pt-4">
                    {showGenerateFeatures && (
                      <button
                        onClick={() => setIsAddSceneModalOpen(true)}
                        title="Add Scene"
                        className="text-text-muted hover:text-(--color-accent-primary) transition-colors"
                      >
                        <PlusIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {isAddScenePolling && (
                    <div className="mb-3 flex items-center gap-3 rounded-lg border border-(--color-accent-primary)/30 bg-(--color-accent-primary)/5 px-3 py-2.5">
                      <div className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-(--color-accent-primary) border-t-transparent" />
                      <span className="text-[10px] font-bold uppercase tracking-widest text-(--color-accent-primary)">
                        Generating scene script…
                      </span>
                    </div>
                  )}

                  <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin scrollbar-thumb-[var(--color-border-hover)] scrollbar-track-transparent">
                    {scenes.map(scene => (
                      <div key={scene.scene_id} className="flex flex-col">
                        <button
                          onClick={() => setActiveSceneId(activeSceneId === scene.scene_id ? '' : scene.scene_id)}
                          className={`flex items-center justify-between rounded-lg px-4 py-3 text-sm font-bold transition-all duration-300 ${activeSceneId === scene.scene_id
                            ? 'bg-linear-to-r from-(--color-accent-primary) to-(--color-accent-secondary) text-black shadow-lg shadow-(--color-accent-primary)/20'
                            : 'bg-white/5 text-text-primary hover:bg-white/10'
                            }`}
                          style={{ fontFamily: "'Sora', sans-serif" }}
                        >
                          {scene.title}
                          <div className={`transition-transform duration-300 ${activeSceneId === scene.scene_id ? 'rotate-180' : 'rotate-0'}`}>
                            <ChevronDownIcon className="h-4 w-4" />
                          </div>
                        </button>

                        <div className={`grid overflow-hidden transition-all duration-300 ease-in-out ${activeSceneId === scene.scene_id
                          ? 'grid-rows-[1fr] opacity-100 mt-2'
                          : 'grid-rows-[0fr] opacity-0 mt-0 invisible'
                          }`}>
                          <div className="min-h-0">
                            <div className="relative rounded-lg bg-accent-rose/10 p-4 border border-accent-rose/20">
                              <p className="text-xs leading-relaxed text-text-primary" style={{ fontFamily: "'Outfit', sans-serif" }}>
                                {getSceneScript(scene)}
                              </p>
                              {scene.segments.some(seg => seg.dialogue.length > 0) && (
                                <div className="mt-3 border-t border-accent-rose/10 pt-3 space-y-1">
                                  {scene.segments.flatMap(seg => seg.dialogue).map((line, i) => (
                                    <p key={i} className="text-[11px] text-text-secondary italic" style={{ fontFamily: "'Outfit', sans-serif" }}>
                                      {line}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </aside>

      {/* Navigation Breadcrumb */}
      <div className={`absolute top-6 z-20 transition-all duration-500 ease-in-out pointer-events-none flex items-center ${isSidebarOpen
        ? 'lg:left-120 lg:right-0 lg:justify-center left-20 w-auto opacity-0 lg:opacity-100'
        : 'left-20 w-auto justify-start opacity-100'
        }`}>
        <div className="flex items-center gap-3 pointer-events-auto">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-text-muted hover:text-(--color-accent-primary) transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Dashboard
          </button>
          <span className="text-text-muted">/</span>
          <span className="text-xs font-bold uppercase tracking-widest text-(--color-accent-primary)">{storyTitle}</span>
        </div>
      </div>

      {/* ============================
          MAIN CANVAS (FLOW)
          ============================ */}
      <main
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDragging}
        onMouseLeave={stopDragging}
        className={`relative flex-1 bg-bg-primary overflow-auto select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        {/* Floating Instruction */}
        <div className="fixed bottom-10 right-10 z-20 rounded-full bg-black/60 border border-white/10 px-6 py-3 backdrop-blur-md">
          <p className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
            <span className="text-(--color-accent-primary)">Mouse Left Click & Drag</span> to Pan Canvas
          </p>
        </div>

        <div className="relative p-75 min-h-375 min-w-625">
          {/* Global Connection Layer */}
          <svg className="pointer-events-none absolute inset-0 z-0 h-full w-full">
            {connections.map(conn => (
              <Connection
                key={`${conn.fromId}-${conn.toId}`}
                fromId={conn.fromId}
                toId={conn.toId}
                isActive={isPathActive(conn.fromId, conn.toId)}
                containerRef={canvasRef}
              />
            ))}
          </svg>

          {/* Dynamic Tree Layout */}
          <div className="relative z-10 flex items-center gap-32">
            {levels.map((level, levelIdx) => (
              <div key={levelIdx} className="flex flex-col items-center gap-12">
                {level.map(scene => (
                  <SceneNode
                    key={scene.scene_id}
                    scene={scene}
                    isActive={activeSceneId === scene.scene_id}
                    isGenerating={generatingSceneIds.has(scene.scene_id) && !scene.video_url}
                    hasVideo={!!scene.video_url}
                    showGenerateFeatures={showGenerateFeatures}
                    onClick={() => { handleSelectScene(scene.scene_id); if (scene.video_url) setIsPreviewOpen(true); }}
                    onSelect={() => handleSelectScene(scene.scene_id)}
                    onGenerate={() => handleOpenProviderModal(scene.scene_id)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Storyboard Loading Overlay */}
      {isLoadingStoryboard && (
        <div className="absolute inset-y-0 right-0 z-100 flex flex-col items-center justify-center gap-6 bg-black/70 backdrop-blur-sm"
          style={{ left: 'var(--sidebar-width, 0px)' }}
        >
          <div className="h-14 w-14 animate-spin rounded-full border-4 border-(--color-accent-primary) border-t-transparent" />
          <div className="text-center">
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-(--color-accent-primary)" style={{ fontFamily: "'Sora', sans-serif" }}>
              Loading storyboard
            </p>
            <p className="mt-1 text-xs text-text-muted animate-pulse" style={{ fontFamily: "'Outfit', sans-serif" }}>
              This may take a moment...
            </p>
          </div>
        </div>
      )}

      {/* ============================
          SCENE THEATER PREVIEW
          ============================ */}
      {isPreviewOpen && activeScene && (
        <div className="fixed inset-0 z-200 flex items-center justify-center bg-black animate-[fade-in]">
          {/* Background Layer - Fullscreen Video */}
          <div className="absolute inset-0 z-0">
            {activeScene.video_url ? (
              <video
                key={activeSceneId}
                autoPlay
                playsInline
                onTimeUpdate={(e) => {
                  const video = e.currentTarget;
                  if (video.duration && video.duration - video.currentTime <= 1) {
                    setShowChoices(true);
                  } else {
                    setShowChoices(false);
                  }
                }}
                onEnded={(e) => {
                  const video = e.currentTarget;
                  video.currentTime = Math.max(0, video.duration - 1);
                  video.play();
                }}
                className="h-full w-full object-cover opacity-80"
              >
                <source src={activeScene.video_url} type="video/mp4" />
              </video>
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-bg-primary">
                <p className="text-text-muted text-sm">No video generated yet</p>
              </div>
            )}
            <div className="absolute inset-0 bg-linear-to-t from-black via-transparent to-black/40" />
          </div>

          {/* Close Button */}
          <button
            onClick={() => setIsPreviewOpen(false)}
            className="absolute right-8 top-8 z-220 rounded-full bg-black/40 p-3 text-white backdrop-blur-md transition-all hover:scale-110 hover:bg-accent-rose"
          >
            <XIcon className="h-6 w-6" />
          </button>

          {/* Scene Stage - Content Overlays */}
          <div className="relative z-210 flex h-full w-full flex-col justify-end p-12 lg:p-24">

            {/* Choices Layer - Above Subtitles */}
            <div className={`mb-12 flex flex-col items-center gap-6 transition-all duration-1000 ${showChoices ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-10 scale-95 pointer-events-none'}`}>
              {activeScene.choices.length > 0 && (
                <>
                  <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-(--color-accent-primary) mb-2">What will you do?</p>
                  <div className="flex flex-wrap justify-center gap-4 max-w-4xl">
                    {activeScene.choices.map((choice, idx) => (
                      <button
                        key={choice.target_scene_id}
                        onClick={() => {
                          const targetId = choice.target_scene_id;
                          handleSelectScene(targetId);
                          const targetScene = scenes.find(s => s.scene_id === targetId);
                          if (!targetScene?.video_url) setIsPreviewOpen(false);
                        }}
                        className="group relative overflow-hidden rounded-xl border border-white/10 bg-black/40 px-8 py-5 transition-all hover:scale-105 hover:border-(--color-accent-primary) hover:bg-black/60 active:scale-95"
                        style={{ animationDelay: `${idx * 150}ms` }}
                      >
                        <div className="absolute inset-0 translate-y-full bg-linear-to-t from-(--color-accent-primary)/10 to-transparent transition-transform group-hover:translate-y-0" />
                        <span className="relative z-10 text-sm font-bold uppercase tracking-widest text-white shadow-sm" style={{ fontFamily: "'Sora', sans-serif" }}>
                          {choice.text}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {activeScene.is_ending && (
                <button
                  onClick={() => setIsPreviewOpen(false)}
                  className="group relative overflow-hidden rounded-xl border border-accent-rose bg-black/40 px-8 py-5 transition-all hover:scale-105 hover:bg-accent-rose/20 active:scale-95"
                >
                  <span className="relative z-10 text-sm font-bold uppercase tracking-widest text-accent-rose" style={{ fontFamily: "'Sora', sans-serif" }}>
                    End of Chapter
                  </span>
                </button>
              )}
            </div>

          </div>
        </div>
      )}

      {/* Provider Selection Modal */}
      <ProviderSelectionModal
        isOpen={isProviderModalOpen}
        onClose={() => { setIsProviderModalOpen(false); setPendingGenerateSceneId(null); }}
        onConfirm={handleConfirmProvider}
      />

      {/* Image Preview Modal */}
      <ImagePreviewModal
        isOpen={!!previewImage}
        onClose={() => setPreviewImage(null)}
        imageUrl={previewImage?.url ?? ''}
        alt={previewImage?.alt ?? ''}
      />

      {/* Add Scene Modal */}
      <AddSceneModal
        isOpen={isAddSceneModalOpen}
        onClose={() => setIsAddSceneModalOpen(false)}
        scenes={scenes}
        actors={actors}
        themes={themes}
        onSubmit={handleAddSceneSubmit}
      />

      {/* Add Scene — Questionnaire (if agent needs clarification) */}
      {addSceneQuestions && (
        <QuestionnaireModal
          isOpen={!!addSceneQuestions}
          onClose={() => setAddSceneQuestions(null)}
          questions={addSceneQuestions}
          onGenerate={handleAddSceneAnswer}
        />
      )}


    </div>
  );
}
