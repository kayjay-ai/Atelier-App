// ─── Quasar's Atelier — Design System ─────────────────────────────────────────
// Single source of truth for colour, type, spacing, radius, shadow and layout.
// Import from here; never hard-code values in screens. The look follows the
// mockups in docs/design/1–5.svg: a thin small-caps display face over
// Montserrat, charcoal ink and actions, sand marks, linen fields.
import { Platform } from 'react-native'

export const Colors = {
  // Brand — sand (docs/design/2.svg #AA9B84) and charcoal (#423D3A)
  primary:        '#AA9B84', // sand — marks, icons, inactive nav. Never small text: 2.6:1 on paper.
  primaryLight:   '#C4B79F', // tinted sand — dividers on dark, selected outlines
  primaryDark:    '#8F8069', // deeper sand — large numerals, pressed states
  primarySubtle:  '#F5F0E6', // sand wash — selected rows, info notices
  accentInk:      '#766953', // sand as text: the darkest sand that still reads as sand (4.9:1 on paper)

  secondary:      '#423D3A', // charcoal — ink, primary actions, dark stages
  secondaryLight: '#6B6460', // lighter charcoal — secondary icons
  secondaryDark:  '#2A2725', // darkest charcoal — scrims, pressed charcoal
  secondarySubtle:'#EDE9E3', // faint warm grey — skeletons, tracks

  // Surfaces
  bg:             '#FAF8F5', // paper — every page
  bgCard:         '#FFFFFF', // cards, sheets, dialogs
  bgSubtle:       '#F2EFE8', // linen — fields, chips, sunken areas (docs/design/2.svg)
  bgDark:         '#423D3A', // the dark stage (Style tab, sign-in panel, upload card)

  // Lines
  border:         '#E5E0D8', // field and card outlines
  borderSubtle:   '#EDE9E3', // dividers inside cards
  borderStrong:   '#423D3A', // focused fields, selected cards

  // Text
  text:           '#423D3A', // body and headings
  textMuted:      '#6F6865', // secondary text, hints (5.2:1 on paper)
  textFaint:      '#9C958F', // placeholders and disabled only — not for text people must read
  textOnDark:     '#FAF8F5',
  textOnDarkMuted:'rgba(250,248,245,0.72)',
  textOnPrimary:  '#423D3A',

  // Semantic
  success:        '#2D7A4F',
  successBg:      '#EAF5EE',
  error:          '#B93C2A',
  errorBg:        '#FDEDEC',
  warning:        '#8B6914',
  warningBg:      '#FEF9E7',

  scrim:          'rgba(42,39,37,0.52)',
}

// ─── Typefaces ────────────────────────────────────────────────────────────────
// Display: the mockups are set in Alta. Until a licensed Alta file is added,
// Italiana (SIL OFL) stands in: the same thin, high-contrast capitals. Body and
// interface: Montserrat, as in the mockups.
//
// Web loads the faces from public/fonts through @font-face in app/+html.tsx,
// as one family with real weights, so fontWeight picks the right file.
// iOS / Android can't map fontWeight onto a custom family, so each weight is
// its own family name (loaded by useFonts in app/_layout.tsx) — use Weight.*
// rather than a bare fontWeight.
const web = Platform.OS === 'web'

export const FONT_DISPLAY = web ? '"Alta", "Italiana", "Didot", Georgia, serif' : 'Italiana_400Regular'
const SANS = '"Montserrat", -apple-system, "Segoe UI", Roboto, sans-serif'

/** The body / interface family (regular weight on native). */
export const FONT = web ? SANS : 'Montserrat_400Regular'

export const NATIVE_FONTS = {
  regular:  'Montserrat_400Regular',
  medium:   'Montserrat_500Medium',
  semibold: 'Montserrat_600SemiBold',
  display:  'Italiana_400Regular',
} as const

const weight = (w: '400' | '500' | '600', native: string) =>
  (web ? { fontFamily: SANS, fontWeight: w } : { fontFamily: native, fontWeight: 'normal' }) as {
    fontFamily: string; fontWeight: '400' | '500' | '600' | 'normal'
  }

/** Spread after a Typography token to change its weight: { ...Typography.body, ...Weight.semibold }. */
export const Weight = {
  regular:  weight('400', NATIVE_FONTS.regular),
  medium:   weight('500', NATIVE_FONTS.medium),
  semibold: weight('600', NATIVE_FONTS.semibold),
}

const displayFace = { fontFamily: FONT_DISPLAY, fontWeight: (web ? '400' : 'normal') as '400' | 'normal' }

// Type scale: 12 · 13 · 15 · 17 · 24 · 32 · 44 (about a fourth apart above body).
// Display sizes are only for headings; Italiana is too fine below 22px.
export const Typography = {
  display: { ...displayFace, fontSize: 44, lineHeight: 50, letterSpacing: 0.5, color: Colors.text },
  h1:      { ...displayFace, fontSize: 32, lineHeight: 38, letterSpacing: 0.5, color: Colors.text },
  h2:      { ...displayFace, fontSize: 24, lineHeight: 30, letterSpacing: 0.5, color: Colors.text },
  h3:      { ...Weight.semibold, fontSize: 17, lineHeight: 24, letterSpacing: -0.1, color: Colors.text },
  body:    { ...Weight.regular, fontSize: 15, lineHeight: 23, color: Colors.text },
  bodySmall: { ...Weight.regular, fontSize: 13, lineHeight: 20, color: Colors.text },
  caption: { ...Weight.regular, fontSize: 12, lineHeight: 17, color: Colors.textMuted },
  /** Card labels in the mockups' style (COLOUR ANALYSIS). Write the text in capitals. */
  label:   { ...Weight.semibold, fontSize: 11, lineHeight: 15, letterSpacing: 1.1, color: Colors.textMuted },
  /** Form labels and small headings: sentence case. */
  fieldLabel: { ...Weight.medium, fontSize: 13, lineHeight: 18, color: Colors.text },
  button:  { ...Weight.semibold, fontSize: 15, lineHeight: 20, letterSpacing: 0.1 },
  /** Figures (credits, prices, counts, sizes): Montserrat with even-width digits.
   *  Italiana's figures are too idiosyncratic to read at a glance. */
  numeral: { ...Weight.regular, fontSize: 44, lineHeight: 50, letterSpacing: -1, fontVariant: ['tabular-nums'] as ('tabular-nums')[], color: Colors.text },
}

// Spacing scale — use only these values for margin / padding / gap.
export const Space = {
  xs:   4,
  sm:   8,
  md:   12,
  base: 16,
  lg:   24,
  xl:   32,
  xxl:  48,
} as const

// Radius follows hierarchy: the larger the surface, the larger the radius.
//   sm   chips' inner parts, thumbnails, checkboxes
//   md   fields, small tiles, menus
//   lg   cards and list rows
//   xl   hero cards, sheets, dialogs
//   full buttons, pills, segmented controls
export const Radius = {
  sm:   8,
  md:   12,
  lg:   16,
  xl:   24,
  full: 999,
} as const

// Page widths and gutters. Every page centres one column of one of these widths.
export const Layout = {
  reading: 720,   // forms, profile, single-column flows
  app:     960,   // store app pages, try-on with results side by side
  wide:    1280,  // dashboards and tables
  /** From this width the tab bar moves into the top bar (as on iPadOS 18) and sign-in splits in two. */
  desktop: 1024,
  /** Horizontal page padding for a window width. */
  gutter: (width: number) => (width < 400 ? Space.base : width < 1024 ? Space.lg : Space.xl),
} as const

// ─── docs/design/2.svg design language ──────────────────────────────────────
// The PRIMARY action ("Try it on") uses this horizontal purple→green gradient.
// Only that action: everything else is solid charcoal or an outlined pill.
export const Gradient = {
  primary: ['#8907E1', '#19F593'] as const, // left → right
  primaryStart: { x: 0, y: 0 },
  primaryEnd:   { x: 1, y: 0 },
}

// Shadows: images and floating things only. Cards of text sit on a hairline.
// boxShadow works the same on the web and on iOS / Android (React Native 0.76+).
export const Shadow = {
  /** Product and try-on image cards (docs/design/2.svg). */
  card:  { boxShadow: '0px 10px 28px rgba(66, 61, 58, 0.09)' },
  /** A small lift: the chosen segment, the focused code box. */
  lift:  { boxShadow: '0px 2px 8px rgba(42, 39, 37, 0.14)' },
  /** Menus, dialogs, toasts, drawers. */
  pop:   { boxShadow: '0px 16px 40px rgba(42, 39, 37, 0.18)' },
  nav:   { boxShadow: '0px -4px 20px rgba(66, 61, 58, 0.08)' },
  /** The gradient "Try it on" button's purple glow. */
  glow:  { boxShadow: '0px 8px 18px rgba(137, 7, 225, 0.22)' },
} as const

export const Motion = {
  fast: 160,
  base: 240,
} as const
