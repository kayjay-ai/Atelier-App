// ─── Owner portal building blocks ─────────────────────────────────────────────
// Small, consistent pieces in the Atelier look (lib/theme.ts): buttons, fields,
// password + checklist, the 6-box code input, status pills, skeletons,
// banners, toasts, confirm / prompt dialogs and a row menu.
import { ReactNode, useEffect, useRef, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, Pressable, Modal, StyleSheet, Animated, Platform,
  ActivityIndicator, ScrollView, useWindowDimensions, type TextInputProps, type StyleProp, type ViewStyle,
} from 'react-native'
import { create } from 'zustand'
import { Colors, Typography, Space, Radius, Shadow } from '../../lib/theme'
import { Icon, type IconName } from '../../lib/ui'
import { PASSWORD_RULES, STATUS_META, TONES, type Tone } from '../../lib/owner'
import type { OwnerStoreStatus } from '../../lib/api'

export const WIDE = 900 // desktop layout (sidebar, table) from this width

// ── Buttons ──────────────────────────────────────────────────────────────────
type BtnKind = 'primary' | 'secondary' | 'ghost' | 'danger'
export function Btn({
  label, onPress, kind = 'primary', icon, loading, disabled, small, style,
}: {
  label: string; onPress: () => void; kind?: BtnKind; icon?: IconName
  loading?: boolean; disabled?: boolean; small?: boolean; style?: StyleProp<ViewStyle>
}) {
  const fg = kind === 'primary' || kind === 'danger' ? Colors.textOnDark : kind === 'secondary' ? Colors.secondary : Colors.secondary
  const off = disabled || loading
  return (
    <TouchableOpacity
      onPress={onPress} disabled={off} accessibilityRole="button" accessibilityState={{ disabled: !!off }}
      style={[k.btn, small && k.btnSmall, k[kind], off && { opacity: 0.5 }, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : (
        <View style={k.btnRow}>
          {icon && <Icon name={icon} size={small ? 16 : 18} color={fg} />}
          <Text style={[k.btnText, small && { fontSize: 13 }, { color: fg }]}>{label}</Text>
        </View>
      )}
    </TouchableOpacity>
  )
}

export function LinkText({ label, onPress, style }: { label: string; onPress: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="link" style={[{ paddingVertical: Space.xs }, style]}>
      <Text style={k.link}>{label}</Text>
    </TouchableOpacity>
  )
}

// ── Fields ───────────────────────────────────────────────────────────────────
export function Field({
  label, error, hint, right, optional, ...input
}: TextInputProps & { label: string; error?: string | null; hint?: string; right?: ReactNode; optional?: boolean }) {
  return (
    <View style={k.field}>
      <Text style={k.label}>{label}{optional ? <Text style={k.optional}>  (optional)</Text> : null}</Text>
      <View style={[k.inputWrap, !!error && k.inputError, input.editable === false && k.inputDisabled]}>
        <TextInput
          placeholderTextColor={Colors.textFaint}
          {...input}
          style={[k.input, input.multiline && { minHeight: 96, textAlignVertical: 'top' }, input.style]}
          accessibilityLabel={label}
        />
        {right}
      </View>
      {!!error && <Text style={k.error} accessibilityLiveRegion="polite">{error}</Text>}
      {!error && !!hint && <Text style={k.hint}>{hint}</Text>}
    </View>
  )
}

export function PasswordField(props: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  const [shown, setShown] = useState(false)
  return (
    <Field
      {...props}
      secureTextEntry={!shown}
      autoCapitalize="none"
      autoCorrect={false}
      right={(
        <TouchableOpacity
          onPress={() => setShown((v) => !v)} style={k.eye}
          accessibilityRole="button" accessibilityLabel={shown ? 'Hide password' : 'Show password'}
        >
          <Icon name={shown ? 'eyeOff' : 'eye'} size={20} color={Colors.textMuted} />
        </TouchableOpacity>
      )}
    />
  )
}

/** The live password checklist (same rules as the API). */
export function PasswordChecklist({ password }: { password: string }) {
  return (
    <View style={k.checklist} accessibilityLabel="Password rules">
      {PASSWORD_RULES.map((r) => {
        const ok = r.test(password)
        return (
          <View key={r.label} style={k.checkRow}>
            <Icon name={ok ? 'check' : 'close'} size={14} color={ok ? Colors.success : Colors.textFaint} />
            <Text style={[k.checkText, ok && { color: Colors.success }]}>{r.label}</Text>
          </View>
        )
      })}
    </View>
  )
}

/**
 * Six single-digit boxes. One hidden input takes the typing, so typing
 * advances by itself, pasting fills all six and the phone's one-time-code
 * autofill works; the sixth digit calls onComplete.
 */
export function OtpInput({ value, onChange, onComplete, disabled, error }: {
  value: string; onChange: (v: string) => void; onComplete: (v: string) => void; disabled?: boolean; error?: boolean
}) {
  const ref = useRef<TextInput>(null)
  const [focused, setFocused] = useState(false)
  useEffect(() => { const t = setTimeout(() => ref.current?.focus(), 150); return () => clearTimeout(t) }, [])
  return (
    <Pressable onPress={() => ref.current?.focus()} style={k.otpRow} accessibilityLabel="6-digit code">
      {Array.from({ length: 6 }, (_, i) => {
        const active = focused && (i === value.length || (i === 5 && value.length === 6))
        return (
          <View key={i} style={[k.otpBox, active && k.otpBoxActive, error && k.inputError]}>
            <Text style={k.otpDigit}>{value[i] ?? ''}</Text>
          </View>
        )
      })}
      <TextInput
        ref={ref}
        value={value}
        onChangeText={(t) => {
          const v = t.replace(/\D/g, '').slice(0, 6)
          onChange(v)
          if (v.length === 6) onComplete(v)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={!disabled}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        caretHidden
        style={k.otpHidden}
        accessibilityLabel="Verification code"
      />
    </Pressable>
  )
}

// ── Status, chips, skeletons, banners ────────────────────────────────────────
export function Pill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <View style={[k.pill, { backgroundColor: TONES[tone].bg }]}>
      <View style={[k.pillDot, { backgroundColor: TONES[tone].fg }]} />
      <Text style={[k.pillText, { color: TONES[tone].fg }]} numberOfLines={1}>{label}</Text>
    </View>
  )
}
export const StatusPill = ({ status }: { status: OwnerStoreStatus }) =>
  <Pill label={STATUS_META[status].label} tone={STATUS_META[status].tone} />

export function Chip({ label, selected, onPress, icon }: { label: string; selected?: boolean; onPress: () => void; icon?: IconName }) {
  return (
    <TouchableOpacity
      onPress={onPress} style={[k.chip, selected && k.chipOn]}
      accessibilityRole="button" accessibilityState={{ selected: !!selected }}
    >
      {icon && <Icon name={icon} size={14} color={selected ? Colors.textOnDark : Colors.secondary} />}
      <Text style={[k.chipText, selected && { color: Colors.textOnDark }]}>{label}</Text>
    </TouchableOpacity>
  )
}

export function Skeleton({ width = '100%', height = 14, radius = Radius.sm, style }: {
  width?: number | `${number}%`; height?: number; radius?: number; style?: StyleProp<ViewStyle>
}) {
  const pulse = useRef(new Animated.Value(0.45)).current
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [pulse])
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: Colors.secondarySubtle, opacity: pulse }, style]} />
}

export function Banner({ tone = 'error', text, actionLabel, onAction }: {
  tone?: 'error' | 'warning' | 'info' | 'success'; text: string; actionLabel?: string; onAction?: () => void
}) {
  const c = tone === 'error' ? { fg: Colors.error, bg: Colors.errorBg }
    : tone === 'warning' ? { fg: Colors.warning, bg: Colors.warningBg }
      : tone === 'success' ? { fg: Colors.success, bg: Colors.successBg }
        : { fg: Colors.secondary, bg: Colors.primarySubtle }
  return (
    <View style={[k.banner, { backgroundColor: c.bg }]} accessibilityRole="alert">
      <Icon name={tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert'} size={18} color={c.fg} />
      <Text style={[k.bannerText, { color: c.fg }]}>{text}</Text>
      {actionLabel && onAction && (
        <TouchableOpacity onPress={onAction} accessibilityRole="button">
          <Text style={[k.bannerAction, { color: c.fg }]}>{actionLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[k.card, style]}>{children}</View>
}

// ── Toasts ───────────────────────────────────────────────────────────────────
type ToastItem = { id: number; text: string; tone: 'success' | 'error' | 'info'; action?: { label: string; onPress: () => void } }
const useToasts = create<{ items: ToastItem[] }>()(() => ({ items: [] }))
let toastId = 0
export function toast(text: string, opts: { tone?: ToastItem['tone']; action?: ToastItem['action']; ms?: number } = {}) {
  const id = ++toastId
  useToasts.setState((s) => ({ items: [...s.items.slice(-2), { id, text, tone: opts.tone ?? 'success', action: opts.action }] }))
  setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), opts.ms ?? 6000)
}
export function ToastHost() {
  const items = useToasts((s) => s.items)
  if (!items.length) return null
  return (
    <View style={k.toastWrap} pointerEvents="box-none">
      {items.map((t) => (
        <View key={t.id} style={[k.toast, t.tone === 'error' && { backgroundColor: Colors.error }]} accessibilityLiveRegion="polite">
          <Text style={k.toastText}>{t.text}</Text>
          {t.action && (
            <TouchableOpacity onPress={() => { t.action!.onPress(); useToasts.setState((s) => ({ items: s.items.filter((x) => x.id !== t.id) })) }}>
              <Text style={k.toastAction}>{t.action.label}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => useToasts.setState((s) => ({ items: s.items.filter((x) => x.id !== t.id) }))}
            accessibilityLabel="Dismiss" hitSlop={8}
          >
            <Icon name="close" size={16} color={Colors.textOnDark} />
          </TouchableOpacity>
        </View>
      ))}
    </View>
  )
}

// ── Confirm / prompt dialogs (promise-based) ─────────────────────────────────
type DialogReq = {
  title: string; body?: string; confirmLabel: string; danger?: boolean
  input?: { label: string; initial: string; keyboardType?: TextInputProps['keyboardType']; validate?: (v: string) => string | null }
  resolve: (v: string | null) => void
}
const useDialog = create<{ req: DialogReq | null }>()(() => ({ req: null }))

/** true when confirmed. */
export function confirmDialog(o: { title: string; body?: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
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
      <View style={k.scrim}>
        <View style={k.dialog} accessibilityRole="alert" accessibilityViewIsModal>
          <Text style={k.dialogTitle}>{req.title}</Text>
          {!!req.body && <Text style={k.dialogBody}>{req.body}</Text>}
          {req.input && (
            <Field
              label={req.input.label} value={value} onChangeText={(v) => { setValue(v); setErr(null) }}
              keyboardType={req.input.keyboardType} autoCapitalize="none" autoCorrect={false} autoFocus error={err}
              onSubmitEditing={submit}
            />
          )}
          <View style={k.dialogActions}>
            <Btn label="Cancel" kind="ghost" small onPress={() => close(null)} />
            <Btn label={req.confirmLabel} kind={req.danger ? 'danger' : 'primary'} small onPress={submit} />
          </View>
        </View>
      </View>
    </Modal>
  )
}

// ── Row menu ─────────────────────────────────────────────────────────────────
export type MenuItem = { label: string; onPress: () => void; danger?: boolean; icon?: IconName }

export function RowMenu({ items, label = 'More actions', triggerLabel }: { items: MenuItem[]; label?: string; triggerLabel?: string }) {
  const anchor = useRef<View>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const { width, height } = useWindowDimensions()
  if (!items.length) return <View style={{ width: 32 }} />
  const open = () => anchor.current?.measureInWindow((x, y, w, h) => setPos({ x: triggerLabel ? x + Math.max(w, 230) : x + w, y: y + h }))
  const menuW = 230
  return (
    <>
      {triggerLabel ? (
        <TouchableOpacity ref={anchor as any} onPress={open} style={k.chip} accessibilityRole="button" accessibilityLabel={label}>
          <Text style={k.chipText}>{triggerLabel}</Text>
          <Icon name="chevronDown" size={14} color={Colors.secondary} />
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          ref={anchor as any} onPress={open} style={k.dots} hitSlop={6}
          accessibilityRole="button" accessibilityLabel={label}
        >
          <Icon name="dots" size={20} color={Colors.textMuted} />
        </TouchableOpacity>
      )}
      {pos && (
        <Modal transparent visible animationType="fade" onRequestClose={() => setPos(null)}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPos(null)} accessibilityLabel="Close menu" />
          <View style={[k.menu, {
            width: menuW,
            left: Math.max(8, Math.min(pos.x - menuW, width - menuW - 8)),
            top: Math.min(pos.y + 4, height - items.length * 44 - 24),
          }]}>
            {items.map((it) => (
              <TouchableOpacity
                key={it.label} style={k.menuItem} accessibilityRole="menuitem"
                onPress={() => { setPos(null); setTimeout(it.onPress, 50) }}
              >
                {it.icon && <Icon name={it.icon} size={16} color={it.danger ? Colors.error : Colors.secondary} />}
                <Text style={[k.menuText, it.danger && { color: Colors.error }]}>{it.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Modal>
      )}
    </>
  )
}

/** A list to choose one value from (e.g. the state). */
export function SelectField({ label, value, options, onChange, error, placeholder }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void; error?: string | null; placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const shown = options.filter((o) => o.toLowerCase().includes(q.toLowerCase()))
  return (
    <View style={k.field}>
      <Text style={k.label}>{label}</Text>
      <TouchableOpacity
        style={[k.inputWrap, k.select, !!error && k.inputError]} onPress={() => setOpen(true)}
        accessibilityRole="button" accessibilityLabel={`${label}: ${value || 'not chosen'}`}
      >
        <Text style={[k.input, !value && { color: Colors.textFaint }]} numberOfLines={1}>{value || placeholder || 'Choose'}</Text>
        <Icon name="chevronDown" size={18} color={Colors.textMuted} style={{ marginRight: Space.md }} />
      </TouchableOpacity>
      {!!error && <Text style={k.error}>{error}</Text>}
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={k.scrim}>
          <View style={[k.dialog, { maxHeight: '80%' }]}>
            <Text style={k.dialogTitle}>{label}</Text>
            <TextInput value={q} onChangeText={setQ} placeholder="Search" placeholderTextColor={Colors.textFaint} style={[k.inputWrap, k.input, { marginBottom: Space.sm }]} autoFocus />
            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              {shown.map((o) => (
                <TouchableOpacity key={o} style={k.menuItem} onPress={() => { onChange(o); setOpen(false); setQ('') }}>
                  <Text style={[k.menuText, o === value && { fontWeight: '700' }]}>{o}</Text>
                  {o === value && <Icon name="check" size={16} color={Colors.success} />}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={k.dialogActions}><Btn label="Close" kind="ghost" small onPress={() => setOpen(false)} /></View>
          </View>
        </View>
      </Modal>
    </View>
  )
}

const k = StyleSheet.create({
  btn: {
    minHeight: 48, paddingHorizontal: Space.lg, paddingVertical: 12, borderRadius: Radius.full,
    alignItems: 'center', justifyContent: 'center',
  },
  btnSmall: { minHeight: 36, paddingHorizontal: Space.base, paddingVertical: 8 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  btnText: { ...Typography.body, fontWeight: '600' },
  primary: { backgroundColor: Colors.secondary },
  secondary: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: Colors.secondary },
  ghost: { backgroundColor: 'transparent' },
  danger: { backgroundColor: Colors.error },
  link: { ...Typography.bodySmall, color: Colors.secondary, fontWeight: '600' },

  field: { marginTop: Space.md },
  label: { ...Typography.label, marginBottom: Space.xs },
  optional: { ...Typography.caption, fontSize: 10, lineHeight: 14, letterSpacing: 0, fontWeight: '400', color: Colors.textFaint },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.bgSubtle,
    borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
  },
  input: { flex: 1, paddingHorizontal: Space.base, paddingVertical: 12, ...Typography.body, color: Colors.text, minHeight: 48 },
  inputError: { borderColor: Colors.error },
  inputDisabled: { opacity: 0.7 },
  select: { minHeight: 48 },
  eye: { paddingHorizontal: Space.md, paddingVertical: Space.sm },
  error: { ...Typography.caption, color: Colors.error, marginTop: Space.xs },
  hint: { ...Typography.caption, color: Colors.textFaint, marginTop: Space.xs },

  checklist: { marginTop: Space.sm, gap: 2 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  checkText: { ...Typography.caption, color: Colors.textMuted },

  otpRow: { flexDirection: 'row', gap: Space.sm, justifyContent: 'center', marginVertical: Space.md },
  otpBox: {
    width: 46, height: 56, borderRadius: Radius.md, borderWidth: 1.5, borderColor: Colors.border,
    backgroundColor: Colors.bgCard, alignItems: 'center', justifyContent: 'center',
  },
  otpBoxActive: { borderColor: Colors.secondary },
  otpDigit: { ...Typography.h2, fontSize: 24 },
  otpHidden: {
    position: 'absolute', opacity: 0.011, width: '100%', height: '100%', color: 'transparent',
    borderWidth: 0, backgroundColor: 'transparent',
  },

  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.full,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { ...Typography.caption, fontWeight: '700' },

  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Space.md, paddingVertical: 7,
    borderRadius: Radius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard,
  },
  chipOn: { backgroundColor: Colors.secondary, borderColor: Colors.secondary },
  chipText: { ...Typography.bodySmall, color: Colors.secondary, fontWeight: '600' },

  banner: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, padding: Space.md, borderRadius: Radius.md },
  bannerText: { ...Typography.bodySmall, flex: 1, fontWeight: '500' },
  bannerAction: { ...Typography.bodySmall, fontWeight: '700', textDecorationLine: 'underline' },

  card: { backgroundColor: Colors.bgCard, borderRadius: Radius.lg, padding: Space.lg, borderWidth: 1, borderColor: Colors.borderSubtle },

  toastWrap: { position: 'absolute', left: 0, right: 0, bottom: 96, alignItems: 'center', gap: Space.sm, paddingHorizontal: Space.base },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: Space.md, maxWidth: 560, width: '100%',
    backgroundColor: Colors.secondary, borderRadius: Radius.md, paddingHorizontal: Space.base, paddingVertical: Space.md, ...Shadow.card,
  },
  toastText: { ...Typography.bodySmall, color: Colors.textOnDark, flex: 1 },
  toastAction: { ...Typography.bodySmall, color: Colors.primaryLight, fontWeight: '700' },

  scrim: { flex: 1, backgroundColor: 'rgba(42,39,37,0.45)', alignItems: 'center', justifyContent: 'center', padding: Space.base },
  dialog: { width: '100%', maxWidth: 440, backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, ...Shadow.card },
  dialogTitle: { ...Typography.h3 },
  // wordBreak: long links (test-mode invite links) wrap instead of overflowing on the web.
  dialogBody: { ...Typography.bodySmall, color: Colors.textMuted, marginTop: Space.sm, lineHeight: 20, ...({ wordBreak: 'break-word' } as object) },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Space.sm, marginTop: Space.lg },

  dots: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.full },
  menu: {
    position: 'absolute', backgroundColor: Colors.bgCard, borderRadius: Radius.md, paddingVertical: Space.xs,
    borderWidth: 1, borderColor: Colors.borderSubtle, ...Shadow.card,
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingHorizontal: Space.base, paddingVertical: 11 },
  menuText: { ...Typography.bodySmall, color: Colors.text, flex: 1 },
})
