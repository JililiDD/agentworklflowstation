import { setTimeout as sleep } from "node:timers/promises";
import type { AgentSessionHandle } from "./session-adapter.ts";
import type { StepEvent } from "./types.ts";

const MAX_RETRIES = 3;
const FIRST_DELAY_MS = 2000;

export class ModelApiError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(
    message: string,
    status?: number,
    code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RetryClock {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
}

export const systemRetryClock: RetryClock = {
  async sleep(ms, signal) {
    await sleep(ms, undefined, { signal });
  },
  random: Math.random,
};

function errorFields(error: unknown): {
  message: string;
  status?: number;
  code?: string;
} {
  if (typeof error !== "object" || error === null)
    return { message: String(error) };
  const record = error as Record<string, unknown>;
  return {
    message:
      error instanceof Error ? error.message : String(record.message ?? ""),
    ...(typeof record.status === "number" ? { status: record.status } : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
  };
}

/** Intentionally narrower than pi's built-in retry policy: only throttling and timeouts. */
export function isRateLimitOrTimeout(error: unknown): boolean {
  const { message, status, code } = errorFields(error);
  if (
    /insufficient_quota|quota exceeded|out of budget|monthly usage limit|billing|subscription_sharing_usage_limit_exceeded|available balance/i.test(
      message,
    )
  ) {
    return false;
  }
  if (status !== undefined)
    return status === 429 || status === 408 || status === 504;
  if (code === "ETIMEDOUT" || code === "ERR_TIMEOUT") return true;
  return /\b429\b|rate[\s_-]?limit|too many requests|timed?\s*out|timeout|deadline exceeded/i.test(
    message,
  );
}

export async function promptWithRetry(
  session: AgentSessionHandle,
  instruction: string,
  onEvent: (event: StepEvent) => void,
  signal: AbortSignal,
  clock: RetryClock,
): Promise<void> {
  for (let retries = 0; ; retries += 1) {
    if (signal.aborted) throw new Error("node aborted");
    try {
      await session.prompt(instruction, onEvent, signal);
      return;
    } catch (error) {
      if (
        signal.aborted ||
        !(error instanceof ModelApiError) ||
        !isRateLimitOrTimeout(error) ||
        retries >= MAX_RETRIES
      ) {
        throw error;
      }
      const delayMs = Math.round(
        FIRST_DELAY_MS * 2 ** retries * (0.8 + 0.4 * clock.random()),
      );
      onEvent({
        type: "retry",
        at: new Date().toISOString(),
        summary: `model API retry ${retries + 1}/${MAX_RETRIES} after ${delayMs}ms`,
      });
      await clock.sleep(delayMs, signal);
    }
  }
}
