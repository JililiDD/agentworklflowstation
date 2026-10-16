import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CredentialStore,
  createFileCredentialStore,
} from "@aipilotagent/runner";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface LoginEvent {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
}

export interface LoginPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export type LoginSessionStatus =
  | "pending"
  | "waiting_user_input"
  | "completed"
  | "failed"
  | "cancelled";

export interface LoginSessionState {
  loginId: string;
  provider: string;
  authType: "oauth" | "api_key";
  status: LoginSessionStatus;
  currentPrompt?: LoginPrompt;
  events: LoginEvent[];
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface CredentialMetadata {
  providerId: string;
  type: "oauth" | "api_key";
  configured: boolean;
}

export interface AuthManagerOptions {
  authPath: string;
  runtime?: ModelRuntime;
  store?: CredentialStore;
}

interface ActiveLogin {
  state: LoginSessionState;
  controller: AbortController;
  resolvePrompt?: (answer: string) => void;
  rejectPrompt?: (error: Error) => void;
}

export class AuthManager {
  readonly authPath: string;
  private runtime?: ModelRuntime;
  private store: CredentialStore;
  private activeLogin?: ActiveLogin;
  private sessions = new Map<string, LoginSessionState>();

  constructor(options: AuthManagerOptions) {
    this.authPath = options.authPath;
    this.store = options.store ?? createFileCredentialStore(options.authPath);
    this.runtime = options.runtime;
  }

  private async getRuntime(): Promise<ModelRuntime> {
    if (!this.runtime) {
      this.runtime = await ModelRuntime.create({ authPath: this.authPath });
    }
    return this.runtime;
  }

  async listProviders(): Promise<CredentialMetadata[]> {
    const list = await this.store.list();
    return list.map(
      (item: { providerId: string; type: "api_key" | "oauth" }) => ({
        providerId: item.providerId,
        type: item.type,
        configured: true,
      }),
    );
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    if (!providerId || typeof providerId !== "string") {
      throw new Error("providerId must be a non-empty string");
    }
    if (!apiKey || typeof apiKey !== "string") {
      throw new Error("apiKey must be a non-empty string");
    }
    await this.store.modify(providerId, async () => ({
      type: "api_key",
      key: apiKey.trim(),
    }));
  }

  async logout(providerId: string): Promise<void> {
    if (!providerId || typeof providerId !== "string") {
      throw new Error("providerId must be a non-empty string");
    }
    await this.store.delete(providerId);
  }

  getLoginSession(loginId: string): LoginSessionState | undefined {
    return this.sessions.get(loginId);
  }

  async startLogin(
    providerId: string,
    authType: "oauth" | "api_key" = "oauth",
  ): Promise<LoginSessionState> {
    if (
      this.activeLogin &&
      (this.activeLogin.state.status === "waiting_user_input" ||
        this.activeLogin.state.status === "pending")
    ) {
      throw new Error(
        `another login is currently in progress for provider: ${this.activeLogin.state.provider}`,
      );
    }

    const loginId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    const state: LoginSessionState = {
      loginId,
      provider: providerId,
      authType,
      status: "pending",
      events: [],
      createdAt: new Date().toISOString(),
    };

    const active: ActiveLogin = {
      state,
      controller,
    };
    this.activeLogin = active;
    this.sessions.set(loginId, state);

    // Run login asynchronously
    void this.executeLogin(active);

    return state;
  }

  private async executeLogin(active: ActiveLogin): Promise<void> {
    const { state, controller } = active;
    try {
      const runtime = await this.getRuntime();
      await runtime.login(state.provider, state.authType, {
        signal: controller.signal,
        notify: (event) => {
          state.events.push({
            type: event.type,
            message: "message" in event ? event.message : undefined,
            url: "url" in event ? event.url : undefined,
            instructions:
              "instructions" in event ? event.instructions : undefined,
            userCode: "userCode" in event ? event.userCode : undefined,
            verificationUri:
              "verificationUri" in event ? event.verificationUri : undefined,
          });
        },
        prompt: async (prompt) => {
          if (controller.signal.aborted) {
            throw new Error("login cancelled");
          }
          state.status = "waiting_user_input";
          state.currentPrompt = {
            type: prompt.type,
            message: prompt.message,
            placeholder:
              "placeholder" in prompt ? prompt.placeholder : undefined,
            options:
              "options" in prompt
                ? prompt.options.map((o) => ({
                    id: o.id,
                    label: o.label,
                    description: o.description,
                  }))
                : undefined,
          };

          return new Promise<string>((resolve, reject) => {
            active.resolvePrompt = resolve;
            active.rejectPrompt = reject;
            controller.signal.addEventListener(
              "abort",
              () => {
                reject(new Error("login cancelled"));
              },
              { once: true },
            );
          });
        },
      });

      state.status = "completed";
      state.completedAt = new Date().toISOString();
      delete state.currentPrompt;
    } catch (error) {
      if (controller.signal.aborted) {
        state.status = "cancelled";
      } else {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
      }
      delete state.currentPrompt;
    } finally {
      if (this.activeLogin === active) {
        this.activeLogin = undefined;
      }
    }
  }

  async respondLogin(
    loginId: string,
    response: string,
  ): Promise<LoginSessionState> {
    const active = this.activeLogin;
    if (!active || active.state.loginId !== loginId) {
      const existing = this.sessions.get(loginId);
      if (!existing) throw new Error(`login session not found: ${loginId}`);
      throw new Error(`login session is not waiting for input: ${loginId}`);
    }

    if (active.state.status !== "waiting_user_input" || !active.resolvePrompt) {
      throw new Error(`login session is not waiting for input: ${loginId}`);
    }

    delete active.state.currentPrompt;
    active.state.status = "pending";
    const resolver = active.resolvePrompt;
    active.resolvePrompt = undefined;
    active.rejectPrompt = undefined;
    resolver(response);

    return active.state;
  }

  async cancelLogin(loginId: string): Promise<LoginSessionState> {
    const existing = this.sessions.get(loginId);
    if (!existing) {
      throw new Error(`login session not found: ${loginId}`);
    }
    if (this.activeLogin && this.activeLogin.state.loginId === loginId) {
      this.activeLogin.controller.abort();
      if (this.activeLogin.rejectPrompt) {
        this.activeLogin.rejectPrompt(new Error("login cancelled"));
      }
      this.activeLogin.state.status = "cancelled";
      delete this.activeLogin.state.currentPrompt;
    } else if (
      existing.status === "pending" ||
      existing.status === "waiting_user_input"
    ) {
      existing.status = "cancelled";
      delete existing.currentPrompt;
    }
    return existing;
  }
}

export function getDefaultAuthPath(): string {
  if (process.env.PI_CODING_AGENT_DIR) {
    return join(process.env.PI_CODING_AGENT_DIR, "auth.json");
  }
  return join(homedir(), ".pi", "agent", "auth.json");
}
