import { GoogleGenAI } from '@google/genai'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PRODUCTS_PATH = path.join(ROOT, 'data/products.json')
const TRYON_DIR = path.join(ROOT, 'data/tryon')
const SAMPLE_PHOTO_PATH = path.join(__dirname, 'sample-user.jpg')

const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-3-pro-image-preview'
const apiKey = process.env.GEMINI_API_KEY

const TRYON_INSTRUCTION =
  `Edit the FIRST image so this exact person is wearing the garment from the SECOND image.
Keep the SAME person: identical face, hair, skin tone, body shape, pose, and background.
Replace ONLY their clothing with this garment, fitted naturally with realistic drape and
shadows. Do NOT output a different person and do NOT return the garment by itself.
Photorealistic, full-length, portrait orientation.`

// Hero items pre-rendered for instant DEMO_MODE try-on.
const HERO_PRODUCT_IDS = [
  'maison-linen-trouser',
  'atelier-wool-overcoat',
  'cascade-silk-blouse',
  'oraline-midi-dress',
  'verdant-cashmere-cardigan',
]

if (!apiKey) {
  console.error('[Atelier] GEMINI_API_KEY is not set. Add it to .env before running seed:tryon.')
  process.exit(1)
}

if (!fs.existsSync(SAMPLE_PHOTO_PATH)) {
  console.error(`[Atelier] No sample photo found at scripts/sample-user.jpg.`)
  console.error('[Atelier] Drop a clear, full-body photo there (named sample-user.jpg) and run again.')
  process.exit(1)
}

const ai = new GoogleGenAI({ apiKey })
const products = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf-8'))

fs.mkdirSync(TRYON_DIR, { recursive: true })

function toInlinePart(filePath, fallbackMime = 'image/png') {
  const data = fs.readFileSync(filePath).toString('base64')
  const ext = path.extname(filePath).toLowerCase()
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : fallbackMime
  return { inlineData: { mimeType, data } }
}

async function generate(product) {
  // Garment photos are the app's catalog images (Atelier-App/public/catalog/*.jpg).
  const garmentPath = path.join(ROOT, '..', 'public', product.hero)
  const ext = path.extname(garmentPath).toLowerCase()
  if (!fs.existsSync(garmentPath) || ext === '.svg') {
    throw new Error(`missing real catalog photo for ${product.id} — add the photo to public/catalog/ in the app`)
  }

  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${TRYON_INSTRUCTION} The garment is: ${product.name} (${product.fabric}).` },
          toInlinePart(SAMPLE_PHOTO_PATH),
          toInlinePart(garmentPath),
        ],
      },
    ],
    config: { responseModalities: ['IMAGE'] },
  })

  const parts = response?.candidates?.[0]?.content?.parts ?? []
  const imagePart = parts.find((p) => p.inlineData)
  if (!imagePart) {
    throw new Error('No image returned by the model')
  }

  const buffer = Buffer.from(imagePart.inlineData.data, 'base64')
  const outPath = path.join(TRYON_DIR, `${product.id}.png`)
  fs.writeFileSync(outPath, buffer)
  return outPath
}

async function main() {
  const targets = products.filter((p) => HERO_PRODUCT_IDS.includes(p.id))
  console.log(`[Atelier] Generating ${targets.length} pre-rendered try-on results with ${IMAGE_MODEL}...`)

  for (const product of targets) {
    try {
      const outPath = await generate(product)
      console.log(`  ✓ ${product.id} -> ${path.relative(ROOT, outPath)}`)
    } catch (err) {
      console.error(`  ✗ ${product.id}: ${err.message}`)
      if (/billing|quota|permission|PERMISSION_DENIED|RESOURCE_EXHAUSTED/i.test(String(err.message))) {
        console.error(
          '    Hint: ensure billing is enabled on your Google AI Studio / Cloud project for image-generation models.'
        )
      }
    }
  }

  console.log('[Atelier] Done. With DEMO_MODE=true, these pieces now return instantly in Virtual Try-On.')
}

main()
