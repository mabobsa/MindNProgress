export const documentReconstructionGuide: {
  readonly version: number
  readonly modes: Record<'compact' | 'spec-update', string>
  readonly steps: readonly string[]
  readonly dispositions: Record<'carry' | 'merge' | 'knowledge' | 'history' | 'drop', string>
}
