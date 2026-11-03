import { useCallback, useState } from 'react'
import {
  View, Text, TouchableOpacity, ScrollView, Image, StyleSheet, ActivityIndicator, Platform,
} from 'react-native'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useAccountStore } from '../../../lib/account'
import {
  getFolder, listFolderResults, saveFolderMeasurements, saveFolderPhoto, deleteFolder, availabilityLabel, expiringSoon,
  useStoreSession, reportShared, maskPhone,
} from '../../../lib/b2b'
import { pickImageDataUri } from '../../../lib/imageInput'
import { downloadImage, shareImage } from '../../../lib/shareImage'
import { Colors, Typography, Space, Radius } from '../../../lib/theme'
import { Icon, PillButton } from '../../../lib/ui'
import {
  MeasurementsFields, emptyMeasurementValues, parseMeasurements, type MeasurementValues,
} from '../../../components/store/MeasurementsFields'
import type { CustomerFolder, CustomerTryOn } from '../../../lib/types'

// Spec §2.8 folder detail: photo, editable measurements, every result with its
// garment and size recommendation, Share / Download (all).
export default function CustomerFolderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const account = useAccountStore((st) => st.account)

  const [folder, setFolder] = useState<CustomerFolder | null>(null)
  const [results, setResults] = useState<CustomerTryOn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [meas, setMeas] = useState<MeasurementValues>(emptyMeasurementValues())
  const [busy, setBusy] = useState<null | 'photo' | 'meas' | 'delete'>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    try {
      const [f, r] = await Promise.all([getFolder(id), listFolderResults(id)])
      setFolder(f)
      setResults(r)
      if (f) setMeas(emptyMeasurementValues(f.measurements))
    } catch (e: any) {
      setError(e?.message ?? 'Could not load this folder.')
    } finally {
      setLoading(false)
    }
  }, [id])

  useFocusEffect(useCallback(() => {
    setLoading(true); setEditing(false); setNotice(null); setConfirmDelete(false)
    load()
  }, [load]))

  if (account?.type !== 'b2b_company') return null

  if (loading) return <View style={s.center}><ActivityIndicator color={Colors.primary} /></View>
  if (error || !folder) {
    return (
      <View style={s.center}>
        <Text style={s.emptyTitle}>{error ? "Couldn't load this folder" : 'Folder not found'}</Text>
        <Text style={s.muted}>{error ?? 'It may no longer be available — folders are kept for 15 days.'}</Text>
        <PillButton variant="secondary" label="Back to customers" onPress={() => router.navigate('/store/customers')} style={{ marginTop: Space.md }} />
      </View>
    )
  }

  async function changePhoto(source: 'camera' | 'library') {
    if (!folder || account?.type !== 'b2b_company') return
    setNotice(null)
    try {
      const uri = await pickImageDataUri(source, { quality: 0.8 })
      if (!uri) return
      setBusy('photo')
      await saveFolderPhoto(account.client.id, folder.id, uri)
      await load()
    } catch (e: any) {
      setNotice(`Couldn't save the photo — ${e?.message ?? 'please try again'}.`)
    } finally {
      setBusy(null)
    }
  }

  async function saveMeasurements() {
    if (!folder) return
    const parsed = parseMeasurements(meas)
    if (parsed.error !== undefined) { setNotice(parsed.error); return }
    if (!parsed.measurements) { setNotice('Enter all measurements to save them.'); return }
    setBusy('meas')
    setNotice(null)
    try {
      await saveFolderMeasurements(folder.id, parsed.measurements)
      setEditing(false)
      // Came from Home's Size Assist with a garment waiting → straight back to it.
      const session = useStoreSession.getState()
      if (session.garment && session.customerId === folder.id) { router.navigate('/store'); return }
      await load()
    } catch (e: any) {
      setNotice(`Couldn't save measurements — ${e?.message ?? 'please try again'}.`)
    } finally {
      setBusy(null)
    }
  }

  async function removeCustomer() {
    if (!folder || account?.type !== 'b2b_company') return
    setBusy('delete')
    setNotice(null)
    try {
      await deleteFolder(account.client.id, folder.id)
      // Don't leave Home pointing at a customer who no longer exists.
      const session = useStoreSession.getState()
      if (session.customerId === folder.id) session.setCustomerId(null)
      router.navigate('/store/customers')
    } catch (e: any) {
      setNotice(`Couldn't delete this customer — ${e?.message ?? 'please try again'}.`)
      setConfirmDelete(false)
    } finally {
      setBusy(null)
    }
  }

  const fileFor = (r: CustomerTryOn) =>
    `atelier-${folder.customerName.replace(/\s+/g, '-').toLowerCase()}-${r.id.slice(0, 6)}.jpg`
  const images = results.filter((r) => r.resultUrl)

  async function downloadAll() {
    try {
      for (const r of images) await downloadImage(r.resultUrl!, fileFor(r))
      reportShared(folder!.id, 'download_all')
    } catch (e: any) {
      setNotice(e?.message ?? 'Could not download.')
    }
  }

  const m = folder.measurements
  const soon = expiringSoon(folder.expiresAt)
  // No measurements yet → the fields are simply open; "Edit" only for saved ones.
  const showFields = editing || !m

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <TouchableOpacity style={s.back} onPress={() => router.navigate('/store/customers')}>
        <Icon name="back" size={18} color={Colors.textMuted} />
        <Text style={s.backText}>Customers</Text>
      </TouchableOpacity>

      <View style={s.top}>
        <View style={s.photoCol}>
          {folder.photoUrl
            ? <Image source={{ uri: folder.photoUrl }} style={s.photo} resizeMode="cover" />
            : <View style={[s.photo, s.photoEmpty]}><Icon name="profile" size={40} color={Colors.textFaint} /><Text style={s.muted}>No photo yet</Text></View>}
          <View style={s.row}>
            <PillButton variant="secondary" label={folder.photoUrl ? 'Retake' : 'Take photo'} icon="takePhoto"
              onPress={() => changePhoto('camera')} loading={busy === 'photo'} style={{ flex: 1 }} />
            <PillButton variant="outline" label="Gallery" icon="gallery"
              onPress={() => changePhoto('library')} disabled={busy === 'photo'} style={{ flex: 1 }} />
          </View>
        </View>

        <View style={s.infoCol}>
          <Text style={s.title}>{folder.customerName}</Text>
          {folder.phone && <Text style={s.muted}>{maskPhone(folder.phone)}</Text>}
          <Text style={s.muted}>
            Created {new Date(folder.createdAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}
          </Text>
          <View style={[s.expiry, soon && s.expirySoon]}>
            <Text style={[s.expiryText, soon && { color: Colors.warning }]}>
              {availabilityLabel(folder.expiresAt)}
            </Text>
          </View>

          <View style={s.section}>
            <View style={s.sectionHead}>
              <Text style={s.label}>MEASUREMENTS</Text>
              {!showFields && (
                <TouchableOpacity onPress={() => setEditing(true)}>
                  <Text style={s.link}>Edit</Text>
                </TouchableOpacity>
              )}
            </View>
            {showFields ? (
              <View style={{ gap: Space.md }}>
                {!m && <Text style={s.muted}>Needed for Size Assist.</Text>}
                <MeasurementsFields value={meas} onChange={setMeas} />
                <View style={s.row}>
                  {m && (
                    <PillButton variant="outline" label="Cancel" onPress={() => { setEditing(false); setMeas(emptyMeasurementValues(m)) }} style={{ flex: 1 }} />
                  )}
                  <PillButton variant="secondary" label="Save measurements" onPress={saveMeasurements} loading={busy === 'meas'} style={{ flex: 1 }} />
                </View>
              </View>
            ) : m && (
              <Text style={s.body}>
                {m.heightCm} cm · {m.weightKg} kg · chest {m.chestIn}" · waist {m.waistIn}" · hip {m.hipIn}" · {m.fitPreference} fit
              </Text>
            )}
          </View>
        </View>
      </View>

      {notice && <View style={s.errorBox}><Text style={s.errorText}>{notice}</Text></View>}

      <View style={s.sectionHead}>
        <Text style={s.label}>RESULTS ({results.length})</Text>
        {Platform.OS === 'web' && images.length > 1 && (
          <TouchableOpacity onPress={downloadAll}><Text style={s.link}>Download all</Text></TouchableOpacity>
        )}
      </View>

      {results.length === 0 ? (
        <Text style={s.muted}>No try-ons yet — upload a garment on Home and tap Try on.</Text>
      ) : (
        <View style={s.grid}>
          {results.map((r) => (
            <View key={r.id} style={s.result}>
              <Image source={{ uri: r.resultUrl ?? r.garmentUrl ?? '' }} style={s.resultImg} resizeMode="cover" />
              <View style={{ padding: Space.md, gap: Space.xs }}>
                <Text style={s.body} numberOfLines={1}>{r.garmentName || (r.resultUrl ? 'Try-on' : 'Size check')}</Text>
                {r.sizeResult && <Text style={s.size}>Size {r.sizeResult.size}</Text>}
                <Text style={s.muted}>{new Date(r.createdAt).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</Text>
                {r.resultUrl && (
                  <View style={s.row}>
                    <TouchableOpacity style={s.smallBtn}
                      onPress={() => shareImage(r.resultUrl!, fileFor(r), `${folder.customerName} — Atelier try-on`).then(() => reportShared(folder.id, 'share')).catch((e) => setNotice(e?.message ?? 'Could not share.'))}>
                      <Icon name="share" size={16} color={Colors.text} /><Text style={s.smallBtnText}>Share</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.smallBtn}
                      onPress={() => downloadImage(r.resultUrl!, fileFor(r)).then(() => reportShared(folder.id, 'download')).catch((e) => setNotice(e?.message ?? 'Could not download.'))}>
                      <Icon name="download" size={16} color={Colors.text} /><Text style={s.smallBtnText}>Download</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>
          ))}
        </View>
      )}

      <View style={s.danger}>
        {confirmDelete ? (
          <>
            <Text style={s.body}>Delete {folder.customerName}?</Text>
            <Text style={s.muted}>
              Their photo, measurements and all {results.length} result{results.length === 1 ? '' : 's'} will be removed permanently. This can't be undone.
            </Text>
            <View style={s.row}>
              <PillButton variant="outline" label="Cancel" onPress={() => setConfirmDelete(false)} disabled={busy === 'delete'} style={{ flex: 1 }} />
              <TouchableOpacity style={[s.deleteBtn, busy === 'delete' && { opacity: 0.6 }]} onPress={removeCustomer} disabled={busy === 'delete'}>
                {busy === 'delete'
                  ? <ActivityIndicator color={Colors.textOnDark} />
                  : <Text style={s.deleteBtnText}>Delete customer</Text>}
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <TouchableOpacity style={s.deleteLink} onPress={() => setConfirmDelete(true)}>
            <Icon name="trash" size={18} color={Colors.error} />
            <Text style={s.deleteLinkText}>Delete customer</Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  )
}

const s = StyleSheet.create({
  scroll: { padding: Space.lg, paddingBottom: Space.xxl, gap: Space.lg, maxWidth: 960, width: '100%', alignSelf: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.lg, gap: Space.sm, backgroundColor: Colors.bg },
  back: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  backText: { ...Typography.bodySmall, color: Colors.textMuted },
  top: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.lg },
  photoCol: { flexBasis: 260, flexGrow: 1, maxWidth: 360, gap: Space.md },
  photo: { width: '100%', aspectRatio: 3 / 4, borderRadius: Radius.xl, backgroundColor: Colors.bgSubtle },
  photoEmpty: { alignItems: 'center', justifyContent: 'center', gap: Space.sm },
  infoCol: { flexBasis: 300, flexGrow: 2, gap: Space.sm },
  title: { ...Typography.h1 },
  body: { ...Typography.body },
  muted: { ...Typography.bodySmall, color: Colors.textMuted },
  expiry: { alignSelf: 'flex-start', backgroundColor: Colors.bgSubtle, borderRadius: Radius.full, paddingHorizontal: Space.md, paddingVertical: 6 },
  expirySoon: { backgroundColor: Colors.warningBg },
  expiryText: { ...Typography.caption, color: Colors.textMuted, fontWeight: '600' },
  section: { marginTop: Space.md, gap: Space.sm },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { ...Typography.label },
  link: { ...Typography.bodySmall, fontWeight: '700', color: Colors.secondary },
  row: { flexDirection: 'row', gap: Space.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  result: {
    flexBasis: 220, flexGrow: 1, maxWidth: 300, backgroundColor: Colors.bgCard,
    borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
  },
  resultImg: { width: '100%', aspectRatio: 3 / 4, backgroundColor: Colors.bgSubtle },
  size: { ...Typography.bodySmall, fontWeight: '700', color: Colors.secondary },
  smallBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.full, paddingHorizontal: Space.md, paddingVertical: 6,
  },
  smallBtnText: { ...Typography.caption, color: Colors.text, fontWeight: '600' },
  emptyTitle: { ...Typography.h3 },
  errorBox: { backgroundColor: Colors.errorBg, borderRadius: Radius.sm, padding: Space.md },
  errorText: { ...Typography.bodySmall, color: Colors.error },
  danger: { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: Space.lg, gap: Space.sm },
  deleteLink: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, alignSelf: 'flex-start' },
  deleteLinkText: { ...Typography.body, fontWeight: '600', color: Colors.error },
  deleteBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44,
    backgroundColor: Colors.error, borderRadius: Radius.full, paddingHorizontal: Space.lg,
  },
  deleteBtnText: { ...Typography.body, fontWeight: '600', color: Colors.textOnDark },
})
