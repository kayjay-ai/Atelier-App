import { View, StyleSheet } from 'react-native'
import { Space } from '../lib/theme'
import { Field } from '../lib/ui'

// Day / Month / Year boxes — works the same on web, iPad and phones (no native
// date picker differences). Value is the three strings; parseDob validates.

export interface DobValue { day: string; month: string; year: string }

export const dobFromIso = (iso: string | null | undefined): DobValue => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  return m ? { day: String(Number(m[3])), month: String(Number(m[2])), year: m[1] } : { day: '', month: '', year: '' }
}

/** 'YYYY-MM-DD', or an error message for the user. */
export function parseDob(v: DobValue): { iso: string } | { error: string } {
  const d = Number(v.day), m = Number(v.month), y = Number(v.year)
  if (!v.day || !v.month || v.year.length !== 4) return { error: 'Enter your full date of birth.' }
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return { error: 'That date doesn’t exist — check the day and month.' }
  }
  const now = new Date()
  if (date > now || y < now.getFullYear() - 120) return { error: 'Enter your real date of birth.' }
  return { iso: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
}

export function DateOfBirthField({ value, onChange }: { value: DobValue; onChange: (v: DobValue) => void }) {
  const digits = (s: string, n: number) => s.replace(/\D/g, '').slice(0, n)
  const parts = [
    { key: 'day', label: 'Day', placeholder: 'DD', max: 2, flex: 1 },
    { key: 'month', label: 'Month', placeholder: 'MM', max: 2, flex: 1 },
    { key: 'year', label: 'Year', placeholder: 'YYYY', max: 4, flex: 1.4 },
  ] as const
  return (
    <View style={s.row} accessibilityLabel="Date of birth">
      {parts.map((p) => (
        <Field
          key={p.key}
          label={p.label}
          value={value[p.key]}
          placeholder={p.placeholder}
          keyboardType="number-pad"
          maxLength={p.max}
          onChangeText={(t) => onChange({ ...value, [p.key]: digits(t, p.max) })}
          containerStyle={[s.part, { flex: p.flex }]}
          inputStyle={s.input}
          accessibilityLabel={`Birth ${p.label.toLowerCase()}`}
        />
      ))}
    </View>
  )
}

const s = StyleSheet.create({
  row:   { flexDirection: 'row', gap: Space.sm },
  part:  { minWidth: 0, marginTop: 0 },
  input: { textAlign: 'center', paddingHorizontal: Space.sm },
})
