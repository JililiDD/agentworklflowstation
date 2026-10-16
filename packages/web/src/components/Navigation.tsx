import type React from "react";

interface NavigationProps {
  currentView: string;
  inboxCount: number;
  onNavigate: (view: string) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export const Navigation: React.FC<NavigationProps> = ({
  currentView,
  inboxCount,
  onNavigate,
  theme,
  onToggleTheme,
}) => {
  return (
    <nav className="nav" aria-label="Main navigation">
      <div className="mark" title="aipilotAgent">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <title>aipilotAgent Mark</title>
          <circle cx="12" cy="12" r="10" />
          <polygon points="12 6 16 14 8 14" fill="currentColor" />
        </svg>
      </div>

      <button
        type="button"
        className={`nav-item ${currentView === "workflows" ? "on" : ""}`}
        title="Workflows"
        onClick={() => onNavigate("workflows")}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <title>Workflows</title>
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="5.5" y="9" width="5" height="5" rx="1" />
          <path d="M4.5 7v1.5h3.5V9M11.5 7v1.5H8" />
        </svg>
      </button>

      <button
        type="button"
        className={`nav-item ${currentView.startsWith("runs") ? "on" : ""}`}
        title="Runs"
        onClick={() => onNavigate("runs")}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <title>Runs</title>
          <path d="M4.5 2.8 13 8l-8.5 5.2Z" />
        </svg>
      </button>

      <button
        type="button"
        className={`nav-item ${currentView === "inbox" ? "on" : ""}`}
        title={inboxCount > 0 ? `Inbox: ${inboxCount} items waiting` : "Inbox"}
        onClick={() => onNavigate("inbox")}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <title>Inbox</title>
          <path d="M2 9h3.2l1 2h3.6l1-2H14M3.6 3h8.8L14 9v4H2V9Z" />
        </svg>
        {inboxCount > 0 && <span className="count-badge">{inboxCount}</span>}
      </button>

      <div className="spacer" />

      <button
        type="button"
        className={`nav-item ${currentView === "settings" ? "on" : ""}`}
        title="Settings"
        onClick={() => onNavigate("settings")}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <title>Settings</title>
          <path d="M2.5 4.5h11M2.5 11.5h11" strokeLinecap="round" />
          <circle cx="10" cy="4.5" r="1.8" fill="var(--panel)" />
          <circle cx="6" cy="11.5" r="1.8" fill="var(--panel)" />
        </svg>
      </button>

      <button
        className="theme-toggle"
        type="button"
        title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        onClick={onToggleTheme}
      >
        {theme === "dark" ? "☼" : "◐"}
      </button>
    </nav>
  );
};
