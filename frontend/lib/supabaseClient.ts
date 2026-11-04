import { Platform } from 'react-native'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? ''

// Cloud-only: without these, nothing can be saved or loaded, so fail loudly
// (createClient would throw anyway, with a less useful message). EXPO_PUBLIC_*
// values are baked in at build time, so a web build needs them set too.
if (!supabaseUrl || !supabaseAnonKey) {
  const missing = [
    !supabaseUrl && 'EXPO_PUBLIC_SUPABASE_URL',
    !supabaseAnonKey && 'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  ].filter(Boolean).join(', ')
  throw new Error(
    `[Atelier] Supabase is not configured: missing ${missing}. Set it in frontend/.env ` +
    '(see frontend/.env.example), or in the build environment for a hosted web build.',
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
