import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type {
  CredentialMetadata,
  LoginSessionState,
  PlatformSettings,
  SkillInfo,
} from "../types";

export const SettingsView: React.FC = () => {
  const [settings, setSettings] = useState<PlatformSettings>({
    skillDirectories: [],
  });
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [providers, setProviders] = useState<CredentialMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New directory input
  const [newDir, setNewDir] = useState("");

  // API Key input
  const [apiKeyProvider, setApiKeyProvider] = useState("openai");
  const [apiKeyVal, setApiKeyVal] = useState("");

  // Login flow state
  const [loginProvider, setLoginProvider] = useState("anthropic");
  const [loginSession, setLoginSession] = useState<LoginSessionState | null>(
    null,
  );
  const [loginResponseText, setLoginResponseText] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [s, sk, p] = await Promise.all([
        api.getSettings(),
        api.listSkills(),
        api.listProviders(),
      ]);
      setSettings(s);
      setSkills(sk);
      setProviders(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Poll login session if active and pending
  useEffect(() => {
    if (!loginSession) return;
    if (
      loginSession.status === "completed" ||
      loginSession.status === "failed" ||
      loginSession.status === "cancelled"
    ) {
      void loadData();
      return;
    }

    const timer = setInterval(async () => {
      try {
        const updated = await api.getLoginSession(loginSession.loginId);
        setLoginSession(updated);
        if (
          updated.status === "completed" ||
          updated.status === "failed" ||
          updated.status === "cancelled"
        ) {
          clearInterval(timer);
          void loadData();
        }
      } catch {
        // ignore
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [loginSession, loadData]);

  const handleAddDirectory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDir.trim()) return;
    try {
      const updatedDirs = Array.from(
        new Set([...settings.skillDirectories, newDir.trim()]),
      );
      const res = await api.saveSettings({ skillDirectories: updatedDirs });
      setSettings(res);
      setNewDir("");
      const refreshedSkills = await api.listSkills();
      setSkills(refreshedSkills);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemoveDirectory = async (dir: string) => {
    try {
      const updatedDirs = settings.skillDirectories.filter((d) => d !== dir);
      const res = await api.saveSettings({ skillDirectories: updatedDirs });
      setSettings(res);
      const refreshedSkills = await api.listSkills();
      setSkills(refreshedSkills);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSetApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyVal.trim()) return;
    try {
      await api.setApiKey(apiKeyProvider, apiKeyVal.trim());
      setApiKeyVal("");
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleLogout = async (providerId: string) => {
    try {
      await api.logout(providerId);
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStartLogin = async (authType: "oauth" | "api_key" = "oauth") => {
    try {
      setLoginLoading(true);
      const session = await api.startLogin(loginProvider, authType);
      setLoginSession(session);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setLoginLoading(false);
    }
  };

  const handleRespondLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginSession) return;
    try {
      const updated = await api.respondLogin(
        loginSession.loginId,
        loginResponseText,
      );
      setLoginSession(updated);
      setLoginResponseText("");
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancelLogin = async () => {
    if (!loginSession) return;
    try {
      const updated = await api.cancelLogin(loginSession.loginId);
      setLoginSession(updated);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return (
      <div className="view-container">
        <div className="view-header">
          <h2>Settings</h2>
        </div>
        <p className="quiet">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2>Settings</h2>
          <p>Skill sources and local model provider authentication</p>
        </div>
      </div>

      {error && <div className="alert-error">{error}</div>}

      {/* 1. Skill Sources */}
      <section className="item-card">
        <h3>Skill Sources</h3>
        <p className="quiet">
          Register local directories containing SKILL.md definitions. Nodes can
          load and read skills from these directories.
        </p>

        <form
          onSubmit={handleAddDirectory}
          style={{ display: "flex", gap: "8px" }}
        >
          <input
            type="text"
            placeholder="/path/to/skills-dir"
            value={newDir}
            onChange={(e) => setNewDir(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn primary" type="submit">
            Add Directory
          </button>
        </form>

        <div style={{ marginTop: "12px" }}>
          <span style={{ fontWeight: 600, fontSize: "12px" }}>
            Configured Directories:
          </span>
          {settings.skillDirectories.length === 0 ? (
            <p className="quiet" style={{ fontSize: "12px" }}>
              No skill directories registered.
            </p>
          ) : (
            <ul style={{ margin: "6px 0", paddingLeft: "20px" }}>
              {settings.skillDirectories.map((dir) => (
                <li key={dir} style={{ margin: "4px 0" }}>
                  <span className="code">{dir}</span>{" "}
                  <button
                    className="btn"
                    style={{
                      height: "22px",
                      padding: "0 6px",
                      fontSize: "11px",
                      marginLeft: "8px",
                    }}
                    type="button"
                    onClick={() => handleRemoveDirectory(dir)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={{ marginTop: "12px" }}>
          <span style={{ fontWeight: 600, fontSize: "12px" }}>
            Discovered Skills ({skills.length}):
          </span>
          {skills.length === 0 ? (
            <p className="quiet" style={{ fontSize: "12px" }}>
              No skills found in configured directories.
            </p>
          ) : (
            <div className="table-wrap" style={{ marginTop: "8px" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Skill Name</th>
                    <th>Description</th>
                    <th>Source Directory</th>
                  </tr>
                </thead>
                <tbody>
                  {skills.map((s) => (
                    <tr key={s.name}>
                      <td className="code" style={{ fontWeight: 600 }}>
                        {s.name}
                      </td>
                      <td>
                        {s.description || <span className="quiet">—</span>}
                      </td>
                      <td className="code quiet" style={{ fontSize: "11px" }}>
                        {s.sourceDir}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* 2. Model Providers & Credentials */}
      <section className="item-card">
        <h3>Model Credentials & Subscriptions</h3>
        <p className="quiet">
          Authenticate with Claude Pro/Max or ChatGPT subscriptions via pi, or
          set local API keys. Tokens are stored only on your machine and never
          displayed.
        </p>

        <div className="table-wrap" style={{ margin: "10px 0" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Type</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {providers.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="quiet"
                    style={{ textAlign: "center" }}
                  >
                    No providers configured.
                  </td>
                </tr>
              ) : (
                providers.map((p) => (
                  <tr key={p.providerId}>
                    <td style={{ fontWeight: 600 }}>{p.providerId}</td>
                    <td>{p.type}</td>
                    <td>
                      <span
                        className={`badge-status ${p.configured ? "badge-succeeded" : "badge-failed"}`}
                      >
                        {p.configured ? "Configured" : "Not configured"}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn stop"
                        type="button"
                        style={{
                          height: "24px",
                          padding: "0 8px",
                          fontSize: "11px",
                        }}
                        onClick={() => handleLogout(p.providerId)}
                      >
                        Logout
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Start Login */}
        <div
          style={{
            marginTop: "16px",
            borderTop: "1px solid var(--line)",
            paddingTop: "14px",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: "13px" }}>
            Subscription Login (via pi SDK)
          </span>
          <div
            style={{
              display: "flex",
              gap: "8px",
              marginTop: "8px",
              alignItems: "center",
            }}
          >
            <select
              value={loginProvider}
              onChange={(e) => setLoginProvider(e.target.value)}
              style={{ minWidth: "160px" }}
            >
              <option value="anthropic">anthropic (Claude subscription)</option>
              <option value="openai-codex">
                openai-codex (ChatGPT subscription)
              </option>
              <option value="openai">openai</option>
              <option value="google">google</option>
            </select>
            <button
              className="btn primary"
              type="button"
              disabled={
                loginLoading ||
                loginSession?.status === "pending" ||
                loginSession?.status === "waiting_user_input"
              }
              onClick={() => handleStartLogin("oauth")}
            >
              {loginLoading ? "Starting..." : "Start OAuth Login"}
            </button>
          </div>

          {/* Active Login Session UI */}
          {loginSession && (
            <div
              style={{
                marginTop: "12px",
                padding: "12px",
                background: "var(--sunken)",
                borderRadius: "5px",
                border: "1px solid var(--line)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>
                  Login Status: <b>{loginSession.status}</b> (
                  {loginSession.provider})
                </span>
                {(loginSession.status === "pending" ||
                  loginSession.status === "waiting_user_input") && (
                  <button
                    className="btn"
                    type="button"
                    onClick={handleCancelLogin}
                  >
                    Cancel
                  </button>
                )}
              </div>

              {loginSession.events.map((ev, i) => (
                <div
                  key={`${ev.type}-${ev.url ?? ev.message ?? i}`}
                  style={{ marginTop: "6px", fontSize: "12px" }}
                >
                  {ev.message && <div>{ev.message}</div>}
                  {ev.instructions && (
                    <div className="quiet">{ev.instructions}</div>
                  )}
                  {ev.url && (
                    <div style={{ marginTop: "4px" }}>
                      Open Link:{" "}
                      <a
                        href={ev.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          textDecoration: "underline",
                          color: "var(--run)",
                        }}
                      >
                        {ev.url}
                      </a>
                    </div>
                  )}
                  {ev.userCode && (
                    <div style={{ marginTop: "4px" }}>
                      User Code:{" "}
                      <kbd style={{ fontSize: "14px", padding: "2px 8px" }}>
                        {ev.userCode}
                      </kbd>
                    </div>
                  )}
                </div>
              ))}

              {loginSession.currentPrompt &&
                loginSession.status === "waiting_user_input" && (
                  <form
                    onSubmit={handleRespondLogin}
                    style={{ marginTop: "10px", display: "flex", gap: "8px" }}
                  >
                    <input
                      type={
                        loginSession.currentPrompt.type === "secret"
                          ? "password"
                          : "text"
                      }
                      placeholder={
                        loginSession.currentPrompt.placeholder ??
                        loginSession.currentPrompt.message
                      }
                      value={loginResponseText}
                      onChange={(e) => setLoginResponseText(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button className="btn primary" type="submit">
                      Submit Response
                    </button>
                  </form>
                )}

              {loginSession.status === "completed" && (
                <div
                  className="alert-warning"
                  style={{
                    background: "#dcfce7",
                    borderColor: "#86efac",
                    color: "#166534",
                    marginTop: "8px",
                  }}
                >
                  Login succeeded! Credentials saved to local store.
                </div>
              )}
              {loginSession.status === "failed" && (
                <div className="alert-error" style={{ marginTop: "8px" }}>
                  Login failed: {loginSession.error ?? "Unknown error"}
                </div>
              )}
            </div>
          )}
        </div>

        {/* API Key Form */}
        <div
          style={{
            marginTop: "16px",
            borderTop: "1px solid var(--line)",
            paddingTop: "14px",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: "13px" }}>
            Or Set API Key
          </span>
          <form
            onSubmit={handleSetApiKey}
            style={{ display: "flex", gap: "8px", marginTop: "8px" }}
          >
            <select
              value={apiKeyProvider}
              onChange={(e) => setApiKeyProvider(e.target.value)}
              style={{ minWidth: "140px" }}
            >
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
              <option value="google">google</option>
            </select>
            <input
              type="password"
              placeholder="Enter API Key"
              value={apiKeyVal}
              onChange={(e) => setApiKeyVal(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn primary" type="submit">
              Save Key
            </button>
          </form>
        </div>
      </section>
    </div>
  );
};
