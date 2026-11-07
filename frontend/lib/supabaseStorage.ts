import { supabase } from './supabaseClient'
import { blobToDataUri } from './dataUri'
import type { Measurements, ColorAnalysisResult, SizeResult, VerdictResult, StyleReport } from './types'

// Columns added by supabase/migrations/cloud-only-history.sql. If the migration
// hasn't run yet, writes/reads of these degrade gracefully so nothing crashes.
const EXTRA_HISTORY_COLS = [
  'size_result', 'verdict_result', 'garment_source', 'garment_name', 'retailer_product_url',
  'garment_path', 'garment_brand', // b2c-app.sql
]
const isMissingCol = (msg?: string) =>
  !!msg && (EXTRA_HISTORY_COLS.some((c) => msg.includes(c)) || /column .* does not exist|schema cache/i.test(msg))
// Raised when we upsert with onConflict:'user_id,product_id' but the unique index
// hasn't been created yet (migrations/history-one-row.sql not run). We then fall
// back to a find-then-update/insert so writes still work (just not race-proof).
const isMissingUniqueIndex = (msg?: string) =>
  !!msg && /no unique or exclusion constraint|on conflict|constraint matching/i.test(msg)

const USER_PHOTOS_BUCKET = 'user-photos'
const TRYON_BUCKET = 'try-on-results'
const SIGNED_URL_TTL_SEC = 60 * 60 * 24 * 7 // 7 days

export function isSupabaseConfigured(): boolean {
  return !!(process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY)
}

// React Native's Blob doesn't expose its bytes to supabase-js, so uploading a
// Blob built from `fetch(dataUri)` silently stores 0 bytes on device. Decoding
// the base64 payload into a Uint8Array uploads correctly on both native and web.
// RFC-4122 v4 UUID. React Native's Hermes engine has no `crypto.randomUUID`, so
// the old timestamp fallback produced non-UUID strings that Postgres rejected on
// insert (`invalid input syntax for type uuid`) — silently losing every try-on.
export function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function dataUriToBytes(dataUri: string): { bytes: Uint8Array; contentType: string } {
  const commaIdx = dataUri.indexOf(',')
  const meta = dataUri.slice(0, commaIdx)
  const b64 = dataUri.slice(commaIdx + 1)
  const contentType = /data:(.*?);base64/.exec(meta)?.[1] || 'image/jpeg'
  const binary = globalThis.atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { bytes, contentType }
}

/** Current signed-in user id, or null. Uses the cached session (no network). */
export async function getCurrentUserId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null
  try {
    const { data } = await supabase.auth.getSession()
    return data.session?.user?.id ?? null
  } catch {
    return null
  }
}

export interface CloudProfile {
  name?: string
  dateOfBirth?: string          // YYYY-MM-DD
  measurements?: Measurements
  colorAnalysis?: ColorAnalysisResult
  styleReport?: StyleReport
  photoPath?: string
  notifyEmail?: boolean
  notifyPush?: boolean
  /** False when the b2c-app.sql columns don't exist yet (skip onboarding checks). */
  hasAccountColumns: boolean
}

export async function fetchProfile(userId: string): Promise<CloudProfile | null> {
  if (!isSupabaseConfigured()) return null
  try {
    // select('*') so a database without the newer columns still returns a row.
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    if (error || !data) return null
    const row = data as any
    return {
      // The signup trigger stores the email as the name until the user sets one.
      name: row.name && row.name !== row.email ? row.name : undefined,
      dateOfBirth: row.date_of_birth ?? undefined,
      measurements: row.measurements ?? undefined,
      colorAnalysis: row.color_analysis ?? undefined,
      styleReport: row.style_profile?.style && row.style_profile?.color ? row.style_profile : undefined,
      photoPath: row.photo_path ?? undefined,
      notifyEmail: row.notify_email ?? true,
      notifyPush: row.notify_push ?? true,
      hasAccountColumns: 'date_of_birth' in row,
    }
  } catch {
    return null
  }
}

// Only writes the fields you provide — other columns are untouched. The profile
// row is created by the signup trigger, so this updates it; an insert (with the
// email as the required name) only happens for accounts that predate the trigger.
export async function upsertProfile(
  userId: string,
  email: string,
  data: {
    name?: string
    dateOfBirth?: string | null
    measurements?: Measurements | null
    colorAnalysis?: ColorAnalysisResult | null
    styleReport?: StyleReport | null
    photoPath?: string | null
    notifyEmail?: boolean
    notifyPush?: boolean
  },
): Promise<void> {
  if (!isSupabaseConfigured()) return
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (data.name !== undefined) patch.name = data.name
  if ('dateOfBirth' in data) patch.date_of_birth = data.dateOfBirth ?? null
  if ('measurements' in data) patch.measurements = data.measurements ?? null
  if ('colorAnalysis' in data) patch.color_analysis = data.colorAnalysis ?? null
  if ('styleReport' in data) patch.style_profile = data.styleReport ?? null
  if ('photoPath' in data) patch.photo_path = data.photoPath ?? null
  if (data.notifyEmail !== undefined) patch.notify_email = data.notifyEmail
  if (data.notifyPush !== undefined) patch.notify_push = data.notifyPush

  const { data: updated, error } = await supabase.from('profiles').update(patch).eq('id', userId).select('id')
  if (error) throw error
  if (updated && updated.length > 0) return
  const { error: insErr } = await supabase.from('profiles').insert({ id: userId, email, name: data.name || email, ...patch })
  if (insErr) throw insErr
}

export async function uploadUserPhoto(userId: string, dataUri: string): Promise<string | null> {
  if (!isSupabaseConfigured()) return null
  try {
    const path = `${userId}/reference.jpg`
    const { bytes, contentType } = dataUriToBytes(dataUri)
    const { error } = await supabase.storage.from(USER_PHOTOS_BUCKET).upload(path, bytes, {
      upsert: true,
      contentType,
    })
    if (error) throw error
    return path
  } catch (err) {
    console.warn('[Atelier] Photo upload failed:', err)
    return null
  }
}

export interface CloudTryOn {
  id: string
  productId: string
  productName: string
  garmentColor?: string
  imageUrl: string
  demo: boolean
  retailerProductUrl?: string
  garmentSource?: string
  garmentUrl?: string           // signed URL of the garment image (b2c-app.sql)
  garmentBrand?: string
  sizeResult?: SizeResult | null
  verdictResult?: VerdictResult | null
  createdAt: string
}

async function signedTryOnUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(TRYON_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

/**
 * The single write path for a garment's history row. Every result — try-on image,
 * size prediction, buy verdict — merges onto ONE row keyed by (user_id, product_id)
 * via an atomic upsert. Columns NOT in `patch` are left untouched on an update, so
 * a size write never nulls an existing try-on image and a try-on write never nulls
 * an existing size result. This is what ties try-on + size + verdict to one record
 * regardless of the order they run in.
 *
 * Requires a unique index on (user_id, product_id) — supabase/migrations/
 * history-one-row.sql. If that index isn't present yet, we fall back to a
 * find-then-update/insert so writes still land (just not race-proof). Throws on a
 * real failure so callers can surface an error + retry.
 */
async function upsertHistoryRow(
  userId: string,
  productId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const row = { user_id: userId, product_id: productId, updated_at: new Date().toISOString(), ...patch }
  const stripExtra = (o: Record<string, unknown>) => {
    const c = { ...o }; EXTRA_HISTORY_COLS.forEach((k) => delete c[k]); return c
  }

  // Preferred: one atomic upsert on the (user_id, product_id) unique index.
  let { error } = await supabase.from('try_ons').upsert(row, { onConflict: 'user_id,product_id' })
  if (error && isMissingCol(error.message)) {
    ;({ error } = await supabase.from('try_ons').upsert(stripExtra(row), { onConflict: 'user_id,product_id' }))
  }
  if (!error) return

  // Fallback: unique index not created yet → emulate with find + update/insert.
  if (isMissingUniqueIndex(error.message)) {
    console.warn('[Atelier] try_ons unique index missing — using non-atomic upsert fallback. Run migrations/history-one-row.sql.')
    const { data: existing } = await supabase
      .from('try_ons').select('id').eq('user_id', userId).eq('product_id', productId).maybeSingle()
    const write = async (payload: Record<string, unknown>) =>
      existing?.id
        ? supabase.from('try_ons').update(payload).eq('user_id', userId).eq('product_id', productId)
        : supabase.from('try_ons').insert(payload)
    let res = await write(row)
    if (res.error && isMissingCol(res.error.message)) res = await write(stripExtra(row))
    if (res.error) throw res.error
    return
  }
  throw error
}

// Uploads the generated try-on image to Storage and merges it onto the garment's
// history row. productId is the caller's local check id so the try-on merges with
// any size/verdict already written for the same garment. Throws on a real failure
// so the caller can surface an error; returns null only for no-op cases.
export async function saveTryOnToCloud(
  userId: string,
  payload: {
    productId: string
    productName: string
    garmentColor?: string
    imageDataUri: string
    garmentDataUri?: string     // the garment picture, shown next to the try-on in History
    garmentBrand?: string
    demo?: boolean
    retailerProductUrl?: string
    garmentSource?: string
    sizeResult?: SizeResult | null
    verdictResult?: VerdictResult | null
  },
): Promise<CloudTryOn | null> {
  if (!isSupabaseConfigured()) return null
  // Only real (data-URI) images can be uploaded; demo images are server paths.
  if (!payload.imageDataUri.startsWith('data:')) return null

  const fileId = (globalThis.crypto?.randomUUID?.() ?? uuidv4())
  const storagePath = `${userId}/${fileId}.jpg`
  const { bytes, contentType } = dataUriToBytes(payload.imageDataUri)

  const { error: uploadErr } = await supabase.storage.from(TRYON_BUCKET).upload(storagePath, bytes, {
    upsert: true,
    contentType,
  })
  if (uploadErr) throw uploadErr

  // The garment image is best-effort: History falls back to the try-on alone.
  let garmentPath: string | null = null
  if (payload.garmentDataUri?.startsWith('data:')) {
    const gp = `${userId}/${fileId}-garment.jpg`
    const g = dataUriToBytes(payload.garmentDataUri)
    const { error: gErr } = await supabase.storage.from(TRYON_BUCKET).upload(gp, g.bytes, { upsert: true, contentType: g.contentType })
    if (gErr) console.warn('[Atelier] garment image upload failed:', gErr.message)
    else garmentPath = gp
  }

  const patch: Record<string, unknown> = {
    product_name: payload.productName,
    garment_color: payload.garmentColor ?? null,
    storage_path: storagePath,
    demo: payload.demo ?? false,
    garment_name: payload.productName,
    garment_source: payload.garmentSource ?? (payload.retailerProductUrl || 'upload'),
    retailer_product_url: payload.retailerProductUrl ?? null,
    garment_brand: payload.garmentBrand ?? null,
  }
  if (garmentPath) patch.garment_path = garmentPath
  // Only carry size/verdict when actually present — NEVER overwrite an existing
  // size/verdict row with a stale null captured in this action's closure.
  if (payload.sizeResult != null) patch.size_result = payload.sizeResult
  if (payload.verdictResult != null) patch.verdict_result = payload.verdictResult

  console.log('[Atelier] try_ons write (try-on):', { productId: payload.productId, storagePath, cols: Object.keys(patch) })
  await upsertHistoryRow(userId, payload.productId, patch)

  const imageUrl = (await signedTryOnUrl(storagePath)) ?? ''
  // Read the merged row back so the returned record reflects any size/verdict that
  // was already on it (and gives history the real row id for delete).
  let saved: any = null
  {
    const { data } = await supabase
      .from('try_ons').select('id, size_result, verdict_result')
      .eq('user_id', userId).eq('product_id', payload.productId).maybeSingle()
    saved = data
  }
  return {
    id: saved?.id ?? payload.productId,
    productId: payload.productId,
    productName: payload.productName,
    garmentColor: payload.garmentColor,
    imageUrl,
    demo: payload.demo ?? false,
    retailerProductUrl: payload.retailerProductUrl,
    garmentSource: payload.garmentSource,
    garmentUrl: payload.garmentDataUri,
    garmentBrand: payload.garmentBrand,
    sizeResult: saved?.size_result ?? payload.sizeResult ?? null,
    verdictResult: saved?.verdict_result ?? payload.verdictResult ?? null,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Write the size and/or verdict result onto the ONE history row for a garment
 * check (keyed by product_id = the local check id). Merges via upsertHistoryRow, so
 * it lands on the same row as the try-on — whether the try-on ran before, after, or
 * never. Throws on failure so the caller can surface an error + retry.
 */
export async function saveHistoryResults(
  userId: string,
  productId: string,
  fields: {
    sizeResult?: SizeResult | null
    verdictResult?: VerdictResult | null
    garmentSource?: string
    garmentName?: string
  },
): Promise<void> {
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured.')

  const patch: Record<string, unknown> = {}
  if ('sizeResult' in fields) patch.size_result = fields.sizeResult ?? null
  if ('verdictResult' in fields) patch.verdict_result = fields.verdictResult ?? null
  if (fields.garmentSource !== undefined) patch.garment_source = fields.garmentSource
  if (fields.garmentName !== undefined) patch.garment_name = fields.garmentName
  // product_name is NOT NULL — supply it so a size/verdict-only insert (no try-on
  // yet) satisfies the constraint. Harmless on an update (same value).
  patch.product_name = fields.garmentName ?? 'Garment'

  console.log('[Atelier] try_ons write (size/verdict):', {
    productId,
    size: fields.sizeResult?.size,
    verdict: fields.verdictResult?.call,
    cols: Object.keys(patch),
  })
  await upsertHistoryRow(userId, productId, patch)
  console.log('[Atelier] try_ons write OK (size/verdict) for', productId)
}

export async function listTryOnsFromCloud(userId: string): Promise<CloudTryOn[]> {
  if (!isSupabaseConfigured()) return []
  const baseSelect = 'id, product_id, product_name, garment_color, storage_path, demo, created_at'
  const fullSelect = `${baseSelect}, retailer_product_url, garment_source, size_result, verdict_result, garment_path, garment_brand`
  try {
    let { data, error }: { data: any; error: any } = await supabase
      .from('try_ons')
      .select(fullSelect)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error && isMissingCol(error.message)) {
      ;({ data, error } = await supabase
        .from('try_ons')
        .select(baseSelect)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50))
    }
    if (error || !data) return []

    console.log('[Atelier] history read:', {
      rows: data.length,
      withSize: data.filter((r: any) => r.size_result).length,
      withVerdict: data.filter((r: any) => r.verdict_result).length,
      withImage: data.filter((r: any) => r.storage_path).length,
    })

    const rows = await Promise.all(
      data.map(async (row: any) => {
        // Rows can now exist without a try-on image (size/verdict only), so a
        // missing image is not a reason to drop the row.
        const [imageUrl, garmentUrl] = await Promise.all([
          row.storage_path ? signedTryOnUrl(row.storage_path) : null,
          row.garment_path ? signedTryOnUrl(row.garment_path) : null,
        ])
        return {
          id: row.id,
          productId: row.product_id,
          productName: row.product_name,
          garmentColor: row.garment_color ?? undefined,
          imageUrl: imageUrl ?? '',
          demo: row.demo ?? false,
          retailerProductUrl: row.retailer_product_url ?? undefined,
          garmentSource: row.garment_source ?? undefined,
          garmentUrl: garmentUrl ?? undefined,
          garmentBrand: row.garment_brand ?? undefined,
          sizeResult: row.size_result ?? null,
          verdictResult: row.verdict_result ?? null,
          createdAt: row.created_at,
        } as CloudTryOn
      }),
    )
    return rows.filter((r): r is CloudTryOn => r !== null)
  } catch (err) {
    console.warn('[Atelier] Could not load try-ons from cloud:', err)
    return []
  }
}

// Delete a cloud try-on: its images in Storage, then the row. Throws on failure
// so History can keep the item and say so.
export async function deleteTryOnFromCloud(userId: string, id: string): Promise<void> {
  if (!isSupabaseConfigured()) return
  let { data: row, error }: { data: any; error: any } = await supabase
    .from('try_ons').select('storage_path, garment_path').eq('id', id).eq('user_id', userId).maybeSingle()
  if (error && isMissingCol(error.message)) {
    ;({ data: row, error } = await supabase
      .from('try_ons').select('storage_path').eq('id', id).eq('user_id', userId).maybeSingle())
  }
  if (error) throw error
  const paths = [row?.storage_path, row?.garment_path].filter(Boolean) as string[]
  if (paths.length) await supabase.storage.from(TRYON_BUCKET).remove(paths)
  const { error: delErr } = await supabase.from('try_ons').delete().eq('id', id).eq('user_id', userId)
  if (delErr) throw delErr
}

export async function downloadUserPhoto(photoPath: string): Promise<string | null> {
  if (!isSupabaseConfigured()) return null
  try {
    const { data, error } = await supabase.storage
      .from(USER_PHOTOS_BUCKET)
      .createSignedUrl(photoPath, SIGNED_URL_TTL_SEC)
    if (error || !data?.signedUrl) return null
    const res = await fetch(data.signedUrl)
    if (!res.ok) return null
    return await blobToDataUri(await res.blob())
  } catch {
    return null
  }
}
