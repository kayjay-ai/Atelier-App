import type { Account, CustomerFolder, CustomerMeasurements, CustomerTryOn, Plan, SizeResult } from './types'
import { getItem, setItem, removeItem } from './localStore'

// ─── B2B demo company (preview only) ──────────────────────────────────────────
// Lets the store app be reviewed before the B2B Supabase tables exist. Enabled
// ONLY when EXPO_PUBLIC_B2B_DEMO_EMAIL is set; signing in with that email opens
// the store app with a mock company. Its customer folders are saved on this
// device (lib/localStore.ts), so they survive reloads and sign-out, but are never
// synced anywhere. It grants nothing server-side: try-ons still go through the
// real API under that login. Remove the env var once the real tables are live.

const DEMO_EMAIL = (process.env.EXPO_PUBLIC_B2B_DEMO_EMAIL ?? '').trim().toLowerCase()
export const DEMO_CLIENT_ID = 'demo-company'

export function isDemoCompanyEmail(email?: string | null): boolean {
  return !!DEMO_EMAIL && (email ?? '').trim().toLowerCase() === DEMO_EMAIL
}

const PLANS: Plan[] = [
  { id: 'Starter',  name: 'Starter',  priceInr: 8000,  cycle: 'monthly', creditsIncluded: 1000, topupPriceInr: null },
  { id: 'Pro',      name: 'Pro',      priceInr: 14000, cycle: 'monthly', creditsIncluded: 2000, topupPriceInr: null },
  { id: 'Business', name: 'Business', priceInr: 18000, cycle: 'monthly', creditsIncluded: 3000, topupPriceInr: null },
  { id: 'Scale',    name: 'Scale',    priceInr: 25000, cycle: 'monthly', creditsIncluded: 5000, topupPriceInr: null },
]

let credits = 240

export function demoAccount(): Account {
  return {
    type: 'b2b_company',
    role: 'admin',
    client: {
      id: DEMO_CLIENT_ID,
      companyName: 'Westside Retail (Demo)',
      storeName: 'Bandra',
      logoUrl: null,
      contactName: 'Store Manager',
      contactEmail: DEMO_EMAIL,
      contactPhone: '+91 98765 43210',
      gstin: '27AAAAA0000A1Z5',
      billingAddress: 'Linking Road, Bandra West, Mumbai 400050',
      planId: 'Starter',
      creditsBalance: credits,
      status: 'active',
      trialEndsAt: null,
      renewalAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
    plan: PLANS[0],
    plans: PLANS,
    stores: [
      { id: 'demo-store-1', name: 'Bandra Flagship', city: 'Mumbai', address: 'Linking Road' },
      { id: 'demo-store-2', name: 'Phoenix Mall', city: 'Pune', address: 'Viman Nagar' },
    ],
    features: { tryon: true, style: true, size: true },
  }
}

// ── Folders (mirrors lib/b2b.ts), kept in memory and saved on the device ──────
// "Paths" are keys into `images`; the data URI doubles as the display URL. The
// folder/result records are saved as one entry, each image as its own entry.

const DAY_MS = 24 * 60 * 60 * 1000
const STATE_KEY = 'demo-company:state'
const IMAGE_KEY = (path: string) => `demo-company:img:${path}`
type ResultRow = Omit<CustomerTryOn, 'garmentUrl' | 'resultUrl'> & { garmentPath: string; resultPath: string | null }

const images = new Map<string, string>()
const folders: { folder: CustomerFolder; createdBy: string }[] = []
const results: ResultRow[] = []
let seq = 0
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`

const warn = (err: unknown) => console.warn('[Atelier] demo folders could not be saved on this device:', err)

function persist() {
  setItem(STATE_KEY, JSON.stringify({ credits, folders, results })).catch(warn)
}

function putImage(path: string, uri: string) {
  images.set(path, uri)
  setItem(IMAGE_KEY(path), uri).catch(warn)
}

function dropImage(path: string | null) {
  if (!path) return
  images.delete(path)
  removeItem(IMAGE_KEY(path)).catch(warn)
}

let restored: Promise<void> | null = null

/** Load the saved folders once per app start; expired ones are deleted. */
export function demoReady(): Promise<void> {
  restored ??= (async () => {
    try {
      const raw = await getItem(STATE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as { credits?: number; folders?: typeof folders; results?: ResultRow[] }
      if (typeof saved.credits === 'number') credits = saved.credits
      const now = Date.now()
      const live = (saved.folders ?? []).filter((x) => Date.parse(x.folder.expiresAt) > now)
      const liveIds = new Set(live.map((x) => x.folder.id))
      folders.push(...live)
      for (const r of saved.results ?? []) {
        if (liveIds.has(r.folderId)) results.push(r)
        else { dropImage(r.garmentPath); dropImage(r.resultPath) }
      }
      for (const x of saved.folders ?? []) if (!liveIds.has(x.folder.id)) dropImage(x.folder.photoPath)
      const paths = [...folders.map((x) => x.folder.photoPath), ...results.flatMap((r) => [r.garmentPath, r.resultPath])]
      await Promise.all(paths.map(async (p) => {
        if (!p) return
        const uri = await getItem(IMAGE_KEY(p))
        if (uri) images.set(p, uri)
      }))
      if (live.length !== (saved.folders ?? []).length) persist()
    } catch (err) {
      console.warn('[Atelier] saved demo folders could not be restored:', err)
    }
  })()
  return restored
}

function view(f: CustomerFolder): CustomerFolder {
  return {
    ...f,
    photoUrl: f.photoPath ? images.get(f.photoPath) ?? null : null,
    tryonCount: results.filter((r) => r.folderId === f.id).length,
  }
}

// Every method waits for demoReady(), so nothing reads or writes before the
// saved folders are back in memory.
export const demoFolders = {
  async list(): Promise<CustomerFolder[]> {
    await demoReady()
    return folders
      .map((x) => x.folder)
      .filter((f) => Date.parse(f.expiresAt) > Date.now())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(view)
  },
  async get(id: string): Promise<CustomerFolder | null> {
    await demoReady()
    const f = folders.find((x) => x.folder.id === id)?.folder
    return f ? view(f) : null
  },
  async create(input: { customerName: string; phone?: string; measurements?: CustomerMeasurements | null }): Promise<CustomerFolder> {
    await demoReady()
    const base = input.customerName.trim()
    let name = base
    for (let n = 2; folders.some((x) => x.folder.customerName === name); n++) name = `${base} (${n})`
    const now = Date.now()
    const folder: CustomerFolder = {
      id: nextId('folder'),
      customerName: name,
      phone: input.phone?.trim() || null,
      measurements: input.measurements ?? null,
      photoPath: null,
      photoUrl: null,
      tryonCount: 0,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15 * DAY_MS).toISOString(),
    }
    folders.push({ folder, createdBy: 'demo' })
    persist()
    return view(folder)
  },
  async setPhoto(folderId: string, dataUri: string): Promise<void> {
    await demoReady()
    const f = folders.find((x) => x.folder.id === folderId)?.folder
    if (!f) throw new Error('Folder not found.')
    const path = nextId('photo')
    dropImage(f.photoPath)
    putImage(path, dataUri)
    f.photoPath = path
    persist()
  },
  async setMeasurements(folderId: string, m: CustomerMeasurements): Promise<void> {
    await demoReady()
    const f = folders.find((x) => x.folder.id === folderId)?.folder
    if (!f) throw new Error('Folder not found.')
    f.measurements = m
    persist()
  },
  async remove(folderId: string): Promise<void> {
    await demoReady()
    const i = folders.findIndex((x) => x.folder.id === folderId)
    if (i < 0) return
    dropImage(folders[i].folder.photoPath)
    folders.splice(i, 1)
    for (let j = results.length - 1; j >= 0; j--) {
      if (results[j].folderId !== folderId) continue
      dropImage(results[j].garmentPath)
      dropImage(results[j].resultPath)
      results.splice(j, 1)
    }
    persist()
  },
  async image(path: string): Promise<string> {
    await demoReady()
    const uri = images.get(path)
    if (!uri) throw new Error('Could not open the stored photo.')
    return uri
  },
  async saveResult(folderId: string, input: { garmentName?: string; garmentDataUri: string; resultDataUri?: string; sizeResult?: SizeResult }): Promise<string> {
    await demoReady()
    const id = nextId('result')
    const garmentPath = `${id}-garment`
    putImage(garmentPath, input.garmentDataUri)
    let resultPath: string | null = null
    if (input.resultDataUri) {
      resultPath = `${id}-tryon`
      putImage(resultPath, input.resultDataUri)
      credits = Math.max(0, credits - 1) // mirror the 1 company credit a real try-on spends
    }
    results.push({
      id, folderId,
      garmentName: input.garmentName ?? null,
      garmentPath, resultPath,
      sizeResult: input.sizeResult ?? null,
      createdAt: new Date().toISOString(),
    })
    persist()
    return id
  },
  async setSize(resultId: string, sizeResult: SizeResult): Promise<void> {
    await demoReady()
    const r = results.find((x) => x.id === resultId)
    if (r) { r.sizeResult = sizeResult; persist() }
  },
  async results(folderId: string): Promise<CustomerTryOn[]> {
    await demoReady()
    return results
      .filter((r) => r.folderId === folderId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ garmentPath, resultPath, ...rest }) => ({
        ...rest,
        garmentUrl: images.get(garmentPath) ?? null,
        resultUrl: resultPath ? images.get(resultPath) ?? null : null,
      }))
  },
  credits: () => credits,
}
