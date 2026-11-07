import dns from 'dns/promises'
import net from 'net'

// =============================================================================
// fetch() for user-supplied URLs (/api/garment/from-url). Refuses anything that
// isn't a public http(s) address — localhost, private ranges, link-local (cloud
// metadata at 169.254.169.254), etc. — and re-checks every redirect hop, so a
// pasted link can't make the server read its own network.
// =============================================================================

export class UnsafeUrlError extends Error {}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)   // carrier-grade NAT
    || (a === 169 && b === 254)             // link-local / cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || a >= 224                              // multicast + reserved
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip)
  const v6 = ip.toLowerCase()
  if (v6.startsWith('::ffff:')) return isPrivateIPv4(v6.slice(7))
  return v6 === '::' || v6 === '::1'
    || v6.startsWith('fc') || v6.startsWith('fd')   // unique local
    || /^fe[89ab]/.test(v6)                         // link-local
    || v6.startsWith('ff')                          // multicast
}

/** Throws UnsafeUrlError unless the URL is http(s) and every resolved address is public. */
export async function assertPublicUrl(raw) {
  let u
  try { u = new URL(raw) } catch { throw new UnsafeUrlError('Invalid URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeUrlError('Only http(s) links are allowed')
  if (u.username || u.password) throw new UnsafeUrlError('Links with credentials are not allowed')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new UnsafeUrlError('Private address')
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => [])
  if (addrs.length === 0) throw new UnsafeUrlError('Could not resolve host')
  if (addrs.some((a) => isPrivateIP(a.address))) throw new UnsafeUrlError('Private address')
  return u
}

/** fetch() that validates the URL and each redirect (max 4 hops). */
export async function safeFetch(url, options = {}, maxRedirects = 4) {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current)
    const res = await fetch(current, { ...options, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href
      continue
    }
    return res
  }
  throw new UnsafeUrlError('Too many redirects')
}

/** Lower-case host without "www." — the key used by blocked_domains. */
export function domainOf(raw) {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, '') } catch { return null }
}
