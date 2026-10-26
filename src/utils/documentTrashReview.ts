export type DocumentTrashPreview = {
  target: { id: string; title: string; version: number; lifecycleVersion: number; archived: boolean }
  references: { mapId: string; mapTitle: string; cardId: string; cardTitle: string; sourceCardId: string; sourceCardTitle: string; archived: boolean }[]
  referenceVersion: string
}

export function trashPreviewFromError(error: unknown): DocumentTrashPreview | null {
  const body = (error as { body?: { code?: string; preview?: DocumentTrashPreview } } | null)?.body
  return body?.code === 'TRASH_REFERENCES_CHANGED' && body.preview?.target && Array.isArray(body.preview.references)
    ? body.preview : null
}
