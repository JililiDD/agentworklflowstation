import type { TokenRates } from "./cost.ts";
import type {
  AgentSessionHandle,
  CreateSessionOptions,
  ProviderCredentials,
  SessionAdapter,
} from "./session-adapter.ts";
import type { StepEvent, TokenUsage } from "./types.ts";

export interface FakeSessionAdapter extends SessionAdapter {
  readonly receivedCredentials: ProviderCredentials[];
  readonly sessionIds: string[];
  rates: TokenRates | undefined;
  nextUsage: TokenUsage;
  nextEvents?: StepEvent[];
  onPrompt?: (workDir: string) => Promise<void>;
}

export function createFakeSessionAdapter(): FakeSessionAdapter {
  let nextId = 1;
  const receivedCredentials: ProviderCredentials[] = [];
  const sessionIds: string[] = [];
  const adapter: FakeSessionAdapter = {
    receivedCredentials,
    sessionIds,
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    nextUsage: { inputTokens: 10, outputTokens: 4 },
    async createSession(options: CreateSessionOptions) {
      receivedCredentials.push(options.credentials);
      const id = `fake-session-${nextId}`;
      nextId += 1;
      sessionIds.push(id);
      const handle: AgentSessionHandle = {
        id,
        get rates() {
          return adapter.rates;
        },
        async prompt(
          _text: string,
          onEvent: (event: StepEvent) => void,
        ): Promise<void> {
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
          await adapter.onPrompt?.(options.workDir);
        },
        async dispose() {},
      };
      return handle;
    },
  };
  return adapter;
}
