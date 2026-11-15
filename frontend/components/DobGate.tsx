import { useState } from 'react'
import { Text, View } from 'react-native'
import { supabase } from '../lib/supabaseClient'
import { upsertProfile } from '../lib/supabaseStorage'
import { useProfileStore } from '../lib/store'
import { Colors, Space, Typography } from '../lib/theme'
import { Notice, PillButton, Sheet, TextLink } from '../lib/ui'
import { DateOfBirthField, parseDob, type DobValue } from './DateOfBirthField'

// A required date of birth over the shopper app, for a personal account that
// has none yet (Google / Apple sign-up; the email form asks for it on sign-up).
// It can't be closed: the only ways out are saving a valid date or signing out.
export function DobGate() {
  const { loaded, dobTracked, dateOfBirth, ownerId } = useProfileStore()
  const [dob, setDob] = useState<DobValue>({ day: '', month: '', year: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visible = loaded && dobTracked && !dateOfBirth && !!ownerId

  async function save() {
    setError(null)
    const parsed = parseDob(dob)
    if ('error' in parsed) { setError(parsed.error); return }
    setSaving(true)
    try {
      const { data } = await supabase.auth.getSession()
      const user = data.session?.user
      if (!user) throw new Error('your session ended — sign in again')
      await upsertProfile(user.id, user.email ?? '', { dateOfBirth: parsed.iso })
      useProfileStore.getState().setAccount({ dateOfBirth: parsed.iso })
    } catch (e: any) {
      setError(`Couldn't save — ${e?.message ?? 'please try again'}.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet visible={visible} title="Your date of birth" onClose={() => {}} closeDisabled width={440}>
      <Text style={[Typography.bodySmall, { color: Colors.textMuted }]}>
        We need this once to tailor advice — some pieces are only meant for certain ages.
      </Text>
      <View style={{ gap: 6 }}>
        <DateOfBirthField value={dob} onChange={setDob} />
      </View>
      {error && <Notice tone="error" text={error} />}
      <PillButton label="Continue" onPress={save} loading={saving} />
      <TextLink label="Sign out" onPress={() => { supabase.auth.signOut() }} style={{ alignSelf: 'center' }} />
    </Sheet>
  )
}
