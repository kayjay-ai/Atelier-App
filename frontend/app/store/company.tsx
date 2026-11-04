import { useCallback, useEffect, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, ScrollView, Image, StyleSheet, Linking } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { supabase } from '../../lib/supabaseClient'
import { useAccountStore } from '../../lib/account'
import { signOutStore, useHeartbeat } from '../../lib/heartbeat'
import { SUPPORT_EMAIL } from '../../lib/b2b'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon, PillButton } from '../../lib/ui'

// Spec §2.10. Company details are maintained by the Atelier admin for now (shown
// read-only); stores are view-only and never limited.

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <Text style={value ? s.value : s.valueEmpty}>{value || 'Not set'}</Text>
    </View>
  )
}

export default function CompanyScreen() {
  const account = useAccountStore((st) => st.account)
  const refresh = useAccountStore((st) => st.refresh)
  const deviceCode = useHeartbeat((st) => st.deviceCode)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user?.email ?? ''))
  }, [])
  useFocusEffect(useCallback(() => { refresh() }, [refresh]))

  if (account?.type !== 'b2b_company') return null
  const { client, stores } = account

  async function changePassword() {
    setPwMsg(null)
    if (pw.length < 8) { setPwMsg({ ok: false, text: 'Use at least 8 characters.' }); return }
    if (pw !== pw2) { setPwMsg({ ok: false, text: 'The two passwords don’t match.' }); return }
    setPwBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setPwBusy(false)
    if (error) { setPwMsg({ ok: false, text: error.message }); return }
    setPw(''); setPw2('')
    setPwMsg({ ok: true, text: 'Password changed. Use it next time you sign in on any device.' })
  }

  async function signOut() {
    await signOutStore() // last heartbeat → dashboard shows this device Offline at once
    router.replace('/auth')
  }

  return (
    <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
      <View style={s.head}>
        {client.logoUrl
          ? <Image source={{ uri: client.logoUrl }} style={s.logo} resizeMode="contain" />
          : <View style={[s.logo, s.logoEmpty]}><Icon name="company" size={32} color={Colors.primary} /></View>}
        <View style={{ flex: 1 }}>
          <Text style={s.title}>{client.companyName}</Text>
          <Text style={s.muted}>Signed in as {email}</Text>
        </View>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Company details</Text>
        <View style={s.fields}>
          <Field label="CONTACT PERSON" value={client.contactName} />
          <Field label="EMAIL" value={client.contactEmail} />
          <Field label="PHONE" value={client.contactPhone} />
          <Field label="GSTIN" value={client.gstin} />
          <Field label="BILLING ADDRESS" value={client.billingAddress} />
        </View>
        <Text style={s.muted}>To change these details, contact Atelier.</Text>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Stores</Text>
        {stores.length === 0 ? (
          <Text style={s.muted}>No stores added yet. Any number of stores and iPads can use Atelier.</Text>
        ) : stores.map((st) => (
          <View key={st.id} style={s.storeRow}>
            <Icon name="company" size={18} color={Colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={s.value}>{st.name}</Text>
              {(st.city || st.address) && <Text style={s.muted}>{[st.address, st.city].filter(Boolean).join(', ')}</Text>}
            </View>
          </View>
        ))}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Change password</Text>
        <TextInput style={s.input} value={pw} onChangeText={setPw} secureTextEntry autoComplete="new-password" placeholder="New password" placeholderTextColor={Colors.textFaint} />
        <TextInput style={s.input} value={pw2} onChangeText={setPw2} secureTextEntry autoComplete="new-password" placeholder="Repeat new password" placeholderTextColor={Colors.textFaint} />
        {pwMsg && <Text style={[s.muted, { color: pwMsg.ok ? Colors.success : Colors.error }]}>{pwMsg.text}</Text>}
        <PillButton variant="secondary" label="Update password" onPress={changePassword} loading={pwBusy} />
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Support</Text>
        {SUPPORT_EMAIL ? (
          <TouchableOpacity style={s.supportRow} onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}>
            <Text style={s.value}>Contact Atelier</Text>
            <Text style={s.link}>{SUPPORT_EMAIL}</Text>
          </TouchableOpacity>
        ) : (
          <Text style={s.muted}>Contact your Atelier account manager for help.</Text>
        )}
        <Text style={s.muted}>
          How it works: New customer → take their photo → Upload garment → Try on → pick the customer. Every result is saved in their folder for 15 days.
        </Text>
      </View>

      {deviceCode && (
        <Text style={s.deviceCode}>This device · device code {deviceCode}</Text>
      )}

      <TouchableOpacity style={s.signOut} onPress={signOut}>
        <Icon name="logout" size={18} color={Colors.error} />
        <Text style={s.signOutText}>Sign out of this device</Text>
      </TouchableOpacity>
    </ScrollView>
  )
}

const s = StyleSheet.create({
  scroll: { padding: Space.lg, paddingBottom: Space.xxl, gap: Space.md, maxWidth: 820, width: '100%', alignSelf: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', gap: Space.md, marginBottom: Space.sm },
  logo: { width: 64, height: 64, borderRadius: Radius.md, backgroundColor: Colors.bgCard },
  logoEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border },
  title: { ...Typography.h1 },
  muted: { ...Typography.bodySmall, color: Colors.textMuted },
  card: { backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, gap: Space.md },
  cardTitle: { ...Typography.h3 },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  field: { flexBasis: 220, flexGrow: 1, gap: 2 },
  label: { ...Typography.label },
  value: { ...Typography.body },
  valueEmpty: { ...Typography.body, color: Colors.textFaint },
  storeRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  input: {
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Space.base, paddingVertical: 12, ...Typography.body, color: Colors.text,
  },
  supportRow: { gap: 2 },
  link: { ...Typography.bodySmall, fontWeight: '600', color: Colors.secondary },
  signOut: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.sm, paddingVertical: Space.lg },
  signOutText: { ...Typography.body, fontWeight: '600', color: Colors.error },
  deviceCode: { ...Typography.caption, color: Colors.textFaint, textAlign: 'center' },
})
