import { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Platform, Linking } from 'react-native'
import { create } from 'zustand'
import { Colors, Typography, Space, Radius, Weight } from './theme'
import { Icon, Sheet, type IconName } from './ui'
import { gmailComposeUrl, mailtoUrl, type EmailDraft } from './emailLinks'

// "Email someone" for the whole app. A mailto: link only works when the
// computer has a mail app set up, and most people on the web use Gmail in the
// browser, so on the web this asks how to write: Gmail, the email app, or copy
// the address. Phones and tablets always have a mail app: they open it directly.
// Mounted once at the root (<EmailChooserHost />), like the dialogs and toasts.

const useChooser = create<{ draft: EmailDraft | null }>(() => ({ draft: null }))

/** Write an email to `to`: the email app on iPad / phone, a choice on the web. */
export function composeEmail(draft: EmailDraft) {
  if (Platform.OS !== 'web') {
    Linking.openURL(mailtoUrl(draft)).catch(() => {})
    return
  }
  useChooser.setState({ draft })
}

export function EmailChooserHost() {
  const draft = useChooser((s) => s.draft)
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  // 'checking' while we wait to see whether an email app took the link.
  const [app, setApp] = useState<'checking' | 'none' | null>(null)
  useEffect(() => { setCopied(null); setApp(null) }, [draft])
  if (!draft) return null
  const close = () => useChooser.setState({ draft: null })

  const options: { icon: IconName; label: string; hint: string; onPress: () => void }[] = [
    {
      icon: 'google', label: 'Open in Gmail', hint: 'A new Gmail draft in a new tab',
      onPress: () => { window.open(gmailComposeUrl(draft), '_blank', 'noopener'); close() },
    },
    {
      icon: app === 'none' ? 'alert' : 'mail',
      label: app === 'checking' ? 'Opening your email app…' : 'Open email app',
      hint: app === 'none'
        ? 'No email app opened — this computer has none set up for email links. Use Gmail or copy the address.'
        : 'Outlook, Apple Mail or your default app',
      // Same tab: a mailto: link hands over to the app and the page stays put.
      // The browser gives no answer when no app is set up for email links, so
      // watch for the page losing focus (an app or the "open with" prompt
      // opening); if it doesn't within a moment, say so.
      onPress: () => {
        if (app === 'checking') return
        let opened = false
        const left = () => { opened = true }
        window.addEventListener('blur', left)
        document.addEventListener('visibilitychange', left)
        setApp('checking')
        window.location.href = mailtoUrl(draft)
        setTimeout(() => {
          window.removeEventListener('blur', left)
          document.removeEventListener('visibilitychange', left)
          if (opened) close()
          else setApp('none')
        }, 1500)
      },
    },
    {
      icon: copied === 'yes' ? 'check' : 'copy',
      label: copied === 'yes' ? 'Copied' : 'Copy email address',
      hint: copied === 'failed' ? 'Couldn’t copy — select the address above instead' : 'Paste it into any email',
      onPress: async () => {
        try {
          await navigator.clipboard.writeText(draft.to)
          setCopied('yes')
          setTimeout(close, 900)
        } catch {
          setCopied('failed')
        }
      },
    },
  ]

  return (
    <Sheet visible title="Send an email" onClose={close} width={420}>
      <Text style={s.to} selectable>{draft.to}</Text>
      <View style={s.list}>
        {options.map((o, i) => (
          <TouchableOpacity
            key={o.label}
            style={[s.row, i > 0 && s.rowBorder]}
            onPress={o.onPress}
            accessibilityRole="button"
            accessibilityLabel={o.label}
            accessibilityHint={o.hint}
          >
            <View style={s.icon}><Icon name={o.icon} size={20} color={Colors.secondary} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.label}>{o.label}</Text>
              <Text style={s.hint}>{o.hint}</Text>
            </View>
            <Icon name="chevron" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        ))}
      </View>
    </Sheet>
  )
}

const s = StyleSheet.create({
  to: { ...Typography.body, color: Colors.textMuted, ...({ wordBreak: 'break-all' } as object) },
  list: { borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.lg, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.md, paddingHorizontal: Space.base },
  rowBorder: { borderTopWidth: 1, borderTopColor: Colors.borderSubtle },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgSubtle },
  label: { ...Typography.body, ...Weight.semibold },
  hint: { ...Typography.caption },
})
