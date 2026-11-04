export const STYLE_FALLBACK = {
  narrative:
    "Your palette — weathered terracotta meets sage at dusk. Warm, earthy, made for golden hour.\nYour silhouettes — wide-leg trousers that skim, blazers worn open, a fluid midi dress for evening.\nWear now — reach for something in warm sand or sage this week and layer it with a textured knit.\nThe move — one anchor piece with texture and presence, everything else in quiet support.",
  archetype: 'The Considered Minimalist',
  palettes: [
    {
      name: 'Weathered Earth',
      colors: [
        { name: 'Sun-Bleached Terracotta', hex: '#B97A56' },
        { name: 'Sage at Dusk', hex: '#6B7359' },
        { name: 'Worn Espresso', hex: '#4A3F35' },
        { name: 'Warm Ivory', hex: '#FAF6F0' },
      ],
    },
  ],
  silhouettes: [
    'Wide-leg trousers that skim the leg for a long, easy line',
    'Open blazers worn loose over simple layers',
    'Fluid midi dresses with movement through the body',
    'Relaxed knitwear with dropped shoulders',
  ],
  silhouettesToAvoid: [
    'Boxy, cropped jackets that cut the line at the widest point',
    'Very stiff fabrics that sit away from the body',
  ],
  necklines: ['Open V-necks to lengthen the neck', 'Relaxed boat necks for balance at the shoulder'],
  lengths: ['Midi hems that hit below the knee', 'Full-length trousers that graze the shoe'],
  patterns: ['Small, tonal prints over large high-contrast ones', 'Soft texture in place of busy pattern'],
  outfits: [
    { name: 'Golden hour', pieces: 'Terracotta midi dress, camel sandals, a thin gold chain.' },
    { name: 'Easy weekday', pieces: 'Sage wide-leg trousers, ivory knit, tan loafers.' },
    { name: 'Evening ease', pieces: 'Espresso open blazer over an ivory slip dress, low block heels.' },
  ],
  picks: [],
}

export const COLOR_FALLBACK = {
  undertone: 'warm',
  season: 'Warm Autumn',
  flatteringColors: [
    { name: 'Sun-Bleached Terracotta', hex: '#B97A56', why: 'Echoes the warmth in your skin.' },
    { name: 'Sage at Dusk', hex: '#6B7359', why: 'A muted green that calms warm undertones.' },
    { name: 'Warm Ivory', hex: '#FAF6F0', why: 'Softer than white, so it never drains you.' },
    { name: 'Worn Espresso', hex: '#4A3F35', why: 'Depth without the harshness of black.' },
    { name: 'Burnished Camel', hex: '#C19A6B', why: 'Picks up golden tones in hair and skin.' },
  ],
  avoid: [
    { name: 'Icy Blue', hex: '#A9C6D8', why: 'Cool and pale — it fights a warm undertone.' },
    { name: 'Stark White', hex: '#FFFFFF', why: 'Too bright next to warm skin; it washes you out.' },
  ],
  picks: [],
  narrative:
    "Oh, you're a warm autumn through and through — and the palette absolutely loves you for it. Think terracotta, sage, burnished camel, all the tones that look like they've spent an afternoon in golden light, instead of icy blues or stark white. Start with the terracotta midi dress and let it do the work.",
}

export const SIZE_FALLBACK_MESSAGE =
  'The atelier is busy — here is our best estimate based on your measurements.'

export const ATELIER_BUSY_MESSAGE = 'The atelier is busy — let me try that again in a moment.'
