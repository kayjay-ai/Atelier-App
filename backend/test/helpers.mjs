// Test helpers: run the API with no database, no Gemini key and no Cashfree
// secrets, so every feature takes its "not configured" path and nothing
// external is called. Import this BEFORE anything from the app.
// (A module that loads .env on import would put real keys back; jobs/daily.mjs
// only does so when run as a script.)
for (const k of [
  'SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY', 'GEMINI_TEXT_API_KEY',
  'CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY', 'CASHFREE_WEBHOOK_SECRET',
  'DEBUG_TRYON', 'CORS_ALLOWED_ORIGINS',
]) process.env[k] = '' // blank, not deleted: dotenv never overrides a set value
process.env.DEMO_MODE = 'false'

/** Start the app on a free port; returns { url, close }. */
export async function startApp() {
  const { createApp } = await import('../app.mjs')
  const server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, close: () => new Promise((r) => server.close(r)) }
}

export async function post(url, path, body, headers = {}) {
  const res = await fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

export async function get(url, path, headers = {}) {
  const res = await fetch(url + path, { headers })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** Every route the app serves, as "METHOD /path". */
export async function routeList() {
  const { createApp } = await import('../app.mjs')
  const out = []
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${layer.route.path}`)
      else if (layer.handle?.stack) walk(layer.handle.stack)
    }
  }
  walk(createApp()._router.stack)
  return out
}
