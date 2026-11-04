import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Backend-owned data lives in server/data/ (products.json + pre-generated demo try-on images).
export const PRODUCTS_PATH = path.resolve(__dirname, '../data/products.json')
export const TRYON_DIR = path.resolve(__dirname, '../data/tryon')

export function loadProducts() {
  return JSON.parse(readFileSync(PRODUCTS_PATH, 'utf-8'))
}

export function getProductById(id) {
  return loadProducts().find((p) => p.id === id)
}

/** Condensed catalog passed to Claude so it can recommend real SKUs. */
export function catalogForPrompt() {
  return loadProducts().map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    price: p.price,
    colors: p.colors,
    fabric: p.fabric,
    fit: p.fit,
    styleTags: p.styleTags,
    description: p.description,
  }))
}
