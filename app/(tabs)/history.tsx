import { useState, useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  View, Text, FlatList, Image, TouchableOpacity, StyleSheet,
  SafeAreaView, Alert, Platform,
} from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import { useGarmentStore, useMembershipStore } from '../../lib/store'
import { getCurrentUserId, listTryOnsFromCloud, deleteTryOnFromCloud } from '../../lib/supabaseStorage'
import { Colors, Typography, Space, Radius, Shadow } from '../../lib/theme'
import { Icon } from '../../lib/ui'
import type { GarmentCheck } from '../../lib/types'

function callColor(call?: string) {
  return call === 'Yes' ? Colors.success : call === 'Skip' ? Colors.error : Colors.warning
}
function callBg(call?: string) {
  return call === 'Yes' ? Colors.successBg : call === 'Skip' ? Colors.errorBg : Colors.warningBg
}

// ─── Download dispatcher ─────────────────────────────────────────────────────
// The stored image (Supabase) is the ORIGINAL, un-watermarked generation — the
// watermark is only composited for display and for non-paying downloads, never
// burned into the stored copy. Paying users (`clean`) get the original file.
// Web composites via <canvas>; native saves the raw JPEG to a user-picked folder.
function downloadImage(imageUri: string, clean: boolean) {
  if (Platform.OS === 'web') { downloadCanvas(imageUri, !clean); return }
  if (Platform.OS === 'android') { saveImageAndroid(imageUri); return }
  Alert.alert('Download', 'Saving is available on Android and the web app.')
}

// Resolve any image (data URI or remote https) down to a base64 payload.
async function imageToBase64(imageUri: string): Promise<string> {
  if (imageUri.startsWith('data:')) return imageUri.substring(imageUri.indexOf(',') + 1)
  const tmp = `${FileSystem.cacheDirectory}atelier-tryon-${Date.now()}.jpg`
  const dl = await FileSystem.downloadAsync(imageUri, tmp)
  return FileSystem.readAsStringAsync(dl.uri, { encoding: FileSystem.EncodingType.Base64 })
}

async function saveImageAndroid(imageUri: string) {
  try {
    const base64 = await imageToBase64(imageUri)
    const perm = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync()
    if (!perm.granted) return
    const fileUri = await FileSystem.StorageAccessFramework.createFileAsync(
      perm.directoryUri, `atelier-tryon-${Date.now()}`, 'image/jpeg',
    )
    await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 })
    Alert.alert('Saved', 'Your try-on image was saved to the folder you selected.')
  } catch (e: any) {
    Alert.alert('Download failed', e?.message ?? 'Could not save the image.')
  }
}

// ─── Web download via <canvas> ──────────────────────────────────────────────
// `watermark` true → diagonal repeating overlay (non-paying); false → clean
// original (paying users). Same CORS-safe path either way; the only difference is
// whether the ATELIER overlay is drawn.
function downloadCanvas(imageUri: string, watermark: boolean) {
  const img = document.createElement('img') as HTMLImageElement
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width  = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)

    if (watermark) {
      // Diagonal repeating watermark — subtle but not croppable
      const fontSize = Math.max(14, Math.floor(img.naturalWidth * 0.038))
      ctx.save()
      ctx.font         = `${fontSize}px "Palatino Linotype", Palatino, Georgia, serif`
      ctx.fillStyle    = 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.translate(canvas.width / 2, canvas.height / 2)
      ctx.rotate(-Math.PI / 5.5)  // ~-33°, diagonal across image

      const spacingX = img.naturalWidth * 0.55
      const spacingY = fontSize * 5
      for (let y = -img.naturalHeight; y < img.naturalHeight; y += spacingY) {
        for (let x = -img.naturalWidth; x < img.naturalWidth; x += spacingX) {
          ctx.fillText('ATELIER', x, y)
        }
      }
      ctx.restore()
    }

    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a   = document.createElement('a')
      a.href     = url
      a.download = watermark ? 'atelier-tryon.jpg' : 'atelier-tryon-hd.jpg'
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/jpeg', 0.92)
  }
  img.src = imageUri
}

// ─── Lightbox ───────────────────────────────────────────────────────────────
function Lightbox({ uri, onClose }: { uri: string; onClose: () => void }) {
  return (
    <View style={[StyleSheet.absoluteFillObject, l.overlay]}>
      <Image source={{ uri }} style={l.img} resizeMode="contain" />
      {/* Diagonal watermark overlay in lightbox */}
      <View style={l.wmOverlay} pointerEvents="none">
        <Text style={l.wmText}>ATELIER</Text>
      </View>
      <TouchableOpacity style={l.closeBtn} onPress={onClose}>
        <Icon name="close" size={26} color="rgba(255,255,255,0.85)" />
      </TouchableOpacity>
    </View>
  )
}

const l = StyleSheet.create({
  overlay:   { backgroundColor: 'rgba(0,0,0,0.93)', justifyContent: 'center', alignItems: 'center', zIndex: 100 },
  img:       { width: '100%', height: '85%' },
  wmOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    // Diagonal tilt via CSS-style transform on web; native will just be centered
    transform: [{ rotate: '-30deg' }],
  },
  wmText:    { ...Typography.h2, color: 'rgba(255,255,255,0.12)', letterSpacing: 8, fontSize: 28 },
  closeBtn:  { position: 'absolute', top: 52, right: 20, padding: 8 },
  closeBtnText: { fontSize: 22, color: 'rgba(255,255,255,0.7)' },
})

// ─── History item card ───────────────────────────────────────────────────────
function HistoryItem({
  item, clean, onDelete, onOpenLightbox,
}: { item: GarmentCheck; clean: boolean; onDelete: () => void; onOpenLightbox: (uri: string) => void }) {
  const v     = item.verdictResult
  const s2    = item.sizeResult
  const tryOnImage = item.tryOnResult?.image && !item.tryOnResult?.fallback
    ? item.tryOnResult.image : null
  const displayUri = tryOnImage ?? item.garment.imageBase64

  // Measure the card so the thumbnail column can be given an explicit height —
  // the only way an <Image> reliably fills the full (variable) card height on
  // native without ballooning to its intrinsic size or rendering at zero.
  const [cardH, setCardH] = useState(0)

  return (
    <View
      style={s.card}
      onLayout={(e) => {
        const h = Math.round(e.nativeEvent.layout.height)
        if (h && h !== cardH) setCardH(h)
      }}
    >
      {/* Thumbnail with diagonal watermark overlay */}
      <TouchableOpacity onPress={() => onOpenLightbox(displayUri)} activeOpacity={0.85}>
        {/* Always keep an explicit height (default 128 before measurement) so the
            image can never balloon to its intrinsic size on the first render. */}
        <View style={[s.thumbWrap, { height: cardH || 128 }]}>
          <Image source={{ uri: displayUri }} style={s.thumb} resizeMode="cover" />
          {tryOnImage && (
            <View style={s.thumbWmWrap} pointerEvents="none">
              <Text style={s.thumbWmText}>ATELIER</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>

      <View style={s.cardBody}>
        {item.garment.brand && <Text style={s.brand}>{item.garment.brand.toUpperCase()}</Text>}
        <Text style={s.name} numberOfLines={2}>{item.garment.name || 'Garment'}</Text>
        <Text style={s.date}>
          {new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </Text>

        <View style={s.pills}>
          {v && (
            <View style={[s.pill, { backgroundColor: callColor(v.call) }]}>
              <Text style={s.pillText}>{v.call}</Text>
            </View>
          )}
          {s2 && (
            <View style={s.pillOutline}>
              <Text style={s.pillOutlineText}>Size {s2.size}</Text>
            </View>
          )}
          {tryOnImage && (
            <View style={[s.pillOutline, { borderColor: Colors.primaryLight }]}>
              <Text style={[s.pillOutlineText, { color: Colors.primaryDark }]}>Tried on</Text>
            </View>
          )}
        </View>

        {v && <Text style={s.verdictSnip} numberOfLines={2}>{v.verdict}</Text>}

        {tryOnImage && (
          <TouchableOpacity style={s.downloadBtn} onPress={() => downloadImage(tryOnImage, clean)}>
            <Icon name="download" size={14} color={Colors.text} />
            <Text style={s.downloadBtnText}>{clean ? 'Download (no watermark)' : 'Download'}</Text>
          </TouchableOpacity>
        )}
      </View>

      <TouchableOpacity style={s.deleteBtn} onPress={onDelete}>
        <Icon name="trash" size={20} color={Colors.textFaint} />
      </TouchableOpacity>
    </View>
  )
}

// ─── Screen ─────────────────────────────────────────────────────────────────
export default function HistoryScreen() {
  const store     = useGarmentStore()
  const { membership } = useMembershipStore()
  // Clean (un-watermarked) download for premium (admin plan='premium') or a real
  // purchase (per_generation/pack_30/pack_100) — NOT a null/'free' plan. Read from
  // the server-sourced membership, so a free user can't spoof it. Everyone can
  // still download; only these get the ORIGINAL file.
  const plan = membership?.plan ?? null
  const clean = !!membership?.isPremium || (plan !== null && plan !== 'free')

  const [lightboxUri, setLightboxUri] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [cloudChecks, setCloudChecks] = useState<GarmentCheck[]>([])

  // Load previously-saved fittings from Supabase so history survives reloads
  // (the local store is not persisted on web) and syncs across devices.
  const loadCloud = useCallback(async () => {
    const uid = await getCurrentUserId()
    setUserId(uid)
    if (!uid) { setCloudChecks([]); return }
    const rows = await listTryOnsFromCloud(uid)
    const localIds = new Set(useGarmentStore.getState().checks.map((c) => c.id))
    // Skip rows already shown from the in-session local store (product_id === local check id).
    const mapped: GarmentCheck[] = rows
      .filter((r) => !localIds.has(r.productId))
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        garment: {
          imageBase64: r.imageUrl,
          name: r.productName,
          source: r.retailerProductUrl ? 'url' : 'upload',
          sourceUrl: r.retailerProductUrl,
        },
        // Reload the full record: image + size prediction + buy verdict.
        tryOnResult: r.imageUrl ? { image: r.imageUrl, demo: r.demo } : undefined,
        sizeResult: r.sizeResult ?? undefined,
        verdictResult: r.verdictResult ?? undefined,
      }))
    setCloudChecks(mapped)
  }, [])

  // Refresh cloud history AND the trusted membership every time History gains focus,
  // so an admin premium change reflects the clean-download eligibility without reinstall.
  useFocusEffect(
    useCallback(() => {
      loadCloud()
      useMembershipStore.getState().refresh()
    }, [loadCloud]),
  )

  // Merge local (rich, in-session) checks with cloud-only history, newest first.
  const localIds = new Set(store.checks.map((c) => c.id))
  const merged: GarmentCheck[] = [...store.checks, ...cloudChecks.filter((c) => !localIds.has(c.id))]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  function removeItem(id: string) {
    if (localIds.has(id)) {
      store.removeCheck(id)
    } else {
      setCloudChecks((prev) => prev.filter((c) => c.id !== id))
      if (userId) deleteTryOnFromCloud(userId, id)
    }
  }

  function confirmDelete(id: string) {
    if (Platform.OS === 'web') { removeItem(id); return }
    Alert.alert(
      'Delete this fitting?',
      "This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => removeItem(id) },
      ],
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
    <SafeAreaView style={s.safe}>
      <View style={s.countRow}>
        <Text style={s.headerCount}>
          {merged.length} piece{merged.length !== 1 ? 's' : ''}
        </Text>
      </View>

      {merged.length === 0 ? (
        <View style={s.empty}>
          <Icon name="tryOn" size={48} color={Colors.border} />
          <Text style={s.emptyTitle}>Nothing checked yet</Text>
          <Text style={s.emptyHint}>Upload a garment on the Home tab to get started.</Text>
        </View>
      ) : (
        <FlatList
          data={merged}
          keyExtractor={(c) => c.id}
          contentContainerStyle={s.list}
          renderItem={({ item }) => (
            <HistoryItem
              item={item}
              clean={clean}
              onDelete={() => confirmDelete(item.id)}
              onOpenLightbox={(uri) => setLightboxUri(uri)}
            />
          )}
        />
      )}
    </SafeAreaView>
    {/* Lightbox outside SafeAreaView so absoluteFillObject covers the full screen */}
    {lightboxUri && <Lightbox uri={lightboxUri} onClose={() => setLightboxUri(null)} />}
    </View>
  )
}

const s = StyleSheet.create({
  safe:  { flex: 1, backgroundColor: Colors.bg },

  countRow: {
    alignItems: 'flex-end',
    paddingHorizontal: Space.base, paddingTop: Space.base, paddingBottom: Space.sm,
  },
  headerCount: { ...Typography.caption, color: Colors.textFaint },

  list: { padding: Space.base, gap: Space.md, paddingBottom: Space.xxl },

  card: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.lg,
    flexDirection: 'row', overflow: 'hidden', ...Shadow.card,
  },

  // Thumbnail with diagonal watermark.
  // `thumbWrap` gets an explicit measured height (see HistoryItem.onLayout) so the
  // image's `height: '100%'` resolves against a real number — it fills the column
  // without ballooning to its intrinsic size.
  thumbWrap:  { position: 'relative', width: 96, backgroundColor: Colors.bgSubtle },
  thumb:      { width: 96, height: '100%' },
  thumbWmWrap: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    transform: [{ rotate: '-30deg' }],
  },
  thumbWmText: { ...Typography.label, color: 'rgba(255,255,255,0.28)', letterSpacing: 3, fontSize: 7 },

  cardBody:    { flex: 1, padding: Space.md, gap: Space.xs },
  brand:       { ...Typography.label, letterSpacing: 1, color: Colors.textFaint },
  name:        { ...Typography.body, fontWeight: '500' as const, fontSize: 14 },
  date:        { ...Typography.caption, color: Colors.textFaint, marginBottom: Space.xs },

  pills:       { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs, marginBottom: Space.xs },
  pill:        { borderRadius: Radius.full, paddingHorizontal: Space.sm, paddingVertical: 3 },
  pillText:    { ...Typography.caption, color: '#FFF', fontWeight: '700' as const },
  pillOutline: { borderRadius: Radius.full, paddingHorizontal: Space.sm, paddingVertical: 3, borderWidth: 1, borderColor: Colors.border },
  pillOutlineText: { ...Typography.caption, color: Colors.textMuted },

  verdictSnip: { ...Typography.caption, color: Colors.textMuted, lineHeight: 17, fontStyle: 'italic' },

  downloadBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Space.xs,
    alignSelf: 'flex-start', marginTop: Space.xs,
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.full,
    borderWidth: 1.5, borderColor: Colors.secondary,
    paddingHorizontal: Space.md, paddingVertical: 5,
  },
  downloadBtnText: { ...Typography.caption, color: Colors.text, fontWeight: '600' as const },

  downloadLocked: {
    flexDirection: 'row', alignItems: 'center', gap: Space.xs,
    alignSelf: 'flex-start', marginTop: Space.xs,
    paddingHorizontal: Space.md, paddingVertical: 5,
    borderRadius: Radius.full, borderWidth: 1.5, borderColor: Colors.primaryLight,
  },
  downloadLockedText: { ...Typography.caption, color: Colors.primaryDark, fontWeight: '600' as const },

  deleteBtn:     { paddingHorizontal: Space.md, justifyContent: 'center', alignItems: 'center' },
  deleteBtnText: { fontSize: 22, color: Colors.border },

  empty:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: Space.md },
  emptyIcon:  { fontSize: 48, color: Colors.border },
  emptyTitle: { ...Typography.h3 },
  emptyHint:  { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center', lineHeight: 22 },
})
