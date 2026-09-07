export const sharedKnowledgeMaxLength = 15_000

export const sharedKnowledgeAuditThresholds = Object.freeze({
  attentionCharacters: 5_000,
  recommendedCharacters: 8_000,
  priorityCharacters: 12_000,
  limitCharacters: sharedKnowledgeMaxLength,
})
