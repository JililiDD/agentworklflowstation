import type { TokenRates } from "./cost.ts";
import type {
  AgentSessionHandle,
  CreateSessionOptions,
  ProviderCredentials,
  SessionAdapter,
} from "./session-adapter.ts";
import type { Answer, Question, StepEvent, TokenUsage } from "./types.ts";

export interface FakeSessionAdapter extends SessionAdapter {
  readonly receivedCredentials: ProviderCredentials[];
  readonly sessionIds: string[];
  readonly disposedSessionIds: string[];
  readonly askEnabled: boolean[];
  readonly sentPrompts: Array<{ sessionId: string; text: string }>;
  readonly answers: Answer[];
  rates: TokenRates | undefined;
  nextUsage: TokenUsage;
  nextEvents?: StepEvent[];
  nextQuestion?: Question;
  failures: Error[];
  onPrompt?: (workDir: string, text: string) => Promise<void>;
}

export function createFakeSessionAdapter(): FakeSessionAdapter {
  let nextId = 1;
  const receivedCredentials: ProviderCredentials[] = [];
  const sessionIds: string[] = [];
  const disposedSessionIds: string[] = [];
  const askEnabled: boolean[] = [];
  const sentPrompts: Array<{ sessionId: string; text: string }> = [];
  const answers: Answer[] = [];
  const adapter: FakeSessionAdapter = {
    receivedCredentials,
    sessionIds,
    disposedSessionIds,
    askEnabled,
    sentPrompts,
    answers,
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    nextUsage: { inputTokens: 10, outputTokens: 4 },
    failures: [],
    async createSession(options: CreateSessionOptions) {
      receivedCredentials.push(options.credentials);
      askEnabled.push(options.ask !== undefined);
      const id = `fake-session-${nextId}`;
      nextId += 1;
      sessionIds.push(id);
      const handle: AgentSessionHandle = {
        id,
        get rates() {
          return adapter.rates;
        },
        async prompt(
          text: string,
          onEvent: (event: StepEvent) => void,
          signal: AbortSignal,
        ): Promise<void> {
          sentPrompts.push({ sessionId: id, text });
          for (const event of adapter.nextEvents ?? [
            {
              type: "model" as const,
              at: new Date().toISOString(),
              summary: "model turn",
              usage: { ...adapter.nextUsage },
            },
          ]) {
            onEvent(event);
          }
          if (adapter.nextQuestion !== undefined && options.ask !== undefined) {
            onEvent({
              type: "tool",
              at: new Date().toISOString(),
              summary: "ask_user",
            });
            answers.push(await options.ask(adapter.nextQuestion, signal));
          }
          const failure = adapter.failures.shift();
          if (failure !== undefined) throw failure;
          await adapter.onPrompt?.(options.workDir, text);
        },
        async dispose() {
          disposedSessionIds.push(id);
        },
      };
      return handle;
    },
  };
  return adapter;
}
