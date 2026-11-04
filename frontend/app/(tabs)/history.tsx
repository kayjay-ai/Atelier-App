import { useState, useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  View, Text, FlatList, Image, TouchableOpacity, StyleSheet, SafeAreaView,
  ScrollView, Platform, Linking, ActivityIndicator, Modal,
} from 'react-native'
import { useGarmentStore, useMembershipStore, useProfileStore } from '../../lib/store'
import { getCurrentUserId, listTryOnsFromCloud, deleteTryOnFromCloud } from '../../lib/supabaseStorage'
import { downloadImage as nativeSave, shareImage } from '../../lib/shareImage'
import { Colors, Typography, Space, Radius, Shadow } from '../../lib/theme'
import { Icon, PillButton } from '../../lib/ui'
import type { GarmentCheck } from '../../lib/types'

// History tab (spec §3.6): every fitting newest first with try-on + garment,
// brand / website (or "Screenshot"), date, size and buy verdict; filters; a
// detail view with an Original / Try-On toggle; Download, Share, Delete.

type Filter = 'all' | 'links' | 'screenshots'

function callColor(call?: string) {
  return call === 'Yes' ? Colors.success : call === 'Skip' ? Colors.error : Colors.warning
}
function callBg(call?: string) {
  return call === 'Yes' ? Colors.successBg : call === 'Skip' ? Colors.errorBg : Colors.warningBg
}
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
  return (
    <TouchableOpacity style={s.card} onPress={onOpen} activeOpacity={0.85}>
      <View style={s.thumbs}>
        {tryOn ? (
          <View style={s.thumbWrap}>
            <Image source={{ uri: tryOn }} style={s.thumb} resizeMode="cover" />
            <View style={s.thumbWm} pointerEvents="none"><Text style={s.thumbWmText}>ATELIER</Text></View>
          </View>
        ) : null}
        {garment ? (
          <Image source={{ uri: garment }} style={[s.thumb, tryOn ? s.thumbSmall : null]} resizeMode="cover" />
        ) : !tryOn ? (
          <View style={[s.thumb, s.thumbEmpty]}><Icon name="tryOn" size={22} color={Colors.textFaint} /></View>
        ) : null}
      </View>
      <View style={s.cardBody}>
        <Text style={s.source} numberOfLines={1}>{sourceLine(item).toUpperCase()}</Text>
        <Text style={s.name} numberOfLines={2}>{item.garment.name || 'Garment'}</Text>
        <Text style={s.date}>{new Date(item.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</Text>
        <View style={s.pills}>
          {tryOn && <View style={s.pillOutline}><Text style={s.pillOutlineText}>Tried on</Text></View>}
          {item.sizeResult && <View style={s.pillOutline}><Text style={s.pillOutlineText}>Size {item.sizeResult.size}</Text></View>}
          {item.verdictResult && (
            <View style={[s.pill, { backgroundColor: callColor(item.verdictResult.call) }]}>
              <Text style={s.pillText}>{callLabel(item.verdictResult.call)}</Text>
            </View>
          )}
        </View>
      </View>
      <Icon name="chevron" size={20} color={Colors.textFaint} style={{ alignSelf: 'center', marginRight: Space.sm }} />
    </TouchableOpacity>
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
  const [confirm, setConfirm] = useState(false)
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
    setBusy('delete')
    setError(null)
    try { await onDelete() }
    catch (e: any) { setError(`Couldn't delete — ${e?.message ?? 'try again'}.`); setBusy(null) }
  }

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} transparent>
      <View style={d.backdrop}>
        <SafeAreaView style={d.sheet}>
          <View style={d.header}>
            <Text style={d.title} numberOfLines={1}>{item.garment.name || 'Garment'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel="Close">
              <Icon name="close" size={24} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={d.scroll}>
            <View style={d.layout}>
              <View style={d.imageCol}>
                {tryOn && (
                  <View style={d.toggle}>
                    {(['tryon', 'original'] as const).map((k) => (
                      <TouchableOpacity key={k} style={[d.toggleBtn, view === k && d.toggleOn]} onPress={() => setView(k)}>
                        <Text style={[d.toggleText, view === k && d.toggleTextOn]}>{k === 'tryon' ? 'Try-On' : 'Original'}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
                <View>
                  <Image source={{ uri: shown }} style={d.image} resizeMode="contain" />
                  {view === 'tryon' && tryOn && <Text style={d.badge}>AI TRY-ON</Text>}
                </View>
                {tryOn && (
                  <View style={d.btnRow}>
                    <PillButton label="Download" icon="download" onPress={() => act('download')} loading={busy === 'download'} disabled={!!busy} style={d.flexBtn} />
                    <PillButton label="Share" icon="share" variant="outline" onPress={() => act('share')} loading={busy === 'share'} disabled={!!busy} style={d.flexBtn} />
                  </View>
                )}
                {tryOn && !clean && <Text style={d.note}>Free downloads carry a light Atelier watermark. Buy any plan for clean images.</Text>}
              </View>

              <View style={d.infoCol}>
                <View style={d.section}>
                  <Text style={d.label}>GARMENT</Text>
                  {!!item.garment.imageBase64 && view === 'tryon' && tryOn && (
                    <Image source={{ uri: item.garment.imageBase64 }} style={d.garmentThumb} resizeMode="cover" />
                  )}
                  <Text style={d.body}>{sourceLine(item)}{item.garment.price ? ` · ${item.garment.price}` : ''}</Text>
                  <Text style={d.muted}>{new Date(item.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</Text>
                  {item.garment.sourceUrl && (
                    <TouchableOpacity onPress={() => Linking.openURL(item.garment.sourceUrl!)}>
                      <Text style={d.link}>Open product page</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {size && (
                  <View style={d.section}>
                    <Text style={d.label}>SIZE</Text>
                    <Text style={d.size}>{size.size}</Text>
                    <Text style={d.body}>{size.explanation}</Text>
                  </View>
                )}

                {v && (
                  <View style={[d.section, d.verdict, { backgroundColor: callBg(v.call) }]}>
                    <Text style={[d.label, { color: callColor(v.call) }]}>SHOULD I BUY IT?</Text>
                    <Text style={d.verdictCall}>{callLabel(v.call)}</Text>
                    <Text style={d.body}>{v.verdict}</Text>
                    {!!v.whyItWorks && v.whyItWorks !== '—' && <Text style={d.muted}>{v.whyItWorks}</Text>}
                  </View>
                )}

                {error && <Text style={d.error}>{error}</Text>}

                {confirm ? (
                  <View style={d.dangerBox}>
                    <Text style={d.body}>Delete this fitting? This can't be undone.</Text>
                    <View style={d.btnRow}>
                      <PillButton label="Cancel" variant="outline" onPress={() => setConfirm(false)} disabled={busy === 'delete'} style={d.flexBtn} />
                      <TouchableOpacity style={[d.deleteBtn, d.flexBtn]} onPress={remove} disabled={busy === 'delete'}>
                        {busy === 'delete' ? <ActivityIndicator color={Colors.textOnDark} /> : <Text style={d.deleteText}>Delete</Text>}
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity style={d.deleteLink} onPress={() => setConfirm(true)}>
                    <Icon name="trash" size={18} color={Colors.error} />
                    <Text style={[d.body, { color: Colors.error }]}>Delete</Text>
                  </TouchableOpacity>
                )}
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
  const store = useGarmentStore()
  const { membership } = useMembershipStore()
  // Clean (un-watermarked) exports for premium or anyone who has bought credits.
  const plan = membership?.plan ?? null
  const clean = !!membership?.isPremium || (plan !== null && plan !== 'free')

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

  return (
    <SafeAreaView style={s.safe}>
      <FlatList
        data={shown}
        keyExtractor={(c) => c.id}
        contentContainerStyle={s.list}
        ListHeaderComponent={
          <View style={s.headerWrap}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filters}>
              {([['all', 'All'], ['links', 'From links'], ['screenshots', 'From screenshots']] as const).map(([k, label]) => (
                <TouchableOpacity key={k} style={[s.filterChip, filter === k && s.filterOn]} onPress={() => setFilter(k)}>
                  <Text style={[s.filterText, filter === k && s.filterTextOn]}>{label} · {counts[k]}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        }
        ListEmptyComponent={
          <View style={s.empty}>
            <Icon name="tryOn" size={48} color={Colors.border} />
            <Text style={s.emptyTitle}>{merged.length ? 'Nothing here yet' : 'No fittings yet'}</Text>
            <Text style={s.emptyHint}>
              {merged.length ? 'Try another filter.' : userId ? 'Add a garment on Home and try it on.' : 'Sign in to keep your fittings on every device.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => <HistoryCard item={item} onOpen={() => setOpenId(item.id)} />}
      />
      {open && <HistoryDetail item={open} clean={clean} onClose={() => setOpenId(null)} onDelete={() => removeItem(open.id)} />}
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  list: { padding: Space.base, gap: Space.md, paddingBottom: Space.xxl, width: '100%', maxWidth: 820, alignSelf: 'center' },
  headerWrap: { marginBottom: Space.xs },
  filters:    { gap: Space.sm },
  filterChip: { paddingHorizontal: Space.base, paddingVertical: 9, borderRadius: Radius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard },
  filterOn:   { backgroundColor: Colors.secondary, borderColor: Colors.secondary },
  filterText: { ...Typography.bodySmall, color: Colors.text },
  filterTextOn: { color: Colors.textOnDark, fontWeight: '600' },

  card: { backgroundColor: Colors.bgCard, borderRadius: Radius.lg, flexDirection: 'row', overflow: 'hidden', ...Shadow.card },
  thumbs:    { flexDirection: 'row' },
  thumbWrap: { position: 'relative' },
  thumb:     { width: 96, height: 128, backgroundColor: Colors.bgSubtle },
  thumbSmall: { width: 64 },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  thumbWm:   { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-30deg' }] },
  thumbWmText: { ...Typography.label, color: 'rgba(255,255,255,0.28)', letterSpacing: 3, fontSize: 7 },

  cardBody: { flex: 1, padding: Space.md, gap: 3, minWidth: 0 },
  source:   { ...Typography.label, letterSpacing: 1, color: Colors.textFaint },
  name:     { ...Typography.body, fontWeight: '500', fontSize: 14 },
  date:     { ...Typography.caption, color: Colors.textFaint },
  pills:    { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs, marginTop: Space.xs },
  pill:     { borderRadius: Radius.full, paddingHorizontal: Space.sm, paddingVertical: 3 },
  pillText: { ...Typography.caption, color: '#FFF', fontWeight: '700' },
  pillOutline:     { borderRadius: Radius.full, paddingHorizontal: Space.sm, paddingVertical: 3, borderWidth: 1, borderColor: Colors.border },
  pillOutlineText: { ...Typography.caption, color: Colors.textMuted },

  empty:      { alignItems: 'center', justifyContent: 'center', padding: 40, gap: Space.md },
  emptyTitle: { ...Typography.h3 },
  emptyHint:  { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center', lineHeight: 22 },
})

const d = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: Space.base },
  sheet:    { width: '100%', maxWidth: 960, maxHeight: '100%', flex: 1, backgroundColor: Colors.bg, borderRadius: Radius.xl, overflow: 'hidden' },
  header:   { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.lg, paddingVertical: Space.md, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle },
  title:    { ...Typography.h3, flex: 1 },
  scroll:   { padding: Space.lg, paddingBottom: Space.xxl },
  layout:   { flexDirection: 'row', flexWrap: 'wrap', gap: Space.lg },
  imageCol: { flexBasis: 300, flexGrow: 1, gap: Space.md },
  infoCol:  { flexBasis: 280, flexGrow: 1, gap: Space.md },

  toggle:     { flexDirection: 'row', alignSelf: 'center', backgroundColor: Colors.bgSubtle, borderRadius: Radius.full, padding: 4 },
  toggleBtn:  { paddingHorizontal: Space.lg, paddingVertical: 8, borderRadius: Radius.full },
  toggleOn:   { backgroundColor: Colors.secondary },
  toggleText: { ...Typography.bodySmall, color: Colors.text, fontWeight: '600' },
  toggleTextOn: { color: Colors.textOnDark },
  image:  { width: '100%', aspectRatio: 3 / 4, borderRadius: Radius.lg, backgroundColor: Colors.bgSubtle },
  badge:  {
    position: 'absolute', top: Space.md, left: Space.md, ...Typography.label, fontSize: 9, color: Colors.textOnDark,
    backgroundColor: 'rgba(66,61,58,0.85)', borderRadius: Radius.full, paddingHorizontal: Space.sm, paddingVertical: 4, overflow: 'hidden',
  },
  btnRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  flexBtn: { flexGrow: 1, flexBasis: 130 },
  note:    { ...Typography.caption, color: Colors.textFaint, textAlign: 'center' },

  section: { backgroundColor: Colors.bgCard, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, padding: Space.base, gap: Space.xs },
  label:   { ...Typography.label, color: Colors.textFaint },
  body:    { ...Typography.bodySmall, color: Colors.text, lineHeight: 20 },
  muted:   { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 20 },
  link:    { ...Typography.bodySmall, color: Colors.secondary, fontWeight: '700', marginTop: Space.xs },
  garmentThumb: { width: 72, height: 96, borderRadius: Radius.sm, backgroundColor: Colors.bgSubtle },
  size:    { ...Typography.h1, fontSize: 36, lineHeight: 42 },
  verdict: { borderWidth: 0 },
  verdictCall: { ...Typography.h3 },
  error:   { ...Typography.bodySmall, color: Colors.error },

  dangerBox:  { backgroundColor: Colors.errorBg, borderRadius: Radius.md, padding: Space.base, gap: Space.sm },
  deleteBtn:  { minHeight: 56, borderRadius: Radius.full, backgroundColor: Colors.error, alignItems: 'center', justifyContent: 'center' },
  deleteText: { ...Typography.body, color: Colors.textOnDark, fontWeight: '600' },
  deleteLink: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingVertical: Space.sm },
})
