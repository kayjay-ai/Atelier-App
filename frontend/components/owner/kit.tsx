// ─── Owner portal building blocks ─────────────────────────────────────────────
// The shared kit (lib/ui.tsx) under the names the owner screens use, plus the
// owner-only pieces: the 6-box code input, the password checklist, store
// status pills, the row menu and the searchable select field.
import { useEffect, useRef, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, Pressable, Modal, StyleSheet, ScrollView, useWindowDimensions,
  type StyleProp, type ViewStyle,
} from 'react-native'
import { Colors, Typography, Space, Radius, Shadow, Weight } from '../../lib/theme'
import {
  Icon, PillButton, Notice, TextLink, type IconName, type NoticeTone,
} from '../../lib/ui'
import { PASSWORD_RULES, STATUS_META, TONES, type Tone } from '../../lib/owner'
import type { OwnerStoreStatus } from '../../lib/api'

export {
  Field, PasswordField, Chip, Skeleton, Card, toast, ToastHost, confirmDialog, promptDialog, DialogHost,
} from '../../lib/ui'

export const WIDE = 900 // desktop layout (sidebar, table) from this width

// ── Buttons ──────────────────────────────────────────────────────────────────
type BtnKind = 'primary' | 'secondary' | 'ghost' | 'danger'
const VARIANT = { primary: 'secondary', secondary: 'outline', ghost: 'ghost', danger: 'danger' } as const

/** primary = charcoal, secondary = outlined, ghost = text, danger = red. */
export function Btn({
  label, onPress, kind = 'primary', icon, loading, disabled, small, style,
}: {
  label: string; onPress: () => void; kind?: BtnKind; icon?: IconName
  loading?: boolean; disabled?: boolean; small?: boolean; style?: StyleProp<ViewStyle>
}) {
  return (
    <PillButton label={label} onPress={onPress} variant={VARIANT[kind]} size={small ? 'sm' : 'md'}
      icon={icon} loading={loading} disabled={disabled} style={style} />
  )
}

export function LinkText({ label, onPress, style }: { label: string; onPress: () => void; style?: StyleProp<ViewStyle> }) {
  return <TextLink label={label} onPress={onPress} style={style} />
}

export function Banner({ tone = 'error', text, actionLabel, onAction }: {
  tone?: NoticeTone; text: string; actionLabel?: string; onAction?: () => void
}) {
  return <Notice tone={tone} text={text} actionLabel={actionLabel} onAction={onAction} />
}

/** The live password checklist (same rules as the API). */
export function PasswordChecklist({ password }: { password: string }) {
  return (
    <View style={k.checklist} accessibilityLabel="Password rules">
      {PASSWORD_RULES.map((r) => {
        const ok = r.test(password)
        return (
          <View key={r.label} style={k.checkRow}>
            <View style={[k.checkDot, ok && k.checkDotOk]}>
              {ok && <Icon name="check" size={10} color={Colors.textOnDark} />}
            </View>
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
  const { width } = useWindowDimensions()
  const box = width < 360 ? 40 : 48
  useEffect(() => { const t = setTimeout(() => ref.current?.focus(), 150); return () => clearTimeout(t) }, [])
  return (
    <Pressable onPress={() => ref.current?.focus()} style={k.otpRow} accessibilityLabel="6-digit code">
      {Array.from({ length: 6 }, (_, i) => {
        const active = focused && (i === value.length || (i === 5 && value.length === 6))
        return (
          <View key={i} style={[k.otpBox, { width: box, height: box + 8 }, !!value[i] && k.otpBoxFilled, active && k.otpBoxActive, error && k.otpBoxError]}>
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

// ── Status ───────────────────────────────────────────────────────────────────
/** Owner store tones keep their own colours (lib/owner TONES) in the shared tag shape. */
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

// ── Row menu ─────────────────────────────────────────────────────────────────
export type MenuItem = { label: string; onPress: () => void; danger?: boolean; icon?: IconName }

export function RowMenu({ items, label = 'More actions', triggerLabel }: { items: MenuItem[]; label?: string; triggerLabel?: string }) {
  const anchor = useRef<View>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const { width, height } = useWindowDimensions()
  if (!items.length) return <View style={{ width: 36 }} />
  const open = () => anchor.current?.measureInWindow((x, y, w, h) => setPos({ x: triggerLabel ? x + Math.max(w, 230) : x + w, y: y + h }))
  const menuW = 240
  return (
    <>
      {triggerLabel ? (
        <TouchableOpacity ref={anchor as any} onPress={open} style={k.trigger} accessibilityRole="button" accessibilityLabel={label}>
          <Text style={k.triggerText}>{triggerLabel}</Text>
          <Icon name="chevronDown" size={16} color={Colors.secondary} />
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
            top: Math.min(pos.y + 6, height - items.length * 46 - 24),
          }]} accessibilityRole="menu">
            {items.map((it) => (
              <Pressable
                key={it.label} accessibilityRole="menuitem"
                style={(st: any) => [k.menuItem, st.hovered && { backgroundColor: Colors.bgSubtle }]}
                onPress={() => { setPos(null); setTimeout(it.onPress, 50) }}
              >
                {it.icon && <Icon name={it.icon} size={17} color={it.danger ? Colors.error : Colors.secondaryLight} />}
                <Text style={[k.menuText, it.danger && { color: Colors.error }]}>{it.label}</Text>
              </Pressable>
            ))}
          </View>
        </Modal>
      )}
    </>
  )
}

/** A list to choose one value from (e.g. the state), with search. */
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
        style={[k.select, !!error && { borderColor: Colors.error }]} onPress={() => setOpen(true)}
        accessibilityRole="button" accessibilityLabel={`${label}: ${value || 'not chosen'}`}
      >
        <Text style={[k.selectText, !value && { color: Colors.textFaint }]} numberOfLines={1}>{value || placeholder || 'Choose'}</Text>
        <Icon name="chevronDown" size={18} color={Colors.textMuted} />
      </TouchableOpacity>
      {!!error && (
        <View style={k.errRow}>
          <Icon name="alert" size={14} color={Colors.error} />
          <Text style={k.error}>{error}</Text>
        </View>
      )}
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={k.scrim}>
          <View style={k.dialog}>
            <View style={k.dialogHead}>
              <Text style={[Typography.h3, { flex: 1 }]}>{label}</Text>
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={10} accessibilityLabel="Close" style={k.close}>
                <Icon name="close" size={18} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <View style={k.searchWrap}>
              <Icon name="search" size={18} color={Colors.textMuted} />
              <TextInput value={q} onChangeText={setQ} placeholder="Search" placeholderTextColor={Colors.textFaint}
                style={[k.searchInput, ({ outlineStyle: 'none' } as object)]} autoFocus accessibilityLabel={`Search ${label}`} />
            </View>
            <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
              {shown.map((o) => (
                <Pressable key={o}
                  style={(st: any) => [k.menuItem, o === value && { backgroundColor: Colors.primarySubtle }, st.hovered && { backgroundColor: Colors.bgSubtle }]}
                  onPress={() => { onChange(o); setOpen(false); setQ('') }}
                  accessibilityRole="button" accessibilityState={{ selected: o === value }}>
                  <Text style={[k.menuText, o === value && Weight.semibold]}>{o}</Text>
                  {o === value && <Icon name="check" size={16} color={Colors.secondary} />}
                </Pressable>
              ))}
              {shown.length === 0 && <Text style={[Typography.bodySmall, { color: Colors.textMuted, padding: Space.base }]}>Nothing matches “{q}”.</Text>}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  )
}

const k = StyleSheet.create({
  field: { marginTop: Space.base, gap: 6 },
  label: { ...Typography.fieldLabel },
  select: {
    flexDirection: 'row', alignItems: 'center', gap: Space.sm, minHeight: 50, paddingHorizontal: Space.base,
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, borderWidth: 1.5, borderColor: 'transparent',
  },
  selectText: { ...Typography.body, flex: 1 },
  errRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  error: { ...Typography.caption, color: Colors.error, flex: 1 },

  checklist: { marginTop: Space.sm, gap: 6 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  checkDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  checkDotOk: { backgroundColor: Colors.success, borderColor: Colors.success },
  checkText: { ...Typography.caption },

  otpRow: { flexDirection: 'row', gap: Space.sm, justifyContent: 'center', marginVertical: Space.lg },
  otpBox: {
    borderRadius: Radius.md, borderWidth: 1.5, borderColor: Colors.border,
    backgroundColor: Colors.bgCard, alignItems: 'center', justifyContent: 'center',
  },
  otpBoxFilled: { borderColor: Colors.primary },
  otpBoxActive: { borderColor: Colors.secondary, backgroundColor: Colors.bgCard, ...Shadow.lift },
  otpBoxError: { borderColor: Colors.error },
  otpDigit: { ...Typography.h3, fontSize: 22, lineHeight: 28 },
  otpHidden: {
    position: 'absolute', opacity: 0.011, width: '100%', height: '100%', color: 'transparent',
    borderWidth: 0, backgroundColor: 'transparent',
  },

  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: Radius.full,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { ...Typography.caption, ...Weight.semibold },

  trigger: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: Space.base,
    borderRadius: Radius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard,
  },
  triggerText: { ...Typography.bodySmall, ...Weight.medium, color: Colors.secondary },
  dots: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.full },
  menu: {
    position: 'absolute', backgroundColor: Colors.bgCard, borderRadius: Radius.md, padding: Space.xs,
    borderWidth: 1, borderColor: Colors.borderSubtle, ...Shadow.pop,
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.md, minHeight: 42, borderRadius: Radius.sm },
  menuText: { ...Typography.bodySmall, color: Colors.text, flex: 1 },

  scrim: { flex: 1, backgroundColor: Colors.scrim, alignItems: 'center', justifyContent: 'center', padding: Space.base },
  dialog: { width: '100%', maxWidth: 440, maxHeight: '85%', backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, gap: Space.md, ...Shadow.pop },
  dialogHead: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  close: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgSubtle },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingHorizontal: Space.base, minHeight: 46, backgroundColor: Colors.bgSubtle, borderRadius: Radius.full },
  searchInput: { flex: 1, minWidth: 0, ...Typography.body, color: Colors.text, paddingVertical: 10 },
})
