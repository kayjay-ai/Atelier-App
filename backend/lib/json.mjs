/**
 * Defensively parses a JSON object/array out of a model response that may be
 * wrapped in markdown code fences or surrounded by stray prose.
 */
export function extractJson(text) {
  if (!text) return null
  let cleaned = text.trim()
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    // fall through to substring extraction
  }

  const firstObj = cleaned.indexOf('{')
  const firstArr = cleaned.indexOf('[')
  let start = -1
  let open = '{'
  let close = '}'
  if (firstObj === -1 && firstArr === -1) return null
  if (firstObj === -1 || (firstArr !== -1 && firstArr < firstObj)) {
    start = firstArr
    open = '['
    close = ']'
  } else {
    start = firstObj
  }

  const end = cleaned.lastIndexOf(close)
  if (end === -1 || end <= start) return null

  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}
