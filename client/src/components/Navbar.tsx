import { useState } from 'react';

interface NavbarProps {
  onCreateStory: () => void;
  showCreateStory?: boolean;
}

export default function Navbar({ onCreateStory, showCreateStory = true }: NavbarProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <nav className="glass-strong fixed top-0 left-0 right-0 z-50">
      <div className="w-full px-6">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-linear-to-br from-(--color-accent-primary) to-(--color-accent-cyan)">
              <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {/* Glow effect */}
              <div className="absolute inset-0 rounded-lg bg-linear-to-br from-(--color-accent-primary) to-(--color-accent-cyan) opacity-40 blur-lg" />
            </div>
            <span className="text-gradient text-lg font-bold tracking-tight" style={{ fontFamily: "'Sora', sans-serif" }}>
              SceneStudio
            </span>
          </div>

          {/* Right Section */}
          <div className="flex items-center gap-3">
            {/* Create Story Button */}
            {showCreateStory && (
              <button
                id="create-story-btn"
                onClick={onCreateStory}
                className="group relative hidden cursor-pointer items-center gap-2 overflow-hidden rounded-(--radius-button) bg-linear-to-r from-(--color-accent-primary) to-(--color-accent-secondary) px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-(--color-accent-primary)/25 transition-all duration-300 hover:shadow-xl hover:shadow-(--color-accent-primary)/40 sm:inline-flex"
              >
                {/* Shimmer overlay */}
                <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/20 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" style={{ backgroundSize: '200% 100%', animation: 'shimmer 2s linear infinite' }} />
                <svg className="relative z-10 h-4 w-4 transition-transform duration-300 group-hover:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span className="relative z-10">Create Story</span>
              </button>
            )}

            {/* Avatar */}
            <button className="group relative h-9 w-9 overflow-hidden rounded-full bg-linear-to-br from-(--color-accent-primary) to-(--color-accent-cyan) p-0.5 transition-all duration-300 hover:scale-105 hover:shadow-lg hover:shadow-(--color-accent-primary)/30">
              <div className="flex h-full w-full items-center justify-center rounded-full bg-bg-secondary">
                <span className="text-sm font-semibold text-(--color-accent-secondary)">D</span>
              </div>
            </button>

            {/* Mobile Menu Toggle */}
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="rounded-lg p-2 text-text-secondary transition-colors duration-200 hover:bg-white/5 hover:text-text-primary md:hidden"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                {isMenuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      <div className={`overflow-hidden transition-all duration-300 md:hidden ${isMenuOpen ? 'max-h-64 border-t border-white/5' : 'max-h-0'}`}>
        <div className="space-y-1 px-4 py-3">
          <MobileNavLink active>Dashboard</MobileNavLink>
          <MobileNavLink>Explore</MobileNavLink>
          <MobileNavLink>My Stories</MobileNavLink>
          <MobileNavLink>Community</MobileNavLink>
          {showCreateStory && (
            <button
              onClick={onCreateStory}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-(--radius-button) bg-linear-to-r from-(--color-accent-primary) to-(--color-accent-secondary) px-4 py-2.5 text-sm font-semibold text-white"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Create Story
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}

function MobileNavLink({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return (
    <a
      href="#"
      className={`block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-200
        ${active
          ? 'bg-white/5 text-text-primary'
          : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'
        }
      `}
    >
      {children}
    </a>
  );
}
