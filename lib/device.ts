import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import { supabase } from './supabaseClient'

// ─── This install's identity (B2B device tracking) ────────────────────────────
// A tablet registers itself once, on the first store login, as a b2b_devices
// row: a 6-digit device_code (a label people can read) plus a long random
// device_key (the secret). Both are kept on the tablet and reused on every
// later login; the heartbeat (lib/heartbeat.ts) sends both. The key is also
// sent as X-Atelier-Device so the API server finds the same row.
// Storage: AsyncStorage = localStorage on web (the browser has no secure
// store); switch to expo-secure-store for the native store builds.

const KEY = 'atelier.deviceKey'
const CODE = 'atelier.deviceCode'
const STORE = 'atelier.deviceStore'
let cached: string | null = null

// Crypto-strength randomness where the platform has it (web, iOS 15+ Safari).
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  const c = (globalThis as any).crypto
  if (c?.getRandomValues) c.getRandomValues(out)
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256)
  return out
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
/** 48 characters, ~288 bits — the device secret. */
const newSecret = () => Array.from(randomBytes(48), (b) => ALPHABET[b & 63]).join('')
/** "000000"–"999999", leading zeros kept. */
const newCode = () => {
  const b = randomBytes(4)
  const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  return String(n % 1_000_000).padStart(6, '0')
}

export async function getDeviceKey(): Promise<string> {
  if (cached) return cached
  try {
    const stored = await AsyncStorage.getItem(KEY)
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return (cached = stored)
  } catch {}
  const fresh = newSecret()
  cached = fresh
  try { await AsyncStorage.setItem(KEY, fresh) } catch {}
  return fresh
}

/** The key if it's already loaded — for request headers without awaiting storage. */
export function deviceKeySync(): string | null {
  return cached
}

export interface RegisteredDevice { code: string; key: string; storeId: string }

/** This tablet's saved registration, or null if it has none yet. */
export async function getRegisteredDevice(): Promise<RegisteredDevice | null> {
  try {
    const [code, key, storeId] = await Promise.all([AsyncStorage.getItem(CODE), getDeviceKey(), AsyncStorage.getItem(STORE)])
    return code && /^\d{6}$/.test(code) && storeId ? { code, key, storeId } : null
  } catch {
    return null
  }
}

/** Drop the saved code (and secret): the row is gone or no longer matches. */
export async function forgetDevice(): Promise<void> {
  cached = null
  try { await AsyncStorage.multiRemove([CODE, KEY, STORE]) } catch {}
}

/**
 * Insert this tablet into b2b_devices for the store that signed in, with a
 * fresh code + secret; a code that is already taken (device_code is unique)
 * is drawn again. Returns null if the insert fails for another reason.
 */
async function register(storeId: string): Promise<RegisteredDevice | null> {
  const key = newSecret()
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode()
    const { error } = await supabase.from('b2b_devices').insert({
      device_code: code,
      device_key: key,
      store_id: storeId,
      device_name: deviceName(),
      device_type: deviceKind(),
      platform: devicePlatform(),
      app_version: appVersion(),
      first_seen_at: new Date().toISOString(),
    })
    if (!error) {
      cached = key
      try { await AsyncStorage.multiSet([[CODE, code], [KEY, key], [STORE, storeId]]) } catch {}
      return { code, key, storeId }
    }
    // 23505 = unique violation; only a clashing code is worth another draw.
    if (error.code === '23505' && /device_code/.test(`${error.message} ${error.details ?? ''}`)) continue
    console.warn('[Atelier] device registration failed:', error.message)
    return null
  }
  console.warn('[Atelier] device registration failed: no free device code after 5 tries')
  return null
}

/**
 * The registration for this store: the saved one, or a new one on the first
 * login (or when this tablet now signs in for a different store).
 */
export async function ensureDeviceRegistered(storeId: string): Promise<RegisteredDevice | null> {
  const saved = await getRegisteredDevice()
  if (saved && saved.storeId === storeId) return saved
  return register(storeId)
}

/** Register again from scratch (the server said unknown_device). */
export async function reRegisterDevice(storeId: string): Promise<RegisteredDevice | null> {
  await forgetDevice()
  return register(storeId)
}

function webKind(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
  return ipad ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Browser'
}

/** iPad / iPhone / Android / Browser — b2b_devices.device_type. */
export function deviceKind(): string {
  if (Platform.OS === 'web') return webKind()
  return Platform.OS === 'ios' ? ((Platform as any).isPad ? 'iPad' : 'iPhone') : 'Android'
}

/** A readable default name, e.g. "iPad (Safari)"; the admin can rename it. */
export function deviceName(): string {
  if (Platform.OS === 'web') {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    const browser = /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : /Firefox/.test(ua) ? 'Firefox' : 'web'
    return `${webKind()} (${browser})`
  }
  return Constants.deviceName || (Platform.OS === 'ios' ? 'iPad' : 'Android tablet')
}

export const devicePlatform = (): string => (Platform.OS === 'web' ? 'web' : `${Platform.OS} ${Platform.Version}`)
export const appVersion = (): string => Constants.expoConfig?.version ?? 'unknown'
