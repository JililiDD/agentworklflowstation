/** Thinking levels accepted by pi 1.3.0. Premise P1. */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type NodeKind = "agent" | "command";

export type NodeStatus = "succeeded" | "failed";

/** Agent node definition. Model is `provider/id`. Premise P1. */
export interface AgentNodeDefinition {
  kind: "agent";
  model: string;
  thinkingLevel: ThinkingLevel;
  skillSourceDir?: string;
  skillNames?: string[];
  task: string;
  instructions?: string;
  interactive: boolean;
  outputs: string[];
}

export interface CommandNodeDefinition {
  kind: "command";
  command: string;
  allowNonZeroExit: boolean;
}

export type NodeDefinition = AgentNodeDefinition | CommandNodeDefinition;

/** Token usage from pi message_end events. Premise P4. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Undefined when the model catalog has no unit price. Premise P7. */
  costUsd?: number;
}

export type StepEventType =
  | "model"
  | "tool"
  | "retry"
  | "question"
  | "answer"
  | "error";

export interface StepEvent {
  type: StepEventType;
  at: string;
  summary: string;
  usage?: TokenUsage;
}

export interface QuestionOption {
  id: string;
  label: string;
}

export interface Question {
  prompt: string;
  options: QuestionOption[];
}

export interface Answer {
  text: string;
  optionId?: string;
}

/**
 * Callbacks from the runner to the caller.
 * `ask` is only provided for interactive nodes. Premises P3 and P6.
 */
export interface StepCallbacks {
  onEvent(event: StepEvent): void;
  ask?(question: Question): Promise<Answer>;
}

export interface StepContext {
  outputDir: string;
  workDir: string;
  signal: AbortSignal;
  callbacks: StepCallbacks;
  /** Test seam for AC-16. Real runs omit this and load one provider from pi auth. */
  providerSecret?: string;
}

export interface StepResult {
  status: NodeStatus;
  outputs: Record<string, string>;
  usage: TokenUsage;
  error?: string;
}

/**
 * Isolated node runner. All pi calls stay behind this interface. Premise P2
 * is implemented by injecting SKILL.md rather than pi skill discovery.
 */
export interface StepRunner {
  runAgent(
    definition: AgentNodeDefinition,
    context: StepContext,
  ): Promise<StepResult>;
  runCommand(
    definition: CommandNodeDefinition,
    context: StepContext,
  ): Promise<StepResult>;
  /**
   * Send another instruction on the same session after the node ends.
   * Premise P5.
   */
  continueAgent(instruction: string, context: StepContext): Promise<StepResult>;
  /** Release sessions retained for possible continuation. The caller must close the runner. */
  dispose(): Promise<void>;
}
