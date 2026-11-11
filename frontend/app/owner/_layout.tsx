import { Stack } from 'expo-router'
import { Platform } from 'react-native'

// /owner: the owner portal. login / activate / forgot are open; everything in
// (portal) needs an owner session (its layout sends anyone else to /owner/login).
export default function OwnerLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: Platform.OS === 'web' ? 'none' : 'fade' }} />
}
