// =============================================================================
// The AI features, under one name each, and what that name maps to in every
// other vocabulary:
//   embedKey   — website-embed partner toggle (embedClients.mjs FEATURE_KEYS)
//   storeKey   — B2B store toggle (b2b_store_features.feature)
//   partnerCost — credits an embed partner spends per call (credits.mjs)
//   ledgers    — also spends a B2B store / B2C member credit (try-on only)
// A null key means that gate doesn't apply to the feature.
// =============================================================================

export const FEATURES = {
  tryon:   { embedKey: 'virtual_tryon',      storeKey: 'tryon', partnerCost: 1, ledgers: true },
  style:   { embedKey: 'style_color_assist', storeKey: 'style', partnerCost: 1, ledgers: false },
  // Colour analysis is half of "Style me", so it follows the style toggles.
  color:   { embedKey: 'style_color_assist', storeKey: 'style', partnerCost: 1, ledgers: false },
  size:    { embedKey: 'size_assist',        storeKey: 'size',  partnerCost: 0, ledgers: false },
  // "Should I buy it?" and the garment safety screen are free and ungated.
  verdict: { embedKey: null,                 storeKey: null,    partnerCost: 0, ledgers: false },
  safety:  { embedKey: null,                 storeKey: null,    partnerCost: 0, ledgers: false },
}

export function featureSpec(feature) {
  const spec = FEATURES[feature]
  if (!spec) throw new Error(`Unknown feature: ${feature}`)
  return spec
}
