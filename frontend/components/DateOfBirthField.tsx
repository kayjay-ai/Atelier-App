import { View, Text, TextInput, StyleSheet } from 'react-native'
import { Colors, Typography, Space, Radius } from '../lib/theme'

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
  return (
    <View style={s.row}>
      <View style={s.part}>
        <Text style={s.label}>DAY</Text>
        <TextInput style={s.input} value={value.day} placeholder="DD" placeholderTextColor={Colors.textFaint}
          keyboardType="number-pad" maxLength={2} onChangeText={(t) => onChange({ ...value, day: digits(t, 2) })} />
      </View>
      <View style={s.part}>
        <Text style={s.label}>MONTH</Text>
        <TextInput style={s.input} value={value.month} placeholder="MM" placeholderTextColor={Colors.textFaint}
          keyboardType="number-pad" maxLength={2} onChangeText={(t) => onChange({ ...value, month: digits(t, 2) })} />
      </View>
      <View style={[s.part, { flex: 1.4 }]}>
        <Text style={s.label}>YEAR</Text>
        <TextInput style={s.input} value={value.year} placeholder="YYYY" placeholderTextColor={Colors.textFaint}
          keyboardType="number-pad" maxLength={4} onChangeText={(t) => onChange({ ...value, year: digits(t, 4) })} />
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  row:   { flexDirection: 'row', gap: Space.sm },
  part:  { flex: 1, minWidth: 0, gap: Space.xs },
  label: { ...Typography.label, color: Colors.textFaint },
  input: {
    minWidth: 0, width: '100%', backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Space.md, paddingVertical: 12, ...Typography.body, color: Colors.text, textAlign: 'center',
  },
})
