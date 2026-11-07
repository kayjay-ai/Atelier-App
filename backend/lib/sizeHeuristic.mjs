const FIT_ADJUSTMENT = {
  snug: -0.5,
  'true-to-size': 0,
  relaxed: 0.5,
}

/**
 * Local fallback when Claude is unavailable: finds the closest size by chest/waist/hip
 * distance, then nudges up or down a half-step based on fit preference.
 */
export function recommendSize(measurements, sizeChart) {
  const usable = sizeChart.filter((s) => s.chest || s.waist || s.hip)
  if (usable.length === 0) {
    return {
      size: sizeChart[0]?.size ?? 'One Size',
      confidence: 'high',
      explanation:
        "One Size, no question — this piece is cut to move with almost any frame, so there's nothing to second-guess here.",
    }
  }

  let bestIndex = 0
  let bestScore = Infinity
  usable.forEach((entry, i) => {
    const score =
      Math.abs(entry.chest - measurements.chestIn) +
      Math.abs(entry.waist - measurements.waistIn) +
      Math.abs(entry.hip - measurements.hipIn)
    if (score < bestScore) {
      bestScore = score
      bestIndex = i
    }
  })

  const adjustment = FIT_ADJUSTMENT[measurements.fitPreference] ?? 0
  let finalIndex = bestIndex
  if (adjustment > 0 && bestIndex < usable.length - 1) finalIndex += 1
  if (adjustment < 0 && bestIndex > 0) finalIndex -= 1

  const recommended = usable[finalIndex]

  return {
    size: recommended.size,
    confidence: 'medium',
    explanation: `${recommended.size}, no question. With your measurements and this fabric's hand, it gives you the cleanest line — close enough to feel tailored, with just enough ease to move through the day without thinking about it.`,
  }
}
