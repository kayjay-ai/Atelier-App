import { create } from 'zustand'
import { supabase } from './supabaseClient'
import { dataUriToBytes, uuidv4 } from './supabaseStorage'
import { blobToDataUri } from './dataUri'
import { useAccountStore } from './account'
import { postEvent } from './api'
import type { CustomerFolder, CustomerMeasurements, CustomerTryOn, SizeResult } from './types'

// ─── B2B customer folders ─────────────────────────────────────────────────────
// Walk-in customers live in customer_folders (15-day lifetime, enforced by RLS so
// expired folders vanish), with photos + results in the private `customer-photos`
// bucket under <store_id>/<folder_id>/. RLS scopes everything to the signed-in
// store, so these calls can only ever touch the caller's own store. The clientId
// parameters below are the store_id (account.client.id).

// Search boxes must not look like a username field: right after sign-in, browser
// password managers otherwise autofill the saved email into them. 'web-search'
// renders <input type="search">, which credential autofill skips.
export const SEARCH_INPUT_PROPS = {
  keyboardType: 'web-search',
  autoComplete: 'off',
  textContentType: 'none',
  importantForAutofill: 'no',
} as const

// "Contact Atelier" address for store staff. Unset → contact buttons are hidden.
export const SUPPORT_EMAIL = process.env.EXPO_PUBLIC_SUPPORT_EMAIL ?? ''

// In-memory working state for the Home flow, so the chosen garment and the
// current customer survive a detour to "New customer" and back.
interface StoreSessionState {
  garment: { dataUri: string; name?: string } | null
  customerId: string | null
  setGarment: (g: StoreSessionState['garment']) => void
  setCustomerId: (id: string | null) => void
  reset: () => void
}

export const useStoreSession = create<StoreSessionState>()((set) => ({
  garment: null,
  customerId: null,
  setGarment: (garment) => set({ garment }),
  setCustomerId: (customerId) => set({ customerId }),
  reset: () => set({ garment: null, customerId: null }),
}))

const BUCKET = 'customer-photos'
const SIGNED_URL_TTL_SEC = 60 * 60 // 1 h — re-signed on every list load

export const FOLDER_LIFETIME_DAYS = 15
const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days until a folder expires (0 on its last day). */
export function daysLeft(expiresAt: string): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / DAY_MS))
}

/** "Expiring soon" tag for the last 2 days (spec §2.8). */
export function expiringSoon(expiresAt: string): boolean {
  return Date.parse(expiresAt) - Date.now() < 2 * DAY_MS
}

/** Customer-facing tag for how long a folder stays: "Available for 14 days". */
export function availabilityLabel(expiresAt: string): string {
  const left = daysLeft(expiresAt)
  if (left === 0) return 'Available until today'
  return `Available for ${left} more day${left === 1 ? '' : 's'}`
}

/** "2 min ago" / "3 h ago" / "Oct 26" for the customer picker. */
export function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(iso).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
}

/** Customer phone for display — only the last 4 digits: "•••••• 4321". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length <= 4) return '••••'
  return `${'•'.repeat(Math.min(digits.length - 4, 6))} ${digits.slice(-4)}`
}

/** Phone search matches on digits only, so "98765" finds "+91 98765 43210". */
export function phoneMatches(phone: string | null | undefined, query: string): boolean {
  const q = query.replace(/\D/g, '')
  return !!q && !!phone && phone.replace(/\D/g, '').includes(q)
}

async function signedUrls(paths: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter((p): p is string => !!p))]
  const out = new Map<string, string>()
  if (unique.length === 0) return out
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(unique, SIGNED_URL_TTL_SEC)
  if (error) throw error
  for (const row of data ?? []) if (row.path && row.signedUrl) out.set(row.path, row.signedUrl)
  return out
}

async function upload(path: string, dataUri: string): Promise<void> {
  const { bytes, contentType } = dataUriToBytes(dataUri)
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { upsert: true, contentType })
  if (error) throw error
}

function toFolder(row: any, urls: Map<string, string>): CustomerFolder {
  return {
    id: row.id,
    customerName: row.customer_name,
    phone: row.phone ?? null,
    measurements: row.measurements ?? null,
    photoPath: row.photo_path ?? null,
    photoUrl: row.photo_path ? urls.get(row.photo_path) ?? null : null,
    tryonCount: row.customer_tryons?.[0]?.count ?? 0,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

const FOLDER_SELECT = 'id, customer_name, phone, measurements, photo_path, created_at, expires_at, customer_tryons(count)'

/** Active (unexpired) folders for the company, newest first. */
export async function listFolders(): Promise<CustomerFolder[]> {
  const { data, error } = await supabase
    .from('customer_folders')
    .select(FOLDER_SELECT)
    .order('created_at', { ascending: false })
  if (error) throw error
  const urls = await signedUrls((data ?? []).map((r: any) => r.photo_path))
  return (data ?? []).map((r) => toFolder(r, urls))
}

export async function getFolder(id: string): Promise<CustomerFolder | null> {
  const { data, error } = await supabase.from('customer_folders').select(FOLDER_SELECT).eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) return null
  const urls = await signedUrls([(data as any).photo_path])
  return toFolder(data, urls)
}

/** Create a folder. The database appends " (2)" etc. to a duplicate name. */
export async function createFolder(clientId: string, input: {
  customerName: string
  phone?: string
  measurements?: CustomerMeasurements | null
}): Promise<CustomerFolder> {
  const { data: session } = await supabase.auth.getSession()
  // The iPad this folder was made on (spec §7 customer_folders.device_id).
  const device = useAccountStore.getState().session?.device ?? null
  const { data, error } = await supabase
    .from('customer_folders')
    .insert({
      store_id: clientId,
      customer_name: input.customerName.trim(),
      phone: input.phone?.trim() || null,
      consent: true,
      measurements: input.measurements ?? null,
      created_by: session.session?.user?.id ?? null,
      ...(device ? { device_id: device.id } : {}),
    })
    .select(FOLDER_SELECT)
    .single()
  if (error) throw error
  const folder = toFolder(data, new Map())
  postEvent('customer_captured', { folderId: folder.id, metadata: { consent: true, measurements: !!input.measurements } })
  return folder
}

/** Upload the customer's try-on photo and attach it to their folder. */
export async function saveFolderPhoto(clientId: string, folderId: string, dataUri: string): Promise<void> {
  const path = `${clientId}/${folderId}/photo-${uuidv4()}.jpg`
  await upload(path, dataUri)
  const { error } = await supabase.from('customer_folders').update({ photo_path: path }).eq('id', folderId)
  if (error) throw error
}

export async function saveFolderMeasurements(folderId: string, m: CustomerMeasurements): Promise<void> {
  const { error } = await supabase.from('customer_folders').update({ measurements: m }).eq('id', folderId)
  if (error) throw error
}

/**
 * Delete a customer: their photo and every result image, then the folder row
 * (customer_tryons rows cascade). Files go first so nothing is left orphaned.
 */
export async function deleteFolder(clientId: string, folderId: string): Promise<void> {
  const prefix = `${clientId}/${folderId}`
  const { data: files, error: listErr } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 })
  if (listErr) throw listErr
  if (files && files.length > 0) {
    const { error: rmErr } = await supabase.storage.from(BUCKET).remove(files.map((f) => `${prefix}/${f.name}`))
    if (rmErr) throw rmErr
  }
  const { error } = await supabase.from('customer_folders').delete().eq('id', folderId)
  if (error) throw error
}

/** Admin dashboard engagement: staff shared or downloaded a result (spec §6.2). */
export function reportShared(folderId: string | null, how: 'share' | 'download' | 'download_all') {
  postEvent('result_shared', { folderId: folderId ?? undefined, metadata: { how } })
}

/** Staff picked a garment for a customer (Activity: product + brand). */
export function reportGarmentSelected(name?: string) {
  postEvent('garment_selected', { metadata: { product: name || null } })
}

/** Download a stored image as a data URI (the API takes base64 images). */
export async function storedImageDataUri(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300)
  if (error || !data?.signedUrl) throw error ?? new Error('Could not open the stored photo.')
  const res = await fetch(data.signedUrl)
  if (!res.ok) throw new Error(`Could not download the stored photo (${res.status}).`)
  return blobToDataUri(await res.blob())
}

/**
 * Record a result in the customer's folder: the garment image, plus the try-on
 * image and/or a size recommendation. Returns the new row id.
 */
export async function saveFolderResult(clientId: string, folderId: string, input: {
  garmentName?: string
  garmentDataUri: string
  resultDataUri?: string
  sizeResult?: SizeResult
}): Promise<string> {
  const id = uuidv4()
  const garmentPath = `${clientId}/${folderId}/${id}-garment.jpg`
  const resultPath = input.resultDataUri ? `${clientId}/${folderId}/${id}-tryon.jpg` : null
  await upload(garmentPath, input.garmentDataUri)
  if (resultPath && input.resultDataUri) await upload(resultPath, input.resultDataUri)

  const { data: session } = await supabase.auth.getSession()
  const { error } = await supabase.from('customer_tryons').insert({
    id,
    folder_id: folderId,
    store_id: clientId,
    garment_name: input.garmentName ?? null,
    garment_path: garmentPath,
    result_path: resultPath,
    size_result: input.sizeResult ?? null,
    created_by: session.session?.user?.id ?? null,
  })
  if (error) throw error
  postEvent('result_saved', {
    folderId,
    metadata: { kind: resultPath ? 'tryon' : 'size', product: input.garmentName ?? null },
  })
  return id
}

/** Attach a size recommendation to an existing result row. */
export async function saveSizeOnResult(resultId: string, sizeResult: SizeResult): Promise<void> {
  const { error } = await supabase.from('customer_tryons').update({ size_result: sizeResult }).eq('id', resultId)
  if (error) throw error
}

export async function listFolderResults(folderId: string): Promise<CustomerTryOn[]> {
  const { data, error } = await supabase
    .from('customer_tryons')
    .select('id, folder_id, garment_name, garment_path, result_path, size_result, created_at')
    .eq('folder_id', folderId)
    .order('created_at', { ascending: false })
  if (error) throw error
  const rows = data ?? []
  const urls = await signedUrls(rows.flatMap((r: any) => [r.garment_path, r.result_path]))
  return rows.map((r: any) => ({
    id: r.id,
    folderId: r.folder_id,
    garmentName: r.garment_name ?? null,
    garmentUrl: r.garment_path ? urls.get(r.garment_path) ?? null : null,
    resultUrl: r.result_path ? urls.get(r.result_path) ?? null : null,
    sizeResult: r.size_result ?? null,
    createdAt: r.created_at,
  }))
}
