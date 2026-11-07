import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Image, StyleSheet, ActivityIndicator,
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
import { Colors, Typography, Space, Radius, Shadow } from '../../lib/theme'
import { Icon, PillButton } from '../../lib/ui'
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
      <ScrollView contentContainerStyle={s.scroll}>

        {/* ── Primary actions ── */}
        <View style={s.actionRow}>
          <TouchableOpacity style={[s.bigAction, s.bigDark]} onPress={() => router.push('/store/new-customer')}>
            <Icon name="newCustomer" size={36} color={Colors.textOnDark} />
            <Text style={[s.bigTitle, { color: Colors.textOnDark }]}>New customer</Text>
            <Text style={[s.bigHint, { color: 'rgba(250,248,245,0.7)' }]}>Create a folder and take their photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.bigAction} onPress={() => uploadGarment()}>
            <Icon name="gallery" size={36} color={Colors.secondary} />
            <Text style={s.bigTitle}>Upload garment</Text>
            <Text style={s.bigHint}>Pick the piece from this iPad's gallery</Text>
          </TouchableOpacity>
        </View>
        {actionError && <View style={s.errorBox}><Text style={s.errorText}>{actionError}</Text></View>}

        {/* ── Recent customers ── */}
        <View style={s.section}>
          <View style={s.sectionHead}>
            <Text style={s.sectionLabel}>RECENT CUSTOMERS</Text>
            {folders.length > 0 && (
              <TouchableOpacity onPress={() => router.navigate('/store/customers')}>
                <Text style={s.seeAll}>See all</Text>
              </TouchableOpacity>
            )}
          </View>
          {foldersLoading ? (
            <ActivityIndicator color={Colors.primary} />
          ) : foldersError ? (
            <View style={s.inlineError}>
              <Text style={s.errorText}>Couldn't load customers.</Text>
              <TouchableOpacity onPress={loadFolders}><Text style={s.retry}>Retry</Text></TouchableOpacity>
            </View>
          ) : folders.length === 0 ? (
            <Text style={s.empty}>No customers yet — tap New customer to start.</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.strip}>
              {folders.slice(0, 12).map((f) => (
                <TouchableOpacity key={f.id} style={s.chip} onPress={() => router.push(`/store/customer/${f.id}`)}>
                  {f.photoUrl
                    ? <Image source={{ uri: f.photoUrl }} style={s.chipImg} />
                    : <View style={[s.chipImg, s.chipEmpty]}><Icon name="profile" size={24} color={Colors.textFaint} /></View>}
                  <Text style={s.chipName} numberOfLines={1}>{f.customerName}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        {/* ── Garment + actions ── */}
        {garment && (
          <View style={[s.card, Shadow.card]}>
            <View style={s.workRow}>
              <View style={s.workCol}>
                <Text style={s.colLabel}>GARMENT</Text>
                <Image source={{ uri: garment.dataUri }} style={s.workImg} resizeMode="contain" />
                <TextInput
                  style={s.nameInput}
                  value={garment.name ?? ''}
                  onChangeText={(t) => setGarment({ ...garment, name: t })}
                  placeholder="Product / brand (optional)"
                  placeholderTextColor={Colors.textFaint}
                />
              </View>
              {customer && (
                <View style={s.workCol}>
                  <Text style={s.colLabel}>{customer.customerName.toUpperCase()}</Text>
                  {customer.photoUrl
                    ? <Image source={{ uri: customer.photoUrl }} style={s.workImg} resizeMode="contain" />
                    : <View style={[s.workImg, s.chipEmpty]}><Text style={s.empty}>No photo yet</Text></View>}
                </View>
              )}
            </View>

            {phase === 'idle' && !customer && (
              <View style={{ gap: Space.md }}>
                <PillButton variant="secondary" label="Choose customer" icon="profile" onPress={() => setPickerOpen(true)} />
                <TouchableOpacity style={s.textBtn} onPress={removeGarment}>
                  <Text style={s.textBtnText}>Remove garment</Text>
                </TouchableOpacity>
              </View>
            )}

            {phase === 'idle' && customer && (
              <View style={{ gap: Space.md }}>
                {features.tryon && (
                  outOfCredits ? (
                    <TouchableOpacity style={s.creditsOut} onPress={() => router.navigate('/store/plan')}>
                      <Text style={s.creditsOutText}>Credits used up — upgrade plan or add credits →</Text>
                    </TouchableOpacity>
                  ) : (
                    <PillButton variant="secondary" label="Try on · 1 credit" icon="tryOn" onPress={generate} />
                  )
                )}
                {features.size && sizeState === 'idle' && (
                  <PillButton variant="outline" label="Size Assist" icon="size" onPress={() => runSize(customer, null)} />
                )}
                <View style={s.linkRow}>
                  <TouchableOpacity style={s.textBtn} onPress={() => setPickerOpen(true)}>
                    <Text style={s.textBtnText}>Change customer</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.textBtn} onPress={removeGarment}>
                    <Text style={s.textBtnText}>Remove garment</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {phase === 'generating' && customer && (
              <View style={s.generating}>
                <ActivityIndicator size="large" color={Colors.primary} />
                <Text style={s.narration}>Draping the garment to {firstName(customer.customerName)}'s proportions…</Text>
                <Text style={s.empty}>This takes 15–30 seconds.</Text>
              </View>
            )}

            {phase === 'failed' && failure && (
              <View style={{ gap: Space.md }}>
                <View style={s.errorBox}><Text style={s.errorText}>{failure.message}</Text></View>
                {failure.toPlan ? (
                  <PillButton variant="secondary" label="Go to Plan & Credits" onPress={() => router.navigate('/store/plan')} />
                ) : customer && !customer.photoPath ? (
                  <PillButton variant="secondary" label={`Open ${firstName(customer.customerName)}'s folder`} onPress={() => router.push(`/store/customer/${customer.id}`)} />
                ) : (
                  <PillButton variant="secondary" label="Try again" icon="refresh" onPress={generate} />
                )}
              </View>
            )}
          </View>
        )}

        {/* ── Result ── */}
        {phase === 'result' && resultImage && customer && garment && (
          <View style={[s.card, Shadow.card]}>
            <View style={s.resultHead}>
              <Text style={s.badge}>AI TRY-ON</Text>
              <Text style={s.resultFor}>for {customer.customerName}</Text>
            </View>
            <View style={s.toggle}>
              {(['Try-On', 'Original'] as const).map((label) => {
                const on = (label === 'Original') === showOriginal
                return (
                  <TouchableOpacity key={label} style={[s.toggleBtn, on && s.toggleOn]} onPress={() => setShowOriginal(label === 'Original')}>
                    <Text style={[s.toggleText, on && s.toggleTextOn]}>{label}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
            <Image
              source={{ uri: showOriginal ? (customer.photoUrl ?? resultImage) : resultImage }}
              style={s.resultImg}
              resizeMode="contain"
            />
            {resultId
              ? <Text style={s.saved}>✓ Saved to {customer.customerName}'s folder</Text>
              : saveError
                ? (
                  <View style={s.inlineError}>
                    <Text style={s.errorText}>{saveError}</Text>
                    <TouchableOpacity onPress={() => saveResult(resultImage)}><Text style={s.retry}>Retry</Text></TouchableOpacity>
                  </View>
                )
                : <Text style={s.empty}>Saving to folder…</Text>}

            <View style={s.btnRow}>
              <PillButton variant="secondary" label="Share" icon="share" style={{ flex: 1 }}
                onPress={() => shareImage(resultImage, resultName, `${customer.customerName} — Atelier try-on`).then(() => reportShared(customer.id, 'share')).catch((e) => setActionError(e?.message ?? 'Could not share.'))} />
              <PillButton variant="outline" label="Download" icon="download" style={{ flex: 1 }}
                onPress={() => downloadImage(resultImage, resultName).then(() => reportShared(customer.id, 'download')).catch((e) => setActionError(e?.message ?? 'Could not download.'))} />
            </View>
            <View style={s.btnRow}>
              <PillButton variant="outline" label="Try another garment" icon="gallery" style={{ flex: 1 }} onPress={tryAnotherGarment} />
              {features.size && sizeState === 'idle' && (
                <PillButton variant="outline" label="Size Assist" icon="size" style={{ flex: 1 }} onPress={() => runSize(customer, resultId)} />
              )}
            </View>
          </View>
        )}

        {/* ── Size Assist ── */}
        {sizeState !== 'idle' && customer && (
          <View style={[s.card, Shadow.card]}>
            <Text style={s.sectionLabel}>SIZE ASSIST · {customer.customerName.toUpperCase()}</Text>
            {sizeState === 'loading' && (
              <View style={s.generating}>
                <ActivityIndicator color={Colors.primary} />
                <Text style={s.narration}>Reading the size chart and fabric…</Text>
              </View>
            )}
            {sizeState === 'needsMeasurements' && (
              <View style={{ gap: Space.md }}>
                <Text style={s.confirmText}>{customer.customerName} has no measurements yet. Add them to their folder, then run Size Assist again.</Text>
                <PillButton variant="secondary" label="Add measurements" onPress={() => router.push(`/store/customer/${customer.id}`)} />
              </View>
            )}
            {sizeState === 'error' && (
              <View style={{ gap: Space.md }}>
                <View style={s.errorBox}><Text style={s.errorText}>{sizeError}</Text></View>
                <PillButton variant="secondary" label="Try again" icon="refresh" onPress={() => runSize(customer, resultId)} />
              </View>
            )}
            {sizeState === 'done' && sizeResult && (
              <View style={{ gap: Space.sm }}>
                <Text style={s.sizeBig}>{sizeResult.size}</Text>
                <Text style={s.confirmText}>{sizeResult.explanation}</Text>
                {sizeResult.caveat && <Text style={s.empty}>{sizeResult.caveat}</Text>}
                {sizeResult.confidence === 'low' && (
                  <Text style={s.warn}>Size and fabric not clearly visible on this image — use a garment photo with the size label for a reliable call.</Text>
                )}
              </View>
            )}
          </View>
        )}
      </ScrollView>

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
  scroll: { padding: Space.lg, paddingBottom: Space.xxl, gap: Space.lg, maxWidth: 960, width: '100%', alignSelf: 'center' },

  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  bigAction: {
    flexGrow: 1, flexBasis: 260, minHeight: 150, gap: Space.sm, justifyContent: 'center',
    backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg,
    borderWidth: 1.5, borderColor: Colors.border,
  },
  bigDark: { backgroundColor: Colors.secondary, borderColor: Colors.secondary },
  bigTitle: { ...Typography.h2 },
  bigHint: { ...Typography.bodySmall, color: Colors.textMuted },

  section: { gap: Space.sm },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionLabel: { ...Typography.label },
  seeAll: { ...Typography.bodySmall, fontWeight: '600', color: Colors.secondary },
  strip: { gap: Space.md },
  chip: { width: 96, gap: Space.xs },
  chipImg: { width: 96, height: 128, borderRadius: Radius.md, backgroundColor: Colors.bgSubtle },
  chipEmpty: { alignItems: 'center', justifyContent: 'center' },
  chipName: { ...Typography.caption, color: Colors.text, textAlign: 'center' },

  card: { backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, gap: Space.md },
  workRow: { flexDirection: 'row', gap: Space.md },
  workCol: { flex: 1, gap: Space.sm },
  colLabel: { ...Typography.label },
  workImg: { width: '100%', aspectRatio: 3 / 4, borderRadius: Radius.md, backgroundColor: Colors.bgSubtle },
  nameInput: {
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, paddingHorizontal: Space.md,
    paddingVertical: 10, ...Typography.bodySmall, color: Colors.text,
  },

  confirmText: { ...Typography.body },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  linkRow: { flexDirection: 'row', justifyContent: 'center', gap: Space.xl },
  textBtn: { alignItems: 'center', paddingVertical: Space.xs },
  textBtnText: { ...Typography.caption, color: Colors.textFaint },
  creditsOut: { backgroundColor: Colors.errorBg, borderRadius: Radius.full, paddingVertical: 16, alignItems: 'center' },
  creditsOutText: { ...Typography.body, fontWeight: '600', color: Colors.error },

  generating: { alignItems: 'center', gap: Space.sm, paddingVertical: Space.lg },
  narration: { ...Typography.h3, textAlign: 'center' },

  resultHead: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  badge: {
    ...Typography.label, color: Colors.textOnDark, backgroundColor: Colors.secondary,
    paddingHorizontal: Space.sm, paddingVertical: 4, borderRadius: Radius.sm, overflow: 'hidden',
  },
  resultFor: { ...Typography.h3 },
  toggle: { flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: Colors.bgSubtle, borderRadius: Radius.full, padding: 3 },
  toggleBtn: { paddingHorizontal: Space.base, paddingVertical: 6, borderRadius: Radius.full },
  toggleOn: { backgroundColor: Colors.secondary },
  toggleText: { ...Typography.bodySmall, fontWeight: '600' },
  toggleTextOn: { color: Colors.textOnDark },
  resultImg: { width: '100%', aspectRatio: 3 / 4, borderRadius: Radius.md, backgroundColor: Colors.bgSubtle },
  saved: { ...Typography.bodySmall, color: Colors.success },

  sizeBig: { ...Typography.display, fontSize: 48, lineHeight: 56, color: Colors.secondary },
  warn: { ...Typography.bodySmall, color: Colors.warning },

  empty: { ...Typography.bodySmall, color: Colors.textMuted },
  errorBox: { backgroundColor: Colors.errorBg, borderRadius: Radius.sm, padding: Space.md },
  errorText: { ...Typography.bodySmall, color: Colors.error },
  inlineError: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  retry: { ...Typography.bodySmall, fontWeight: '700', color: Colors.secondary },
})
