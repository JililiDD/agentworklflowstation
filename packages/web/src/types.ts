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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface StepEvent {
  type: "model" | "tool" | "retry" | "question" | "answer" | "error";
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
  secret?: boolean;
}

export interface DurableRunNodeRecord {
  state: NodeState;
  result?: {
    status: "succeeded" | "failed";
    outputs: Record<string, string>;
    usage: TokenUsage;
    error?: string;
  };
  checkpointCommit?: string;
  diffPath?: string;
}

export interface DurableRunState {
  runId: string;
  repoDir: string;
  worktreeDir: string;
  branch: string;
  headCommit: string;
  lastCheckpointCommit?: string;
  status: WorkflowStatus;
  budgetUsd?: number;
  totalUsage: TokenUsage;
  nodes: Record<string, DurableRunNodeRecord>;
  events: Array<{ path: string; state: NodeState }>;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowLibraryItem {
  id: string;
  name?: string;
  path: string;
  updatedAt: string;
  valid: boolean;
  error?: string;
  inputs?: string[];
  nodeCount?: number;
  budgetUsd?: number;
  maxParallel?: number;
}

export interface Condition {
  ref: string;
  equals: unknown;
}

export interface AgentNodeDef {
  model: string;
  thinkingLevel: string;
  skillSourceDir?: string;
  skillNames?: string[];
  task: string;
  instructions?: string;
  interactive: boolean;
  outputs: string[];
}

export interface CommandNodeDef {
  command: string;
  allowNonZeroExit: boolean;
}

export interface WorkflowNodeItem {
  id: string;
  kind: "agent" | "command" | "group" | "foreach";
  dependsOn?: string[];
  when?: Condition[];
  approval?: boolean;
  writable?: boolean;
  definition?: AgentNodeDef | CommandNodeDef;
  nodes?: WorkflowNodeItem[];
  until?: Condition;
  maxRounds?: number;
  onExhausted?: "fail" | "approve";
  source?: string;
}

export interface WorkflowDefinition {
  name?: string;
  inputs: string[];
  maxParallel: number;
  budgetUsd?: number;
  nodes: WorkflowNodeItem[];
}

export interface PendingQuestionInfo {
  runId: string;
  nodePath: string;
  question: Question;
  createdAt: string;
}

export interface PendingApprovalInfo {
  runId: string;
  nodePath: string;
  request: { path: string; reason: string; outputs: Record<string, string> };
  createdAt: string;
}

export interface InboxResponse {
  questions: PendingQuestionInfo[];
  approvals: PendingApprovalInfo[];
}

export interface RecordedInteraction {
  id: string;
  type: "question" | "approval";
  nodePath: string;
  createdAt: string;
  question?: Question;
  approvalRequest?: {
    path: string;
    reason: string;
    outputs: Record<string, string>;
  };
  answeredAt?: string;
  answer?: {
    text: string;
    optionId?: string;
    isSecret?: boolean;
  };
  approvalDecision?: {
    approved: boolean;
    feedback?: string;
  };
}

export interface RunPreviewResult {
  content: string;
  truncated: boolean;
  size: number;
  fileName?: string;
  kind: "diff" | "output" | "task";
}

export interface RunSetupValidation {
  valid: boolean;
  warnings: string[];
  errors: string[];
  missingInputs: string[];
  workflow?: WorkflowDefinition;
}

export interface PlatformSettings {
  skillDirectories: string[];
}

export interface SkillInfo {
  name: string;
  directory: string;
  sourceDir: string;
  description?: string;
}

export interface CredentialMetadata {
  providerId: string;
  type: "oauth" | "api_key";
  configured: boolean;
}

export interface LoginPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export interface LoginEvent {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
}

export interface LoginSessionState {
  loginId: string;
  provider: string;
  authType: "oauth" | "api_key";
  status:
    | "pending"
    | "waiting_user_input"
    | "completed"
    | "failed"
    | "cancelled";
  currentPrompt?: LoginPrompt;
  events: LoginEvent[];
  error?: string;
  createdAt: string;
  completedAt?: string;
}
