import { BaseEdge, getBezierPath, Position, type Edge, type EdgeProps } from '@xyflow/react'
import type { MindMapEdgeData } from '../types/mindMap'

type KnowledgeEdgeType = Edge<MindMapEdgeData, 'knowledge-parallel'>

type Point = { x: number; y: number }

function calculateControlOffset(distance: number, curvature = .25) {
  return distance >= 0 ? distance * .5 : curvature * 25 * Math.sqrt(-distance)
}

function controlPoint(position: Position, x1: number, y1: number, x2: number, y2: number): Point {
  if (position === Position.Left) return { x: x1 - calculateControlOffset(x1 - x2), y: y1 }
  if (position === Position.Right) return { x: x1 + calculateControlOffset(x2 - x1), y: y1 }
  if (position === Position.Top) return { x: x1, y: y1 - calculateControlOffset(y1 - y2) }
  return { x: x1, y: y1 + calculateControlOffset(y2 - y1) }
}

function cubicPoint(start: Point, firstControl: Point, secondControl: Point, end: Point, progress: number) {
  const remainder = 1 - progress
  const point = {
    x: remainder ** 3 * start.x
      + 3 * remainder ** 2 * progress * firstControl.x
      + 3 * remainder * progress ** 2 * secondControl.x
      + progress ** 3 * end.x,
    y: remainder ** 3 * start.y
      + 3 * remainder ** 2 * progress * firstControl.y
      + 3 * remainder * progress ** 2 * secondControl.y
      + progress ** 3 * end.y,
  }
  const tangent = {
    x: 3 * remainder ** 2 * (firstControl.x - start.x)
      + 6 * remainder * progress * (secondControl.x - firstControl.x)
      + 3 * progress ** 2 * (end.x - secondControl.x),
    y: 3 * remainder ** 2 * (firstControl.y - start.y)
      + 6 * remainder * progress * (secondControl.y - firstControl.y)
      + 3 * progress ** 2 * (end.y - secondControl.y),
  }
  return { point, tangent }
}

function smoothPathThrough(points: Point[]) {
  const commands = [`M ${points[0].x},${points[0].y}`]
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)]
    const current = points[index]
    const next = points[index + 1]
    const following = points[Math.min(points.length - 1, index + 2)]
    const firstControl = {
      x: current.x + (next.x - previous.x) / 6,
      y: current.y + (next.y - previous.y) / 6,
    }
    const secondControl = {
      x: next.x - (following.x - current.x) / 6,
      y: next.y - (following.y - current.y) / 6,
    }
    commands.push(`C ${firstControl.x},${firstControl.y} ${secondControl.x},${secondControl.y} ${next.x},${next.y}`)
  }
  return commands.join(' ')
}

function parallelBezierPath(
  sourceX: number,
  sourceY: number,
  sourcePosition: Position,
  targetX: number,
  targetY: number,
  targetPosition: Position,
  offset: number,
) {
  const start = { x: sourceX, y: sourceY }
  const end = { x: targetX, y: targetY }
  const firstControl = controlPoint(sourcePosition, sourceX, sourceY, targetX, targetY)
  const secondControl = controlPoint(targetPosition, targetX, targetY, sourceX, sourceY)
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const distance = Math.hypot(deltaX, deltaY) || 1
  let referenceNormalX = -deltaY / distance
  let referenceNormalY = deltaX / distance

  if (referenceNormalY > 0 || (Math.abs(referenceNormalY) < .001 && referenceNormalX > 0)) {
    referenceNormalX *= -1
    referenceNormalY *= -1
  }

  const points = Array.from({ length: 25 }, (_, index) => {
    const progress = index / 24
    const { point, tangent } = cubicPoint(start, firstControl, secondControl, end, progress)
    const tangentLength = Math.hypot(tangent.x, tangent.y) || 1
    let normalX = -tangent.y / tangentLength
    let normalY = tangent.x / tangentLength
    if (normalX * referenceNormalX + normalY * referenceNormalY < 0) {
      normalX *= -1
      normalY *= -1
    }
    const endpointBlend = Math.sin(Math.PI * progress) ** 2
    return {
      x: point.x + normalX * offset * endpointBlend,
      y: point.y + normalY * offset * endpointBlend,
    }
  })
  const label = points[12]

  return [
    smoothPathThrough(points),
    label.x,
    label.y,
  ] as const
}

export function KnowledgeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  style,
  markerStart,
  markerEnd,
  interactionWidth,
}: EdgeProps<KnowledgeEdgeType>) {
  const offset = Number(data?.parallelOffset ?? 0)
  const [path, labelX, labelY] = offset
    ? parallelBezierPath(sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, offset)
    : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })

  return (
    <BaseEdge
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      label={label}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      style={style}
      markerStart={markerStart}
      markerEnd={markerEnd}
      interactionWidth={interactionWidth}
    />
  )
}
