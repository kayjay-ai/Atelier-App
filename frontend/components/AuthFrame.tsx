import { ReactNode } from 'react'
import {
  View, Text, ScrollView, ImageBackground, KeyboardAvoidingView, Platform, StyleSheet, useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import { Colors, Typography, Space, Layout } from '../lib/theme'
import { Title, Wordmark } from '../lib/ui'

// The frame of every sign-in page (sign in, welcome, owner sign-in /
// activation / reset, store invite). Phones and iPads in portrait: the
// wordmark over one centred column. From Layout.desktop: split in two — the
// charcoal stage with the photograph on the left, the form on the right.

const STAGE = {
  personal: {
    title: 'See It On You',
    line: 'Virtual try-on, your size and an honest second opinion on any piece you find.',
  },
  company: {
    title: 'Atelier For Stores',
    line: 'Walk-in try-ons on your store iPads, and every store’s devices, credits and payments in one place.',
  },
} as const

export function AuthFrame({ title, subtitle, children, top, audience = 'personal' }: {
  title?: string; subtitle?: string; children: ReactNode; top?: ReactNode; audience?: keyof typeof STAGE
}) {
  const { width, height } = useWindowDimensions()
  const desktop = width >= Layout.desktop
  const gutter = Layout.gutter(width)

  const form = (
    <View style={s.column}>
      {!desktop && <View style={s.brand}><Wordmark size="md" /></View>}
      {top}
      {!!title && <Title size="h1" style={s.title}>{title}</Title>}
      {!!subtitle && <Text style={s.subtitle}>{subtitle}</Text>}
      {children}
    </View>
  )

  const scroller = (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[s.scroll, { paddingHorizontal: gutter }, desktop && { justifyContent: 'center', minHeight: height }]}
        keyboardShouldPersistTaps="handled"
      >
        {form}
      </ScrollView>
    </KeyboardAvoidingView>
  )

  if (!desktop) return <SafeAreaView style={s.safe}>{scroller}</SafeAreaView>

  const stage = STAGE[audience]
  return (
    <View style={s.split}>
      <ImageBackground
        source={require('../assets/hero.jpg')}
        style={s.stage}
        imageStyle={s.stageImage}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
      >
        {/* The photograph's backdrop is already charcoal; deepen it under the words. */}
        <LinearGradient
          colors={['rgba(66,61,58,0.15)', 'rgba(66,61,58,0.05)', 'rgba(42,39,37,0.92)']}
          locations={[0, 0.45, 1]}
          style={StyleSheet.absoluteFill}
        />
        <View style={s.stageInner}>
          <Wordmark size="sm" tone="light" align="left" />
          <View style={s.stageCopy}>
            <Title size="display" tone="light">{stage.title}</Title>
            <Text style={s.stageLine}>{stage.line}</Text>
          </View>
        </View>
      </ImageBackground>
      <View style={s.formSide}>{scroller}</View>
    </View>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Colors.bg },
  scroll: { flexGrow: 1, paddingTop: Space.xl, paddingBottom: Space.xxl },
  column: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  brand:  { alignItems: 'center', marginBottom: Space.xl },
  title:  { marginTop: Space.lg, marginBottom: Space.sm },
  subtitle: { ...Typography.body, color: Colors.textMuted, marginBottom: Space.xs },

  split: { flex: 1, flexDirection: 'row', backgroundColor: Colors.bg },
  stage: { flex: 1, maxWidth: 760, backgroundColor: Colors.bgDark, overflow: 'hidden' },
  stageImage: { width: '100%', height: '100%' },
  stageInner: { flex: 1, justifyContent: 'space-between', padding: Space.xxl },
  stageCopy: { gap: Space.base, maxWidth: 460 },
  stageLine: { ...Typography.body, fontSize: 16, lineHeight: 25, color: Colors.textOnDarkMuted },
  formSide: { flex: 1, minWidth: 460 },
})
