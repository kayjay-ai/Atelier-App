// ─── Shared UI kit — the docs/design/*.svg design language ────────────────────
// One set of pieces so every screen (shopper app, store app, owner portal)
// reads as one product: the wordmark, small-caps titles, buttons, fields,
// notices, segmented controls, chips, checkboxes, cards, skeletons, empty
// states, the page frame, the tab bars, toasts and dialogs.
import { ReactNode, useEffect, useRef, useState } from 'react'
import {
  Text, View, TextInput, TouchableOpacity, Pressable, ActivityIndicator, StyleSheet, ScrollView, Modal,
  Animated, Platform, AccessibilityInfo, useWindowDimensions,
  type StyleProp, type ViewStyle, type TextStyle, type TextInputProps, type ScrollViewProps,
} from 'react-native'
import { MaterialCommunityIcons } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import { create } from 'zustand'
import { Colors, Typography, Space, Radius, Gradient, Shadow, Layout, Weight, FONT_DISPLAY } from './theme'

const web = Platform.OS === 'web'
/** Removes the browser's own focus outline on inputs that draw their own focus state. */
const noOutline = web ? ({ outlineStyle: 'none' } as object) : null

/**
 * Spread onto a <Text> set in the display face. On the web it tags the text so
 * app/+html.tsx can firm up Italiana's hairlines, which thin out below ~28px.
 */
export function displayProps(fontSize: number): object {
  if (!web) return {}
  return { dataSet: { display: fontSize < 24 ? 'sm' : fontSize < 36 ? 'md' : 'lg' } }
}

// ─── Motion ──────────────────────────────────────────────────────────────────
/** True when the person asked their device for less motion. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let live = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (live) setReduced(v) }).catch(() => {})
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => { live = false; sub?.remove?.() }
  }, [])
  return reduced
}

// ─── Icons ───────────────────────────────────────────────────────────────────
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
  imageUpload: 'image-plus-outline',

  size:     'arrow-expand',        // resize arrows — "Find my size"
  reveal:   'auto-fix',
  download: 'download',
  crown:    'crown',
  check:    'check',
  close:    'close',
  help:     'help',
  edit:     'pencil-outline',
  logout:   'logout',
  back:     'arrow-left',
  arrowRight: 'arrow-right',
  refresh:  'refresh',
  camera:   'tray-arrow-up',
  star:     'star-four-points',
  plus:     'plus',

  // B2B store app
  company:     'storefront-outline',
  newCustomer: 'account-plus-outline',
  gallery:     'image-multiple-outline',
  takePhoto:   'camera-outline',
  search:      'magnify',
  share:       'share-variant-outline',
  clock:       'clock-outline',
  chevron:     'chevron-right',
  link:        'link-variant',

  // Owner portal
  home:        'home-variant-outline',
  storePlus:   'store-plus-outline',
  bell:        'bell-outline',
  eye:         'eye-outline',
  eyeOff:      'eye-off-outline',
  copy:        'content-copy',
  dots:        'dots-horizontal',
  chevronDown: 'chevron-down',
  chevronLeft: 'chevron-left',
  arrowUp:     'arrow-up',
  arrowDown:   'arrow-down',
  devices:     'tablet-cellphone',
  tablet:      'tablet',
  credits:     'star-four-points-outline',
  payment:     'credit-card-outline',
  gift:        'gift-outline',
  offer:       'tag-outline',
  shield:      'shield-check-outline',
  alert:       'alert-circle-outline',
  mail:        'email-outline',
  activity:    'storefront-outline',
  filter:      'filter-variant',
  info:        'information-outline',
  success:     'check-circle-outline',
  lock:        'lock-outline',
  google:      'google',
  apple:       'apple',
} as const

export type IconName = keyof typeof ICON

export function Icon({
  name, size = 22, color = Colors.text, style,
}: { name: IconName; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  return <MaterialCommunityIcons name={ICON[name] as any} size={size} color={color} style={style} />
}

// ─── Wordmark ────────────────────────────────────────────────────────────────
// QUASAR'S over ATELIER. One component, so every header and sign-in page sets
// it identically.
export function Wordmark({ size = 'md', tone = 'dark', align = 'center', suffix }: {
  size?: 'sm' | 'md' | 'lg'; tone?: 'dark' | 'light'; align?: 'left' | 'center'; suffix?: string
}) {
  const mark = size === 'lg' ? 40 : size === 'md' ? 30 : 22
  return (
    <View style={{ alignItems: align === 'center' ? 'center' : 'flex-start' }} accessibilityRole="header" accessibilityLabel={`Quasar's Atelier${suffix ? `, ${suffix}` : ''}`}>
      <Text style={[w.sub, { fontSize: size === 'sm' ? 9 : 10, color: tone === 'light' ? Colors.primaryLight : Colors.accentInk }]}>
        QUASAR’S{suffix ? `  ·  ${suffix.toUpperCase()}` : ''}
      </Text>
      <Text {...displayProps(mark)} style={[w.mark, { fontSize: mark, lineHeight: mark * 1.1, letterSpacing: mark * 0.2, color: tone === 'light' ? Colors.textOnDark : Colors.text }]}>
        ATELIER
      </Text>
    </View>
  )
}

const w = StyleSheet.create({
  sub:  { ...Weight.semibold, letterSpacing: 3.5, lineHeight: 14 },
  // letterSpacing adds space after the last letter too; pull it back so the mark centres.
  mark: { fontFamily: FONT_DISPLAY, marginRight: -6 },
})

// ─── Title: the mockups' small capitals ──────────────────────────────────────
// "Found Something You Love?" is set with each word's first letter at full
// size and the rest as smaller capitals (docs/design/1.svg). This is the one
// typographic signature: page titles and the sign-in stage only.
export function Title({ children, size = 'h1', tone = 'dark', align, style, numberOfLines }: {
  children: string; size?: 'display' | 'h1' | 'h2'; tone?: 'dark' | 'light'
  align?: 'left' | 'center'; style?: StyleProp<TextStyle>; numberOfLines?: number
}) {
  const base = Typography[size]
  const small = Math.round(base.fontSize * 0.8)
  const words = children.split(/(\s+)/)
  return (
    <Text
      {...displayProps(base.fontSize)}
      style={[base, { color: tone === 'light' ? Colors.textOnDark : Colors.text, textAlign: align }, style]}
      accessibilityRole="header" numberOfLines={numberOfLines}
      accessibilityLabel={children}
    >
      {words.map((part, i) => {
        if (!part.trim()) return part
        // Italiana's ampersand reads as an "e"; set it in the body face.
        if (part === '&') return <Text key={i} style={[Weight.regular, { fontSize: small }]}>&</Text>
        const first = part[0].toUpperCase()
        const rest = part.slice(1).toUpperCase()
        return (
          <Text key={i}>
            {first}
            {!!rest && <Text style={{ fontSize: small }}>{rest}</Text>}
          </Text>
        )
      })}
    </Text>
  )
}

/** Someone without a photo: their initials in the display face. */
export function Initials({ name, size = 30, tone = 'dark' }: { name: string; size?: number; tone?: 'dark' | 'light' }) {
  const letters = name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <Text {...displayProps(size)} accessibilityElementsHidden importantForAccessibility="no"
      style={{ fontFamily: FONT_DISPLAY, fontSize: size, lineHeight: size * 1.15, letterSpacing: 1, color: tone === 'light' ? Colors.textOnDark : Colors.accentInk }}>
      {letters}
    </Text>
  )
}

// ─── Buttons ─────────────────────────────────────────────────────────────────
// Pills. primary = the purple→green gradient, kept for "Try it on" alone;
// secondary = solid charcoal (the everyday action); outline = charcoal border;
// ghost = text only; danger = red; gold = sand on the dark stage; light =
// white on the dark stage.
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'gold' | 'light'
export type ButtonSize = 'sm' | 'md' | 'lg'

const BTN_H: Record<ButtonSize, number> = { sm: 40, md: 48, lg: 56 }
const BTN_FONT: Record<ButtonSize, number> = { sm: 14, md: 15, lg: 16 }

export function PillButton({
  label, onPress, variant = 'secondary', size = 'lg', icon, loading = false, disabled = false, style, accessibilityLabel,
}: {
  label: string
  onPress: () => void
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  loading?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  accessibilityLabel?: string
}) {
  const fg = variant === 'primary' || variant === 'secondary' || variant === 'danger' ? Colors.textOnDark
    : variant === 'light' || variant === 'gold' ? Colors.secondary
      : variant === 'ghost' ? Colors.secondary : Colors.text
  const isDisabled = disabled || loading
  const height = BTN_H[size]

  const inner: ReactNode = loading
    ? <ActivityIndicator color={fg} />
    : (
      <View style={b.row}>
        {icon && <Icon name={icon} size={size === 'sm' ? 16 : 20} color={fg} />}
        <Text style={[Typography.button, { fontSize: BTN_FONT[size], color: fg }]} numberOfLines={1}>{label}</Text>
      </View>
    )

  const frame = [b.pill, { minHeight: height, paddingHorizontal: size === 'sm' ? Space.base : Space.lg }]
  const a11y = {
    accessibilityRole: 'button' as const,
    accessibilityLabel: accessibilityLabel ?? label,
    accessibilityState: { disabled: isDisabled, busy: loading },
  }

  if (variant === 'primary') {
    return (
      <TouchableOpacity onPress={onPress} disabled={isDisabled} activeOpacity={0.88} {...a11y}
        style={[b.pill, b.glow, isDisabled && b.disabled, style]}>
        <LinearGradient colors={Gradient.primary} start={Gradient.primaryStart} end={Gradient.primaryEnd} style={[frame, b.center]}>
          {inner}
        </LinearGradient>
      </TouchableOpacity>
    )
  }

  return (
    <TouchableOpacity onPress={onPress} disabled={isDisabled} activeOpacity={0.82} {...a11y}
      style={[frame, b.center, b[variant], isDisabled && b.disabled, style]}>
      {inner}
    </TouchableOpacity>
  )
}

const b = StyleSheet.create({
  pill:   { borderRadius: Radius.full, overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
  row:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.sm },
  secondary: { backgroundColor: Colors.secondary },
  outline:   { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: Colors.secondary },
  ghost:     { backgroundColor: 'transparent' },
  danger:    { backgroundColor: Colors.error },
  gold:      { backgroundColor: Colors.primary },
  light:     { backgroundColor: Colors.bgCard },
  disabled:  { opacity: 0.45 },
  glow: { ...Shadow.glow },
})

/** A quiet text action ("Edit", "See all", "Resend code"). */
export function TextLink({ label, onPress, tone = 'ink', icon, style }: {
  label: string; onPress: () => void; tone?: 'ink' | 'muted' | 'danger' | 'light'; icon?: IconName; style?: StyleProp<ViewStyle>
}) {
  const color = tone === 'muted' ? Colors.textMuted : tone === 'danger' ? Colors.error : tone === 'light' ? Colors.textOnDark : Colors.secondary
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="link" hitSlop={8} style={[{ flexDirection: 'row', alignItems: 'center', gap: Space.xs, paddingVertical: Space.xs }, style]}>
      {icon && <Icon name={icon} size={16} color={color} />}
      <Text style={[Typography.bodySmall, Weight.semibold, { color }]}>{label}</Text>
    </TouchableOpacity>
  )
}

// ─── Fields ──────────────────────────────────────────────────────────────────
// Label above, linen field, charcoal outline while focused, the error or hint
// below. `pill` rounds the field fully, for a field that sits beside a pill
// button (the product link on Home).
export function Field({
  label, error, hint, right, left, optional, pill, containerStyle, inputStyle, tone = 'light', ...input
}: TextInputProps & {
  label?: string; error?: string | null; hint?: string; right?: ReactNode; left?: ReactNode; optional?: boolean
  pill?: boolean; containerStyle?: StyleProp<ViewStyle>; inputStyle?: StyleProp<TextStyle>; tone?: 'light' | 'card'
}) {
  const [focused, setFocused] = useState(false)
  const disabled = input.editable === false
  return (
    <View style={[f.field, containerStyle]}>
      {!!label && (
        <Text style={f.label}>
          {label}{optional ? <Text style={f.optional}>  Optional</Text> : null}
        </Text>
      )}
      <View style={[
        f.wrap, tone === 'card' && f.wrapCard, pill && f.pill,
        focused && f.wrapFocus, !!error && f.wrapError, disabled && f.wrapDisabled,
      ]}>
        {left}
        <TextInput
          placeholderTextColor={Colors.textFaint}
          {...input}
          onFocus={(e) => { setFocused(true); input.onFocus?.(e) }}
          onBlur={(e) => { setFocused(false); input.onBlur?.(e) }}
          style={[f.input, pill && { paddingHorizontal: Space.lg }, input.multiline && f.multi, noOutline, inputStyle, input.style]}
          accessibilityLabel={input.accessibilityLabel ?? label}
        />
        {right}
      </View>
      {!!error && (
        <View style={f.msgRow} accessibilityLiveRegion="polite">
          <Icon name="alert" size={14} color={Colors.error} />
          <Text style={f.error}>{error}</Text>
        </View>
      )}
      {!error && !!hint && <Text style={f.hint}>{hint}</Text>}
    </View>
  )
}

export function PasswordField(props: TextInputProps & { label: string; error?: string | null; hint?: string; containerStyle?: StyleProp<ViewStyle> }) {
  const [shown, setShown] = useState(false)
  return (
    <Field
      {...props}
      secureTextEntry={!shown}
      autoCapitalize="none"
      autoCorrect={false}
      right={(
        <TouchableOpacity
          onPress={() => setShown((v) => !v)} style={f.eye}
          accessibilityRole="button" accessibilityLabel={shown ? 'Hide password' : 'Show password'}
        >
          <Icon name={shown ? 'eyeOff' : 'eye'} size={20} color={Colors.textMuted} />
        </TouchableOpacity>
      )}
    />
  )
}

const f = StyleSheet.create({
  field: { marginTop: Space.base, gap: 6 },
  label: { ...Typography.fieldLabel },
  optional: { ...Typography.caption, color: Colors.textMuted },
  wrap: {
    flexDirection: 'row', alignItems: 'center', minHeight: 50,
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, borderWidth: 1.5, borderColor: 'transparent',
  },
  wrapCard: { backgroundColor: Colors.bgCard, borderColor: Colors.border },
  pill: { borderRadius: Radius.full, borderColor: Colors.secondary },
  wrapFocus: { borderColor: Colors.borderStrong, backgroundColor: Colors.bgCard },
  wrapError: { borderColor: Colors.error },
  wrapDisabled: { opacity: 0.65 },
  // minWidth 0: a web <input> otherwise won't shrink and pushes past its row.
  input: { flex: 1, minWidth: 0, paddingHorizontal: Space.base, paddingVertical: 13, ...Typography.body, color: Colors.text },
  multi: { minHeight: 104, textAlignVertical: 'top' },
  eye: { paddingHorizontal: Space.md, alignSelf: 'stretch', justifyContent: 'center' },
  msgRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  error: { ...Typography.caption, color: Colors.error, flex: 1 },
  hint: { ...Typography.caption, color: Colors.textMuted },
})

/** A search field with the magnifier and a clear button. */
export function SearchField({ value, onChangeText, placeholder, tone = 'card', style, ...rest }: TextInputProps & {
  value: string; onChangeText: (v: string) => void; tone?: 'light' | 'card'; style?: StyleProp<ViewStyle>
}) {
  return (
    <Field
      {...rest}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      tone={tone}
      pill
      containerStyle={[{ marginTop: 0 }, style]}
      inputStyle={{ paddingHorizontal: Space.sm }}
      autoCorrect={false}
      accessibilityLabel={rest.accessibilityLabel ?? placeholder}
      left={<View style={{ paddingLeft: Space.base }}><Icon name="search" size={18} color={Colors.textMuted} /></View>}
      right={value ? (
        <TouchableOpacity onPress={() => onChangeText('')} accessibilityLabel="Clear search" hitSlop={8} style={{ paddingHorizontal: Space.md }}>
          <Icon name="close" size={16} color={Colors.textMuted} />
        </TouchableOpacity>
      ) : null}
    />
  )
}

// ─── Notices ─────────────────────────────────────────────────────────────────
// Inline messages: what happened and what to do. One component for errors,
// warnings, information and confirmations.
export type NoticeTone = 'error' | 'warning' | 'info' | 'success'

export const NOTICE_TONES: Record<NoticeTone, { fg: string; bg: string; icon: IconName }> = {
  error:   { fg: Colors.error,     bg: Colors.errorBg,       icon: 'alert' },
  warning: { fg: Colors.warning,   bg: Colors.warningBg,     icon: 'alert' },
  info:    { fg: Colors.secondary, bg: Colors.primarySubtle, icon: 'info' },
  success: { fg: Colors.success,   bg: Colors.successBg,     icon: 'success' },
}

export function Notice({ tone = 'error', title, text, actionLabel, onAction, onClose, style }: {
  tone?: NoticeTone; title?: string; text: string; actionLabel?: string; onAction?: () => void
  onClose?: () => void; style?: StyleProp<ViewStyle>
}) {
  const c = NOTICE_TONES[tone]
  return (
    <View style={[n.box, { backgroundColor: c.bg }, style]} accessibilityRole={tone === 'error' ? 'alert' : undefined} accessibilityLiveRegion="polite">
      <Icon name={c.icon} size={18} color={c.fg} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 2 }}>
        {!!title && <Text style={[n.title, { color: c.fg }]}>{title}</Text>}
        <Text style={[n.text, { color: tone === 'info' ? Colors.text : c.fg }]}>{text}</Text>
        {actionLabel && onAction && (
          <TouchableOpacity onPress={onAction} accessibilityRole="button" style={{ alignSelf: 'flex-start', marginTop: Space.xs }}>
            <Text style={[n.action, { color: c.fg }]}>{actionLabel}</Text>
          </TouchableOpacity>
        )}
      </View>
      {onClose && (
        <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss">
          <Icon name="close" size={18} color={c.fg} />
        </TouchableOpacity>
      )}
    </View>
  )
}

const n = StyleSheet.create({
  box:    { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm, paddingVertical: Space.md, paddingHorizontal: Space.base, borderRadius: Radius.md },
  title:  { ...Typography.bodySmall, ...Weight.semibold },
  text:   { ...Typography.bodySmall },
  action: { ...Typography.bodySmall, ...Weight.semibold, textDecorationLine: 'underline' },
})

// ─── Segmented control ───────────────────────────────────────────────────────
// Two to four exclusive options in one linen pill; the chosen one is charcoal.
export function Segmented<T extends string>({ options, value, onChange, size = 'md', disabled, style, accessibilityLabel }: {
  options: readonly { value: T; label: string; hint?: string }[]
  value: T; onChange: (v: T) => void; size?: 'sm' | 'md' | 'lg'; disabled?: boolean
  style?: StyleProp<ViewStyle>; accessibilityLabel?: string
}) {
  const h = size === 'lg' ? 56 : size === 'md' ? 44 : 36
  return (
    <View style={[sg.row, style]} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <TouchableOpacity
            key={o.value}
            style={[sg.btn, { minHeight: h - 8 }, on && sg.btnOn]}
            onPress={() => onChange(o.value)}
            disabled={disabled}
            activeOpacity={0.85}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, disabled }}
            accessibilityLabel={o.hint ? `${o.label}, ${o.hint}` : o.label}
          >
            <Text style={[sg.label, size === 'sm' && { fontSize: 13 }, on && sg.labelOn]} numberOfLines={1}>{o.label}</Text>
            {!!o.hint && <Text style={[sg.hint, on && sg.hintOn]} numberOfLines={1}>{o.hint}</Text>}
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

const sg = StyleSheet.create({
  row: { flexDirection: 'row', padding: 4, gap: 4, backgroundColor: Colors.bgSubtle, borderRadius: Radius.full },
  btn: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Space.md, paddingVertical: 6, borderRadius: Radius.full },
  btnOn: { backgroundColor: Colors.secondary, ...Shadow.lift },
  label: { ...Typography.bodySmall, ...Weight.semibold, fontSize: 14, color: Colors.text },
  labelOn: { color: Colors.textOnDark },
  hint: { ...Typography.caption, fontSize: 11, lineHeight: 14, color: Colors.textMuted },
  hintOn: { color: Colors.textOnDarkMuted },
})

// ─── Chips ───────────────────────────────────────────────────────────────────
export function Chip({ label, selected, onPress, icon, count }: {
  label: string; selected?: boolean; onPress: () => void; icon?: IconName; count?: number
}) {
  return (
    <TouchableOpacity
      onPress={onPress} style={[c.chip, selected && c.chipOn]} activeOpacity={0.85}
      accessibilityRole="button" accessibilityState={{ selected: !!selected }}
    >
      {icon && <Icon name={icon} size={14} color={selected ? Colors.textOnDark : Colors.secondary} />}
      <Text style={[c.text, selected && { color: Colors.textOnDark }]}>{label}</Text>
      {count !== undefined && <Text style={[c.count, selected && { color: Colors.textOnDarkMuted }]}>{count}</Text>}
    </TouchableOpacity>
  )
}

/** A small read-only tag (status, size, "Tried on"). */
export function Tag({ label, tone = 'neutral', dot }: { label: string; tone?: 'neutral' | NoticeTone | 'dark'; dot?: boolean }) {
  const t = tone === 'neutral' ? { fg: Colors.textMuted, bg: Colors.bgSubtle }
    : tone === 'dark' ? { fg: Colors.textOnDark, bg: Colors.secondary }
      : { fg: NOTICE_TONES[tone].fg, bg: NOTICE_TONES[tone].bg }
  return (
    <View style={[c.tag, { backgroundColor: t.bg }]}>
      {dot && <View style={[c.dot, { backgroundColor: t.fg }]} />}
      <Text style={[c.tagText, { color: t.fg }]} numberOfLines={1}>{label}</Text>
    </View>
  )
}

const c = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 14,
    borderRadius: Radius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard,
  },
  chipOn: { backgroundColor: Colors.secondary, borderColor: Colors.secondary },
  text: { ...Typography.bodySmall, ...Weight.medium, color: Colors.secondary },
  count: { ...Typography.caption, color: Colors.textMuted },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 3, borderRadius: Radius.full },
  dot: { width: 6, height: 6, borderRadius: 3 },
  tagText: { ...Typography.caption, ...Weight.semibold },
})

// ─── Checkbox ────────────────────────────────────────────────────────────────
export function Checkbox({ checked, onChange, label, hint, disabled, children }: {
  checked: boolean; onChange: (v: boolean) => void; label?: string; hint?: string; disabled?: boolean; children?: ReactNode
}) {
  return (
    <TouchableOpacity
      style={cb.row} onPress={() => onChange(!checked)} disabled={disabled} activeOpacity={0.8}
      accessibilityRole="checkbox" accessibilityState={{ checked, disabled }} accessibilityLabel={label}
    >
      <View style={[cb.box, checked && cb.boxOn]}>{checked && <Icon name="check" size={15} color={Colors.textOnDark} />}</View>
      <View style={{ flex: 1, gap: 2 }}>
        {!!label && <Text style={cb.label}>{label}</Text>}
        {!!hint && <Text style={cb.hint}>{hint}</Text>}
        {children}
      </View>
    </TouchableOpacity>
  )
}

const cb = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md, paddingVertical: Space.xs },
  box: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: Colors.secondary, marginTop: 1,
    alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgCard,
  },
  boxOn: { backgroundColor: Colors.secondary },
  label: { ...Typography.bodySmall, ...Weight.semibold, color: Colors.text },
  hint: { ...Typography.caption },
})

/** Brand colours for <Switch>. activeThumbColor / activeTrackColor are the web
 *  (react-native-web) names; without them the "on" state falls back to teal. */
export const SWITCH_COLORS = {
  trackColor: { true: Colors.secondary, false: Colors.border },
  thumbColor: Colors.bgCard,
  activeTrackColor: Colors.secondary,
  activeThumbColor: Colors.bgCard,
  ios_backgroundColor: Colors.border,
} as any

// ─── Surfaces ────────────────────────────────────────────────────────────────
// plain: white on a hairline (text content) · raised: white with the soft
// shadow (images: products, try-ons) · sunken: linen · dark: the charcoal stage.
export function Card({ children, variant = 'plain', padded = true, style }: {
  children: ReactNode; variant?: 'plain' | 'raised' | 'sunken' | 'dark'; padded?: boolean; style?: StyleProp<ViewStyle>
}) {
  return <View style={[cd.base, cd[variant], padded && cd.padded, style]}>{children}</View>
}

const cd = StyleSheet.create({
  base:   { borderRadius: Radius.lg, gap: Space.md },
  padded: { padding: Space.lg },
  plain:  { backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.borderSubtle },
  raised: { backgroundColor: Colors.bgCard, ...Shadow.card },
  sunken: { backgroundColor: Colors.bgSubtle },
  dark:   { backgroundColor: Colors.secondary },
})

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: 1, backgroundColor: Colors.borderSubtle }, style]} />
}

/** A section heading inside a page: sentence case, with an optional link on the right. */
export function SectionHeader({ title, detail, action, style }: {
  title: string; detail?: string; action?: { label: string; onPress: () => void }; style?: StyleProp<ViewStyle>
}) {
  return (
    <View style={[sh.row, style]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={sh.title} accessibilityRole="header">{title}</Text>
        {!!detail && <Text style={sh.detail}>{detail}</Text>}
      </View>
      {action && <TextLink label={action.label} onPress={action.onPress} />}
    </View>
  )
}

const sh = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: Space.md },
  title: { ...Typography.h3 },
  detail: { ...Typography.caption },
})

// ─── Loading ─────────────────────────────────────────────────────────────────
export function Skeleton({ width = '100%', height = 14, radius = Radius.sm, style, tone = 'light' }: {
  width?: number | `${number}%`; height?: number | `${number}%`; radius?: number; style?: StyleProp<ViewStyle>; tone?: 'light' | 'dark'
}) {
  const reduced = useReducedMotion()
  const pulse = useRef(new Animated.Value(0.55)).current
  useEffect(() => {
    if (reduced) return
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 750, useNativeDriver: !web }),
      Animated.timing(pulse, { toValue: 0.55, duration: 750, useNativeDriver: !web }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [pulse, reduced])
  return (
    <Animated.View
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius, backgroundColor: tone === 'dark' ? 'rgba(250,248,245,0.10)' : Colors.secondarySubtle, opacity: pulse }, style]}
    />
  )
}

/** A whole area waiting for data: a quiet spinner, optionally with a line of text. */
export function Loading({ label, tone = 'light', style }: { label?: string; tone?: 'light' | 'dark'; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.md, padding: Space.xl, backgroundColor: tone === 'dark' ? Colors.bgDark : Colors.bg }, style]}
      accessibilityRole="progressbar" accessibilityLabel={label ?? 'Loading'}>
      <ActivityIndicator color={tone === 'dark' ? Colors.primaryLight : Colors.primaryDark} />
      {!!label && <Text style={[Typography.bodySmall, { color: tone === 'dark' ? Colors.textOnDarkMuted : Colors.textMuted, textAlign: 'center' }]}>{label}</Text>}
    </View>
  )
}

// ─── Empty states ────────────────────────────────────────────────────────────
// An empty screen is an invitation to act: say what goes here and offer the
// action that fills it.
export function EmptyState({ icon, title, body, action, secondary, tone = 'light', style }: {
  icon?: IconName; title: string; body?: string
  action?: { label: string; onPress: () => void; icon?: IconName }
  secondary?: { label: string; onPress: () => void }
  tone?: 'light' | 'dark'; style?: StyleProp<ViewStyle>
}) {
  const dark = tone === 'dark'
  return (
    <View style={[es.wrap, style]}>
      {icon && (
        <View style={[es.icon, dark && { backgroundColor: 'rgba(250,248,245,0.08)' }]}>
          <Icon name={icon} size={26} color={dark ? Colors.primaryLight : Colors.accentInk} />
        </View>
      )}
      <Text style={[es.title, dark && { color: Colors.textOnDark }]}>{title}</Text>
      {!!body && <Text style={[es.body, dark && { color: Colors.textOnDarkMuted }]}>{body}</Text>}
      {action && (
        <PillButton label={action.label} icon={action.icon} onPress={action.onPress} size="md"
          variant={dark ? 'gold' : 'secondary'} style={{ marginTop: Space.sm, minWidth: 200 }} />
      )}
      {secondary && <TextLink label={secondary.label} onPress={secondary.onPress} tone={dark ? 'light' : 'ink'} />}
    </View>
  )
}

const es = StyleSheet.create({
  wrap:  { alignItems: 'center', paddingVertical: Space.xxl, paddingHorizontal: Space.lg, gap: Space.sm },
  icon:  { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.primarySubtle, alignItems: 'center', justifyContent: 'center', marginBottom: Space.xs },
  title: { ...Typography.h3, textAlign: 'center' },
  body:  { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center', maxWidth: 380 },
})

// ─── Page frame ──────────────────────────────────────────────────────────────
// One scrolling column, centred, at one of the Layout widths, with gutters
// that grow with the window (16 → 24 → 32).
export type PageWidth = 'reading' | 'app' | 'wide'

export function usePageGutter() {
  const { width } = useWindowDimensions()
  return Layout.gutter(width)
}

export function Page({ children, width = 'app', gap = Space.lg, scroll = true, style, contentStyle, tone = 'light', ...rest }: {
  children: ReactNode; width?: PageWidth; gap?: number; scroll?: boolean; tone?: 'light' | 'dark'
  style?: StyleProp<ViewStyle>; contentStyle?: StyleProp<ViewStyle>
} & Omit<ScrollViewProps, 'style' | 'contentContainerStyle'>) {
  const gutter = usePageGutter()
  const column = [{ width: '100%' as const, maxWidth: Layout[width] + gutter * 2, alignSelf: 'center' as const, paddingHorizontal: gutter, gap }, contentStyle]
  const bg = { backgroundColor: tone === 'dark' ? Colors.bgDark : Colors.bg }
  if (!scroll) return <View style={[{ flex: 1 }, bg, style]}><View style={[column, { flex: 1, paddingTop: Space.lg }]}>{children}</View></View>
  return (
    <ScrollView style={[{ flex: 1 }, bg, style]} contentContainerStyle={[{ paddingTop: Space.lg, paddingBottom: Space.xxl + Space.lg }, column]}
      keyboardShouldPersistTaps="handled" {...rest}>
      {children}
    </ScrollView>
  )
}

/** The top of a page: small-caps title, a line of context, actions on the right. */
export function PageHeader({ title, subtitle, actions, back, tone = 'dark', style }: {
  title: string; subtitle?: string; actions?: ReactNode; back?: { label: string; onPress: () => void }
  tone?: 'dark' | 'light'; style?: StyleProp<ViewStyle>
}) {
  return (
    <View style={[ph.wrap, style]}>
      {back && <TextLink label={back.label} icon="back" tone={tone === 'light' ? 'light' : 'muted'} onPress={back.onPress} style={{ alignSelf: 'flex-start', marginBottom: Space.xs }} />}
      <View style={ph.row}>
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 260, minWidth: 0, gap: Space.sm }}>
          <Title tone={tone}>{title}</Title>
          {!!subtitle && <Text style={[ph.sub, tone === 'light' && { color: Colors.textOnDarkMuted }]}>{subtitle}</Text>}
        </View>
        {actions && <View style={ph.actions}>{actions}</View>}
      </View>
    </View>
  )
}

const ph = StyleSheet.create({
  wrap:    { gap: Space.xs },
  row:     { flexDirection: 'row', alignItems: 'flex-end', gap: Space.base, flexWrap: 'wrap' },
  sub:     { ...Typography.body, color: Colors.textMuted, maxWidth: 620 },
  actions: { flexDirection: 'row', gap: Space.sm, alignItems: 'center' },
})

// ─── Header pieces ───────────────────────────────────────────────────────────
/** The credits counter in the top bars; red when there are none left. */
export function CreditPill({ label, empty, onPress, accessibilityLabel }: {
  label: string; empty?: boolean; onPress: () => void; accessibilityLabel?: string
}) {
  return (
    <TouchableOpacity
      style={[hp.pill, empty && hp.pillEmpty]} onPress={onPress} activeOpacity={0.85}
      accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
    >
      <Icon name="star" size={13} color={empty ? Colors.error : Colors.primaryDark} />
      <Text style={[hp.text, empty && { color: Colors.error }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  )
}

const hp = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36,
    backgroundColor: Colors.bgCard, borderRadius: Radius.full, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 14,
  },
  pillEmpty: { backgroundColor: Colors.errorBg, borderColor: Colors.errorBg },
  text: { ...Typography.bodySmall, ...Weight.semibold, color: Colors.secondary },
})

// ─── Tab bars ────────────────────────────────────────────────────────────────
// Phones and portrait iPads: the mockups' bottom bar — white, rounded at the
// top, the current tab a charcoal capsule holding its icon and name.
// From Layout.desktop: the same tabs sit in the top bar beside the wordmark.
export type TabItem = { name: string; title: string; short?: string; icon: IconName }

type TabBarState = { index: number; routes: { key: string; name: string }[] }
type TabBarNav = { navigate: (name: string) => void; emit?: (e: any) => any }

export function AppTabBar({ state, navigation, items, desktop, insetBottom, brand, right, badges }: {
  state: TabBarState; navigation: TabBarNav; items: TabItem[]; desktop: boolean; insetBottom: number
  brand?: ReactNode; right?: ReactNode; badges?: Record<string, number>
}) {
  const current = state.routes[state.index]?.name
  const go = (name: string, key: string) => {
    const event = navigation.emit?.({ type: 'tabPress', target: key, canPreventDefault: true })
    if (current !== name && !event?.defaultPrevented) navigation.navigate(name)
  }
  const routes = items
    .map((it) => ({ it, route: state.routes.find((r) => r.name === it.name) }))
    .filter((x): x is { it: TabItem; route: { key: string; name: string } } => !!x.route)

  if (desktop) {
    return (
      <View style={tb.top}>
        <View style={tb.topInner}>
          {brand}
          <View style={tb.topNav} accessibilityRole="tablist">
            {routes.map(({ it, route }) => {
              const on = current === it.name
              return (
                <Pressable
                  key={route.key} onPress={() => go(it.name, route.key)}
                  accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={it.title}
                  style={(st: any) => [tb.topItem, on ? tb.topItemOn : st.hovered && tb.topItemHover]}
                >
                  <Icon name={it.icon} size={18} color={on ? Colors.textOnDark : Colors.primaryDark} />
                  <Text style={[tb.topText, on && { color: Colors.textOnDark }]}>{it.title}</Text>
                  {!!badges?.[it.name] && <Badge n={badges[it.name]} inline />}
                </Pressable>
              )
            })}
          </View>
          <View style={tb.topRight}>{right}</View>
        </View>
      </View>
    )
  }

  return (
    <View style={[tb.bottom, { paddingBottom: Space.sm + insetBottom }]} accessibilityRole="tablist">
      {routes.map(({ it, route }) => {
        const on = current === it.name
        return (
          <TouchableOpacity
            key={route.key} style={tb.item} onPress={() => go(it.name, route.key)} activeOpacity={0.8}
            accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={it.title}
          >
            <View style={[tb.capsule, on && tb.capsuleOn]}>
              <View>
                <Icon name={it.icon} size={22} color={on ? Colors.textOnDark : Colors.primary} />
                {!!badges?.[it.name] && <Badge n={badges[it.name]} />}
              </View>
              <Text style={[tb.label, on && tb.labelOn]} numberOfLines={1}>{it.short ?? it.title}</Text>
            </View>
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

export function Badge({ n, inline }: { n: number; inline?: boolean }) {
  if (n <= 0) return null
  return (
    <View style={[tb.badge, inline ? tb.badgeInline : tb.badgeFloat]} accessibilityLabel={`${n} unread`}>
      <Text style={tb.badgeText}>{n > 9 ? '9+' : String(n)}</Text>
    </View>
  )
}

const tb = StyleSheet.create({
  bottom: {
    flexDirection: 'row', backgroundColor: Colors.bgCard, paddingTop: Space.sm, paddingHorizontal: Space.sm,
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl, ...Shadow.nav,
  },
  item: { flex: 1, alignItems: 'center' },
  capsule: { alignItems: 'center', justifyContent: 'center', gap: 2, minWidth: 64, maxWidth: 96, paddingHorizontal: Space.sm, paddingVertical: 7, borderRadius: Radius.lg },
  capsuleOn: { backgroundColor: Colors.secondary },
  label: { ...Typography.caption, ...Weight.medium, fontSize: 11, lineHeight: 14, color: Colors.accentInk },
  labelOn: { color: Colors.textOnDark },

  top: { backgroundColor: Colors.bg, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle },
  topInner: {
    flexDirection: 'row', alignItems: 'center', gap: Space.xl, width: '100%', maxWidth: Layout.wide + 64,
    alignSelf: 'center', paddingHorizontal: Space.xl, paddingVertical: Space.md,
  },
  topNav: { flexDirection: 'row', gap: Space.xs, flex: 1 },
  topItem: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingHorizontal: Space.base, minHeight: 40, borderRadius: Radius.full },
  topItemOn: { backgroundColor: Colors.secondary },
  topItemHover: { backgroundColor: Colors.bgSubtle },
  topText: { ...Typography.bodySmall, ...Weight.semibold, fontSize: 14, color: Colors.text },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },

  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: Colors.error, alignItems: 'center', justifyContent: 'center' },
  badgeFloat: { position: 'absolute', top: -5, right: -10, borderWidth: 2, borderColor: Colors.bgCard },
  badgeInline: { marginLeft: 'auto' },
  badgeText: { color: '#fff', fontSize: 10, lineHeight: 13, ...Weight.semibold },
})

/** react-navigation screenOptions for the shared tab bar. */
export function tabScreenOptions(desktop: boolean) {
  return { headerShown: false, tabBarPosition: (desktop ? 'top' : 'bottom') as 'top' | 'bottom' }
}

// ─── Toasts ──────────────────────────────────────────────────────────────────
// Short confirmations ("Invite sent") and failures that need no decision.
type ToastTone = 'success' | 'error' | 'info'
type ToastItem = { id: number; title?: string; text: string; tone: ToastTone; action?: { label: string; onPress: () => void } }
const useToasts = create<{ items: ToastItem[] }>()(() => ({ items: [] }))
let toastId = 0
export function toast(text: string, opts: { tone?: ToastTone; title?: string; action?: ToastItem['action']; ms?: number } = {}) {
  const id = ++toastId
  useToasts.setState((s) => ({ items: [...s.items.slice(-2), { id, text, title: opts.title, tone: opts.tone ?? 'success', action: opts.action }] }))
  setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), opts.ms ?? 6000)
}
const dropToast = (id: number) => useToasts.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }))

export function ToastHost() {
  const items = useToasts((s) => s.items)
  const { width } = useWindowDimensions()
  if (!items.length) return null
  return (
    <View style={[t.wrap, { bottom: width >= Layout.desktop ? Space.xl : 104, pointerEvents: 'box-none' }]}>
      {items.map((it) => (
        <View key={it.id} style={t.toast} accessibilityLiveRegion="polite" accessibilityRole={it.tone === 'error' ? 'alert' : undefined}>
          <Icon name={it.tone === 'error' ? 'alert' : it.tone === 'info' ? 'info' : 'success'} size={18}
            color={it.tone === 'error' ? '#F3B7AC' : it.tone === 'info' ? Colors.primaryLight : '#A8D8BA'} />
          <View style={{ flex: 1, gap: 2 }}>
            {!!it.title && <Text style={[t.text, Weight.semibold]}>{it.title}</Text>}
            <Text style={t.text}>{it.text}</Text>
          </View>
          {it.action && (
            <TouchableOpacity onPress={() => { it.action!.onPress(); dropToast(it.id) }} accessibilityRole="button">
              <Text style={t.action}>{it.action.label}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => dropToast(it.id)} accessibilityLabel="Dismiss" hitSlop={10}>
            <Icon name="close" size={16} color={Colors.textOnDarkMuted} />
          </TouchableOpacity>
        </View>
      ))}
    </View>
  )
}

const t = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: Space.sm, paddingHorizontal: Space.base, zIndex: 1000 },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: Space.md, maxWidth: 520, width: '100%',
    backgroundColor: Colors.secondaryDark, borderRadius: Radius.lg, paddingHorizontal: Space.base, paddingVertical: Space.md, ...Shadow.pop,
  },
  text: { ...Typography.bodySmall, color: Colors.textOnDark },
  action: { ...Typography.bodySmall, ...Weight.semibold, color: Colors.primaryLight },
})

// ─── Dialogs (promise-based) ─────────────────────────────────────────────────
type DialogReq = {
  title: string; body?: string; confirmLabel: string; cancelLabel?: string; danger?: boolean
  input?: { label: string; initial: string; keyboardType?: TextInputProps['keyboardType']; validate?: (v: string) => string | null }
  resolve: (v: string | null) => void
}
const useDialog = create<{ req: DialogReq | null }>()(() => ({ req: null }))

/** true when confirmed. */
export function confirmDialog(o: { title: string; body?: string; confirmLabel: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => useDialog.setState({ req: { ...o, resolve: (v) => resolve(v !== null) } }))
}
/** The entered value, or null when cancelled. */
export function promptDialog(o: { title: string; body?: string; confirmLabel: string; input: NonNullable<DialogReq['input']> }): Promise<string | null> {
  return new Promise((resolve) => useDialog.setState({ req: { ...o, resolve } }))
}

export function DialogHost() {
  const req = useDialog((s) => s.req)
  const [value, setValue] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setValue(req?.input?.initial ?? ''); setErr(null) }, [req])
  if (!req) return null
  const close = (v: string | null) => { useDialog.setState({ req: null }); req.resolve(v) }
  const submit = () => {
    if (req.input) {
      const problem = req.input.validate?.(value.trim()) ?? null
      if (problem) { setErr(problem); return }
      close(value.trim())
    } else close('ok')
  }
  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => close(null)}>
      <View style={dg.scrim}>
        <View style={dg.dialog} accessibilityRole="alert" accessibilityViewIsModal>
          <Text style={dg.title}>{req.title}</Text>
          {!!req.body && <Text style={dg.body}>{req.body}</Text>}
          {req.input && (
            <Field
              label={req.input.label} value={value} onChangeText={(v) => { setValue(v); setErr(null) }}
              keyboardType={req.input.keyboardType} autoCapitalize="none" autoCorrect={false} autoFocus error={err}
              onSubmitEditing={submit}
            />
          )}
          <View style={dg.actions}>
            <PillButton label={req.cancelLabel ?? 'Cancel'} variant="ghost" size="sm" onPress={() => close(null)} />
            <PillButton label={req.confirmLabel} variant={req.danger ? 'danger' : 'secondary'} size="sm" onPress={submit} />
          </View>
        </View>
      </View>
    </Modal>
  )
}

/** A centred modal sheet with a title row and a close button (pickers, confirmations). */
export function Sheet({ visible, title, onClose, children, width = 520, closeDisabled }: {
  visible: boolean; title: string; onClose: () => void; children: ReactNode; width?: number; closeDisabled?: boolean
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={closeDisabled ? undefined : onClose}>
      <View style={dg.scrim}>
        <View style={[dg.sheet, { maxWidth: width }]} accessibilityViewIsModal>
          <View style={dg.sheetHead}>
            <Text style={[Typography.h2, { flex: 1 }]} accessibilityRole="header">{title}</Text>
            {!closeDisabled && (
              <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={dg.close}>
                <Icon name="close" size={20} color={Colors.text} />
              </TouchableOpacity>
            )}
          </View>
          {children}
        </View>
      </View>
    </Modal>
  )
}

const dg = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: Colors.scrim, alignItems: 'center', justifyContent: 'center', padding: Space.base },
  dialog: { width: '100%', maxWidth: 440, backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, ...Shadow.pop },
  title: { ...Typography.h3, fontSize: 18 },
  // wordBreak: long links (test-mode invite links) wrap instead of overflowing on the web.
  body: { ...Typography.bodySmall, color: Colors.textMuted, marginTop: Space.sm, lineHeight: 21, ...({ wordBreak: 'break-word' } as object) },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Space.sm, marginTop: Space.lg },
  sheet: { width: '100%', maxHeight: '90%', backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, gap: Space.base, ...Shadow.pop },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  close: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgSubtle },
})
