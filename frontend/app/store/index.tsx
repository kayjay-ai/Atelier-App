import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View, Text, TouchableOpacity, ScrollView, Image, StyleSheet, ActivityIndicator,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { useAccountStore, usableCredits } from '../../lib/account'
import {
  listFolders, storedImageDataUri, saveFolderResult, saveSizeOnResult, useStoreSession,
  reportShared, reportGarmentSelected,
} from '../../lib/b2b'
import { fetchTryOn, fetchSizeAssist } from '../../lib/api'
import { pickImageDataUri } from '../../lib/imageInput'
import { isFallback, isRetryable } from '../../lib/aiOutcome'
import { runTryOnAttempt } from '../../lib/tryOnAttempt'
import { downloadImage, shareImage } from '../../lib/shareImage'
import { Colors, Typography, Space, Radius, Weight } from '../../lib/theme'
import {
  Card, Field, Icon, Initials, Notice, Page, PillButton, SectionHeader, Segmented, Skeleton, Tag, TextLink, displayProps,
} from '../../lib/ui'
import { CustomerPicker } from '../../components/store/CustomerPicker'
import type { CustomerFolder, SizeResult } from '../../lib/types'

// ─── B2B Home (spec §2.3–2.7) ─────────────────────────────────────────────────
// New customer · Upload garment · recent customers → Choose customer → garment
// and customer side by side → Try on (1 company credit) or Size Assist → result
// saved into the customer's folder → Share / Download / Try another garment.

type Phase = 'idle' | 'generating' | 'result' | 'failed'
type SizeState = 'idle' | 'loading' | 'done' | 'needsMeasurements' | 'error'

const firstName = (name: string) => name.split(' ')[0]

export default function StoreHomeScreen() {
  const account = useAccountStore((st) => st.account)
  const refreshAccount = useAccountStore((st) => st.refresh)
  const setCreditsBalance = useAccountStore((st) => st.setCreditsBalance)
  const { garment, setGarment, customerId, setCustomerId } = useStoreSession()

  const [folders, setFolders] = useState<CustomerFolder[]>([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [foldersError, setFoldersError] = useState<string | null>(null)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [customer, setCustomer] = useState<CustomerFolder | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [failure, setFailure] = useState<{ message: string; toPlan?: boolean } | null>(null)
  const [resultImage, setResultImage] = useState<string | null>(null)
  const [resultId, setResultId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [sizeState, setSizeState] = useState<SizeState>('idle')
  const [sizeResult, setSizeResult] = useState<SizeResult | null>(null)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const loadFolders = useCallback(async () => {
    setFoldersError(null)
    try {
      setFolders(await listFolders())
    } catch (e: any) {
      setFoldersError(e?.message ?? 'Could not load customers.')
    } finally {
      setFoldersLoading(false)
    }
  }, [])

  // A finished try-on / size check belongs to that moment: once staff leave Home
  // it is cleared (it's already saved in the customer's folder), so Home starts
  // fresh. A garment that hasn't been tried on yet is kept (e.g. to add a new
  // customer first). A result that lands while away is cleared on return.
  // "Add measurements" / "no photo yet" send staff to the folder to fix it — that
  // detour keeps the garment and customer, and just resets the prompt on return.
  const detour = sizeState === 'needsMeasurements' || (phase === 'failed' && !!customer && !customer.photoPath)
  const finished = !detour && (phase === 'result' || phase === 'failed' || sizeState !== 'idle')
  const finishedRef = useRef(finished)
  finishedRef.current = finished
  const detourRef = useRef(detour)
  detourRef.current = detour
  const clearFinished = useCallback(() => {
    if (!finishedRef.current) return
    setPhase('idle'); setFailure(null); setResultImage(null); setResultId(null); setSaveError(null)
    setShowOriginal(false); setSizeState('idle'); setSizeResult(null); setSizeError(null)
    setCustomer(null); setCustomerId(null); setGarment(null)
  }, [setCustomerId, setGarment])

  // Feature toggles / credits changed by the admin reach the iPad on next focus.
  useFocusEffect(useCallback(() => {
    if (detourRef.current) { setPhase('idle'); setFailure(null); setSizeState('idle') }
    clearFinished()
    loadFolders()
    refreshAccount()
    return clearFinished
  }, [clearFinished, loadFolders, refreshAccount]))

  // Keep the selected customer's folder data (e.g. a newly added photo) fresh.
  // Back from "New customer" with a garment waiting → that customer is chosen.
  useEffect(() => {
    if (!customer) {
      const created = garment && customerId ? folders.find((f) => f.id === customerId) : null
      if (created) setCustomer(created)
      return
    }
    const fresh = folders.find((f) => f.id === customer.id)
    if (fresh && fresh !== customer) setCustomer(fresh)
  }, [folders]) // eslint-disable-line react-hooks/exhaustive-deps

  if (account?.type !== 'b2b_company') return null
  const { client, features } = account
  const outOfCredits = usableCredits(client) <= 0

  function resetResult() {
    setPhase('idle'); setFailure(null); setResultImage(null); setResultId(null); setSaveError(null)
    setShowOriginal(false); setSizeState('idle'); setSizeResult(null); setSizeError(null)
  }

  // A fresh upload always starts with "Choose customer"; only "Try another
  // garment" keeps the customer it was just tried on.
  async function uploadGarment(keepCustomer = false) {
    setActionError(null)
    try {
      const uri = await pickImageDataUri('library', { quality: 0.85, allowsEditing: true })
      if (!uri) return
      resetResult()
      if (!keepCustomer) { setCustomer(null); setCustomerId(null) }
      setGarment({ dataUri: uri })
    } catch (e: any) {
      setActionError(e?.message ?? 'Could not open the gallery.')
    }
  }

  function onPick(folder: CustomerFolder) {
    setPickerOpen(false)
    resetResult()
    setCustomer(folder)
    setCustomerId(folder.id)
  }

  function removeGarment() {
    resetResult()
    setGarment(null)
    setCustomer(null)
    setCustomerId(null)
  }

  async function generate() {
    if (!garment || !customer) return
    if (!customer.photoPath) {
      setFailure({ message: `${customer.customerName} has no photo yet — add one from their folder first.` })
      setPhase('failed')
      return
    }
    setPhase('generating')
    setFailure(null)
    let userPhoto: string
    try {
      userPhoto = await storedImageDataUri(customer.photoPath)
    } catch (e: any) {
      setFailure({ message: e?.message ?? 'Could not open the customer photo.' })
      setPhase('failed')
      return
    }
    reportGarmentSelected(garment.name)
    const g = garment
    const { outcome } = await runTryOnAttempt({
      call: () => fetchTryOn(g.dataUri, g.name || 'garment', userPhoto, { inputSource: 'gallery' }),
      applyBalance: (r) => { if (r.client) setCreditsBalance(r.client.creditsBalance) },
      save: (image) => saveResult(image), // into the customer's folder; reports its own errors
    })
    if (outcome.kind !== 'image') {
      // The server refunds the credit when generation fails.
      refreshAccount(true)
      setFailure(outcome.kind === 'paywall'
        ? { message: 'Credits used up — upgrade your plan or add credits.', toPlan: true }
        : { message: outcome.message })
      setPhase('failed')
      return
    }
    setResultImage(outcome.image)
    setPhase('result')
  }

  async function saveResult(image: string) {
    if (!garment || !customer) return
    setSaveError(null)
    try {
      const id = await saveFolderResult(client.id, customer.id, {
        garmentName: garment.name,
        garmentDataUri: garment.dataUri,
        resultDataUri: image,
        sizeResult: sizeResult ?? undefined,
      })
      setResultId(id)
      loadFolders()
    } catch (e: any) {
      console.error('[Atelier] saving try-on to folder failed:', e)
      setSaveError(`Couldn't save this result to ${customer.customerName}'s folder.`)
    }
  }

  async function runSize(folder: CustomerFolder, onResult: string | null) {
    if (!garment) return
    setSizeError(null)
    setSizeResult(null)
    if (!folder.measurements) { setSizeState('needsMeasurements'); return }
    setSizeState('loading')
    try {
      const r = await fetchSizeAssist({
        measurements: folder.measurements,
        garmentImageBase64: garment.dataUri,
        garmentName: garment.name,
      })
      // A stand-in answer is never saved into the customer's folder.
      if (isFallback(r)) {
        setSizeError(isRetryable(r) ? 'Size Assist is busy — try again in a moment.' : 'Size Assist isn’t available right now.')
        setSizeState('error')
        return
      }
      setSizeResult(r)
      setSizeState('done')
      if (onResult) await saveSizeOnResult(onResult, r)
      else await saveFolderResult(client.id, folder.id, { garmentName: garment.name, garmentDataUri: garment.dataUri, sizeResult: r })
      loadFolders()
    } catch (e: any) {
      setSizeError(e?.message ?? 'Size Assist is unavailable right now.')
      setSizeState('error')
    }
  }

  function tryAnotherGarment() {
    resetResult()
    setGarment(null)
    uploadGarment(true) // same customer stays selected
  }

  const resultName = customer ? `atelier-${customer.customerName.replace(/\s+/g, '-').toLowerCase()}.jpg` : 'atelier-tryon.jpg'

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <Page width="app">

        {/* ── Primary actions ── */}
        <View style={s.actionRow}>
          <TouchableOpacity style={[s.bigAction, s.bigDark]} onPress={() => router.push('/store/new-customer')} activeOpacity={0.88} accessibilityRole="button">
            <View style={[s.bigIcon, s.bigIconDark]}><Icon name="newCustomer" size={26} color={Colors.textOnDark} /></View>
            <View style={{ gap: Space.xs }}>
              <Text {...displayProps(28)} style={[s.bigTitle, { color: Colors.textOnDark }]}>New customer</Text>
              <Text style={[s.bigHint, { color: Colors.textOnDarkMuted }]}>Create their folder and take their photo</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity style={s.bigAction} onPress={() => uploadGarment()} activeOpacity={0.88} accessibilityRole="button">
            <View style={s.bigIcon}><Icon name="gallery" size={26} color={Colors.secondary} /></View>
            <View style={{ gap: Space.xs }}>
              <Text {...displayProps(28)} style={s.bigTitle}>Upload garment</Text>
              <Text style={s.bigHint}>Pick the piece from this iPad’s gallery</Text>
            </View>
          </TouchableOpacity>
        </View>
        {actionError && <Notice tone="error" text={actionError} onClose={() => setActionError(null)} />}

        {/* ── Garment + actions ── */}
        {garment && (
          <Card variant="raised" style={s.work}>
            <View style={s.workRow}>
              <View style={s.workCol}>
                <Text style={s.colLabel}>GARMENT</Text>
                <Image source={{ uri: garment.dataUri }} style={s.workImg} resizeMode="contain" accessibilityLabel="The garment" />
                <Field
                  value={garment.name ?? ''}
                  onChangeText={(t) => setGarment({ ...garment, name: t })}
                  placeholder="Product or brand (optional)"
                  containerStyle={{ marginTop: 0 }}
                  accessibilityLabel="Product or brand"
                />
              </View>
              <View style={s.workCol}>
                <Text style={s.colLabel}>{customer ? customer.customerName.toUpperCase() : 'CUSTOMER'}</Text>
                {customer ? (
                  customer.photoUrl
                    ? <Image source={{ uri: customer.photoUrl }} style={s.workImg} resizeMode="contain" accessibilityLabel={customer.customerName} />
                    : <View style={[s.workImg, s.workEmpty]}><Initials name={customer.customerName} size={44} /><Text style={s.muted}>No photo yet</Text></View>
                ) : (
                  <TouchableOpacity style={[s.workImg, s.workEmpty, s.choose]} onPress={() => setPickerOpen(true)} accessibilityRole="button" accessibilityLabel="Choose customer">
                    <Icon name="profile" size={32} color={Colors.primaryDark} />
                    <Text style={s.chooseText}>Choose customer</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {phase === 'idle' && !customer && (
              <View style={s.stack}>
                <PillButton label="Choose customer" icon="profile" onPress={() => setPickerOpen(true)} />
                <PillButton label="Remove garment" variant="ghost" size="sm" onPress={removeGarment} style={{ alignSelf: 'center' }} />
              </View>
            )}

            {phase === 'idle' && customer && (
              <View style={s.stack}>
                {features.tryon && (
                  outOfCredits ? (
                    <Notice tone="error" title="Credits used up" text="Upgrade your plan or add top-up credits to keep trying on."
                      actionLabel="Open Plan & Credits" onAction={() => router.navigate('/store/plan')} />
                  ) : (
                    <PillButton variant="primary" label="Try It On · 1 credit" icon="tryOn" onPress={generate} />
                  )
                )}
                {features.size && sizeState === 'idle' && (
                  <PillButton variant="outline" label="Size Assist" icon="size" onPress={() => runSize(customer, null)} />
                )}
                <View style={s.linkRow}>
                  <TextLink label="Change customer" tone="muted" onPress={() => setPickerOpen(true)} />
                  <TextLink label="Remove garment" tone="muted" onPress={removeGarment} />
                </View>
              </View>
            )}

            {phase === 'generating' && customer && (
              <View style={s.generating} accessibilityLiveRegion="polite">
                <ActivityIndicator color={Colors.primaryDark} />
                <Text style={s.narration}>Draping the garment to {firstName(customer.customerName)}’s proportions…</Text>
                <Text style={s.muted}>This takes 15–30 seconds.</Text>
              </View>
            )}

            {phase === 'failed' && failure && (
              <View style={s.stack}>
                <Notice tone="error" text={failure.message} />
                {failure.toPlan ? (
                  <PillButton label="Open Plan & Credits" onPress={() => router.navigate('/store/plan')} />
                ) : customer && !customer.photoPath ? (
                  <PillButton label={`Open ${firstName(customer.customerName)}’s folder`} onPress={() => router.push(`/store/customer/${customer.id}`)} />
                ) : (
                  <PillButton label="Try again" icon="refresh" onPress={generate} />
                )}
              </View>
            )}
          </Card>
        )}

        {/* ── Result ── */}
        {phase === 'generating' && (
          <Card variant="raised" style={s.resultCard}>
            <View style={s.resultHead}><Tag label="AI try-on" tone="dark" /></View>
            <View style={s.resultImg}>
              <Skeleton height="100%" radius={Radius.lg} style={StyleSheet.absoluteFill} />
            </View>
          </Card>
        )}
        {phase === 'result' && resultImage && customer && garment && (
          <Card variant="raised" style={s.resultCard}>
            <View style={s.resultHead}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Space.sm, flex: 1, minWidth: 200 }}>
                <Tag label="AI try-on" tone="dark" />
                <Text style={s.resultFor} numberOfLines={1}>for {customer.customerName}</Text>
              </View>
              <Segmented
                options={[{ value: 'tryon', label: 'Try-on' }, { value: 'original', label: 'Original' }] as const}
                value={showOriginal ? 'original' : 'tryon'} onChange={(v) => setShowOriginal(v === 'original')} size="sm"
                style={{ minWidth: 220 }}
              />
            </View>
            <Image
              source={{ uri: showOriginal ? (customer.photoUrl ?? resultImage) : resultImage }}
              style={s.resultImg}
              resizeMode="contain"
              accessibilityLabel={showOriginal ? `${customer.customerName}’s photo` : `${customer.customerName} wearing the garment`}
            />
            {resultId
              ? <View style={s.saved}><Icon name="success" size={16} color={Colors.success} /><Text style={s.savedText}>Saved to {customer.customerName}’s folder</Text></View>
              : saveError
                ? <Notice tone="error" text={saveError} actionLabel="Retry" onAction={() => saveResult(resultImage)} />
                : <Text style={[s.muted, { textAlign: 'center' }]}>Saving to the folder…</Text>}

            <View style={s.btnRow}>
              <PillButton label="Share" icon="share" size="md" style={s.flexBtn}
                onPress={() => shareImage(resultImage, resultName, `${customer.customerName} — Atelier try-on`).then(() => reportShared(customer.id, 'share')).catch((e) => setActionError(e?.message ?? 'Could not share.'))} />
              <PillButton variant="outline" label="Download" icon="download" size="md" style={s.flexBtn}
                onPress={() => downloadImage(resultImage, resultName).then(() => reportShared(customer.id, 'download')).catch((e) => setActionError(e?.message ?? 'Could not download.'))} />
            </View>
            <View style={s.btnRow}>
              <PillButton variant="outline" label="Try another garment" icon="gallery" size="md" style={s.flexBtn} onPress={tryAnotherGarment} />
              {features.size && sizeState === 'idle' && (
                <PillButton variant="outline" label="Size Assist" icon="size" size="md" style={s.flexBtn} onPress={() => runSize(customer, resultId)} />
              )}
            </View>
          </Card>
        )}

        {/* ── Size Assist ── */}
        {sizeState !== 'idle' && customer && (
          <Card style={s.stack}>
            <Text style={s.colLabel}>SIZE ASSIST · {customer.customerName.toUpperCase()}</Text>
            {sizeState === 'loading' && (
              <View style={s.generating}>
                <ActivityIndicator color={Colors.primaryDark} />
                <Text style={s.narration}>Reading the size chart and fabric…</Text>
              </View>
            )}
            {sizeState === 'needsMeasurements' && (
              <View style={s.stack}>
                <Text style={s.body}>{customer.customerName} has no measurements yet. Add them to their folder, then run Size Assist again.</Text>
                <PillButton label="Add measurements" icon="edit" onPress={() => router.push(`/store/customer/${customer.id}`)} />
              </View>
            )}
            {sizeState === 'error' && (
              <View style={s.stack}>
                <Notice tone="error" text={sizeError ?? 'Size Assist is unavailable right now.'} />
                <PillButton label="Try again" icon="refresh" onPress={() => runSize(customer, resultId)} />
              </View>
            )}
            {sizeState === 'done' && sizeResult && (
              <View style={s.sizeRow}>
                <Text style={s.sizeBig}>{sizeResult.size}</Text>
                <View style={{ flex: 1, gap: Space.sm, minWidth: 220 }}>
                  <Text style={s.body}>{sizeResult.explanation}</Text>
                  {!!sizeResult.caveat && <Text style={s.muted}>{sizeResult.caveat}</Text>}
                  {sizeResult.confidence === 'low' && (
                    <Notice tone="warning" text="Size and fabric aren’t clear on this image. A photo with the size label gives a reliable call." />
                  )}
                </View>
              </View>
            )}
          </Card>
        )}

        {/* ── Recent customers ── */}
        <View style={s.section}>
          <SectionHeader title="Recent customers" detail="Folders are kept for 15 days"
            action={folders.length > 0 ? { label: 'See all', onPress: () => router.navigate('/store/customers') } : undefined} />
          {foldersLoading ? (
            <View style={s.strip}>{[0, 1, 2, 3].map((i) => <View key={i} style={s.chip}><Skeleton width={104} height={138} radius={Radius.md} /><Skeleton width={80} height={10} /></View>)}</View>
          ) : foldersError ? (
            <Notice tone="error" text="Couldn’t load customers. Check the connection." actionLabel="Retry" onAction={loadFolders} />
          ) : folders.length === 0 ? (
            <Card variant="sunken"><Text style={s.muted}>No customers yet. Tap New customer when someone walks in.</Text></Card>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.strip}>
              {folders.slice(0, 12).map((f) => (
                <TouchableOpacity key={f.id} style={s.chip} onPress={() => router.push(`/store/customer/${f.id}`)} accessibilityRole="button" accessibilityLabel={`Open ${f.customerName}’s folder`}>
                  {f.photoUrl
                    ? <Image source={{ uri: f.photoUrl }} style={s.chipImg} />
                    : <View style={[s.chipImg, s.chipEmpty]}><Initials name={f.customerName} /></View>}
                  <Text style={s.chipName} numberOfLines={1}>{f.customerName}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        {/* ── How a try-on works: shown while nothing is in progress ── */}
        {!garment && phase === 'idle' && (
          <View style={s.steps}>
            {[
              ['New customer', 'Create their folder and photograph them, head to feet.'],
              ['Upload garment', 'Pick the piece from this iPad’s gallery.'],
              ['Try it on', 'Choose the customer. The result is saved to their folder.'],
            ].map(([title, body], i) => (
              <View key={title} style={s.step}>
                <Text style={s.stepNum}>{i + 1}</Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.stepTitle}>{title}</Text>
                  <Text style={s.muted}>{body}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </Page>

      <CustomerPicker
        visible={pickerOpen}
        folders={folders}
        loading={foldersLoading}
        onPick={onPick}
        onNewCustomer={() => { setPickerOpen(false); router.push('/store/new-customer') }}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  )
}

const s = StyleSheet.create({
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.base },
  bigAction: {
    flexGrow: 1, flexBasis: 280, minHeight: 168, gap: Space.lg, justifyContent: 'space-between',
    backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg,
    borderWidth: 1, borderColor: Colors.border,
  },
  bigDark: { backgroundColor: Colors.bgDark, borderColor: Colors.bgDark },
  bigIcon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgSubtle },
  bigIconDark: { backgroundColor: 'rgba(250,248,245,0.10)' },
  bigTitle: { ...Typography.h2, fontSize: 28, lineHeight: 34 },
  bigHint: { ...Typography.bodySmall, color: Colors.textMuted },

  section: { gap: Space.base },
  strip: { gap: Space.md, flexDirection: 'row' },
  chip: { width: 104, gap: Space.sm },
  chipImg: { width: 104, height: 138, borderRadius: Radius.md, backgroundColor: Colors.bgSubtle },
  chipEmpty: { alignItems: 'center', justifyContent: 'center' },
  chipName: { ...Typography.caption, ...Weight.medium, color: Colors.text, textAlign: 'center' },

  work: { padding: Space.lg, gap: Space.lg },
  workRow: { flexDirection: 'row', gap: Space.base },
  workCol: { flex: 1, minWidth: 0, gap: Space.sm },
  colLabel: { ...Typography.label },
  workImg: { width: '100%', aspectRatio: 3 / 4, borderRadius: Radius.lg, backgroundColor: Colors.bgSubtle },
  workEmpty: { alignItems: 'center', justifyContent: 'center', gap: Space.sm },
  choose: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: Colors.primary, backgroundColor: Colors.primarySubtle },
  chooseText: { ...Typography.bodySmall, ...Weight.semibold, color: Colors.secondary },

  stack: { gap: Space.md },
  body: { ...Typography.body },
  muted: { ...Typography.bodySmall, color: Colors.textMuted },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  flexBtn: { flexGrow: 1, flexBasis: 180 },
  linkRow: { flexDirection: 'row', justifyContent: 'center', gap: Space.xl },

  generating: { alignItems: 'center', gap: Space.sm, paddingVertical: Space.lg },
  narration: { ...Typography.h3, textAlign: 'center' },

  resultCard: { padding: Space.lg, gap: Space.base },
  resultHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: Space.md },
  resultFor: { ...Typography.h3, flexShrink: 1 },
  resultImg: { width: '100%', aspectRatio: 3 / 4, maxHeight: 760, borderRadius: Radius.lg, backgroundColor: Colors.bgSubtle, overflow: 'hidden' },
  saved: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.xs },
  savedText: { ...Typography.bodySmall, ...Weight.medium, color: Colors.success },

  sizeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Space.lg },
  sizeBig: { ...Typography.numeral, fontSize: 64, lineHeight: 70 },

  steps: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.base, borderTopWidth: 1, borderTopColor: Colors.borderSubtle, paddingTop: Space.lg },
  step: { flexBasis: 240, flexGrow: 1, flexDirection: 'row', gap: Space.md, alignItems: 'flex-start' },
  stepNum: {
    width: 30, height: 30, borderRadius: 15, textAlign: 'center', lineHeight: 30, overflow: 'hidden',
    backgroundColor: Colors.secondary, color: Colors.textOnDark, ...Weight.semibold, fontSize: 13,
  },
  stepTitle: { ...Typography.bodySmall, ...Weight.semibold },
})
