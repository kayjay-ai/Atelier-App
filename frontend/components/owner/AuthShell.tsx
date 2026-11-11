import { ReactNode } from 'react'
import { View, Text, StyleSheet, SafeAreaView, ScrollView, KeyboardAvoidingView, Platform } from 'react-native'
import { router } from 'expo-router'
import { Colors, Typography, Space } from '../../lib/theme'
import { AccountKindSwitch } from '../AccountKindSwitch'

/**
 * The frame of the owner's sign-in pages (login, activation, forgot password):
 * the brand, the Personal / Company › Owner switch (so it reads as the same
 * sign-in page), a title and the form.
 */
export function AuthShell({ title, subtitle, children, showSwitch = true }: {
  title: string; subtitle?: string; children: ReactNode; showSwitch?: boolean
}) {
  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.column}>
            <View style={s.brand}>
              <Text style={s.brandSub}>QUASAR'S</Text>
              <Text style={s.brandMark}>ATELIER</Text>
            </View>
            {showSwitch && (
              <AccountKindSwitch
                value="owner"
                onChange={(role) => {
                  if (role === 'personal') router.replace('/auth')
                  else if (role === 'store') router.replace('/auth?as=company')
                }}
              />
            )}
            <Text style={s.title} accessibilityRole="header">{title}</Text>
            {!!subtitle && <Text style={s.subtitle}>{subtitle}</Text>}
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Colors.bg },
  scroll: { flexGrow: 1, padding: Space.lg, paddingTop: Space.xxl },
  column: { width: '100%', maxWidth: 440, alignSelf: 'center' },
  brand:     { alignItems: 'center', marginBottom: Space.xl },
  brandSub:  { ...Typography.label, color: Colors.primary, letterSpacing: 4, fontSize: 11 },
  brandMark: { ...Typography.display, color: Colors.text, fontSize: 32, letterSpacing: 8, fontWeight: '300' },
  title:    { ...Typography.h1, marginBottom: Space.sm },
  subtitle: { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 22, marginBottom: Space.sm },
})
