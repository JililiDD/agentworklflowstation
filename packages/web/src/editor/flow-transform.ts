import type { Edge, Node } from "@xyflow/react";
import type { EditorNode, EditorWorkflowDraft } from "./draft.ts";

export interface NodeLayoutItem {
  x: number;
  y: number;
  width?: number;
  height?: number;
  collapsed?: boolean;
}

export type LayoutMap = Record<string, NodeLayoutItem>;

export interface FlowTransformResult {
  nodes: Node[];
  edges: Edge[];
}

export function detectReferencedOutputs(
  downstreamTask: string,
  upstreamId: string,
): string[] {
  const pattern = new RegExp(`\\$\\{nodes\\.${upstreamId}\\.([^#\\}]+)`, "g");
  const matches = [...downstreamTask.matchAll(pattern)];
  const files = new Set<string>();
  for (const m of matches) {
    if (m[1]) files.add(m[1]);
  }
  return Array.from(files);
}

export function draftToFlowElements(
  draft: EditorWorkflowDraft,
  layoutMap: LayoutMap = {},
): FlowTransformResult {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Helper to compute automatic coordinates when layout missing
  let autoX = 40;
  let autoY = 40;

  function processNodeList(
    nodeList: EditorNode[],
    parentId?: string,
    depth = 0,
  ): void {
    const innerX = 30;
    let innerY = 60;

    for (const node of nodeList) {
      const savedLayout = layoutMap[node.id];
      const posX = savedLayout?.x ?? (parentId ? innerX : autoX);
      const posY = savedLayout?.y ?? (parentId ? innerY : autoY);
      const isCollapsed = savedLayout?.collapsed ?? false;

      if (!savedLayout) {
        if (parentId) {
          innerY += 150;
        } else {
          autoX += 300;
          if (autoX > 1200) {
            autoX = 40;
            autoY += 240;
          }
        }
      }

      if (node.kind === "group" || node.kind === "foreach") {
        // Group or Foreach container
        const defaultWidth = 380;
        const defaultHeight = isCollapsed
          ? 60
          : Math.max(260, node.nodes.length * 160 + 80);

        const containerNode: Node = {
          id: node.id,
          type: node.kind,
          position: { x: posX, y: posY },
          parentId,
          style: {
            width: savedLayout?.width ?? defaultWidth,
            height: savedLayout?.height ?? defaultHeight,
          },
          data: {
            node,
            collapsed: isCollapsed,
            depth,
          },
        };
        // In React Flow, parent node MUST be pushed before its children
        nodes.push(containerNode);

        // Process children if not collapsed
        if (!isCollapsed) {
          processNodeList(node.nodes, node.id, depth + 1);
        }
      } else {
        // Agent or Command card
        const cardNode: Node = {
          id: node.id,
          type: node.kind,
          position: { x: posX, y: posY },
          parentId,
          data: {
            node,
            depth,
          },
        };
        nodes.push(cardNode);
      }

      // Add edges from dependsOn
      for (const depId of node.dependsOn) {
        // Inspect if downstream task, instructions or command quotes an output of depId (D-16)
        let textToInspect = "";
        if (node.kind === "agent") {
          textToInspect = `${node.task} ${node.instructions ?? ""}`;
        } else if (node.kind === "command") {
          textToInspect = node.command;
        }
        const files = detectReferencedOutputs(textToInspect, depId);
        const label = files.length > 0 ? files.join(", ") : undefined;

        edges.push({
          id: `${depId}->${node.id}`,
          source: depId,
          target: node.id,
          label,
          type: "smoothstep",
          style: { stroke: "var(--ink)", strokeWidth: 1.5 },
        });
      }
    }
  }

  processNodeList(draft.nodes);
  return { nodes, edges };
}

export function flowNodesToLayoutMap(nodes: Node[]): LayoutMap {
  const map: LayoutMap = {};
  for (const n of nodes) {
    map[n.id] = {
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      width:
        n.measured?.width ??
        (typeof n.style?.width === "number" ? n.style.width : undefined),
      height:
        n.measured?.height ??
        (typeof n.style?.height === "number" ? n.style.height : undefined),
      collapsed: Boolean(n.data?.collapsed),
    };
  }
  return map;
}

export function updateDraftNodeHierarchy(
  draft: EditorWorkflowDraft,
  targetNodeId: string,
  newParentId: string | undefined,
): EditorWorkflowDraft {
  let targetNode: EditorNode | null = null;

  function removeNode(list: EditorNode[]): EditorNode[] {
    const result: EditorNode[] = [];
    for (const item of list) {
      if (item.id === targetNodeId) {
        targetNode = item;
      } else {
        if (item.kind === "group" || item.kind === "foreach") {
          result.push({
            ...item,
            nodes: removeNode(item.nodes),
          });
        } else {
          result.push(item);
        }
      }
    }
    return result;
  }

  const prunedNodes = removeNode(draft.nodes);
  if (!targetNode) return draft;

  const nodeToInsert: EditorNode = targetNode;

  if (!newParentId) {
    return {
      ...draft,
      nodes: [...prunedNodes, nodeToInsert],
    };
  }

  function insertNode(list: EditorNode[]): EditorNode[] {
    return list.map((item) => {
      if (item.id === newParentId) {
        if (item.kind === "group" || item.kind === "foreach") {
          return {
            ...item,
            nodes: [...item.nodes, nodeToInsert],
          };
        }
      }
      if (item.kind === "group" || item.kind === "foreach") {
        return {
          ...item,
          nodes: insertNode(item.nodes),
        };
      }
      return item;
    });
  }

  return {
    ...draft,
    nodes: insertNode(prunedNodes),
  };
}
