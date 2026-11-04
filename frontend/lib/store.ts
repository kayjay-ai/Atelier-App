import { create } from 'zustand'
import type { Measurements, ColorAnalysisResult, GarmentCheck, Membership, StyleReport } from './types'
import { fetchMembership } from './api'
import { FREE_CREDITS } from './pricing'
import { fetchProfile, downloadUserPhoto } from './supabaseStorage'

// ─── Cloud-only ───────────────────────────────────────────────────────────────
// None of these stores persist to localStorage / AsyncStorage / IndexedDB. They
// hold transient in-memory state for the session only; the source of truth is
// Supabase (profile, history, memberships), hydrated on load by each screen.
// The only client-side persistence is the Supabase auth session (handled by the
// Supabase client itself), which is expected.

interface ProfileState {
  ownerId: string | null
  /** True once the signed-in user's cloud profile has been read. */
  loaded: boolean
  name: string | null
  dateOfBirth: string | null       // YYYY-MM-DD
  notifyEmail: boolean
  notifyPush: boolean
  measurements: Measurements | null
  photoUri: string | null
  colorAnalysis: ColorAnalysisResult | null
  styleReport: StyleReport | null
  setMeasurements: (m: Measurements) => void
  setPhotoUri: (uri: string) => void
  setColorAnalysis: (c: ColorAnalysisResult) => void
  setStyleReport: (r: StyleReport) => void
  setAccount: (a: Partial<Pick<ProfileState, 'name' | 'dateOfBirth' | 'notifyEmail' | 'notifyPush'>>) => void
  setOwner: (id: string | null) => void
  /** Load the profile from Supabase for this user (no-op if already loaded). */
  hydrate: (userId: string, force?: boolean) => Promise<void>
  reset: () => void
}

const EMPTY_PROFILE = {
  loaded: false, name: null, dateOfBirth: null, notifyEmail: true, notifyPush: true,
  measurements: null, photoUri: null, colorAnalysis: null, styleReport: null,
}

export const useProfileStore = create<ProfileState>()((set, get) => ({
  ownerId: null,
  ...EMPTY_PROFILE,
  setMeasurements: (m) => set({ measurements: m }),
  setPhotoUri: (uri) => set({ photoUri: uri }),
  setColorAnalysis: (c) => set({ colorAnalysis: c }),
  setStyleReport: (r) => set({ styleReport: r, colorAnalysis: r.color }),
  setAccount: (a) => set(a),
  setOwner: (id) => set({ ownerId: id }),
  hydrate: async (userId, force = false) => {
    if (!force && get().ownerId === userId && get().loaded) return
    if (get().ownerId !== userId) set({ ownerId: userId, ...EMPTY_PROFILE })
    const remote = await fetchProfile(userId)
    if (get().ownerId !== userId) return // signed out / switched meanwhile
    set({
      loaded: true,
      name: remote?.name ?? null,
      dateOfBirth: remote?.dateOfBirth ?? null,
      notifyEmail: remote?.notifyEmail ?? true,
      notifyPush: remote?.notifyPush ?? true,
      measurements: remote?.measurements ?? get().measurements,
      colorAnalysis: remote?.styleReport?.color ?? remote?.colorAnalysis ?? get().colorAnalysis,
      styleReport: remote?.styleReport ?? get().styleReport,
    })
    if (remote?.photoPath && !get().photoUri) {
      const uri = await downloadUserPhoto(remote.photoPath)
      if (uri && get().ownerId === userId) set({ photoUri: uri })
    }
  },
  reset: () => set({ ...EMPTY_PROFILE }),
}))

interface GarmentHistoryState {
  checks: GarmentCheck[]
  addCheck: (check: GarmentCheck) => void
  updateCheck: (id: string, updates: Partial<Pick<GarmentCheck, 'tryOnResult' | 'sizeResult' | 'verdictResult'>>) => void
  removeCheck: (id: string) => void
  clear: () => void
}

// In-memory session history. Persisted copies live in Supabase (try_ons) and are
// hydrated by the History screen.
export const useGarmentStore = create<GarmentHistoryState>()((set, get) => ({
  checks: [],
  addCheck: (check) => set({ checks: [check, ...get().checks].slice(0, 50) }),
  updateCheck: (id, updates) =>
    set({ checks: get().checks.map((c) => (c.id === id ? { ...c, ...updates } : c)) }),
  removeCheck: (id) => set({ checks: get().checks.filter((c) => c.id !== id) }),
  clear: () => set({ checks: [] }),
}))

interface MembershipState {
  membership: Membership | null
  loading: boolean
  refresh: () => Promise<Membership | null>
  setMembership: (m: Membership | null) => void
}

export const useMembershipStore = create<MembershipState>((set) => ({
  membership: null,
  loading: false,
  setMembership: (m) => set({ membership: m }),
  refresh: async () => {
    set({ loading: true })
    const m = await fetchMembership()
    set({ membership: m, loading: false })
    return m
  },
}))

// ─── Credits ────────────────────────────────────────────────────────────────
// The balance lives on the server's membership row (decremented atomically by
// consume_tryon, topped up only by verified purchases) and is read from
// useMembershipStore: there is no second copy to keep in step.
export { FREE_CREDITS }

/** Premium (admin-granted, plan='premium') is unlimited: never gated on credits. */
export function isPremium(m: Membership | null | undefined): boolean {
  return !!m && (m.isPremium === true || m.plan === 'premium')
}

/** Credits left, or null until the membership has loaded. */
export function creditsLeft(m: Membership | null | undefined): number | null {
  return m && typeof m.creditsBalance === 'number' ? Math.max(0, m.creditsBalance) : null
}

// ─── Try-on result cache ──────────────────────────────────────────────────────
// In-memory only (no persistence). De-dupes repeat (photo + garment) within a
// session so re-running the same fitting doesn't re-bill. Maps to the History
// check id that holds the image; the image itself lives in the garment store.
const TRYON_CACHE_VERSION = 'eco-3x4-v1'
const TRYON_CACHE_MAX = 200

function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Stable key from (userPhoto + garment). Length is folded in to guard collisions. */
export function tryOnCacheKey(userPhoto: string, garment: string): string {
  return `${fnv1a(userPhoto)}.${userPhoto.length}:${fnv1a(garment)}.${garment.length}:${TRYON_CACHE_VERSION}`
}

interface TryOnCacheState {
  entries: Record<string, { checkId: string; at: string }>
  lookup: (key: string) => { checkId: string; at: string } | undefined
  save: (key: string, checkId: string) => void
  clear: () => void
}

export const useTryOnCacheStore = create<TryOnCacheState>()((set, get) => ({
  entries: {},
  lookup: (key) => get().entries[key],
  save: (key, checkId) =>
    set((s) => {
      const next = { ...s.entries, [key]: { checkId, at: new Date().toISOString() } }
      const keys = Object.keys(next)
      if (keys.length > TRYON_CACHE_MAX) {
        keys
          .sort((a, b) => Date.parse(next[a].at) - Date.parse(next[b].at))
          .slice(0, keys.length - TRYON_CACHE_MAX)
          .forEach((k) => delete next[k])
      }
      return { entries: next }
    }),
  clear: () => set({ entries: {} }),
}))
