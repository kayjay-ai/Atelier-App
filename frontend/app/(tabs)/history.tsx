import { useState, useCallback } from 'react'
import { router, useFocusEffect } from 'expo-router'
import {
  View, Text, FlatList, Image, TouchableOpacity, Pressable, StyleSheet, SafeAreaView,
  ScrollView, Platform, Linking, Modal, useWindowDimensions,
} from 'react-native'
import { useGarmentStore, useMembershipStore, useProfileStore, isPremium } from '../../lib/store'
import { getCurrentUserId, listTryOnsFromCloud, deleteTryOnFromCloud } from '../../lib/supabaseStorage'
import { downloadImage as nativeSave, shareImage } from '../../lib/shareImage'
import { Colors, Typography, Space, Radius, Shadow, Layout, Weight, FONT_DISPLAY } from '../../lib/theme'
import {
  Card, Chip, EmptyState, Icon, Notice, PageHeader, PillButton, Segmented, Tag, TextLink, confirmDialog, displayProps, toast,
} from '../../lib/ui'
import type { GarmentCheck } from '../../lib/types'

// History tab (spec §3.6): every fitting newest first with try-on + garment,
// brand / website (or "Screenshot"), date, size and buy verdict; filters; a
// detail view with an Original / Try-On toggle; Download, Share, Delete.

type Filter = 'all' | 'links' | 'screenshots'

const callTone = (call?: string) => (call === 'Yes' ? 'success' : call === 'Skip' ? 'error' : 'warning') as 'success' | 'error' | 'warning'
const callLabel = (call?: string) => (call === 'Yes' ? 'Yes, buy it' : call === 'Skip' ? 'Skip it' : 'Maybe')

const domainOf = (url?: string) => {
  try { return url ? new URL(url).hostname.replace(/^www\./, '') : null } catch { return null }
}
const sourceLine = (c: GarmentCheck) =>
  c.garment.brand?.trim() || domainOf(c.garment.sourceUrl) || (c.garment.source === 'url' ? 'Link' : 'Screenshot')

const tryOnOf = (c: GarmentCheck) =>
  c.tryOnResult?.image && !c.tryOnResult.fallback ? c.tryOnResult.image : null

// ─── Image export ─────────────────────────────────────────────────────────────
// The stored image is the ORIGINAL generation; the ATELIER watermark is drawn
// only on export for users who haven't paid. Web renders through <canvas>.
function renderForExport(imageUri: string, watermark: boolean): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img') as HTMLImageElement
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      if (watermark) {
        const fontSize = Math.max(14, Math.floor(img.naturalWidth * 0.038))
        ctx.save()
        ctx.font = `${fontSize}px "Palatino Linotype", Palatino, Georgia, serif`
        ctx.fillStyle = 'rgba(255,255,255,0.22)'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.rotate(-Math.PI / 5.5)
        for (let y = -img.naturalHeight; y < img.naturalHeight; y += fontSize * 5) {
          for (let x = -img.naturalWidth; x < img.naturalWidth; x += img.naturalWidth * 0.55) ctx.fillText('ATELIER', x, y)
        }
        ctx.restore()
      }
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the image.'))), 'image/jpeg', 0.92)
    }
    img.onerror = () => reject(new Error('Could not load the image.'))
    img.src = imageUri
  })
}

async function exportImage(kind: 'download' | 'share', imageUri: string, clean: boolean, title: string) {
  const filename = clean ? 'atelier-tryon-hd.jpg' : 'atelier-tryon.jpg'
  if (Platform.OS !== 'web') {
    // Native: the share sheet ("Save Image" puts it in Photos).
    return kind === 'share' ? shareImage(imageUri, filename, title) : nativeSave(imageUri, filename)
  }
  const blob = await renderForExport(imageUri, !clean)
  const file = new File([blob], filename, { type: 'image/jpeg' })
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (kind === 'share' && nav.share && nav.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file], title }) } catch (e: any) { if (e?.name !== 'AbortError') throw e }
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ─── List card ────────────────────────────────────────────────────────────────
function HistoryCard({ item, onOpen }: { item: GarmentCheck; onOpen: () => void }) {
  const tryOn = tryOnOf(item)
  const garment = item.garment.imageBase64 || null
  const v = item.verdictResult
  return (
    <Pressable
      style={(st: any) => [s.card, st.hovered && s.cardHover]} onPress={onOpen}
      accessibilityRole="button" accessibilityLabel={`${item.garment.name || 'Garment'}. Open details`}
    >
      <View style={s.thumbs}>
        {tryOn ? (
          <View>
            <Image source={{ uri: tryOn }} style={s.thumb} resizeMode="cover" />
            {garment && <Image source={{ uri: garment }} style={s.thumbInset} resizeMode="cover" />}
          </View>
        ) : garment ? (
          <Image source={{ uri: garment }} style={s.thumb} resizeMode="cover" />
        ) : (
          <View style={[s.thumb, s.thumbEmpty]}><Icon name="tryOn" size={22} color={Colors.textFaint} /></View>
        )}
      </View>
      <View style={s.cardBody}>
        <Text {...displayProps(15)} style={s.source} numberOfLines={1}>{sourceLine(item).toUpperCase()}</Text>
        <Text style={s.name} numberOfLines={2}>{item.garment.name || 'Garment'}</Text>
        <Text style={s.date}>{new Date(item.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</Text>
        <View style={s.pills}>
          {tryOn && <Tag label="Tried on" tone="dark" />}
          {item.sizeResult && <Tag label={`Size ${item.sizeResult.size}`} />}
          {v && <Tag label={callLabel(v.call)} tone={callTone(v.call)} dot />}
        </View>
      </View>
      <Icon name="chevron" size={20} color={Colors.textMuted} style={{ alignSelf: 'center', marginRight: Space.base }} />
    </Pressable>
  )
}

// ─── Detail view ──────────────────────────────────────────────────────────────
function HistoryDetail({
  item, clean, onClose, onDelete,
}: { item: GarmentCheck; clean: boolean; onClose: () => void; onDelete: () => Promise<void> }) {
  const userPhoto = useProfileStore((st) => st.photoUri)
  const tryOn = tryOnOf(item)
  const [view, setView] = useState<'tryon' | 'original'>('tryon')
  const [busy, setBusy] = useState<null | 'download' | 'share' | 'delete'>(null)
  const [error, setError] = useState<string | null>(null)

  const shown = view === 'tryon' ? (tryOn ?? item.garment.imageBase64) : (userPhoto ?? item.garment.imageBase64)
  const v = item.verdictResult
  const size = item.sizeResult

  async function act(kind: 'download' | 'share') {
    if (!tryOn) return
    setBusy(kind)
    setError(null)
    try { await exportImage(kind, tryOn, clean, item.garment.name || 'My Atelier try-on') }
    catch (e: any) { setError(e?.message ?? 'Something went wrong.') }
    finally { setBusy(null) }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Delete this fitting?', body: 'The try-on, size and verdict for this piece are removed from every device. This can’t be undone.',
      confirmLabel: 'Delete fitting', danger: true,
    })
    if (!ok) return
    setBusy('delete')
    setError(null)
    try { await onDelete(); toast('Fitting deleted.') }
    catch (e: any) { setError(`Couldn’t delete — ${e?.message ?? 'try again'}.`); setBusy(null) }
  }

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} transparent>
      <View style={d.backdrop}>
        <SafeAreaView style={d.sheet}>
          <View style={d.header}>
            <Text style={d.title} numberOfLines={1}>{item.garment.name || 'Garment'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={d.close}>
              <Icon name="close" size={20} color={Colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={d.scroll}>
            <View style={d.layout}>
              <View style={d.imageCol}>
                {tryOn && (
                  <Segmented
                    options={[{ value: 'tryon', label: 'Try-on' }, { value: 'original', label: 'Original' }] as const}
                    value={view} onChange={setView} size="sm" style={{ alignSelf: 'center', minWidth: 240 }}
                  />
                )}
                <View>
                  <Image source={{ uri: shown }} style={d.image} resizeMode="contain" />
                  {view === 'tryon' && tryOn && <View style={d.badge}><Tag label="AI try-on" tone="dark" /></View>}
                </View>
                {tryOn && (
                  <View style={d.btnRow}>
                    <PillButton label="Download" icon="download" size="md" onPress={() => act('download')} loading={busy === 'download'} disabled={!!busy} style={d.flexBtn} />
                    <PillButton label="Share" icon="share" size="md" variant="outline" onPress={() => act('share')} loading={busy === 'share'} disabled={!!busy} style={d.flexBtn} />
                  </View>
                )}
                {tryOn && !clean && <Text style={d.note}>Free downloads carry a light Atelier watermark. Any plan gives clean images.</Text>}
              </View>

              <View style={d.infoCol}>
                <Card style={{ gap: Space.sm }}>
                  <Text style={d.label}>THE PIECE</Text>
                  <View style={{ flexDirection: 'row', gap: Space.base, alignItems: 'flex-start' }}>
                    {!!item.garment.imageBase64 && view === 'tryon' && tryOn && (
                      <Image source={{ uri: item.garment.imageBase64 }} style={d.garmentThumb} resizeMode="cover" />
                    )}
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={d.bodyStrong}>{sourceLine(item)}{item.garment.price ? ` · ${item.garment.price}` : ''}</Text>
                      <Text style={d.muted}>{new Date(item.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</Text>
                      {item.garment.sourceUrl && <TextLink label="Open product page" icon="link" onPress={() => Linking.openURL(item.garment.sourceUrl!)} />}
                    </View>
                  </View>
                </Card>

                {size && (
                  <Card style={{ gap: Space.sm }}>
                    <Text style={d.label}>YOUR SIZE</Text>
                    <Text style={d.size}>{size.size}</Text>
                    <Text style={d.body}>{size.explanation}</Text>
                  </Card>
                )}

                {v && (
                  <Card style={{ gap: Space.sm }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: Space.sm }}>
                      <Text style={d.label}>SHOULD I BUY IT?</Text>
                      <Tag label={callLabel(v.call)} tone={callTone(v.call)} dot />
                    </View>
                    <Text style={d.verdictLine}>{v.verdict}</Text>
                    {!!v.whyItWorks && v.whyItWorks !== '—' && <Text style={d.muted}>{v.whyItWorks}</Text>}
                  </Card>
                )}

                {error && <Notice tone="error" text={error} />}

                <PillButton label="Delete fitting" icon="trash" variant="ghost" size="sm" onPress={remove}
                  loading={busy === 'delete'} disabled={!!busy} style={{ alignSelf: 'flex-start' }} />
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  )
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function HistoryScreen() {
  const { width } = useWindowDimensions()
  const store = useGarmentStore()
  const { membership } = useMembershipStore()
  // Clean (un-watermarked) exports for premium or anyone who has bought credits.
  const plan = membership?.plan ?? null
  const clean = isPremium(membership) || (plan !== null && plan !== 'free')

  const [userId, setUserId] = useState<string | null>(null)
  const [cloudChecks, setCloudChecks] = useState<GarmentCheck[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [openId, setOpenId] = useState<string | null>(null)

  // Saved fittings live in Supabase so history survives reloads and devices.
  const loadCloud = useCallback(async () => {
    const uid = await getCurrentUserId()
    setUserId(uid)
    if (!uid) { setCloudChecks([]); return }
    const rows = await listTryOnsFromCloud(uid)
    const localIds = new Set(useGarmentStore.getState().checks.map((c) => c.id))
    setCloudChecks(rows
      .filter((r) => !localIds.has(r.productId))
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        garment: {
          imageBase64: r.garmentUrl ?? '',
          name: r.productName,
          brand: r.garmentBrand,
          source: r.retailerProductUrl ? 'url' : 'upload',
          sourceUrl: r.retailerProductUrl,
        },
        tryOnResult: r.imageUrl ? { image: r.imageUrl, demo: r.demo } : undefined,
        sizeResult: r.sizeResult ?? undefined,
        verdictResult: r.verdictResult ?? undefined,
      })))
  }, [])

  useFocusEffect(useCallback(() => {
    loadCloud()
    useMembershipStore.getState().refresh()
  }, [loadCloud]))

  const localIds = new Set(store.checks.map((c) => c.id))
  const merged = [...store.checks, ...cloudChecks.filter((c) => !localIds.has(c.id))]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const shown = merged.filter((c) =>
    filter === 'all' ? true : filter === 'links' ? c.garment.source === 'url' : c.garment.source !== 'url')
  const open = merged.find((c) => c.id === openId) ?? null

  async function removeItem(id: string) {
    if (localIds.has(id)) {
      store.removeCheck(id)
    } else {
      if (userId) await deleteTryOnFromCloud(userId, id)
      setCloudChecks((prev) => prev.filter((c) => c.id !== id))
    }
    setOpenId(null)
  }

  const counts = {
    all: merged.length,
    links: merged.filter((c) => c.garment.source === 'url').length,
    screenshots: merged.filter((c) => c.garment.source !== 'url').length,
  }

  const gutter = Layout.gutter(width)
  const columns = width >= 820 ? 2 : 1

  return (
    <View style={s.safe}>
      <FlatList
        key={columns}
        data={shown}
        numColumns={columns}
        keyExtractor={(c) => c.id}
        columnWrapperStyle={columns > 1 ? { gap: Space.base } : undefined}
        contentContainerStyle={[s.list, { paddingHorizontal: gutter, maxWidth: Layout.app + gutter * 2 }]}
        ListHeaderComponent={
          <View style={s.headerWrap}>
            <PageHeader title="History" subtitle="Every fitting, newest first." />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filters}>
              {([['all', 'All'], ['links', 'From links'], ['screenshots', 'From screenshots']] as const).map(([k, label]) => (
                <Chip key={k} label={label} count={counts[k]} selected={filter === k} onPress={() => setFilter(k)} />
              ))}
            </ScrollView>
          </View>
        }
        ListEmptyComponent={
          merged.length ? (
            <EmptyState icon="filter" title="Nothing here yet" body="No fittings match this filter."
              secondary={{ label: 'Show all fittings', onPress: () => setFilter('all') }} />
          ) : (
            <EmptyState icon="tryOn" title="No fittings yet"
              body={userId ? 'Add a piece on Home and try it on. Every fitting is kept here.' : 'Sign in to keep your fittings on every device.'}
              action={userId ? { label: 'Add a piece', icon: 'upload', onPress: () => router.navigate('/(tabs)') } : { label: 'Sign in', onPress: () => router.push('/auth') }} />
          )
        }
        renderItem={({ item }) => <View style={{ flex: 1 / columns }}><HistoryCard item={item} onOpen={() => setOpenId(item.id)} /></View>}
      />
      {open && <HistoryDetail item={open} clean={clean} onClose={() => setOpenId(null)} onDelete={() => removeItem(open.id)} />}
    </View>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  list: { paddingTop: Space.lg, gap: Space.base, paddingBottom: Space.xxl + Space.lg, width: '100%', alignSelf: 'center' },
  headerWrap: { gap: Space.lg, marginBottom: Space.sm },
  filters:    { gap: Space.sm },

  card: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.lg, flexDirection: 'row', overflow: 'hidden',
    borderWidth: 1, borderColor: Colors.borderSubtle,
  },
  cardHover:  { borderColor: Colors.border, ...Shadow.card },
  thumbs:     { flexDirection: 'row' },
  thumb:      { width: 104, height: 138, backgroundColor: Colors.bgSubtle },
  thumbInset: {
    position: 'absolute', right: 6, bottom: 6, width: 36, height: 48, borderRadius: 6,
    borderWidth: 2, borderColor: Colors.bgCard, backgroundColor: Colors.bgSubtle,
  },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },

  cardBody: { flex: 1, paddingVertical: Space.md, paddingHorizontal: Space.base, gap: 3, minWidth: 0, justifyContent: 'center' },
  source:   { fontFamily: FONT_DISPLAY, fontSize: 15, lineHeight: 19, letterSpacing: 1.5, color: Colors.text },
  name:     { ...Typography.bodySmall, ...Weight.medium, fontSize: 14 },
  date:     { ...Typography.caption },
  pills:    { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs, marginTop: Space.xs },
})

const d = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: Colors.scrim, alignItems: 'center', justifyContent: 'center', padding: Space.base },
  sheet:    { width: '100%', maxWidth: 960, maxHeight: '100%', flex: 1, backgroundColor: Colors.bg, borderRadius: Radius.xl, overflow: 'hidden', ...Shadow.pop },
  header:   { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.lg, paddingVertical: Space.md, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle, backgroundColor: Colors.bgCard },
  title:    { ...Typography.h3, flex: 1 },
  close:    { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgSubtle },
  scroll:   { padding: Space.lg, paddingBottom: Space.xxl },
  layout:   { flexDirection: 'row', flexWrap: 'wrap', gap: Space.lg },
  imageCol: { flexBasis: 300, flexGrow: 1, gap: Space.base },
  infoCol:  { flexBasis: 280, flexGrow: 1, gap: Space.base },

  image:  { width: '100%', aspectRatio: 3 / 4, borderRadius: Radius.lg, backgroundColor: Colors.bgSubtle },
  badge:  { position: 'absolute', top: Space.md, left: Space.md },
  btnRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  flexBtn: { flexGrow: 1, flexBasis: 130 },
  note:    { ...Typography.caption, textAlign: 'center' },

  label:   { ...Typography.label },
  body:    { ...Typography.bodySmall, lineHeight: 21 },
  bodyStrong: { ...Typography.body, ...Weight.semibold },
  muted:   { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 21 },
  garmentThumb: { width: 64, height: 86, borderRadius: Radius.sm, backgroundColor: Colors.bgSubtle },
  size:    { ...Typography.numeral, fontSize: 48, lineHeight: 52 },
  verdictLine: { ...Typography.h3, fontSize: 16, lineHeight: 24 },
})
