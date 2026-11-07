import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'

// Durable key → string storage on this device, big enough for photos stored as
// data URIs: IndexedDB on web (localStorage caps out around 5 MB), one file per
// key in the app's document directory on native. Survives reloads and sign-out.

const DB_NAME = 'atelier-local'
const STORE = 'kv'
let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function idb<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = op(d.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

const fileFor = (key: string) => `${FileSystem.documentDirectory}local-${encodeURIComponent(key)}`

export async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return (await idb<string | undefined>('readonly', (s) => s.get(key))) ?? null
  const path = fileFor(key)
  const info = await FileSystem.getInfoAsync(path)
  return info.exists ? FileSystem.readAsStringAsync(path) : null
}

export async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') { await idb('readwrite', (s) => s.put(value, key)); return }
  await FileSystem.writeAsStringAsync(fileFor(key), value)
}

export async function removeItem(key: string): Promise<void> {
  if (Platform.OS === 'web') { await idb('readwrite', (s) => s.delete(key)); return }
  await FileSystem.deleteAsync(fileFor(key), { idempotent: true })
}
