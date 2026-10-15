import type {
  AgentNodeDefinition,
  Answer,
  CommandNodeDefinition,
  Question,
  StepEvent,
  StepResult,
  ThinkingLevel,
  TokenUsage,
} from "@aipilotagent/runner";

export interface Condition {
  ref: string;
  equals: unknown;
}

interface CommonNode {
  id: string;
  dependsOn: string[];
  when?: Condition[];
  approval?: boolean;
  writable?: boolean;
}

export interface AgentWorkflowNode extends CommonNode {
  kind: "agent";
  definition: AgentNodeDefinition;
  schemas?: Record<string, Record<string, unknown>>;
}

export interface CommandWorkflowNode extends CommonNode {
  kind: "command";
  definition: CommandNodeDefinition;
}

export interface GroupWorkflowNode extends CommonNode {
  kind: "group";
  nodes: WorkflowNode[];
  until: Condition;
  maxRounds: number;
  onExhausted: "fail" | "approve";
}

export interface ForeachWorkflowNode extends CommonNode {
  kind: "foreach";
  source: string;
  nodes: WorkflowNode[];
}

export type WorkflowNode =
  | AgentWorkflowNode
  | CommandWorkflowNode
  | GroupWorkflowNode
  | ForeachWorkflowNode;

export interface WorkflowDefinition {
  inputs: string[];
  maxParallel: number;
  budgetUsd?: number;
  nodes: WorkflowNode[];
}

export interface WorkflowCapabilities {
  /** Every selectable provider/id and its supported levels. */
  models: Record<string, ThinkingLevel[]>;
}

export type WorkflowStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "budget_exceeded";
export type NodeState =
  | "pending"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "skipped"
  | "aborted";

export interface StateEvent {
  path: string;
  state: NodeState;
}

export interface WorkflowResult {
  status: WorkflowStatus;
  nodes: Record<string, { state: NodeState; result?: StepResult }>;
  events: StateEvent[];
}

export interface ApprovalRequest {
  path: string;
  reason: "node" | "group_exhausted";
  outputs: Record<string, string>;
}

export interface WorkflowCallbacks {
  onState?(event: StateEvent): void;
  onStepEvent?(path: string, event: StepEvent): void;
  ask?(path: string, question: Question): Promise<Answer>;
  approve?(
    request: ApprovalRequest,
  ): Promise<{ approved: true } | { approved: false; feedback: string }>;
}

export class WorkflowFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowFatalError";
  }
}

export interface WorkflowHooks {
  onNodeStart?(path: string, node: WorkflowNode): Promise<void>;
  onNodeResult?(
    path: string,
    node: WorkflowNode,
    result: StepResult,
  ): Promise<StepResult>;
  onStepUsage?(path: string, usage: TokenUsage): void;
}

export interface WorkflowContext {
  workDir: string;
  outputDir: string;
  inputs: Record<string, string>;
  signal: AbortSignal;
  callbacks?: WorkflowCallbacks;
  /** Supplied by the trusted host, never read from the workflow file. */
  providerSecrets?: Record<string, string>;
  hooks?: WorkflowHooks;
  resume?: {
    nodes: Record<string, { state: NodeState; result?: StepResult }>;
  };
  initialCost?: number;
}
