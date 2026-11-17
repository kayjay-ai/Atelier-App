/**
 * A swatch hex as '#RRGGBB', or undefined. Saved reports can hold a hex
 * without its '#' ('FFDAB9'), which React Native draws as no colour at all.
 */
export function swatchHex(hex: unknown): string | undefined {
  const m = /^(?:#|0x)?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return undefined
  const digits = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]
  return `#${digits.toUpperCase()}`
}
