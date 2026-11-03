import { Platform, Share } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'

// Download / share a try-on image (data URI or signed https URL). On web it's a
// file download / Web Share; on native (iPad app) the image is copied to a local
// file and handed to the system share sheet, which also offers "Save Image".

async function toBlob(src: string): Promise<Blob> {
  const res = await fetch(src)
  if (!res.ok) throw new Error(`Could not fetch the image (${res.status}).`)
  return res.blob()
}

/** Native: a file:// copy of the image, which the iOS share sheet can save. */
async function toLocalFile(src: string, filename: string): Promise<string> {
  const dest = `${FileSystem.cacheDirectory}${filename}`
  if (src.startsWith('data:')) {
    await FileSystem.writeAsStringAsync(dest, src.slice(src.indexOf(',') + 1), { encoding: FileSystem.EncodingType.Base64 })
    return dest
  }
  const res = await FileSystem.downloadAsync(src, dest)
  if (res.status !== 200) throw new Error(`Could not fetch the image (${res.status}).`)
  return res.uri
}

export async function downloadImage(src: string, filename: string): Promise<void> {
  if (Platform.OS !== 'web') {
    // No downloads folder on iPad: the share sheet's "Save Image" puts it in Photos.
    await Share.share({ url: await toLocalFile(src, filename) })
    return
  }
  // Fetch to a blob first: the download attribute is ignored on cross-origin URLs.
  const url = URL.createObjectURL(await toBlob(src))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Share sheet (WhatsApp / AirDrop / Messages) — falls back to download on web. */
export async function shareImage(src: string, filename: string, title: string): Promise<void> {
  if (Platform.OS === 'web') {
    const blob = await toBlob(src)
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' })
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title })
      } catch (e: any) {
        if (e?.name !== 'AbortError') throw e // user closing the sheet is not an error
      }
      return
    }
    await downloadImage(src, filename)
    return
  }
  await Share.share({ url: await toLocalFile(src, filename), title })
}
