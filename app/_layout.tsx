import { useEffect } from 'react'
import { Platform, View } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Colors } from '../lib/theme'
import { supabase } from '../lib/supabaseClient'
import { useAccountStore } from '../lib/account'
import { useStoreSession } from '../lib/b2b'
import { stopHeartbeat } from '../lib/heartbeat'
import { useProfileStore, useGarmentStore, useMembershipStore, useTryOnCacheStore } from '../lib/store'

export default function RootLayout() {
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
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, animation: Platform.OS === 'web' ? 'none' : 'fade' }}>
        <Stack.Screen name="index"  options={{ headerShown: false }} />
        <Stack.Screen name="auth"   options={{ headerShown: false }} />
        <Stack.Screen name="welcome" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="store"  options={{ headerShown: false }} />
      </Stack>
    </View>
  )
}
