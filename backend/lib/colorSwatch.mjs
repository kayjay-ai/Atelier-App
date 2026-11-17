import zlib from 'zlib'

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[i] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function solidPngBuffer(r, g, b, size = 64) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const row = Buffer.alloc(1 + size * 3)
  row[0] = 0
  for (let x = 0; x < size; x++) {
    const o = 1 + x * 3
    row[o] = r
    row[o + 1] = g
    row[o + 2] = b
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  const compressed = zlib.deflateSync(raw)

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * '#RRGGBB', or null. Gemini sometimes drops the '#' ('FFDAB9') or answers
 * with 3 digits or '0x…' — a colour without the '#' renders as nothing.
 */
export function normalizeHex(hex) {
  const m = /^(?:#|0x)?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return null
  const digits = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]
  return `#${digits.toUpperCase()}`
}

/** An AI swatch list with every hex as '#RRGGBB'; swatches without a usable colour are dropped. */
export function cleanSwatches(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((c) => (c && typeof c === 'object' ? { ...c, hex: normalizeHex(c.hex) } : null))
    .filter((c) => c?.name && c.hex)
}

/** Solid-color PNG data URL — Gemini accepts image/png, not SVG. */
export function solidColorSwatchDataUrl(hex) {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  const r = parseInt(normalized.slice(1, 3), 16)
  const g = parseInt(normalized.slice(3, 5), 16)
  const b = parseInt(normalized.slice(5, 7), 16)
  const png = solidPngBuffer(r, g, b)
  return `data:image/png;base64,${png.toString('base64')}`
}
