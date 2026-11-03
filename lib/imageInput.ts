import { Platform } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import * as FileSystem from 'expo-file-system/legacy'

// Camera or photo-library pick, returned as a data URI (what the API and the
// Storage upload both take). Works on native and web — on web the camera option
// opens the device camera through the browser's file input.
export async function pickImageDataUri(
  source: 'camera' | 'library',
  opts: { quality?: number; allowsEditing?: boolean } = {},
): Promise<string | null> {
  if (Platform.OS !== 'web') {
    const perm = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) throw new Error(source === 'camera' ? 'Allow camera access to take a photo.' : 'Allow photo library access.')
  }

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: opts.quality ?? 0.8,
    allowsEditing: opts.allowsEditing ?? false,
    base64: true,
  }
  const picked = source === 'camera'
    ? await ImagePicker.launchCameraAsync(options)
    : await ImagePicker.launchImageLibraryAsync(options)
  if (picked.canceled || !picked.assets[0]) return null

  const asset = picked.assets[0]
  if (asset.uri.startsWith('data:')) return asset.uri
  const mime = asset.mimeType ?? 'image/jpeg'
  if (asset.base64) return `data:${mime};base64,${asset.base64}`
  const raw = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 })
  return `data:${mime};base64,${raw}`
}
