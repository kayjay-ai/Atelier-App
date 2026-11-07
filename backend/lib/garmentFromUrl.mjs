import { serviceDb } from './db.mjs'
import { safeFetch, domainOf, UnsafeUrlError } from './safeFetch.mjs'

// =============================================================================
// Garment from a product link: fetch the page (or the image itself), find the
// product image through a fallback chain (OG/Twitter tags, JSON-LD Product,
// image hints, the largest <img>, then any product-looking URL in the HTML),
// download it as a data URI, and pull the name, brand, price, description and
// a size chart when the page has one. Returns { status, body } for the route.
// =============================================================================

const reply = (body) => ({ status: 200, body })
const reply400 = (body) => ({ status: 400, body })

// Admin "Websites → Block": links from these domains are refused.
async function domainBlocked(url) {
  const domain = domainOf(url)
  const db = serviceDb()
  if (!domain || !db) return false
  try {
    const parent = domain.split('.').slice(-2).join('.')
    const { data } = await db.from('blocked_domains').select('domain').in('domain', [domain, parent])
    return (data ?? []).length > 0
  } catch {
    return false
  }
}

export async function garmentFromUrl(url) {
  if (await domainBlocked(url)) {
    return reply({
      imageBase64: '',
      blocked: true,
      error: 'Links from this site aren\'t supported — screenshot the piece and upload it instead.',
    })
  }

  const TIMEOUT_MS = 8000
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

  let html = ''
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const pageRes = await safeFetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!pageRes.ok) throw new Error(`Page responded ${pageRes.status}`)

    // If the URL points directly at an image, use it as-is instead of scraping HTML.
    const contentType = pageRes.headers.get('content-type')?.split(';')[0]?.trim() || ''
    if (contentType.startsWith('image/')) {
      const buf = Buffer.from(await pageRes.arrayBuffer())
      const imageBase64 = `data:${contentType};base64,${buf.toString('base64')}`
      let name
      try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || undefined } catch {}
      return reply({ imageBase64, name })
    }

    html = await pageRes.text()
  } catch (err) {
    console.info(`[Atelier] garment/from-url: could not fetch ${url}: ${err.message}`)
    if (err instanceof UnsafeUrlError) {
      return reply400({ imageBase64: '', error: 'That link can’t be opened — paste a link to a public product page.' })
    }
    return reply({
      imageBase64: '',
      error: `I couldn't reach that page — drop me a screenshot of the piece instead and I'll take it from there.`,
    })
  }

  // --- Extract image URL via fallback chain ---
  let imageUrl = ''

  // 1. OG / Twitter image meta tags
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
  if (ogMatch) imageUrl = ogMatch[1]

  if (!imageUrl) {
    const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)
    if (twMatch) imageUrl = twMatch[1]
  }

  // 2. JSON-LD Product schema
  if (!imageUrl) {
    const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    for (const m of ldMatches) {
      try {
        const data = JSON.parse(m[1])
        const items = Array.isArray(data) ? data : [data]
        for (const item of items) {
          const t = item['@type']
          if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
            const img = Array.isArray(item.image) ? item.image[0] : item.image
            if (img && typeof img === 'string') { imageUrl = img; break }
          }
        }
        if (imageUrl) break
      } catch {}
    }
  }

  // 3. Other well-known image hints: link rel=image_src / preload, itemprop=image
  if (!imageUrl) {
    const linkMatch = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)
      || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["']/i)
      || html.match(/<link[^>]+rel=["']preload["'][^>]+as=["']image["'][^>]+href=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i)
    if (linkMatch) imageUrl = linkMatch[1]
  }

  // 4. Largest <img> on page (by src string heuristic: prefer large/product/hero in path)
  if (!imageUrl) {
    const imgMatches = [
      ...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi),
      ...html.matchAll(/<(?:img|source)[^>]+srcset=["']([^"'\s,]+)[^"']*["'][^>]*>/gi),
    ]
    const scored = imgMatches
      .map((m) => ({ src: m[1], score: /product|hero|main|large|zoom|full|pdp|featured/i.test(m[1]) ? 2 : m[1].match(/\d{3,}x\d{3,}/) ? 1 : 0 }))
      .sort((a, b) => b.score - a.score)
    if (scored[0]) imageUrl = scored[0].src
  }

  // 5. Last resort: any product-image-looking URL embedded in the raw HTML/JSON state.
  //    Catches SPA pages that inline image URLs in a __NEXT_DATA__ / preloaded-state blob.
  if (!imageUrl) {
    const raw = [...html.matchAll(/https?:\\?\/\\?\/[^"'\\\s)]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s)]*)?/gi)]
      .map((m) => m[0].replace(/\\\//g, '/'))
    const scored = raw
      .map((src) => ({ src, score: /product|media|image|cdn|catalog|large|zoom|hero/i.test(src) ? 2 : 1 }))
      .filter((x) => !/sprite|logo|icon|favicon|placeholder|thumb/i.test(x.src))
      .sort((a, b) => b.score - a.score)
    if (scored[0]) imageUrl = scored[0].src
  }

  if (!imageUrl) {
    // Distinguish a bot wall (Akamai / Cloudflare / PerimeterX interstitial) from a
    // page we simply couldn't parse — the user's next step is different.
    const blocked = /bm-verify|_sec\/verify|interstitial|akamai|perimeterx|px-captcha|captcha|cf-browser-verification|Just a moment|Attention Required|enable JavaScript/i.test(html)
      || html.length < 3000
    let host = 'This site'
    try { host = new URL(url).hostname.replace(/^www\./, '') } catch {}
    console.info(`[Atelier] garment/from-url: no image extracted from ${url} (${blocked ? 'bot-wall/empty shell' : 'no image tags'}, ${html.length}b)`)
    return reply({
      imageBase64: '',
      blocked,
      error: blocked
        ? `${host} blocks automatic previews (bot protection), so I can't pull the image from the link. Screenshot the piece and upload it — that works perfectly.`
        : `I couldn't find the product image on that page — drop me a screenshot of the piece instead and I'll take it from there.`,
    })
  }

  // Resolve relative URLs
  try {
    imageUrl = new URL(imageUrl, url).href
  } catch {}

  // Download the image server-side to avoid CORS
  let imageBase64 = ''
  let mimeType = 'image/jpeg'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const imgRes = await safeFetch(imageUrl, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
    clearTimeout(timer)
    if (!imgRes.ok) throw new Error(`Image responded ${imgRes.status}`)
    mimeType = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
    const buf = Buffer.from(await imgRes.arrayBuffer())
    imageBase64 = `data:${mimeType};base64,${buf.toString('base64')}`
  } catch (err) {
    console.info(`[Atelier] garment/from-url: could not download image ${imageUrl}: ${err.message}`)
    return reply({
      imageBase64: '',
      error: `I couldn't reach that page — drop me a screenshot of the piece instead and I'll take it from there.`,
    })
  }

  // Extract metadata
  const metaContent = (name) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i'))
    return m ? m[1].trim() : undefined
  }

  const name = metaContent('og:title') || metaContent('twitter:title') || undefined
  const description = metaContent('og:description') || metaContent('twitter:description') || undefined

  // Try JSON-LD for brand/price
  let brand, price
  const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1])
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        const t = item['@type']
        if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
          if (item.brand?.name) brand = item.brand.name
          if (item.offers) {
            const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers
            if (offer?.price) price = `${offer.price}${offer.priceCurrency ? ' ' + offer.priceCurrency : ''}`
          }
          break
        }
      }
      if (brand || price) break
    } catch {}
  }

  // Extract size chart text — look for common size-guide patterns in the page HTML
  let sizeChartText
  try {
    // 1. Tables whose headers mention sizing (XS/S/M/L/XL, chest, waist, shoulder, UK/EU/US sizes)
    const sizeTableRx = /<table[^>]*>([\s\S]*?)<\/table>/gi
    const tables = [...html.matchAll(sizeTableRx)]
    for (const tm of tables) {
      const thtml = tm[1]
      if (/\b(XS|S\/M|X?XL|chest|waist|hip|shoulder|bust|inseam|EU\s*\d|UK\s*\d|US\s*\d|\bsize\b)/i.test(thtml)) {
        // Strip tags, normalise whitespace
        const text = thtml.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim()
        if (text.length > 20 && text.length < 2000) { sizeChartText = text; break }
      }
    }
    // 2. Sections / divs with sizing keywords in class or id
    if (!sizeChartText) {
      const sectionRx = /<(?:section|div)[^>]+(?:class|id)=["'][^"']*size[^"']*["'][^>]*>([\s\S]{20,800}?)<\/(?:section|div)>/gi
      const sm = sectionRx.exec(html)
      if (sm) {
        const text = sm[1].replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim()
        if (text.length > 20) sizeChartText = text
      }
    }
    // 3. JSON-LD additionalProperty for size guide
    if (!sizeChartText) {
      for (const m of ldMatches) {
        try {
          const data = JSON.parse(m[1])
          const items = Array.isArray(data) ? data : [data]
          for (const item of items) {
            const props = item.additionalProperty || []
            const sg = props.find(p => /size/i.test(p.name || ''))
            if (sg?.value) { sizeChartText = String(sg.value); break }
          }
        } catch {}
        if (sizeChartText) break
      }
    }
  } catch {}

  return reply({ imageBase64, name, brand, price, description, sizeChartText })
}
