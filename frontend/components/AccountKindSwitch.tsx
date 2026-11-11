import { View, StyleSheet } from 'react-native'
import { Colors, Space } from '../lib/theme'
import { Segmented } from '../lib/ui'

/**
 * Who is signing in, picked at the top of the sign-in pages:
 *   personal → the shopper (B2C) app
 *   store    → Company › Store staff: the in-store (B2B) app
 *   owner    → Company › Owner: the owner portal (/owner)
 */
export type SignInRole = 'personal' | 'store' | 'owner'

const KINDS = [
  { value: 'personal', label: 'Personal', hint: 'For you' },
  { value: 'company', label: 'Company', hint: 'Stores & owners' },
] as const

const ROLES = [
  { value: 'store', label: 'Store staff', hint: 'Store iPads' },
  { value: 'owner', label: 'Owner', hint: 'All your stores' },
] as const

export function AccountKindSwitch({ value, onChange, disabled }: {
  value: SignInRole; onChange: (v: SignInRole) => void; disabled?: boolean
}) {
  const company = value !== 'personal'
  return (
    <View style={s.wrap}>
      <Segmented
        options={KINDS} size="lg" disabled={disabled} accessibilityLabel="Account type"
        value={company ? 'company' : 'personal'}
        onChange={(v) => onChange(v === 'company' ? (company ? value : 'store') : 'personal')}
      />
      {company && (
        <Segmented
          options={ROLES} size="md" disabled={disabled} accessibilityLabel="Company role"
          value={value === 'owner' ? 'owner' : 'store'}
          onChange={onChange}
          style={s.sub}
        />
      )}
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { gap: Space.sm, marginBottom: Space.sm },
  sub:  { marginHorizontal: Space.lg, backgroundColor: 'transparent', borderWidth: 1, borderColor: Colors.border },
})
