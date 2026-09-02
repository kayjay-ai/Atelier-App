// ─── Shared UI primitives — the 2.svg design language ─────────────────────────
// One Icon set + one Button system so every screen reads as a single design.
import { ReactNode } from 'react'
import {
  Text, View, TouchableOpacity, ActivityIndicator, StyleSheet, SafeAreaView,
  StyleProp, ViewStyle, TextStyle,
} from 'react-native'
import { MaterialCommunityIcons } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import { Colors, Typography, Space, Radius, Gradient, FONT } from './theme'

// ─── Shared app header ────────────────────────────────────────────────────────
// The Quasar's Atelier branding, rendered ONCE in the tab layout so every page
// gets pixel-identical placement. Do not duplicate this per-screen.
export function AppHeader() {
  return (
    <SafeAreaView style={hdr.safe}>
      <View style={hdr.wrap}>
        <Text style={hdr.sub}>QUASAR'S</Text>
        <Text style={hdr.mark}>ATELIER</Text>
      </View>
    </SafeAreaView>
  )
}

const hdr = StyleSheet.create({
  safe: { backgroundColor: Colors.bg },
  wrap: { paddingHorizontal: Space.lg, paddingTop: Space.lg, paddingBottom: Space.md },
  sub:  { ...Typography.label, color: Colors.primary, letterSpacing: 4, fontSize: 9 },
  mark: { ...Typography.h2, letterSpacing: 5, marginTop: -2 },
})

// ─── Icons ────────────────────────────────────────────────────────────────────
// Thin-line MaterialCommunityIcons matching the reference. Reference semantic
// names here — never the raw glyph — so the icon set stays swappable in one place.
const ICON = {
  tryOn:    'auto-fix',            // magic wand + sparkles
  style:    'hanger',
  premium:  'diamond-stone',
  profile:  'account',
  history:  'history',
  trash:    'trash-can-outline',
  upload:   'tray-arrow-up',
  imageUpload: 'image-plus-outline', // refined "add an image" glyph

  size:     'arrow-expand',        // resize arrows — "Find my size"
  reveal:   'auto-fix',
  download: 'download',
  crown:    'crown',
  check:    'check',
  close:    'close',
  help:     'help',
  edit:     'pencil',
  logout:   'logout',
  back:     'arrow-left',
  refresh:  'refresh',
  camera:   'tray-arrow-up',
  star:     'star-four-points',
} as const

export type IconName = keyof typeof ICON

export function Icon({
  name, size = 22, color = Colors.text, style,
}: { name: IconName; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  return <MaterialCommunityIcons name={ICON[name] as any} size={size} color={color} style={style} />
}

// ─── Buttons ──────────────────────────────────────────────────────────────────
// Full-width pills. primary = purple→green gradient, secondary = solid charcoal,
// outline = charcoal-bordered transparent. All share size + typography.
type Variant = 'primary' | 'secondary' | 'outline'

export function PillButton({
  label, onPress, variant = 'secondary', icon, loading = false, disabled = false, style,
}: {
  label: string
  onPress: () => void
  variant?: Variant
  icon?: IconName
  loading?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const onDark = variant !== 'outline'
  const fg = onDark ? Colors.textOnDark : Colors.text

  const inner: ReactNode = loading
    ? <ActivityIndicator color={fg} />
    : (
      <View style={b.row}>
        {icon && <Icon name={icon} size={20} color={fg} />}
        <Text style={[b.label, { color: fg }]}>{label}</Text>
      </View>
    )

  const isDisabled = disabled || loading

  if (variant === 'primary') {
    return (
      <TouchableOpacity
        onPress={onPress} disabled={isDisabled} activeOpacity={0.85}
        style={[b.pill, b.shadow, isDisabled && b.disabled, style]}
      >
        <LinearGradient
          colors={Gradient.primary}
          start={Gradient.primaryStart} end={Gradient.primaryEnd}
          style={b.pillFill}
        >
          {inner}
        </LinearGradient>
      </TouchableOpacity>
    )
  }

  return (
    <TouchableOpacity
      onPress={onPress} disabled={isDisabled} activeOpacity={0.85}
      style={[
        b.pill, b.pillFill,
        variant === 'secondary' ? b.solid : b.outline,
        isDisabled && b.disabled, style,
      ]}
    >
      {inner}
    </TouchableOpacity>
  )
}

const b = StyleSheet.create({
  pill: { borderRadius: Radius.full, overflow: 'hidden' },
  pillFill: {
    minHeight: 56, paddingVertical: 16, paddingHorizontal: Space.lg,
    alignItems: 'center', justifyContent: 'center',
  },
  solid:   { backgroundColor: Colors.secondary },
  outline: { backgroundColor: 'transparent', borderWidth: 2, borderColor: Colors.secondary },
  disabled: { opacity: 0.55 },
  row:   { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  label: {
    fontFamily: FONT,
    fontSize: 16, fontWeight: '600', letterSpacing: 0.3,
  },
  shadow: {
    shadowColor: '#8907E1', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28, shadowRadius: 16, elevation: 6,
  },
})
