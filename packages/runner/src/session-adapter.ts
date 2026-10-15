import type { Answer, Question, StepEvent, ThinkingLevel } from "./types.ts";

export interface ProviderCredentials {
  provider: string;
  secret: string;
}

export interface CreateSessionOptions {
  modelProvider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  /** Only interactive nodes provide this callback and receive the ask tool. */
  ask?: (question: Question, signal?: AbortSignal) => Promise<Answer>;
  credentials: ProviderCredentials;
  workDir: string;
}

export interface AgentSessionHandle {
  readonly id: string;
  /** Model catalog rates, measured in USD per million tokens. */
  readonly rates:
    | { input: number; output: number; cacheRead: number; cacheWrite: number }
    | undefined;
  prompt(
    text: string,
    onEvent: (event: StepEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export interface SessionAdapter {
  createSession(options: CreateSessionOptions): Promise<AgentSessionHandle>;
}
