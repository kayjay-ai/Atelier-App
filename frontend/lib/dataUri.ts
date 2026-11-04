import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'

// The API and Storage uploads take images as data URIs. One place to turn what
// the app holds (a Blob, a URL, a native file) into one.

export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'))
    reader.readAsDataURL(blob)
  })
}

/** An image the app holds (data URI, http/blob URL, or a native file URI) as a data URI. */
export async function imageToDataUri(uri: string): Promise<string> {
  if (uri.startsWith('data:')) return uri
  if (Platform.OS === 'web' || /^(https?|blob):/i.test(uri)) {
    const res = await fetch(uri)
    if (!res.ok) throw new Error(`Could not download the image (${res.status}).`)
    return blobToDataUri(await res.blob())
  }
  const raw = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
  return `data:image/jpeg;base64,${raw}`
}
