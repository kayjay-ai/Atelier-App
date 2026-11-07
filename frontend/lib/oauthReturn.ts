// What Google / Apple sign-in sent back to the app (atelier://auth...).
// Supabase puts the session after '#' (implicit flow, the default) or a ?code=
// to exchange (PKCE flow); an error comes as error / error_description.
// Plain string parsing on purpose: React Native's URLSearchParams has been
// incomplete in older versions.

export type AuthReturn =
  | { kind: 'tokens'; accessToken: string; refreshToken: string }
  | { kind: 'code'; code: string }
  | { kind: 'error'; message: string }
  | { kind: 'none' }

function parseParams(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of s.split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    const decode = (v: string) => {
      try { return decodeURIComponent(v.replace(/\+/g, ' ')) } catch { return v }
    }
    out[decode(i < 0 ? part : part.slice(0, i))] = i < 0 ? '' : decode(part.slice(i + 1))
  }
  return out
}

export function readAuthReturn(url: string): AuthReturn {
  const hashAt = url.indexOf('#')
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt)
  const queryAt = beforeHash.indexOf('?')
  const query = parseParams(queryAt < 0 ? '' : beforeHash.slice(queryAt + 1))
  const hash = parseParams(hashAt < 0 ? '' : url.slice(hashAt + 1))

  const error = hash.error_description || hash.error || query.error_description || query.error
  if (error) return { kind: 'error', message: error }
  if (hash.access_token && hash.refresh_token) {
    return { kind: 'tokens', accessToken: hash.access_token, refreshToken: hash.refresh_token }
  }
  if (query.code) return { kind: 'code', code: query.code }
  return { kind: 'none' }
}
