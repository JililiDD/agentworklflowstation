export interface EditorCondition {
  ref: string;
  equals: unknown;
}

export interface EditorAgentNode {
  id: string;
  kind: "agent";
  dependsOn: string[];
  when?: EditorCondition[];
  approval?: boolean;
  writable?: boolean;
  model: string;
  thinkingLevel?: string;
  thinking?: string;
  task: string;
  instructions?: string;
  interactive?: boolean;
  skillNames?: string[];
  skillSourceDir?: string;
  outputs?: string[];
  schemas?: Record<string, Record<string, unknown>>;
}

export interface EditorCommandNode {
  id: string;
  kind: "command";
  dependsOn: string[];
  when?: EditorCondition[];
  approval?: boolean;
  writable?: boolean;
  command: string;
  allowNonZeroExit?: boolean;
}

export interface EditorGroupNode {
  id: string;
  kind: "group";
  dependsOn: string[];
  when?: EditorCondition[];
  approval?: boolean;
  writable?: boolean;
  until: EditorCondition;
  maxRounds: number;
  onExhausted: "fail" | "approve";
  nodes: EditorNode[];
}

export interface EditorForeachNode {
  id: string;
  kind: "foreach";
  dependsOn: string[];
  when?: EditorCondition[];
  approval?: boolean;
  writable?: boolean;
  source: string;
  nodes: EditorNode[];
}

export type EditorNode =
  | EditorAgentNode
  | EditorCommandNode
  | EditorGroupNode
  | EditorForeachNode;

export interface EditorWorkflowDraft {
  name?: string;
  inputs: string[];
  maxParallel: number;
  budgetUsd?: number;
  nodes: EditorNode[];
}

export interface DraftParseResult {
  draft: EditorWorkflowDraft;
  unsupportedFields: string[];
  valid: boolean;
}

export function createDefaultAgentNode(id: string): EditorAgentNode {
  return {
    id,
    kind: "agent",
    dependsOn: [],
    model: "claude-sonnet-4-5",
    thinkingLevel: "off",
    task: "",
    writable: false,
    interactive: false,
    skillNames: [],
    outputs: [],
  };
}

export function createDefaultCommandNode(id: string): EditorCommandNode {
  return {
    id,
    kind: "command",
    dependsOn: [],
    command: "",
    writable: false,
    allowNonZeroExit: false,
  };
}

export function createDefaultGroupNode(id: string): EditorGroupNode {
  return {
    id,
    kind: "group",
    dependsOn: [],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
    until: { ref: "${nodes.child.manifest.json#/ok}", equals: true },
    maxRounds: 3,
    onExhausted: "fail",
    nodes: [],
  };
}

export function createDefaultForeachNode(id: string): EditorForeachNode {
  return {
    id,
    kind: "foreach",
    dependsOn: [],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
    source: "${nodes.upstream.manifest.json}",
    nodes: [],
  };
}

const KNOWN_WORKFLOW_KEYS = new Set([
  "name",
  "inputs",
  "maxParallel",
  "budgetUsd",
  "nodes",
]);
const KNOWN_COMMON_NODE_KEYS = new Set([
  "id",
  "kind",
  "dependsOn",
  "when",
  "approval",
  "writable",
]);
const KNOWN_AGENT_KEYS = new Set([
  ...KNOWN_COMMON_NODE_KEYS,
  "definition",
  "schemas",
]);
const KNOWN_AGENT_DEF_KEYS = new Set([
  "kind",
  "model",
  "thinking",
  "thinkingLevel",
  "task",
  "instructions",
  "interactive",
  "skillNames",
  "skillSourceDir",
  "outputs",
]);
const KNOWN_COMMAND_KEYS = new Set([...KNOWN_COMMON_NODE_KEYS, "definition"]);
const KNOWN_COMMAND_DEF_KEYS = new Set(["kind", "command", "allowNonZeroExit"]);
const KNOWN_GROUP_KEYS = new Set([
  ...KNOWN_COMMON_NODE_KEYS,
  "until",
  "maxRounds",
  "onExhausted",
  "nodes",
]);
const KNOWN_FOREACH_KEYS = new Set([
  ...KNOWN_COMMON_NODE_KEYS,
  "source",
  "nodes",
]);

export function parseDraftFromObject(raw: unknown): DraftParseResult {
  const unsupportedFields: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      draft: { inputs: [], maxParallel: 1, nodes: [] },
      unsupportedFields: ["workflow must be an object"],
      valid: false,
    };
  }

  const rootRecord = raw as Record<string, unknown>;
  for (const key of Object.keys(rootRecord)) {
    if (!KNOWN_WORKFLOW_KEYS.has(key)) {
      unsupportedFields.push(`workflow.${key}`);
    }
  }

  const name =
    typeof rootRecord.name === "string" ? rootRecord.name : undefined;
  const inputs = Array.isArray(rootRecord.inputs)
    ? (rootRecord.inputs.filter((i) => typeof i === "string") as string[])
    : [];
  const maxParallel =
    typeof rootRecord.maxParallel === "number" && rootRecord.maxParallel >= 1
      ? rootRecord.maxParallel
      : 1;
  const budgetUsd =
    typeof rootRecord.budgetUsd === "number" ? rootRecord.budgetUsd : undefined;

  function parseCondition(cRaw: unknown, path: string): EditorCondition {
    if (typeof cRaw !== "object" || cRaw === null || Array.isArray(cRaw)) {
      unsupportedFields.push(path);
      return { ref: "", equals: null };
    }
    const c = cRaw as Record<string, unknown>;
    for (const k of Object.keys(c)) {
      if (k !== "ref" && k !== "equals") {
        unsupportedFields.push(`${path}.${k}`);
      }
    }
    return {
      ref: typeof c.ref === "string" ? c.ref : "",
      equals: c.equals,
    };
  }

  function parseConditions(
    arrRaw: unknown,
    path: string,
  ): EditorCondition[] | undefined {
    if (arrRaw === undefined) return undefined;
    if (!Array.isArray(arrRaw)) {
      unsupportedFields.push(path);
      return undefined;
    }
    return arrRaw.map((item, idx) => parseCondition(item, `${path}[${idx}]`));
  }

  function parseNode(nodeRaw: unknown, path: string): EditorNode {
    if (
      typeof nodeRaw !== "object" ||
      nodeRaw === null ||
      Array.isArray(nodeRaw)
    ) {
      unsupportedFields.push(path);
      return createDefaultAgentNode("invalid");
    }
    const n = nodeRaw as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id : "unnamed";
    const kind = String(n.kind);
    const dependsOn = Array.isArray(n.dependsOn)
      ? (n.dependsOn.filter((d) => typeof d === "string") as string[])
      : [];
    const when = parseConditions(n.when, `${path}.when`);
    const approval = typeof n.approval === "boolean" ? n.approval : undefined;
    const writable = typeof n.writable === "boolean" ? n.writable : undefined;

    if (kind === "agent") {
      for (const k of Object.keys(n)) {
        if (!KNOWN_AGENT_KEYS.has(k)) unsupportedFields.push(`${path}.${k}`);
      }
      const defRaw =
        typeof n.definition === "object" &&
        n.definition !== null &&
        !Array.isArray(n.definition)
          ? (n.definition as Record<string, unknown>)
          : {};
      for (const k of Object.keys(defRaw)) {
        if (!KNOWN_AGENT_DEF_KEYS.has(k))
          unsupportedFields.push(`${path}.definition.${k}`);
      }

      const schemasRaw =
        typeof n.schemas === "object" &&
        n.schemas !== null &&
        !Array.isArray(n.schemas)
          ? (n.schemas as Record<string, unknown>)
          : undefined;
      const schemas: Record<string, Record<string, unknown>> = {};
      if (schemasRaw) {
        for (const [sKey, sVal] of Object.entries(schemasRaw)) {
          if (
            typeof sVal === "object" &&
            sVal !== null &&
            !Array.isArray(sVal)
          ) {
            schemas[sKey] = sVal as Record<string, unknown>;
          } else {
            unsupportedFields.push(`${path}.schemas.${sKey}`);
          }
        }
      }

      return {
        id,
        kind: "agent",
        dependsOn,
        when,
        approval,
        writable,
        model: typeof defRaw.model === "string" ? defRaw.model : "",
        thinkingLevel:
          typeof defRaw.thinkingLevel === "string"
            ? defRaw.thinkingLevel
            : typeof defRaw.thinking === "string"
              ? defRaw.thinking
              : "off",
        task: typeof defRaw.task === "string" ? defRaw.task : "",
        instructions:
          typeof defRaw.instructions === "string"
            ? defRaw.instructions
            : undefined,
        interactive:
          typeof defRaw.interactive === "boolean"
            ? defRaw.interactive
            : undefined,
        skillNames: Array.isArray(defRaw.skillNames)
          ? (defRaw.skillNames.filter((s) => typeof s === "string") as string[])
          : [],
        skillSourceDir:
          typeof defRaw.skillSourceDir === "string"
            ? defRaw.skillSourceDir
            : undefined,
        outputs: Array.isArray(defRaw.outputs)
          ? (defRaw.outputs.filter((o) => typeof o === "string") as string[])
          : [],
        schemas: Object.keys(schemas).length > 0 ? schemas : undefined,
      };
    }

    if (kind === "command") {
      for (const k of Object.keys(n)) {
        if (!KNOWN_COMMAND_KEYS.has(k)) unsupportedFields.push(`${path}.${k}`);
      }
      const defRaw =
        typeof n.definition === "object" &&
        n.definition !== null &&
        !Array.isArray(n.definition)
          ? (n.definition as Record<string, unknown>)
          : {};
      for (const k of Object.keys(defRaw)) {
        if (!KNOWN_COMMAND_DEF_KEYS.has(k))
          unsupportedFields.push(`${path}.definition.${k}`);
      }

      return {
        id,
        kind: "command",
        dependsOn,
        when,
        approval,
        writable,
        command: typeof defRaw.command === "string" ? defRaw.command : "",
        allowNonZeroExit:
          typeof defRaw.allowNonZeroExit === "boolean"
            ? defRaw.allowNonZeroExit
            : undefined,
      };
    }

    if (kind === "group") {
      for (const k of Object.keys(n)) {
        if (!KNOWN_GROUP_KEYS.has(k)) unsupportedFields.push(`${path}.${k}`);
      }
      const until = parseCondition(n.until, `${path}.until`);
      const maxRounds =
        typeof n.maxRounds === "number" && n.maxRounds >= 1 ? n.maxRounds : 1;
      const onExhausted = n.onExhausted === "approve" ? "approve" : "fail";
      const childNodes = Array.isArray(n.nodes)
        ? n.nodes.map((c, idx) => parseNode(c, `${path}.nodes[${idx}]`))
        : [];

      return {
        id,
        kind: "group",
        dependsOn,
        when,
        approval,
        writable,
        until,
        maxRounds,
        onExhausted,
        nodes: childNodes,
      };
    }

    if (kind === "foreach") {
      for (const k of Object.keys(n)) {
        if (!KNOWN_FOREACH_KEYS.has(k)) unsupportedFields.push(`${path}.${k}`);
      }
      const source = typeof n.source === "string" ? n.source : "";
      const childNodes = Array.isArray(n.nodes)
        ? n.nodes.map((c, idx) => parseNode(c, `${path}.nodes[${idx}]`))
        : [];

      return {
        id,
        kind: "foreach",
        dependsOn,
        when,
        approval,
        writable,
        source,
        nodes: childNodes,
      };
    }

    unsupportedFields.push(`${path}.unknownKind(${kind})`);
    return createDefaultAgentNode(id);
  }

  const nodes = Array.isArray(rootRecord.nodes)
    ? rootRecord.nodes.map((item, idx) => parseNode(item, `nodes[${idx}]`))
    : [];

  return {
    draft: {
      name,
      inputs,
      maxParallel,
      budgetUsd,
      nodes,
    },
    unsupportedFields,
    valid: unsupportedFields.length === 0,
  };
}

export function draftToPlainObject(
  draft: EditorWorkflowDraft,
): Record<string, unknown> {
  function serializeNode(n: EditorNode): Record<string, unknown> {
    const common: Record<string, unknown> = {
      id: n.id,
      kind: n.kind,
    };
    if (n.dependsOn.length > 0) {
      common.dependsOn = [...n.dependsOn];
    }
    if (n.when && n.when.length > 0) {
      common.when = n.when.map((w) => ({ ref: w.ref, equals: w.equals }));
    }
    if (n.approval !== undefined) {
      common.approval = n.approval;
    }
    if (n.writable !== undefined) {
      common.writable = n.writable;
    }

    if (n.kind === "agent") {
      const def: Record<string, unknown> = {
        kind: "agent",
        model: n.model,
        thinkingLevel: n.thinkingLevel || n.thinking || "off",
        task: n.task,
      };
      if (n.instructions) def.instructions = n.instructions;
      if (n.interactive !== undefined) def.interactive = n.interactive;
      if (n.skillNames && n.skillNames.length > 0) {
        def.skillNames = [...n.skillNames];
      }
      if (n.skillSourceDir) {
        def.skillSourceDir = n.skillSourceDir;
      }
      if (n.outputs && n.outputs.length > 0) {
        def.outputs = [...n.outputs];
      }
      common.definition = def;
      if (n.schemas && Object.keys(n.schemas).length > 0) {
        common.schemas = { ...n.schemas };
      }
      return common;
    }

    if (n.kind === "command") {
      const def: Record<string, unknown> = {
        kind: "command",
        command: n.command,
      };
      if (n.allowNonZeroExit !== undefined) {
        def.allowNonZeroExit = n.allowNonZeroExit;
      }
      common.definition = def;
      return common;
    }

    if (n.kind === "group") {
      common.until = { ref: n.until.ref, equals: n.until.equals };
      common.maxRounds = n.maxRounds;
      common.onExhausted = n.onExhausted;
      common.nodes = n.nodes.map(serializeNode);
      return common;
    }

    if (n.kind === "foreach") {
      common.source = n.source;
      common.nodes = n.nodes.map(serializeNode);
      return common;
    }

    return common;
  }

  const root: Record<string, unknown> = {
    inputs: [...draft.inputs],
    maxParallel: draft.maxParallel,
  };
  if (draft.name) {
    root.name = draft.name;
  }
  if (draft.budgetUsd !== undefined) {
    root.budgetUsd = draft.budgetUsd;
  }
  root.nodes = draft.nodes.map(serializeNode);
  return root;
}

export function duplicateSubtree(
  nodes: EditorNode[],
  existingIds: Set<string>,
): { newNodes: EditorNode[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();

  function collectIds(list: EditorNode[]): void {
    for (const node of list) {
      const base = `${node.id}_copy`;
      let candidate = base;
      let counter = 1;
      while (existingIds.has(candidate) || idMap.has(candidate)) {
        candidate = `${base}_${counter++}`;
      }
      idMap.set(node.id, candidate);
      if (node.kind === "group" || node.kind === "foreach") {
        collectIds(node.nodes);
      }
    }
  }

  collectIds(nodes);

  function remapRef(ref: string): string {
    let result = ref;
    for (const [oldId, newId] of idMap.entries()) {
      // remap ${nodes.oldId...} -> ${nodes.newId...}
      result = result.replaceAll(`nodes.${oldId}.`, `nodes.${newId}.`);
    }
    return result;
  }

  function cloneNode(node: EditorNode): EditorNode {
    const newId = idMap.get(node.id) ?? `${node.id}_copy`;
    const newDependsOn = node.dependsOn.map((dep) => idMap.get(dep) ?? dep);
    const newWhen = node.when?.map((w) => ({
      ref: remapRef(w.ref),
      equals: w.equals,
    }));

    if (node.kind === "agent") {
      return {
        ...node,
        id: newId,
        dependsOn: newDependsOn,
        when: newWhen,
        task: remapRef(node.task),
        instructions: node.instructions
          ? remapRef(node.instructions)
          : undefined,
        skillNames: node.skillNames ? [...node.skillNames] : [],
        skillSourceDir: node.skillSourceDir,
        outputs: node.outputs ? [...node.outputs] : [],
        schemas: node.schemas
          ? JSON.parse(JSON.stringify(node.schemas))
          : undefined,
      };
    }

    if (node.kind === "command") {
      return {
        ...node,
        id: newId,
        dependsOn: newDependsOn,
        when: newWhen,
        command: remapRef(node.command),
      };
    }

    if (node.kind === "group") {
      return {
        ...node,
        id: newId,
        dependsOn: newDependsOn,
        when: newWhen,
        until: {
          ref: remapRef(node.until.ref),
          equals: node.until.equals,
        },
        nodes: node.nodes.map(cloneNode),
      };
    }

    if (node.kind === "foreach") {
      return {
        ...node,
        id: newId,
        dependsOn: newDependsOn,
        when: newWhen,
        source: remapRef(node.source),
        nodes: node.nodes.map(cloneNode),
      };
    }

    const unreachable: never = node;
    throw new Error(
      `unsupported node kind in duplicateSubtree: ${String((unreachable as EditorNode).kind)}`,
    );
  }

  const newNodes = nodes.map(cloneNode);
  return { newNodes, idMap };
}

export function renameNodeInDraft(
  draft: EditorWorkflowDraft,
  oldId: string,
  newId: string,
): EditorWorkflowDraft {
  function renameInList(list: EditorNode[]): EditorNode[] {
    return list.map((n) => {
      const nextId = n.id === oldId ? newId : n.id;
      const nextDeps = n.dependsOn.map((d) => (d === oldId ? newId : d));
      if (n.kind === "group" || n.kind === "foreach") {
        return {
          ...n,
          id: nextId,
          dependsOn: nextDeps,
          nodes: renameInList(n.nodes),
        };
      }
      return {
        ...n,
        id: nextId,
        dependsOn: nextDeps,
      };
    });
  }
  return {
    ...draft,
    nodes: renameInList(draft.nodes),
  };
}
