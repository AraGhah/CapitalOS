"use client";

export const THEME_KEY = "capitalos.theme";

// Runs before the first paint so a pinned dark theme never flashes white.
// Kept as a string because it has to go into the document head verbatim.
export const themeBootScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t}}catch(e){}`;

// Which glyph shows is decided in CSS from the same signals that decide the
// colours, so the button never has to guess during hydration and there is no
// state here to fall out of step with the page.
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const pinned = root.dataset.theme;
    const isDark = pinned
      ? pinned === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;

    const next = isDark ? "light" : "dark";
    root.dataset.theme = next;

    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // private window or blocked storage — the choice just will not survive a refresh
    }
  }

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      title="Switch theme"
      aria-label="Switch between dark and light"
    >
      <svg
        className="theme-moon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" strokeLinejoin="round" />
      </svg>
      <svg
        className="theme-sun"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
      </svg>
    </button>
  );
}
