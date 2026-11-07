import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import type { CustomerMeasurements } from '../../lib/types'

// Staff-entered body measurements for a walk-in customer (needed only for Size
// Assist). Values are kept as strings while editing; parseMeasurements validates.

export type MeasurementValues = Record<'heightCm' | 'weightKg' | 'chestIn' | 'waistIn' | 'hipIn', string> & {
  fitPreference: CustomerMeasurements['fitPreference']
}

const FIELDS: { key: Exclude<keyof MeasurementValues, 'fitPreference'>; label: string; unit: string }[] = [
  { key: 'heightCm', label: 'Height', unit: 'cm' },
  { key: 'weightKg', label: 'Weight', unit: 'kg' },
  { key: 'chestIn',  label: 'Chest',  unit: 'in' },
  { key: 'waistIn',  label: 'Waist',  unit: 'in' },
  { key: 'hipIn',    label: 'Hip',    unit: 'in' },
]

const FITS: CustomerMeasurements['fitPreference'][] = ['slim', 'regular', 'relaxed']

export function emptyMeasurementValues(m?: CustomerMeasurements | null): MeasurementValues {
  return {
    heightCm: m ? String(m.heightCm) : '',
    weightKg: m ? String(m.weightKg) : '',
    chestIn:  m ? String(m.chestIn) : '',
    waistIn:  m ? String(m.waistIn) : '',
    hipIn:    m ? String(m.hipIn) : '',
    fitPreference: m?.fitPreference ?? 'regular',
  }
}

/** null = nothing entered (allowed); error = partially or wrongly filled. */
export function parseMeasurements(v: MeasurementValues):
  { measurements: CustomerMeasurements | null; error?: undefined } | { error: string } {
  const filled = FIELDS.filter((f) => v[f.key].trim() !== '')
  if (filled.length === 0) return { measurements: null }
  const nums = Object.fromEntries(FIELDS.map((f) => [f.key, Number(v[f.key].replace(',', '.'))]))
  const bad = FIELDS.filter((f) => !(nums[f.key] > 0))
  if (bad.length) return { error: `Fill in ${bad.map((f) => f.label.toLowerCase()).join(', ')} — or leave all measurements empty.` }
  return { measurements: { ...(nums as Omit<CustomerMeasurements, 'fitPreference'>), fitPreference: v.fitPreference } }
}

export function MeasurementsFields({ value, onChange }: {
  value: MeasurementValues
  onChange: (v: MeasurementValues) => void
}) {
  return (
    <View style={{ gap: Space.md }}>
      <View style={s.grid}>
        {FIELDS.map((f) => (
          <View key={f.key} style={s.cell}>
            <Text style={s.label}>{f.label.toUpperCase()}</Text>
            <View style={s.inputRow}>
              <TextInput
                style={s.input}
                value={value[f.key]}
                onChangeText={(t) => onChange({ ...value, [f.key]: t })}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={Colors.textFaint}
              />
              <Text style={s.unit}>{f.unit}</Text>
            </View>
          </View>
        ))}
      </View>
      <View>
        <Text style={s.label}>FIT PREFERENCE</Text>
        <View style={s.fitRow}>
          {FITS.map((fit) => {
            const on = value.fitPreference === fit
            return (
              <TouchableOpacity
                key={fit}
                style={[s.fitPill, on && s.fitPillOn]}
                onPress={() => onChange({ ...value, fitPreference: fit })}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
              >
                <Text style={[s.fitText, on && s.fitTextOn]}>{fit[0].toUpperCase() + fit.slice(1)}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  cell: { flexGrow: 1, flexBasis: 140 },
  label: { ...Typography.label, marginBottom: Space.xs },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Space.md,
  },
  input: { flex: 1, minWidth: 0, ...Typography.body, color: Colors.text, paddingVertical: 10 },
  unit: { ...Typography.caption },
  fitRow: { flexDirection: 'row', gap: Space.sm },
  fitPill: {
    flex: 1, alignItems: 'center', paddingVertical: 10,
    borderRadius: Radius.full, borderWidth: 1.5, borderColor: Colors.border,
  },
  fitPillOn: { borderColor: Colors.secondary, backgroundColor: Colors.secondary },
  fitText: { ...Typography.bodySmall, fontWeight: '600', color: Colors.text },
  fitTextOn: { color: Colors.textOnDark },
})
