import type { TokenUsage } from "./types.ts";

export interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function costUsdFromUsage(
  usage: TokenUsage,
  rates: TokenRates | undefined,
): number | undefined {
  if (rates === undefined) {
    return undefined;
  }
  if (
    rates.input === 0 &&
    rates.output === 0 &&
    rates.cacheRead === 0 &&
    rates.cacheWrite === 0
  ) {
    return undefined;
  }
  return (
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      (usage.cacheReadTokens ?? 0) * rates.cacheRead +
      (usage.cacheWriteTokens ?? 0) * rates.cacheWrite) /
    1_000_000
  );
}

export function usageWithCost(
  usage: TokenUsage,
  rates: TokenRates | undefined,
): TokenUsage {
  const costUsd = costUsdFromUsage(usage, rates);
  if (costUsd === undefined) {
    const { costUsd: _omitted, ...rest } = usage;
    return rest;
  }
  return { ...usage, costUsd };
}
