import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  type Node,
  ReactFlow,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from '@xyflow/react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Panel } from '../../../../ui/compositions/panel';
import type {
  AgentDirectoryItem,
  AgentWorkflowMap,
} from '../../agents-queries';
import {
  AgentWorkflowEmployeeNode,
  AgentWorkflowNode,
  WorkflowLabelNode,
} from './agent-workflow-node';
import { layoutWorkflow, WORKFLOW_WIDTH } from './workflow-map-layout';
import { workflowCards } from './workflow-map-model';
import type { AgentDetailTab, WorkflowNodeData } from './workflow-map-types';

const nodeTypes = {
  workflowNode: AgentWorkflowNode,
  workflowEmployee: AgentWorkflowEmployeeNode,
  workflowLabel: WorkflowLabelNode,
};

export function AgentWorkflowMapView({
  agent,
  map,
  onActivate,
}: {
  agent: AgentDirectoryItem;
  map: AgentWorkflowMap;
  onActivate: (tab: AgentDetailTab) => void;
}) {
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<Node<WorkflowNodeData>>>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
  const isFullscreen = nativeFullscreen || fallbackFullscreen;
  const layout = useMemo(
    () => layoutWorkflow(workflowCards(agent, map)),
    [agent, map],
  );
  const activate: NodeMouseHandler = (_, node) => {
    const targetTab = (node.data as WorkflowNodeData).targetTab;
    if (targetTab) onActivate(targetTab);
  };
  useEffect(() => {
    const syncFullscreen = () => {
      setNativeFullscreen(document.fullscreenElement === fullscreenRef.current);
      requestAnimationFrame(() =>
        flowRef.current?.fitView({ padding: 0.12, maxZoom: 1 }),
      );
    };
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () =>
      document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);
  useEffect(() => {
    if (!fallbackFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFallbackFullscreen(false);
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', exitOnEscape);
    requestAnimationFrame(() =>
      flowRef.current?.fitView({ padding: 0.12, maxZoom: 1 }),
    );
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', exitOnEscape);
      requestAnimationFrame(() =>
        flowRef.current?.fitView({ padding: 0.12, maxZoom: 1 }),
      );
    };
  }, [fallbackFullscreen]);
  const toggleFullscreen = async () => {
    if (fallbackFullscreen) {
      setFallbackFullscreen(false);
      return;
    }
    if (document.fullscreenElement === fullscreenRef.current) {
      await document.exitFullscreen();
      return;
    }
    try {
      await fullscreenRef.current?.requestFullscreen();
    } catch {
      setFallbackFullscreen(true);
    }
  };

  return (
    <div
      className="workflow-map-fullscreen"
      data-fullscreen={fallbackFullscreen ? 'fallback' : undefined}
      ref={fullscreenRef}
    >
      <Panel
        action={
          <span className="font-mono text-micro tracking-[0.04em] text-text-muted">
            what comes in · who decides · what it can reach
          </span>
        }
        className="workflow-map-panel"
        title="How the work flows"
      >
        <div
          className="workflow-map-canvas"
          style={{ height: Math.max(352, layout.height) }}
        >
          <ReactFlow
            aria-label={`Workflow map for ${agent.name}`}
            edges={layout.edges}
            elementsSelectable={false}
            fitView
            fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
            maxZoom={1.25}
            minZoom={0.45}
            nodeTypes={nodeTypes}
            nodes={layout.nodes}
            nodesConnectable={false}
            nodesDraggable={false}
            nodesFocusable={false}
            panOnDrag
            translateExtent={[
              [0, 0],
              [WORKFLOW_WIDTH, layout.height],
            ]}
            onInit={(instance) => {
              flowRef.current = instance;
            }}
            onNodeClick={activate}
          >
            <Background
              color="var(--border-strong)"
              gap={18}
              size={1}
              variant={BackgroundVariant.Dots}
            />
            <Controls
              orientation="horizontal"
              position="bottom-right"
              showInteractive={false}
            >
              <ControlButton
                aria-label={
                  isFullscreen
                    ? 'Exit diagram fullscreen'
                    : 'Open diagram fullscreen'
                }
                title={
                  isFullscreen
                    ? 'Exit diagram fullscreen'
                    : 'Open diagram fullscreen'
                }
                onClick={() => void toggleFullscreen()}
              >
                {isFullscreen ? <Minimize2 /> : <Maximize2 />}
              </ControlButton>
            </Controls>
          </ReactFlow>
        </div>
      </Panel>
    </div>
  );
}
