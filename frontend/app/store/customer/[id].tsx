import { useCallback, useState } from 'react'
import { View, Text, TouchableOpacity, Image, StyleSheet, Platform } from 'react-native'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useAccountStore } from '../../../lib/account'
import {
  getFolder, listFolderResults, saveFolderMeasurements, saveFolderPhoto, deleteFolder, availabilityLabel, expiringSoon,
  useStoreSession, useHiddenResults, reportShared, maskPhone,
} from '../../../lib/b2b'
import { pickImageDataUri } from '../../../lib/imageInput'
import { downloadImage, shareImage } from '../../../lib/shareImage'
import { Colors, Typography, Space, Radius, Weight } from '../../../lib/theme'
import {
  Card, EmptyState, Icon, Initials, Loading, Notice, Page, PillButton, SectionHeader, Tag, TextLink, Title,
  confirmDialog, toast, type IconName,
} from '../../../lib/ui'
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
  const [savedResults, setSavedResults] = useState<CustomerTryOn[]>([])
  const hiddenIds = useHiddenResults((st) => st.hidden[id])
  const hideResult = useHiddenResults((st) => st.hide)
  const results = savedResults.filter((r) => !hiddenIds?.includes(r.id))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [meas, setMeas] = useState<MeasurementValues>(emptyMeasurementValues())
  const [busy, setBusy] = useState<null | 'photo' | 'meas' | 'delete'>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmResultId, setConfirmResultId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    try {
      const [f, r] = await Promise.all([getFolder(id), listFolderResults(id)])
      setFolder(f)
      setSavedResults(r)
      if (f) setMeas(emptyMeasurementValues(f.measurements))
    } catch (e: any) {
      setError(e?.message ?? 'Could not load this folder.')
    } finally {
      setLoading(false)
    }
  }, [id])

  useFocusEffect(useCallback(() => {
    setLoading(true); setEditing(false); setNotice(null); setConfirmDelete(false); setConfirmResultId(null)
    load()
  }, [load]))

  if (account?.type !== 'b2b_company') return null

  if (loading) return <Loading label="Opening the folder…" />
  if (error || !folder) {
    return (
      <Page width="reading">
        <EmptyState
          icon={error ? 'alert' : 'clock'}
          title={error ? 'Couldn’t load this folder' : 'This folder is no longer here'}
          body={error ?? 'Folders are kept for 15 days, then removed with their photos.'}
          action={{ label: 'Back to customers', onPress: () => router.navigate('/store/customers') }}
        />
      </Page>
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

  async function askDeleteCustomer() {
    const ok = await confirmDialog({
      title: `Delete ${folder!.customerName}?`,
      body: `Their photo, measurements and all ${results.length} result${results.length === 1 ? '' : 's'} are removed permanently. This can’t be undone.`,
      confirmLabel: 'Delete customer', danger: true,
    })
    if (ok) removeCustomer()
  }

  async function askHideResult(r: CustomerTryOn) {
    const ok = await confirmDialog({
      title: `Delete this ${r.resultUrl ? 'try-on' : 'size check'}?`,
      body: 'It’s removed from this device. The saved copy stays in your store’s records.',
      confirmLabel: 'Delete', danger: true,
    })
    if (ok) { hideResult(folder!.id, r.id); toast('Deleted from this device.') }
  }

  return (
    <Page width="app">
      <TextLink label="Customers" icon="back" tone="muted" onPress={() => router.navigate('/store/customers')} style={{ alignSelf: 'flex-start' }} />

      <View style={s.top}>
        <View style={s.photoCol}>
          {folder.photoUrl
            ? <Image source={{ uri: folder.photoUrl }} style={s.photo} resizeMode="cover" accessibilityLabel={`Photo of ${folder.customerName}`} />
            : <View style={[s.photo, s.photoEmpty]}><Initials name={folder.customerName} size={56} /><Text style={s.muted}>No photo yet</Text></View>}
          <View style={s.row}>
            <PillButton label={folder.photoUrl ? 'Retake' : 'Take photo'} icon="takePhoto" size="md"
              onPress={() => changePhoto('camera')} loading={busy === 'photo'} style={s.flex} />
            <PillButton variant="outline" label="Gallery" icon="gallery" size="md"
              onPress={() => changePhoto('library')} disabled={busy === 'photo'} style={s.flex} />
          </View>
        </View>

        <View style={s.infoCol}>
          <View style={{ gap: Space.sm }}>
            <Title size="h1">{folder.customerName}</Title>
            <View style={s.metaRow}>
              <Tag label={availabilityLabel(folder.expiresAt)} tone={soon ? 'warning' : 'neutral'} dot={soon} />
              <Text style={s.muted}>
                Added {new Date(folder.createdAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}
                {folder.phone ? ` · ${maskPhone(folder.phone)}` : ''}
              </Text>
            </View>
          </View>

          <Card>
            <View style={s.sectionHead}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.cardTitle}>Measurements</Text>
                {!m && <Text style={s.muted}>Needed for Size Assist.</Text>}
              </View>
              {!showFields && <TextLink label="Edit" icon="edit" onPress={() => setEditing(true)} />}
            </View>
            {showFields ? (
              <View style={{ gap: Space.base }}>
                <MeasurementsFields value={meas} onChange={setMeas} />
                <View style={[s.row, { justifyContent: 'flex-end' }]}>
                  {m && (
                    <PillButton variant="ghost" label="Cancel" size="md" onPress={() => { setEditing(false); setMeas(emptyMeasurementValues(m)) }} />
                  )}
                  <PillButton label="Save measurements" size="md" onPress={saveMeasurements} loading={busy === 'meas'} />
                </View>
              </View>
            ) : m && (
              <View style={s.measGrid}>
                {([['Height', `${m.heightCm} cm`], ['Weight', `${m.weightKg} kg`], ['Chest', `${m.chestIn} in`], ['Waist', `${m.waistIn} in`], ['Hip', `${m.hipIn} in`], ['Fit', m.fitPreference.charAt(0).toUpperCase() + m.fitPreference.slice(1)]] as const).map(([k, v]) => (
                  <View key={k} style={s.measItem}>
                    <Text style={s.measValue}>{v}</Text>
                    <Text style={s.measLabel}>{k}</Text>
                  </View>
                ))}
              </View>
            )}
          </Card>
        </View>
      </View>

      {notice && <Notice tone="error" text={notice} onClose={() => setNotice(null)} />}

      <View style={{ gap: Space.base }}>
        <SectionHeader
          title={`Results (${results.length})`}
          action={Platform.OS === 'web' && images.length > 1 ? { label: 'Download all', onPress: downloadAll } : undefined}
        />
        {results.length === 0 ? (
          <Card variant="sunken"><Text style={s.muted}>No try-ons yet. Upload a garment on Home and tap Try It On.</Text></Card>
        ) : (
          <View style={s.grid}>
            {results.map((r) => (
              <View key={r.id} style={s.result}>
                <Image source={{ uri: r.resultUrl ?? r.garmentUrl ?? '' }} style={s.resultImg} resizeMode="cover" />
                {!r.resultUrl && <View style={s.resultBadge}><Tag label="Size check" tone="dark" /></View>}
                <View style={s.resultBody}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: Space.sm }}>
                    <Text style={[s.body, { flex: 1 }]} numberOfLines={1}>{r.garmentName || (r.resultUrl ? 'Try-on' : 'Size check')}</Text>
                    {r.sizeResult && <Tag label={`Size ${r.sizeResult.size}`} tone="info" />}
                  </View>
                  <Text style={s.caption}>{new Date(r.createdAt).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</Text>
                  <View style={s.resultActions}>
                    {r.resultUrl && (
                      <>
                        <IconButton icon="share" label="Share"
                          onPress={() => shareImage(r.resultUrl!, fileFor(r), `${folder.customerName} — Atelier try-on`).then(() => reportShared(folder.id, 'share')).catch((e) => setNotice(e?.message ?? 'Could not share.'))} />
                        <IconButton icon="download" label="Download"
                          onPress={() => downloadImage(r.resultUrl!, fileFor(r)).then(() => reportShared(folder.id, 'download')).catch((e) => setNotice(e?.message ?? 'Could not download.'))} />
                      </>
                    )}
                    <View style={{ flex: 1 }} />
                    <IconButton icon="trash" label="Delete" danger onPress={() => askHideResult(r)} />
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      <View style={s.danger}>
        <View style={{ flex: 1, minWidth: 220, gap: 2 }}>
          <Text style={s.cardTitle}>Delete this customer</Text>
          <Text style={s.muted}>Removes their photo, measurements and every result now, before the 15 days are up.</Text>
        </View>
        <PillButton label="Delete customer" icon="trash" variant="danger" size="md" onPress={askDeleteCustomer} loading={busy === 'delete'} />
      </View>
    </Page>
  )
}

/** A small round action on a result card. */
function IconButton({ icon, label, onPress, danger }: { icon: IconName; label: string; onPress: () => void; danger?: boolean }) {
  return (
    <TouchableOpacity onPress={onPress} style={[s.iconBtn, danger && s.iconBtnDanger]} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}>
      <Icon name={icon} size={17} color={danger ? Colors.error : Colors.secondary} />
    </TouchableOpacity>
  )
}

const s = StyleSheet.create({
  top: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xl },
  photoCol: { flexBasis: 280, flexGrow: 1, maxWidth: 380, gap: Space.md },
  photo: { width: '100%', aspectRatio: 3 / 4, borderRadius: Radius.xl, backgroundColor: Colors.bgSubtle },
  photoEmpty: { alignItems: 'center', justifyContent: 'center', gap: Space.sm },
  infoCol: { flexBasis: 320, flexGrow: 2, gap: Space.lg },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Space.sm },
  cardTitle: { ...Typography.h3 },
  body: { ...Typography.bodySmall, ...Weight.medium },
  muted: { ...Typography.bodySmall, color: Colors.textMuted },
  caption: { ...Typography.caption },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  flex: { flexGrow: 1, flexBasis: 140 },

  measGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  measItem: { flexBasis: 96, flexGrow: 1, backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, padding: Space.md, gap: 2 },
  measValue: { ...Typography.h3, fontSize: 16 },
  measLabel: { ...Typography.caption },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.base },
  result: {
    flexBasis: 210, flexGrow: 1, maxWidth: 320, backgroundColor: Colors.bgCard,
    borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.borderSubtle, overflow: 'hidden',
  },
  resultImg: { width: '100%', aspectRatio: 3 / 4, backgroundColor: Colors.bgSubtle },
  resultBadge: { position: 'absolute', top: Space.sm, left: Space.sm },
  resultBody: { padding: Space.md, gap: Space.xs },
  resultActions: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, marginTop: Space.xs },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgSubtle },
  iconBtnDanger: { backgroundColor: Colors.errorBg },

  danger: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Space.base,
    borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: Space.lg, marginTop: Space.sm,
  },
})
