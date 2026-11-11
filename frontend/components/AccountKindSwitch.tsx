import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { Colors, Typography, Space, Radius } from '../lib/theme'

/**
 * Who is signing in, picked at the top of the sign-in pages:
 *   personal → the shopper (B2C) app
 *   store    → Company › Store staff: the in-store (B2B) app
 *   owner    → Company › Owner: the owner portal (/owner)
 */
export type SignInRole = 'personal' | 'store' | 'owner'

export function AccountKindSwitch({ value, onChange, disabled }: {
  value: SignInRole; onChange: (v: SignInRole) => void; disabled?: boolean
}) {
  const company = value !== 'personal'
  return (
    <View style={s.wrap}>
      <View style={s.row} accessibilityRole="tablist">
        {([
          ['personal', 'Personal', 'For you'],
          ['company', 'Company', 'Stores & owners'],
        ] as const).map(([v, label, hint]) => {
          const on = v === 'company' ? company : !company
          return (
            <TouchableOpacity
              key={v}
              style={[s.btn, on && s.btnOn]}
              onPress={() => onChange(v === 'company' ? (company ? value : 'store') : 'personal')}
              disabled={disabled}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${label} — ${hint}`}
            >
              <Text style={[s.label, on && s.labelOn]}>{label}</Text>
              <Text style={[s.hint, on && s.hintOn]}>{hint}</Text>
            </TouchableOpacity>
          )
        })}
      </View>
      {company && (
        <View style={s.subRow} accessibilityRole="tablist">
          {([
            ['store', 'Store staff', 'Open the store app'],
            ['owner', 'Owner', 'Track all your stores'],
          ] as const).map(([v, label, hint]) => {
            const on = value === v
            return (
              <TouchableOpacity
                key={v}
                style={[s.subBtn, on && s.subBtnOn]}
                onPress={() => onChange(v)}
                disabled={disabled}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${label} — ${hint}`}
              >
                <Text style={[s.subLabel, on && s.subLabelOn]}>{label}</Text>
                <Text style={s.subHint}>{hint}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { marginBottom: Space.xl, gap: Space.sm },
  row: {
    flexDirection: 'row', gap: Space.xs, padding: Space.xs,
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.full,
    borderWidth: 1, borderColor: Colors.border,
  },
  btn:     { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 48, paddingVertical: Space.sm, borderRadius: Radius.full },
  btnOn:   { backgroundColor: Colors.secondary },
  label:   { ...Typography.body, fontWeight: '600', color: Colors.text },
  labelOn: { color: Colors.textOnDark },
  hint:    { ...Typography.caption, color: Colors.textFaint, marginTop: 1 },
  hintOn:  { color: Colors.textOnDark, opacity: 0.8 },

  subRow: { flexDirection: 'row', gap: Space.sm },
  subBtn: {
    flex: 1, alignItems: 'center', paddingVertical: Space.sm, borderRadius: Radius.md,
    borderWidth: 1.5, borderColor: Colors.border, backgroundColor: Colors.bgCard,
  },
  subBtnOn:   { borderColor: Colors.secondary, backgroundColor: Colors.primarySubtle },
  subLabel:   { ...Typography.bodySmall, fontWeight: '600', color: Colors.textMuted },
  subLabelOn: { color: Colors.secondary },
  subHint:    { ...Typography.caption, color: Colors.textFaint },
})
