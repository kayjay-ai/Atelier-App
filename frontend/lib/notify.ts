import { Alert, Platform } from 'react-native'

/**
 * A simple message dialog that works everywhere. On the web, react-native-web's
 * Alert.alert does nothing at all, so use the browser's own dialog there.
 */
export function showAlert(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(message ? `${title}\n\n${message}` : title)
    return
  }
  Alert.alert(title, message)
}
