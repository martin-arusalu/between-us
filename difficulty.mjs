// Legacy labels remain accepted by the API; room state always stores an integer.
export function difficultyLevel(value = 5) {
  const legacy = { normal: 2, medium: 5, challenging: 8 };
  if (typeof value === 'string' && Object.hasOwn(legacy, value)) return legacy[value];
  if (!['number', 'string'].includes(typeof value)) return null;
  const level = Number(value);
  return Number.isInteger(level) && level >= 1 && level <= 10 ? level : null;
}

export function nextDifficulty(current, { humanCorrect, aiCorrect, scored = true }) {
  const level = difficultyLevel(current) || 5;
  if (!scored) return level;
  const change = humanCorrect ? 1 : aiCorrect ? 0 : -1;
  return Math.max(1, Math.min(10, level + change));
}
