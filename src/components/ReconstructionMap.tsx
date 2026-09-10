import { useEffect, useMemo, useRef } from 'react'
import { Background, Controls, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow, type Edge, type Node } from '@xyflow/react'
import { MindNode } from './MindNode'
import type { MindNodeData, TeamMember } from '../types/mindMap'
import { computeProgressRollups } from '../utils/progressRollup.mjs'
import { isSameDoorayKnowledgeUrl, normalizedDoorayKnowledgeUrl } from '../utils/externalLinks'
import type { LayoutMeasurement } from '../utils/mindMapLayout.mjs'
import './ReconstructionMap.css'

export type ReconstructionPreviewMap = { id: string; title: string; nodes: Node<MindNodeData>[]; edges: Edge[] }
const nodeTypes = { mind: MindNode }

function MeasuredMap({ map, members, onMeasured, onError }: {
  map: ReconstructionPreviewMap; members: TeamMember[]
  onMeasured: (measurements: LayoutMeasurement[]) => void; onError: (message: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  // 미리보기는 모든 노드를 표시하고 렌더러가 측정한 dimensions 변경만 로컬 상태로 수신한다.
  const initialized = useNodesInitialized()
  const flow = useReactFlow()
  const preparedNodes = useMemo(() => {
    const rollups = new Map(computeProgressRollups(map.nodes, map.edges).map((item) => [item.nodeId, item]))
    return map.nodes.map((node) => {
      const rollup = rollups.get(node.id)
      const external = node.data.externalLink && isSameDoorayKnowledgeUrl(node.data.externalLink.url, normalizedDoorayKnowledgeUrl(node.data.taskUrl ?? '') ?? '') ? node.data.externalLink : undefined
      return { ...node, hidden: false, draggable: false, selectable: false, connectable: false,
        style: external ? { width: external.displayWidth, height: external.displayHeight } : undefined,
        data: { ...node.data, externalLink: external, externalLinkEditable: false, collapsed: false,
          hasChildren: map.edges.some((edge) => edge.source === node.id && edge.data?.relation !== 'knowledge'),
          assignee: members.find((member) => member.id === node.data.assigneeId),
          unresolvedDependencyCount: (node.data.blockedBy ?? []).filter((id) => (map.nodes.find((card) => card.id === id)?.data.progress ?? 0) < 100).length,
          ...(rollup ? { progress: rollup.progress, status: rollup.status, progressRollupTargetCount: rollup.targetCount } : {}),
        } }
    })
  }, [map, members])
  const [nodes, setNodes, onNodesChange] = useNodesState(preparedNodes)
  useEffect(() => { setNodes(preparedNodes) }, [preparedNodes, setNodes])
  useEffect(() => {
    if (!initialized || !container.current) return
    let stopped = false; let timer: ReturnType<typeof setTimeout>
    const measure = async () => {
      await document.fonts.ready
      if (stopped) return
      try {
        const zoom = flow.getViewport().zoom
        const elements = [...(container.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])]
        if (elements.length !== map.nodes.length) throw new Error('모든 카드를 렌더링하지 못했습니다.')
        const measured = elements.map((element) => {
          const cardId = element.getAttribute('data-id') ?? ''
          const body = element.querySelector<HTMLElement>('.mind-node')
          if (!body) throw new Error('크기를 확인할 수 없는 카드가 있습니다.')
          const rect = body.getBoundingClientRect()
          const origin = flow.screenToFlowPosition({ x: rect.left, y: rect.top }, { snapToGrid: false })
          const occupied = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
          for (const child of body.querySelectorAll<HTMLElement>('*')) {
            const style = getComputedStyle(child)
            if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0 || child.classList.contains('react-flow__handle')) continue
            const bounds = child.getBoundingClientRect()
            if (bounds.width <= 0 || bounds.height <= 0) continue
            occupied.left = Math.min(occupied.left, bounds.left); occupied.top = Math.min(occupied.top, bounds.top)
            occupied.right = Math.max(occupied.right, bounds.right); occupied.bottom = Math.max(occupied.bottom, bounds.bottom)
          }
          // 그림자·말풍선 꼬리·접기 버튼 hover 확대까지 여유를 둔다.
          return { cardId, ...origin, width: rect.width / zoom, height: rect.height / zoom,
            outsets: { left: Math.max(0, (rect.left - occupied.left) / zoom) + 8, top: Math.max(0, (rect.top - occupied.top) / zoom) + 8,
              right: Math.max(0, (occupied.right - rect.right) / zoom) + 8, bottom: Math.max(0, (occupied.bottom - rect.bottom) / zoom) + 8 } }
        })
        onMeasured(measured)
      } catch (error) { onError(error instanceof Error ? error.message : '카드 크기를 검사하지 못했습니다.') }
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void measure() }, 150) }
    const observer = new ResizeObserver(schedule)
    container.current.querySelectorAll('.mind-node, .node-waiting, .node-collapse-toggle').forEach((node) => observer.observe(node))
    schedule()
    return () => { stopped = true; clearTimeout(timer); observer.disconnect() }
  }, [flow, initialized, map, onError, onMeasured])
  return <div className="reconstruction-map" ref={container} data-map-id={map.id} aria-label={`${map.title} 배치 미리보기`}>
    <ReactFlow nodes={nodes} onNodesChange={onNodesChange} edges={map.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null} onlyRenderVisibleElements={false} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.02} maxZoom={2} preventScrolling={false}>
      <Background /><Controls showInteractive={false} />
    </ReactFlow>
  </div>
}

export function ReconstructionMap(props: Parameters<typeof MeasuredMap>[0]) {
  return <ReactFlowProvider><MeasuredMap {...props} /></ReactFlowProvider>
}
