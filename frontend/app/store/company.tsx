import { useCallback, useEffect, useState } from 'react'
import { View, Text, Image, StyleSheet, Linking } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { supabase } from '../../lib/supabaseClient'
import { useAccountStore } from '../../lib/account'
import { signOutStore, useHeartbeat } from '../../lib/heartbeat'
import { SUPPORT_EMAIL } from '../../lib/b2b'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Card, Icon, Initials, Notice, Page, PasswordField, PillButton, Tag, TextLink, Title, toast } from '../../lib/ui'

// Spec §2.10. Company details are maintained by the Atelier admin for now (shown
// read-only); stores are view-only and never limited.

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <Text style={value ? s.value : s.valueEmpty} selectable>{value || 'Not set'}</Text>
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
    setPwMsg(null)
    toast('Password changed. Use it next time you sign in on any device.')
  }

  async function signOut() {
    await signOutStore() // last heartbeat → dashboard shows this device Offline at once
    router.replace('/auth')
  }

  return (
    <Page width="app">
      <View style={s.head}>
        {client.logoUrl
          ? <Image source={{ uri: client.logoUrl }} style={s.logo} resizeMode="contain" accessibilityLabel={`${client.companyName} logo`} />
          : <View style={[s.logo, s.logoEmpty]}><Initials name={client.companyName} size={26} tone="light" /></View>}
        <View style={{ flex: 1, minWidth: 0, gap: Space.xs }}>
          <Title size="h1">{client.companyName}</Title>
          <Text style={s.muted} numberOfLines={1}>Signed in as {email}</Text>
        </View>
      </View>

      <View style={s.columns}>
        <View style={s.colMain}>
          <Card>
            <View style={{ gap: 2 }}>
              <Text style={s.cardTitle}>Company details</Text>
              <Text style={s.muted}>Kept up to date by Atelier. Contact us to change them.</Text>
            </View>
            <View style={s.fields}>
              <Detail label="Contact person" value={client.contactName} />
              <Detail label="Email" value={client.contactEmail} />
              <Detail label="Phone" value={client.contactPhone} />
              <Detail label="GSTIN" value={client.gstin} />
              <Detail label="Billing address" value={client.billingAddress} />
            </View>
          </Card>

          <Card>
            <Text style={s.cardTitle}>Stores</Text>
            {stores.length === 0 ? (
              <Text style={s.muted}>No stores added yet. Any number of stores and iPads can use Atelier.</Text>
            ) : stores.map((st, i) => (
              <View key={st.id} style={[s.storeRow, i > 0 && s.rowBorder]}>
                <View style={s.storeIcon}><Icon name="company" size={18} color={Colors.secondary} /></View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.value}>{st.name}</Text>
                  {(st.city || st.address) && <Text style={s.muted}>{[st.address, st.city].filter(Boolean).join(', ')}</Text>}
                </View>
                {st.id === client.id && <Tag label="This store" tone="dark" />}
              </View>
            ))}
          </Card>
        </View>

        <View style={s.colSide}>
          <Card>
            <Text style={s.cardTitle}>Change password</Text>
            <PasswordField label="New password" value={pw} onChangeText={setPw} autoComplete="new-password" containerStyle={{ marginTop: 0 }} />
            <PasswordField label="Repeat new password" value={pw2} onChangeText={setPw2} autoComplete="new-password" containerStyle={{ marginTop: 0 }} />
            {pwMsg && !pwMsg.ok && <Notice tone="error" text={pwMsg.text} />}
            <PillButton label="Update password" size="md" onPress={changePassword} loading={pwBusy} />
          </Card>

          <Card variant="sunken">
            <Text style={s.cardTitle}>Help</Text>
            <Text style={s.muted}>
              New customer, take their photo, upload a garment, then Try It On and choose the customer. Every result is kept in their folder for 15 days.
            </Text>
            {SUPPORT_EMAIL
              ? <TextLink label={`Email ${SUPPORT_EMAIL}`} icon="mail" onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)} />
              : <Text style={s.muted}>Contact your Atelier account manager for help.</Text>}
          </Card>

          <View style={s.device}>
            {deviceCode && <Text style={s.deviceCode}>This iPad’s device code: {deviceCode}</Text>}
            <PillButton label="Sign out of this iPad" icon="logout" variant="outline" size="md" onPress={signOut} />
          </View>
        </View>
      </View>
    </Page>
  )
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: Space.base },
  logo: { width: 72, height: 72, borderRadius: Radius.lg, backgroundColor: Colors.bgCard },
  logoEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgDark },
  columns: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.lg, alignItems: 'flex-start' },
  colMain: { flexBasis: 420, flexGrow: 3, gap: Space.lg },
  colSide: { flexBasis: 300, flexGrow: 2, gap: Space.lg },
  muted: { ...Typography.bodySmall, color: Colors.textMuted },
  cardTitle: { ...Typography.h3 },
  fields: { flexDirection: 'row', flexWrap: 'wrap', rowGap: Space.base, columnGap: Space.lg },
  field: { flexBasis: 200, flexGrow: 1, gap: 2 },
  label: { ...Typography.caption },
  value: { ...Typography.body },
  valueEmpty: { ...Typography.body, color: Colors.textMuted },
  storeRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.sm },
  rowBorder: { borderTopWidth: 1, borderTopColor: Colors.borderSubtle, paddingTop: Space.md },
  storeIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgSubtle },
  device: { gap: Space.sm, alignItems: 'stretch' },
  deviceCode: { ...Typography.caption, textAlign: 'center', fontVariant: ['tabular-nums'] },
})
