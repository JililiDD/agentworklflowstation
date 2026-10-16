import type React from "react";
import { useEffect, useState } from "react";
import { api } from "./api";
import { Navigation } from "./components/Navigation";
import { InboxView } from "./views/InboxView";
import { RunDetailView } from "./views/RunDetailView";
import { RunsListView } from "./views/RunsListView";
import { SettingsView } from "./views/SettingsView";
import { WorkflowsView } from "./views/WorkflowsView";

export const App: React.FC = () => {
  const [currentHash, setCurrentHash] = useState(
    () => window.location.hash || "#workflows",
  );
  const [inboxCount, setInboxCount] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("aipilot_theme") as
      | "light"
      | "dark"
      | null;
    if (saved) return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  // Apply theme to document element
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("aipilot_theme", theme);
  }, [theme]);

  // Listen to hash changes
  useEffect(() => {
    const onHashChange = () => {
      setCurrentHash(window.location.hash || "#workflows");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Poll inbox count
  useEffect(() => {
    const checkInbox = async () => {
      try {
        const inb = await api.getInbox();
        setInboxCount(inb.questions.length + inb.approvals.length);
      } catch {
        // ignore
      }
    };
    void checkInbox();
    const timer = setInterval(() => {
      void checkInbox();
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  const handleNavigate = (view: string) => {
    window.location.hash = `#${view}`;
  };

  const handleToggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  // Route parsing
  const cleanHash = currentHash.replace(/^#/, "");
  let view = "workflows";
  let runId: string | undefined;
  let initialNodePath: string | undefined;

  if (cleanHash.startsWith("runs/")) {
    view = "run-detail";
    const rest = cleanHash.slice(5);
    const qIndex = rest.indexOf("?");
    if (qIndex !== -1) {
      runId = decodeURIComponent(rest.slice(0, qIndex));
      const params = new URLSearchParams(rest.slice(qIndex));
      initialNodePath = params.get("node") ?? undefined;
    } else {
      runId = decodeURIComponent(rest);
    }
  } else if (cleanHash === "runs") {
    view = "runs";
  } else if (cleanHash === "inbox") {
    view = "inbox";
  } else if (cleanHash === "settings") {
    view = "settings";
  } else {
    view = "workflows";
  }

  return (
    <div className="app-shell">
      <Navigation
        currentView={view}
        inboxCount={inboxCount}
        onNavigate={handleNavigate}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />

      {view === "workflows" && (
        <WorkflowsView
          onStartRun={(newRunId) => {
            window.location.hash = `#runs/${encodeURIComponent(newRunId)}`;
          }}
        />
      )}

      {view === "runs" && (
        <RunsListView
          onSelectRun={(selectedId) => {
            window.location.hash = `#runs/${encodeURIComponent(selectedId)}`;
          }}
        />
      )}

      {view === "run-detail" && runId && (
        <RunDetailView
          runId={runId}
          initialNodePath={initialNodePath}
          onBack={() => {
            window.location.hash = "#runs";
          }}
        />
      )}

      {view === "inbox" && (
        <InboxView
          onSelectNode={(targetRunId, targetNode) => {
            window.location.hash = `#runs/${encodeURIComponent(targetRunId)}?node=${encodeURIComponent(targetNode)}`;
          }}
        />
      )}

      {view === "settings" && <SettingsView />}
    </div>
  );
};
