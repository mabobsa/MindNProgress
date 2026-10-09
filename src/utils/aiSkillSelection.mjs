export function defaultAiSkillIds(skills) {
  return new Set(skills.filter((skill) => skill.id === 'session-message').map((skill) => skill.id))
}
