import { Platform } from 'react-native'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? ''

// Cloud-only: without these, nothing can be saved or loaded. Fail loudly.
if (!supabaseUrl || !supabaseAnonKey) {
  const missing = [
    !supabaseUrl && 'EXPO_PUBLIC_SUPABASE_URL',
    !supabaseAnonKey && 'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  ].filter(Boolean).join(', ')
  console.error(
    `[Atelier] Supabase is not configured — missing ${missing}. This app stores all user data in ` +
    'the cloud, so profile, photo, history and credits cannot be saved or loaded until these env vars are set.',
  )
}

function getAuthStorage() {
  if (Platform.OS === 'web') return undefined // Supabase defaults to localStorage on web
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@react-native-async-storage/async-storage').default
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: getAuthStorage(),
    autoRefreshToken: true,
    persistSession: true,
    // Web: Google / Apple sign-in return to /auth with the session in the URL,
    // which the client must read. Native has no URL session.
    detectSessionInUrl: Platform.OS === 'web',
  },
})
