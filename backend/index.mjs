import 'dotenv/config'
import { createApp } from './app.mjs'
import { TEXT_MODEL, IMAGE_MODEL, IMAGE_QUALITY } from './lib/ai.mjs'

// Entry point: build the app (app.mjs) and listen on $PORT.
const app = createApp()
const PORT = process.env.PORT || 8787

// Bind 0.0.0.0 so the host (Caddy on the Droplet) can route traffic to the port.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Atelier] API server listening on http://0.0.0.0:${PORT}`)
  if (!process.env.GEMINI_TEXT_API_KEY && !process.env.GEMINI_API_KEY) {
    console.error('[Atelier] ⚠️  MISSING: GEMINI_TEXT_API_KEY — Size, Style & Color features will return "AI unavailable" fallbacks.')
  } else {
    console.log(`[Atelier] GEMINI_TEXT_API_KEY loaded (model: ${TEXT_MODEL})`)
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('[Atelier] ⚠️  MISSING: GEMINI_API_KEY — Virtual Try-On will fail.')
  } else {
    console.log(`[Atelier] GEMINI_API_KEY loaded (IMAGE_QUALITY=${IMAGE_QUALITY}, model: ${IMAGE_MODEL})`)
  }
})
