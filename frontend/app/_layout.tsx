import { useEffect } from 'react'
import { Platform, View } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useFonts } from 'expo-font'
import { Montserrat_400Regular } from '@expo-google-fonts/montserrat/400Regular'
import { Montserrat_500Medium } from '@expo-google-fonts/montserrat/500Medium'
import { Montserrat_600SemiBold } from '@expo-google-fonts/montserrat/600SemiBold'
import { Italiana_400Regular } from '@expo-google-fonts/italiana/400Regular'
import { Colors, NATIVE_FONTS } from '../lib/theme'
import { DialogHost, ToastHost } from '../lib/ui'
import { supabase } from '../lib/supabaseClient'
import { useAccountStore } from '../lib/account'
import { useStoreSession } from '../lib/b2b'
import { stopHeartbeat } from '../lib/heartbeat'
import { useOwnerStore } from '../lib/owner'
import { useProfileStore, useGarmentStore, useMembershipStore, useTryOnCacheStore } from '../lib/store'

// The typefaces on iPad / phone (the web loads them through CSS in +html.tsx).
const NATIVE_FONT_FILES: Record<string, number> = Platform.OS === 'web' ? {} : {
  [NATIVE_FONTS.regular]: Montserrat_400Regular,
  [NATIVE_FONTS.medium]: Montserrat_500Medium,
  [NATIVE_FONTS.semibold]: Montserrat_600SemiBold,
  [NATIVE_FONTS.display]: Italiana_400Regular,
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(NATIVE_FONT_FILES)

  // A different login on the same device must never inherit the previous
  // account's interface (B2B ↔ B2C) or in-store working state.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        stopHeartbeat()
        useAccountStore.getState().clear()
        useStoreSession.getState().reset()
        useProfileStore.getState().reset()
        useProfileStore.getState().setOwner(null)
        useGarmentStore.getState().clear()
        useMembershipStore.getState().setMembership(null)
        useTryOnCacheStore.getState().clear()
        useOwnerStore.getState().clear()
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  // Native: wait for the typefaces (a moment, from the app bundle) so text
  // never reflows; a font that fails to load falls back to the system face.
  if (Platform.OS !== 'web' && !fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: Colors.bg }} />
  }

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, animation: Platform.OS === 'web' ? 'none' : 'fade', contentStyle: { backgroundColor: Colors.bg } }}>
        <Stack.Screen name="index"  options={{ headerShown: false }} />
        <Stack.Screen name="auth"   options={{ headerShown: false }} />
        <Stack.Screen name="welcome" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="store"  options={{ headerShown: false }} />
        <Stack.Screen name="owner"  options={{ headerShown: false }} />
        <Stack.Screen name="invite" options={{ headerShown: false }} />
      </Stack>
      {/* Toasts and dialogs for every part of the app (shopper, store, owner). */}
      <ToastHost />
      <DialogHost />
    </View>
  )
}
