import { Alert, Platform } from 'react-native'
import { toast } from './ui'

/**
 * A short message that works everywhere. On the web (where react-native-web's
 * Alert.alert does nothing) it is a toast in the Atelier style rather than the
 * browser's blocking dialog; on iPad / phone it is the system alert.
 */
export function showAlert(title: string, message?: string, tone: 'success' | 'error' | 'info' = 'info'): void {
  if (Platform.OS === 'web') {
    toast(message ?? title, { title: message ? title : undefined, tone, ms: 7000 })
    return
  }
  Alert.alert(title, message)
}
