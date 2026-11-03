import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native'
import { create } from 'zustand'
import { supabase } from './supabaseClient'
import { appVersion, ensureDeviceRegistered, getRegisteredDevice, reRegisterDevice } from './device'

// ─── Tablet heartbeat (admin dashboard: Online / Unstable / Offline) ──────────
// While a store is signed in and the app is in the foreground, the tablet calls
// device_heartbeat every 30 s with its saved device_code + device_key; the
// server stamps the time. One beat right away (and on returning from the
// background) so the dashboard flips to Online at once; a final beat with
// p_signed_out on logout flips it to Offline at once. A failed call is simply
// retried on the next tick.

const INTERVAL_MS = 30_000

interface HeartbeatState {
  /** The 6-digit label of this tablet, once registered. */
  deviceCode: string | null
  /** b2b_stores.status from the last beat; anything but 'active' locks the app. */
  storeStatus: string | null
}

export const useHeartbeat = create<HeartbeatState>()(() => ({ deviceCode: null, storeStatus: null }))

let storeId: string | null = null
let timer: ReturnType<typeof setInterval> | null = null
let appStateSub: NativeEventSubscription | null = null
let inFlight = false

async function beat(signedOut = false): Promise<void> {
  if (!storeId || (inFlight && !signedOut)) return
  inFlight = true
  try {
    let device = await getRegisteredDevice()
    if (!device || device.storeId !== storeId) device = await ensureDeviceRegistered(storeId)
    if (!device) return // couldn't register (offline / not allowed) — try next tick
    useHeartbeat.setState({ deviceCode: device.code })

    const call = (code: string, key: string) => supabase.rpc('device_heartbeat', {
      p_device_code: code, p_device_key: key, p_app_version: appVersion(), p_signed_out: signedOut,
    })
    let { data, error } = await call(device.code, device.key)
    if (error) return // network / server hiccup — next tick
    if (data?.ok === false && data?.error === 'unknown_device' && !signedOut) {
      // The row was deleted or no longer matches: start over with a new code + secret.
      const fresh = await reRegisterDevice(storeId)
      if (!fresh) return
      useHeartbeat.setState({ deviceCode: fresh.code })
      ;({ data, error } = await call(fresh.code, fresh.key))
      if (error) return
    }
    if (data?.ok) useHeartbeat.setState({ storeStatus: data.store_status ?? null })
  } catch {
    // never surface heartbeat failures
  } finally {
    inFlight = false
  }
}

function startTimer() {
  if (timer) return
  timer = setInterval(() => { beat() }, INTERVAL_MS)
}

function stopTimer() {
  if (timer) clearInterval(timer)
  timer = null
}

function onAppState(state: AppStateStatus) {
  if (state === 'active') { beat(); startTimer() }
  else stopTimer() // background: pause until the app comes back
}

/** Start beating for the signed-in store (registers the tablet if needed). */
export function startHeartbeat(forStore: string) {
  if (storeId === forStore && timer) return
  stopHeartbeat()
  storeId = forStore
  beat()
  if (AppState.currentState === 'active' || AppState.currentState == null) startTimer()
  appStateSub = AppState.addEventListener('change', onAppState)
}

/** Stop without telling the server (e.g. the session already ended). */
export function stopHeartbeat() {
  stopTimer()
  appStateSub?.remove()
  appStateSub = null
  storeId = null
  useHeartbeat.setState({ storeStatus: null })
}

/**
 * Store logout: one last beat with p_signed_out so the dashboard shows Offline
 * immediately, then sign out. Use this instead of supabase.auth.signOut() in
 * the store app.
 */
export async function signOutStore(): Promise<void> {
  if (storeId) await beat(true)
  stopHeartbeat()
  await supabase.auth.signOut()
}
