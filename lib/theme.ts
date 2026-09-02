// ─── Quasar's Atelier — Design System ─────────────────────────────────────────
// Single source of truth for all color, typography, spacing, and radius values.
// Import from here; never hard-code values in screens.
import { Platform } from 'react-native'

export const Colors = {
  // Brand primaries — gold accent from 2.svg (#AA9B84)
  primary:        '#AA9B84', // warm sand/gold — accents, icons, inactive nav, eyebrows
  primaryLight:   '#C4B79F', // tinted sand — hover, selected borders
  primaryDark:    '#8F8069', // deeper sand — pressed states
  primarySubtle:  '#F5F0E6', // very light sand — tinted backgrounds

  secondary:      '#423D3A', // deep warm charcoal — headings, primary actions, key surfaces
  secondaryLight: '#6B6460', // lighter charcoal — muted text, icons
  secondaryDark:  '#2A2725', // darkest charcoal — strong emphasis
  secondarySubtle:'#EDE9E3', // faint warm gray — card borders, dividers

  // Backgrounds (warm neutrals derived from secondary)
  bg:             '#FAF8F5', // main app background
  bgCard:         '#FFFFFF', // card / modal surface
  bgSubtle:       '#F2EFE8', // subtle section fill / light pills (from 2.svg)
  bgDark:         '#423D3A', // dark surface (= secondary)

  // Borders
  border:         '#E5E0D8',
  borderSubtle:   '#EDE9E3',

  // Text
  text:           '#423D3A', // primary text (on light bg)
  textMuted:      '#7A7370', // secondary / helper text
  textFaint:      '#B5B0AA', // placeholder, disabled
  textOnDark:     '#FAF8F5', // text on dark surfaces
  textOnPrimary:  '#423D3A', // text on sand buttons (sufficient contrast)

  // Semantic
  success:        '#2D7A4F',
  successBg:      '#EAF5EE',
  error:          '#B93C2A',
  errorBg:        '#FDEDEC',
  warning:        '#8B6914',
  warningBg:      '#FEF9E7',
}

// Alta font stack — elegant editorial fallback until the font file is dropped in.
// To activate Alta: add your licensed Alta.woff2 to atelier-mobile/public/fonts/
// and uncomment the @font-face block in app/_layout.tsx.
//
// IMPORTANT: React Native (iOS/Android) only accepts a SINGLE font family name —
// a CSS comma-separated stack silently breaks text metrics/rendering on device.
// So we only send the CSS stack to web; native falls back to the platform serif
// (Noto Serif on Android, Georgia/Times on iOS), which best matches the desktop look.
export const FONT = Platform.select({
  web: '"Alta", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif',
  default: 'serif',
}) as string

if (typeof console !== 'undefined' && typeof window !== 'undefined') {
  // Runs once on web startup; harmless on native
  console.info(
    '[Atelier] Alta font file not found — drop it in public/fonts/ and it will apply everywhere.',
  )
}

export const Typography = {
  display: {
    fontFamily: FONT,
    fontSize: 34,
    fontWeight: '300' as const,
    letterSpacing: 8,
    lineHeight: 44,
    color: Colors.text,
  },
  h1: {
    fontFamily: FONT,
    fontSize: 28,
    fontWeight: '400' as const,
    letterSpacing: 2,
    lineHeight: 36,
    color: Colors.text,
  },
  h2: {
    fontFamily: FONT,
    fontSize: 22,
    fontWeight: '400' as const,
    letterSpacing: 1,
    lineHeight: 30,
    color: Colors.text,
  },
  h3: {
    fontFamily: FONT,
    fontSize: 18,
    fontWeight: '500' as const,
    letterSpacing: 0.3,
    lineHeight: 26,
    color: Colors.text,
  },
  body: {
    fontFamily: FONT,
    fontSize: 15,
    fontWeight: '400' as const,
    lineHeight: 24,
    color: Colors.text,
  },
  bodySmall: {
    fontFamily: FONT,
    fontSize: 13,
    fontWeight: '400' as const,
    lineHeight: 20,
    color: Colors.text,
  },
  caption: {
    fontFamily: FONT,
    fontSize: 11,
    fontWeight: '400' as const,
    lineHeight: 16,
    color: Colors.textMuted,
  },
  label: {
    fontFamily: FONT,
    fontSize: 10,
    fontWeight: '600' as const,
    letterSpacing: 1.5,
    lineHeight: 14,
    color: Colors.textMuted,
  },
}

// Spacing scale — use only these values for margin/padding/gap
export const Space = {
  xs:   4,
  sm:   8,
  md:   12,
  base: 16,
  lg:   24,
  xl:   32,
  xxl:  48,
} as const

// Border radius scale
export const Radius = {
  sm:   8,
  md:   12,
  lg:   16,
  xl:   24,
  full: 999,
} as const

// ─── 2.svg design language ────────────────────────────────────────────────────
// The PRIMARY action ("Try it on") uses this horizontal purple→green gradient.
// Everything else uses solid charcoal (secondary) or an outlined pill.
export const Gradient = {
  primary: ['#8907E1', '#19F593'] as const, // left → right
  primaryStart: { x: 0, y: 0 },
  primaryEnd:   { x: 1, y: 0 },
}

// Soft floating shadow used by cards and the bottom nav in 2.svg.
export const Shadow = {
  card: {
    shadowColor: '#423D3A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 8,
  },
  nav: {
    shadowColor: '#423D3A',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.10,
    shadowRadius: 20,
    elevation: 20,
  },
} as const
