import type {
  DurableRunState,
  InboxResponse,
  LoginSessionState,
  PlatformSettings,
  RecordedInteraction,
  RunPreviewResult,
  RunSetupValidation,
  SkillInfo,
  WorkflowDefinition,
  WorkflowLibraryItem,
} from "./types.ts";

export async function apiRequest<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      errorBody.error ?? `API error ${res.status}: ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  // Health
  getHealth: () => apiRequest<{ status: string }>("/api/health"),

  // Workflows
  listWorkflows: () => apiRequest<WorkflowLibraryItem[]>("/api/workflows"),
  getWorkflow: (id: string) =>
    apiRequest<{ id: string; yaml: string; updatedAt: string }>(
      `/api/workflows/${encodeURIComponent(id)}`,
    ),
  saveWorkflow: (
    idOrOptions:
      | string
      | {
          id: string;
          yaml?: string;
          updatedObject?: Record<string, unknown>;
          expectedYaml?: string;
          layout?: Record<
            string,
            {
              x: number;
              y: number;
              width?: number;
              height?: number;
              collapsed?: boolean;
            }
          >;
        },
    maybeYaml?: string,
  ) => {
    if (typeof idOrOptions === "string") {
      return apiRequest<{ id: string; yaml: string; path: string }>(
        "/api/workflows",
        {
          method: "POST",
          body: JSON.stringify({ id: idOrOptions, yaml: maybeYaml }),
        },
      );
    }
    return apiRequest<{ id: string; yaml: string; path: string }>(
      "/api/workflows",
      {
        method: "POST",
        body: JSON.stringify(idOrOptions),
      },
    );
  },
  getWorkflowLayout: (id: string) =>
    apiRequest<{
      version: number;
      current: Record<
        string,
        {
          x: number;
          y: number;
          width?: number;
          height?: number;
          collapsed?: boolean;
        }
      >;
    }>(`/api/workflows/${encodeURIComponent(id)}/layout`),
  saveWorkflowLayout: (
    id: string,
    layout: Record<
      string,
      {
        x: number;
        y: number;
        width?: number;
        height?: number;
        collapsed?: boolean;
      }
    >,
  ) =>
    apiRequest<{ version: number }>(
      `/api/workflows/${encodeURIComponent(id)}/layout`,
      {
        method: "PUT",
        body: JSON.stringify({ layout }),
      },
    ),
  deleteWorkflow: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/workflows/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // Settings & Skills
  getSettings: () => apiRequest<PlatformSettings>("/api/settings"),
  saveSettings: (settings: PlatformSettings) =>
    apiRequest<PlatformSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  listSkills: () => apiRequest<SkillInfo[]>("/api/skills"),

  // Auth
  listProviders: () =>
    apiRequest<
      Array<{
        providerId: string;
        type: "oauth" | "api_key";
        configured: boolean;
      }>
    >("/api/auth/providers"),
  startLogin: (provider: string, authType: "oauth" | "api_key" = "oauth") =>
    apiRequest<LoginSessionState>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ provider, authType }),
    }),
  getLoginSession: (loginId: string) =>
    apiRequest<LoginSessionState>(
      `/api/auth/login/${encodeURIComponent(loginId)}`,
    ),
  respondLogin: (loginId: string, response: string) =>
    apiRequest<LoginSessionState>(
      `/api/auth/login/${encodeURIComponent(loginId)}/respond`,
      {
        method: "POST",
        body: JSON.stringify({ response }),
      },
    ),
  cancelLogin: (loginId: string) =>
    apiRequest<LoginSessionState>(
      `/api/auth/login/${encodeURIComponent(loginId)}/cancel`,
      {
        method: "POST",
      },
    ),
  setApiKey: (provider: string, key: string) =>
    apiRequest<{ ok: boolean; providerId: string }>("/api/auth/api-key", {
      method: "POST",
      body: JSON.stringify({ provider, key }),
    }),
  logout: (provider: string) =>
    apiRequest<{ ok: boolean; providerId: string }>("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({ provider }),
    }),

  // Runs
  listRuns: () => apiRequest<DurableRunState[]>("/api/runs"),
  getRun: (runId: string) =>
    apiRequest<DurableRunState>(`/api/runs/${encodeURIComponent(runId)}`),
  validateRunSetup: (data: {
    targetRepo?: string;
    workflowId?: string;
    workflowYaml?: string;
    inputs?: Record<string, string>;
  }) =>
    apiRequest<RunSetupValidation>("/api/runs/validate", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  startRun: (data: {
    targetRepo: string;
    inputs: Record<string, string>;
    workflowId?: string;
    workflowYaml?: string;
    budgetUsd?: number;
  }) =>
    apiRequest<{ runId: string; state: DurableRunState; warnings: string[] }>(
      "/api/runs",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),
  stopRun: (runId: string) =>
    apiRequest<{ ok: boolean; runId: string }>(
      `/api/runs/${encodeURIComponent(runId)}/stop`,
      {
        method: "POST",
      },
    ),
  resumeRun: (runId: string, options?: { newBudgetUsd?: number }) =>
    apiRequest<{ runId: string; state: DurableRunState }>(
      `/api/runs/${encodeURIComponent(runId)}/resume`,
      {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      },
    ),
  getRunDefinition: (runId: string) =>
    apiRequest<WorkflowDefinition>(
      `/api/runs/${encodeURIComponent(runId)}/definition`,
    ),
  getRunEvents: (runId: string) =>
    apiRequest<unknown[]>(`/api/runs/${encodeURIComponent(runId)}/events`),
  getRunInteractions: (runId: string) =>
    apiRequest<RecordedInteraction[]>(
      `/api/runs/${encodeURIComponent(runId)}/interactions`,
    ),
  getRunPreview: (
    runId: string,
    params: {
      nodePath: string;
      kind: "diff" | "output" | "task";
      fileName?: string;
    },
  ) => {
    const q = new URLSearchParams({
      nodePath: params.nodePath,
      kind: params.kind,
      ...(params.fileName ? { fileName: params.fileName } : {}),
    });
    return apiRequest<RunPreviewResult>(
      `/api/runs/${encodeURIComponent(runId)}/preview?${q.toString()}`,
    );
  },
  answerQuestion: (
    runId: string,
    nodePath: string,
    answer: { text: string; optionId?: string; secret?: boolean },
  ) =>
    apiRequest<{ ok: boolean; runId: string; nodePath: string }>(
      `/api/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(nodePath)}`,
      {
        method: "POST",
        body: JSON.stringify(answer),
      },
    ),
  handleApproval: (
    runId: string,
    nodePath: string,
    decision: { approved: boolean; feedback?: string },
  ) =>
    apiRequest<{
      ok: boolean;
      runId: string;
      nodePath: string;
      approved: boolean;
    }>(
      `/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(nodePath)}`,
      {
        method: "POST",
        body: JSON.stringify(decision),
      },
    ),
  getInbox: () => apiRequest<InboxResponse>("/api/inbox"),
};
