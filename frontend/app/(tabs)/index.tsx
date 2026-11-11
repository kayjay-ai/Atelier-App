import { useState, useRef, useEffect, useCallback } from 'react'
import { View, Text, TouchableOpacity, Image, StyleSheet, Platform, useWindowDimensions } from 'react-native'
import { pickImageDataUri } from '../../lib/imageInput'
import { useRouter, useFocusEffect } from 'expo-router'
import { useProfileStore, useGarmentStore, useMembershipStore, useTryOnCacheStore, tryOnCacheKey, isPremium } from '../../lib/store'
import { imageToDataUri } from '../../lib/dataUri'
import { isFallback, isRetryable } from '../../lib/aiOutcome'
import { runTryOnAttempt } from '../../lib/tryOnAttempt'
import { PurchaseOptions } from '../../lib/purchaseOptions'
import { showAlert } from '../../lib/notify'
import {
  fetchGarmentFromUrl, fetchTryOn, fetchSizeAssist,
  fetchVerdict, checkGarmentSafety, postEvent,
} from '../../lib/api'
import { getCurrentUserId, saveTryOnToCloud, saveHistoryResults } from '../../lib/supabaseStorage'
import { Colors, Typography, Space, Radius, Shadow, Weight, FONT_DISPLAY } from '../../lib/theme'
import { Card, Field, Icon, Notice, Page, PillButton, Skeleton, Tag, Title, displayProps } from '../../lib/ui'
import type { CapturedGarment, TryOnResult, SizeResult, VerdictResult } from '../../lib/types'

type Action = 'tryon' | 'size' | 'verdict'
type ActionState = 'idle' | 'loading' | 'done' | 'error'

// In-memory session flag (no local persistence) — see cloud-only note in store.ts.
let onboardingSeenThisSession = false

// Debug mode: server stubs the paid try-on image. Client mirrors it to skip the
// credit gate and show a DEBUG label. Size & verdict still hit the real API.
const DEBUG_TRYON = process.env.EXPO_PUBLIC_DEBUG_TRYON === 'true'

const IMAGE_COPY = [
  'Reading the drape…',
  'Mapping the garment to your proportions…',
  'Setting the light…',
  'Compositing the look…',
  'Almost there…',
]
const TEXT_COPY = [
  'Looking closely…',
  'Weighing the cut against your lines…',
  'Considering the fabric…',
  'Forming a view…',
]

function useRotatingCopy(lines: string[], active: boolean, interval = 2200) {
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    if (!active) { setIdx(0); return }
    const t = setInterval(() => setIdx(i => (i + 1) % lines.length), interval)
    return () => clearInterval(t)
  }, [active, lines, interval])
  return lines[idx]
}


// ─── Onboarding modal ─────────────────────────────────────────────────────────
// How it works, in three pictures: you → a piece → your fitting.
const PANELS = [
  { src: '/hero.jpg',                        label: 'You',          hint: 'Your photo' },
  { src: '/catalog/cascade-silk-blouse.jpg', label: 'A piece',      hint: 'Something you love' },
  { src: '/catalog/oraline-midi-dress.jpg',  label: 'Your fitting', hint: 'Virtually on you' },
]

function OnboardingModal({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  if (!visible) return null
  return (
    <View style={[StyleSheet.absoluteFill, m.overlay]} accessibilityViewIsModal>
      <View style={m.card}>
        <Title size="h2" align="center">How It Works</Title>
        <Text style={m.sub}>See any piece on yourself before you buy it.</Text>

        <View style={m.panelRow}>
          {PANELS.flatMap((p, i) => {
            const imgSrc = Platform.OS === 'web' ? { uri: p.src } : null
            const panel = (
              <View key={`panel-${i}`} style={m.panel}>
                {imgSrc
                  ? <Image source={imgSrc} style={m.panelImg} resizeMode="cover" accessibilityIgnoresInvertColors />
                  : <View style={[m.panelImg, { backgroundColor: Colors.bgSubtle }]} />}
                <Text style={m.panelLabel}>{p.label}</Text>
                <Text style={m.panelHint}>{p.hint}</Text>
              </View>
            )
            return i < PANELS.length - 1
              ? [panel, <Icon key={`arrow-${i}`} name="chevron" size={18} color={Colors.primary} style={m.arrow} />]
              : [panel]
          })}
        </View>

        <PillButton label="Get started" onPress={onDismiss} size="md" style={{ alignSelf: 'stretch' }} />
      </View>
    </View>
  )
}

const m = StyleSheet.create({
  overlay: { backgroundColor: Colors.scrim, justifyContent: 'center', alignItems: 'center', padding: Space.base, zIndex: 100 },
  card: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, paddingTop: Space.xl,
    width: '100%', maxWidth: 460, alignItems: 'center', gap: Space.sm, ...Shadow.pop,
  },
  sub:        { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center' },
  panelRow:   { flexDirection: 'row', alignItems: 'flex-start', width: '100%', marginVertical: Space.base },
  panel:      { flex: 1, alignItems: 'center', gap: 2 },
  panelImg:   { width: '100%', aspectRatio: 3 / 4, borderRadius: Radius.md, overflow: 'hidden', backgroundColor: Colors.border, marginBottom: Space.xs },
  panelLabel: { ...Typography.bodySmall, ...Weight.semibold, textAlign: 'center' },
  panelHint:  { ...Typography.caption, textAlign: 'center' },
  arrow:      { alignSelf: 'center', marginHorizontal: 2, marginTop: -Space.xl },
})

export default function HomeScreen() {
  const profile       = useProfileStore()
  const garmentStore  = useGarmentStore()
  const membershipStore = useMembershipStore()
  const tryOnCache    = useTryOnCacheStore()
  const router        = useRouter()
  const { width }     = useWindowDimensions()

  // Onboarding: in-memory only (cloud-only — no local persistence). Shown once per
  // app load; dismissed for the rest of the session.
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(onboardingSeenThisSession)

  // Re-fetch membership every time Home gains focus (not just first mount) so an
  // admin premium upgrade / credit change reflects on return, without a reinstall.
  useFocusEffect(
    useCallback(() => {
      membershipStore.refresh()
    }, []), // eslint-disable-line react-hooks/exhaustive-deps
  )

  function dismissOnboarding() {
    onboardingSeenThisSession = true
    setHasSeenOnboarding(true)
  }

  const [garment, setGarment]       = useState<CapturedGarment | null>(null)
  const [urlInput, setUrlInput]     = useState('')
  const [urlLoading, setUrlLoading] = useState(false)
  const [urlError, setUrlError]     = useState<string | null>(null)
  const [safetyWarning, setSafetyWarning] = useState<string | null>(null)

  const [tryOnResult, setTryOnResult]   = useState<TryOnResult | null>(null)
  const [sizeResult, setSizeResult]     = useState<SizeResult | null>(null)
  const [verdictResult, setVerdictResult] = useState<VerdictResult | null>(null)
  const [paywall, setPaywall]           = useState(false)
  const [creditNote, setCreditNote]     = useState<string | null>(null)
  const [cloudError, setCloudError]     = useState<string | null>(null)
  const cloudRetry = useRef<null | (() => void)>(null)
  const [actionState, setActionState]   = useState<Record<Action, ActionState>>({
    tryon: 'idle', size: 'idle', verdict: 'idle',
  })
  const [retryIn, setRetryIn] = useState<Record<Action, number>>({ tryon: 0, size: 0, verdict: 0 })
  const [photoHint, setPhotoHint] = useState(false)
  const [measHint, setMeasHint] = useState(false)

  const currentCheckId = useRef<string | null>(null)

  useEffect(() => {
    if (!Object.values(retryIn).some(v => v > 0)) return
    const t = setInterval(() => {
      setRetryIn(prev => {
        const next = { ...prev }
        ;(Object.keys(next) as Action[]).forEach(k => { if (next[k] > 0) next[k]-- })
        return next
      })
    }, 1000)
    return () => clearInterval(t)
  }, [retryIn])

  function startRetryCountdown(action: Action, seconds = 60) {
    setRetryIn(prev => ({ ...prev, [action]: seconds }))
  }
  function setAction(a: Action, state: ActionState) {
    setActionState(prev => ({ ...prev, [a]: state }))
  }

  const tryOnCopy   = useRotatingCopy(IMAGE_COPY, actionState.tryon   === 'loading')
  const sizeCopy    = useRotatingCopy(TEXT_COPY,  actionState.size    === 'loading')
  const verdictCopy = useRotatingCopy(TEXT_COPY,  actionState.verdict === 'loading')

  async function pickImage(source: 'camera' | 'library' = 'library') {
    let uri: string | null = null
    try {
      uri = await pickImageDataUri(source, { quality: 0.85 })
    } catch (e: any) {
      showAlert('Photo', e?.message ?? 'Could not open the camera or gallery.')
      return
    }
    if (uri) captureGarment({ imageBase64: uri, source: 'upload' })
  }

  async function loadFromUrl() {
    const url = urlInput.trim()
    if (!url) return
    setUrlLoading(true)
    setUrlError(null)
    try {
      const result = await fetchGarmentFromUrl(url)
      if (result.error || !result.imageBase64) {
        setUrlError(result.error ?? "I couldn't reach that page — drop me a screenshot instead.")
        return
      }
      captureGarment({
        imageBase64: result.imageBase64,
        name: result.name,
        brand: result.brand,
        price: result.price,
        description: result.description,
        sourceUrl: url,
        source: 'url',
        sizeChartText: result.sizeChartText,
      })
    } catch {
      setUrlError("I couldn't reach that page — drop me a screenshot of the piece instead and I'll take it from there.")
    } finally {
      setUrlLoading(false)
    }
  }

  // Safety check: fire-and-forget, never blocks buttons.
  // Warning is dismissible and never leaves the UI in a blocked state.
  function captureGarment(g: CapturedGarment) {
    postEvent('garment_added', { metadata: { source: g.source === 'url' ? 'link' : 'screenshot', url: g.sourceUrl ?? null } })
    setGarment(g)
    setTryOnResult(null)
    setSizeResult(null)
    setVerdictResult(null)
    setPaywall(false)
    setCreditNote(null)
    setSafetyWarning(null)  // clear on new garment
    setActionState({ tryon: 'idle', size: 'idle', verdict: 'idle' })
    setRetryIn({ tryon: 0, size: 0, verdict: 0 })
    setPhotoHint(false)
    setMeasHint(false)
    const id = Date.now().toString()
    currentCheckId.current = id
    garmentStore.addCheck({ id, createdAt: new Date().toISOString(), garment: g })

    // Fire-and-forget — buttons are always accessible regardless of result
    checkGarmentSafety({ imageBase64: g.imageBase64, name: g.name, description: g.description })
      .then((safety) => {
        if (!safety.safe) {
          setSafetyWarning(
            safety.reason ?? "This piece may not be supported — results may vary.",
          )
        }
      })
      .catch(() => {})
  }

  async function readUserPhoto(): Promise<string | undefined> {
    return profile.photoUri ? imageToDataUri(profile.photoUri) : undefined
  }

  function gateCredits(): boolean {
    // Gate on the AUTHORITATIVE server balance (synced onto the membership), never
    // a client-only optimistic counter. The old code called credits.consume() on
    // every action, but the server charges a credit ONLY for a try-on — Size and
    // "Should I Buy It?" are free server-side. That drift pushed the local counter
    // to 0 and wrongly blocked the Verdict/Size buttons (worse since v17 lowered the
    // free allowance to 3). Now we block only when the real balance is genuinely 0.
    const m = membershipStore.membership
    // Premium (admin-granted, plan='premium') is unlimited — never gated on credits.
    if (isPremium(m)) { setCreditNote(null); return true }
    const outOfCredits = !!m && typeof m.creditsBalance === 'number' && m.creditsBalance <= 0
    if (outOfCredits) {
      // Out of credits → reveal the purchase options inline (no dead block).
      setCreditNote("You're out of credits. Buy more to keep generating:")
      return false
    }
    setCreditNote(null)
    return true
  }

  // Persist a size/verdict result to the ONE cloud history row for this garment.
  // Cloud-only: on failure we surface an error + Retry, never a silent local save.
  function persistResults(fields: { sizeResult?: SizeResult; verdictResult?: VerdictResult }, what: string) {
    const checkId = currentCheckId.current
    const g = garment
    if (!checkId || !g) return
    ;(async () => {
      const uid = await getCurrentUserId()
      if (!uid) return // guest (no account) — nothing to sync; kept in-session only
      await saveHistoryResults(uid, checkId, {
        ...fields,
        garmentSource: g.sourceUrl ?? 'upload',
        garmentName: g.name ?? 'Garment',
      })
    })()
      .then(() => setCloudError(null))
      .catch((e) => {
        console.error(`[Atelier] cloud save failed (${what}):`, e)
        cloudRetry.current = () => persistResults(fields, what)
        setCloudError(`Couldn't save your ${what} to the cloud.`)
      })
  }

  async function runTryOn() {
    if (!garment) return
    // Guard: never fire a second paid call while one is in flight (double-tap).
    if (actionState.tryon === 'loading') return
    if (!profile.photoUri) {
      setPhotoHint(true)
      return
    }

    const userB64 = await readUserPhoto()

    // ── Cache check BEFORE credits/API — repeat (same photo + garment) is free. ──
    // Skipped in debug so stub images never pollute the real-result cache.
    const cacheKey = (!DEBUG_TRYON && userB64) ? tryOnCacheKey(userB64, garment.imageBase64) : null
    if (cacheKey) {
      const hit = tryOnCache.lookup(cacheKey)
      const cachedImage = hit
        ? garmentStore.checks.find((c) => c.id === hit.checkId)?.tryOnResult?.image
        : undefined
      if (cachedImage) {
        const cachedResult: TryOnResult = { image: cachedImage, demo: false, cached: true }
        setSafetyWarning(null)
        setPaywall(false)
        setTryOnResult(cachedResult)
        setAction('tryon', 'done')
        if (currentCheckId.current) {
          garmentStore.updateCheck(currentCheckId.current, { tryOnResult: cachedResult })
          tryOnCache.save(cacheKey, currentCheckId.current) // point the key at the current check too
        }
        return // no API call, no credit spent
      }
    }

    if (!DEBUG_TRYON && !gateCredits()) return // debug stub costs no credit
    setSafetyWarning(null)  // dismiss warning when user acts
    setAction('tryon', 'loading')
    setTryOnResult(null)
    setPaywall(false)
    const checkId = currentCheckId.current
    const g = garment
    const { outcome, saved } = await runTryOnAttempt({
      call: () => fetchTryOn(g.imageBase64, g.name ?? 'garment', userB64, {
        inputSource: g.source === 'url' ? 'link' : 'screenshot',
        productUrl: g.sourceUrl,
        garmentBrand: g.brand,
      }),
      applyBalance: (r) => { if (r.membership) membershipStore.setMembership(r.membership) },
      // Saved to Supabase so it survives reloads, syncs across devices, and shows
      // in the admin dashboard. Guests (no account) keep it in-session only.
      save: async (image, r) => {
        const userId = await getCurrentUserId()
        if (!userId) return
        await saveTryOnToCloud(userId, {
          productId: checkId ?? Date.now().toString(),
          productName: g.name ?? 'Garment',
          imageDataUri: image,
          garmentDataUri: g.imageBase64,
          garmentBrand: g.brand,
          demo: r.demo,
          retailerProductUrl: g.sourceUrl,
          garmentSource: g.sourceUrl ?? 'upload',
          // Carry any real size/verdict already run for this garment into the one row.
          sizeResult: isFallback(sizeResult) ? undefined : sizeResult ?? undefined,
          verdictResult: isFallback(verdictResult) ? undefined : verdictResult ?? undefined,
        })
      },
    })

    if (outcome.kind === 'paywall') {
      postEvent('paywall_viewed', { metadata: { feature: 'tryon' } })
      setPaywall(true)
      setCreditNote(outcome.message)
      setAction('tryon', 'error')
      return
    }
    const shown: TryOnResult = outcome.kind === 'image' ? outcome.result : { ...outcome.result, fallback: true, message: outcome.message }
    setTryOnResult(shown)
    setAction('tryon', outcome.kind === 'image' ? 'done' : 'error')
    if (outcome.kind === 'failed' && outcome.retryable) startRetryCountdown('tryon')
    if (checkId) garmentStore.updateCheck(checkId, { tryOnResult: shown })
    if (outcome.kind === 'image') {
      // Cache real generations so re-running the same photo+garment is free.
      if (!shown.demo && cacheKey && checkId) tryOnCache.save(cacheKey, checkId)
      membershipStore.refresh()
    }
    saved
      ?.then(() => setCloudError(null))
      .catch((e) => {
        console.error('[Atelier] try-on cloud save failed:', e)
        cloudRetry.current = () => runTryOn()
        setCloudError("Couldn't save this fitting to the cloud.")
      })
  }

  async function runSize() {
    if (!garment) return
    if (!profile.measurements) {
      setMeasHint(true)
      return
    }
    if (!gateCredits()) return
    setSafetyWarning(null)
    setAction('size', 'loading')
    setSizeResult(null)
    try {
      const r = await fetchSizeAssist({
        measurements: profile.measurements,
        garmentImageBase64: garment.imageBase64,
        garmentName: garment.name,
        sizeChartText: garment.sizeChartText,
      })
      console.log('[Atelier] size result received:', { checkId: currentCheckId.current, size: r.size, confidence: r.confidence })
      setSizeResult(r)
      setAction('size', 'done')
      // A stand-in answer is shown but never saved as the garment's size.
      if (isFallback(r)) { if (isRetryable(r)) startRetryCountdown('size'); return }
      if (currentCheckId.current) garmentStore.updateCheck(currentCheckId.current, { sizeResult: r })
      persistResults({ sizeResult: r }, 'size prediction')
    } catch (e: any) {
      setSizeResult({ size: '?', confidence: 'low', explanation: e.message ?? 'Size assist failed.' })
      setAction('size', 'error')
    }
  }

  async function runVerdict() {
    if (!garment) return
    console.log('[Atelier] "Should I Buy It?" clicked — balance:', membershipStore.membership?.creditsBalance ?? '(guest/unlimited)')
    if (!gateCredits()) return
    setSafetyWarning(null)
    setAction('verdict', 'loading')
    setVerdictResult(null)
    try {
      const userB64 = await readUserPhoto()
      const r = await fetchVerdict({
        garmentImageBase64: garment.imageBase64,
        userPhotoBase64: userB64,
        measurements: profile.measurements ?? undefined,
        palette: profile.colorAnalysis
          ? { undertone: profile.colorAnalysis.undertone, season: profile.colorAnalysis.season, flatteringColors: profile.colorAnalysis.flatteringColors }
          : undefined,
        garmentName: garment.name,
        garmentBrand: garment.brand,
        garmentDescription: garment.description,
      })
      console.log('[Atelier] verdict result received:', { checkId: currentCheckId.current, call: r.call })
      setVerdictResult(r)
      setAction('verdict', 'done')
      // A stand-in answer is shown but never saved as the garment's verdict.
      if (isFallback(r)) { if (isRetryable(r)) startRetryCountdown('verdict'); return }
      if (currentCheckId.current) garmentStore.updateCheck(currentCheckId.current, { verdictResult: r })
      persistResults({ verdictResult: r }, 'buy verdict')
    } catch (e: any) {
      setVerdictResult({ call: 'Maybe', verdict: e.message ?? 'Verdict failed.', whyItWorks: '', theCatch: '', wearItWith: '' })
      setAction('verdict', 'error')
    }
  }

  const callTone = (call?: string) => (call === 'Yes' ? 'success' : call === 'Skip' ? 'error' : 'warning') as 'success' | 'error' | 'warning'
  const callLabel = (call?: string) => (call === 'Yes' ? 'Yes, buy it' : call === 'Skip' ? 'Skip it' : 'Maybe')
  const confidenceTone = (c?: string) => (c === 'high' ? 'success' : c === 'medium' ? 'warning' : 'error') as 'success' | 'warning' | 'error'
  const clearGarment = () => { setGarment(null); setUrlInput(''); setSafetyWarning(null) }
  const twoCol = width >= 900

  // ── The piece: photo, brand, name, price, where it came from ──
  const garmentCard = garment && (
    <View style={s.garmentCard}>
      <View>
        <Image source={{ uri: garment.imageBase64 }} style={s.garmentImg} resizeMode="cover" accessibilityLabel={garment.name ?? 'Your garment'} />
        <TouchableOpacity style={s.trashBtn} onPress={clearGarment} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove this piece">
          <Icon name="trash" size={20} color={Colors.textOnDark} />
        </TouchableOpacity>
      </View>
      <View style={s.garmentBody}>
        {!!garment.brand && <Text {...displayProps(20)} style={s.garmentBrand} numberOfLines={1}>{garment.brand.toUpperCase()}</Text>}
        {(garment.name || garment.price) && (
          <View style={s.garmentNameRow}>
            <Text style={s.garmentName} numberOfLines={3}>{garment.name || 'Garment'}</Text>
            {!!garment.price && <Text style={s.garmentPrice}>{garment.price}</Text>}
          </View>
        )}
        <View style={s.sourceRow}>
          <View style={s.sourcePill}>
            <Icon name={garment.sourceUrl ? 'link' : 'gallery'} size={14} color={Colors.textMuted} />
            <Text style={s.sourceText} numberOfLines={1}>
              {garment.sourceUrl ? garment.sourceUrl.replace(/^https?:\/\/(www\.)?/, '') : 'Uploaded photo'}
            </Text>
          </View>
          <PillButton label="New piece" variant="secondary" size="sm" onPress={clearGarment} />
        </View>
      </View>
    </View>
  )

  // ── Try it on · Find my size · Should I buy it? ──
  const actions = garment && (
    <View style={s.actions}>
      {cloudError && (
        <Notice tone="error" text={cloudError} actionLabel="Retry"
          onAction={() => { const r = cloudRetry.current; setCloudError(null); r?.() }} />
      )}

      {(creditNote || paywall) && (
        <Card variant="sunken" style={{ gap: Space.base }}>
          <Text style={s.buyTitle}>{creditNote ?? 'You’re out of credits. Buy more to keep generating:'}</Text>
          <PurchaseOptions onPurchased={() => { setCreditNote(null); setPaywall(false) }} />
        </Card>
      )}

      {/* Try it on — the one gradient action */}
      <View style={s.actionSection}>
        <PillButton
          variant="primary"
          icon={retryIn.tryon > 0 ? 'refresh' : 'tryOn'}
          label={retryIn.tryon > 0 ? `Retry in ${retryIn.tryon}s` : tryOnResult?.image && !tryOnResult.fallback ? 'Try It On Again' : 'Try It On'}
          loading={actionState.tryon === 'loading'}
          disabled={retryIn.tryon > 0}
          onPress={runTryOn}
        />
        {photoHint && !profile.photoUri && (
          <Notice tone="info" text="Try-on needs a full-length photo of you." actionLabel="Add your photo"
            onAction={() => router.navigate('/(tabs)/profile')} />
        )}
        {actionState.tryon === 'loading' && (
          <View style={s.resultCard} accessibilityLiveRegion="polite">
            <View style={s.resultHead}><Text {...displayProps(16)} style={s.resultTag}>AI TRY-ON</Text></View>
            <View style={s.tryOnLoading}>
              <Skeleton height="100%" radius={Radius.md} style={StyleSheet.absoluteFill} />
              <Icon name="tryOn" size={28} color={Colors.primaryDark} />
              <Text style={s.loadingNote}>{tryOnCopy}</Text>
            </View>
          </View>
        )}
        {tryOnResult && !paywall && actionState.tryon !== 'loading' && (
          tryOnResult.image && !tryOnResult.fallback ? (
            <View style={s.resultCard}>
              <View style={s.resultHead}>
                <Text {...displayProps(16)} style={[s.resultTag, tryOnResult.debug && { color: Colors.error }]}>
                  {tryOnResult.debug ? 'DEBUG MODE — STUB, NOT A REAL GENERATION' : tryOnResult.demo ? 'DEMO' : 'AI TRY-ON'}
                </Text>
                {tryOnResult.cached && <Tag label="Saved · no credit used" tone="success" />}
              </View>
              <Image source={{ uri: tryOnResult.image }} style={s.tryOnImg} resizeMode="contain" accessibilityLabel="You wearing this piece" />
              <Text style={s.resultFoot}>Saved to your History.</Text>
            </View>
          ) : (
            <Notice tone="warning" text={tryOnResult.message ?? 'Try-on isn’t available right now. Please try again in a moment.'} />
          )
        )}
      </View>

      {/* Find my size */}
      <View style={s.actionSection}>
        <PillButton
          variant="secondary"
          icon={retryIn.size > 0 ? 'refresh' : 'size'}
          label={retryIn.size > 0 ? `Retry in ${retryIn.size}s` : 'Find My Size'}
          loading={actionState.size === 'loading'}
          disabled={retryIn.size > 0}
          onPress={runSize}
        />
        {actionState.size === 'loading' && <Text style={s.loadingNote}>{sizeCopy}</Text>}
        {garment.sizeChartText && actionState.size === 'idle' && (
          <View style={s.inlineNote}><Icon name="check" size={14} color={Colors.success} /><Text style={s.okNote}>Size chart found on the product page</Text></View>
        )}
        {measHint && !profile.measurements && (
          <Notice tone="info" text="Add your measurements for an accurate size." actionLabel="Add measurements"
            onAction={() => router.navigate('/(tabs)/profile')} />
        )}
        {sizeResult && (
          <View style={s.resultCard}>
            <View style={s.sizeHeader}>
              <Text style={s.sizeBig}>{sizeResult.size}</Text>
              <View style={{ gap: Space.xs, flex: 1 }}>
                <Text {...displayProps(16)} style={s.resultTag}>YOUR SIZE</Text>
                <Tag label={`${sizeResult.confidence} confidence`} tone={confidenceTone(sizeResult.confidence)} dot />
              </View>
            </View>
            {sizeResult.detected && (
              <View style={s.detectedRow}>
                {sizeResult.detected.garmentType && <Tag label={sizeResult.detected.garmentType} />}
                {sizeResult.detected.fabric && <Tag label={sizeResult.detected.fabric} />}
                {sizeResult.detected.fit && <Tag label={`${sizeResult.detected.fit} fit`} />}
              </View>
            )}
            <Text style={s.resultBody}>{sizeResult.explanation}</Text>
            {!!sizeResult.caveat && <Text style={s.resultCaveat}>{sizeResult.caveat}</Text>}
          </View>
        )}
      </View>

      {/* Should I buy it? */}
      <View style={s.actionSection}>
        <PillButton
          variant="outline"
          icon={retryIn.verdict > 0 ? 'refresh' : undefined}
          label={retryIn.verdict > 0 ? `Retry in ${retryIn.verdict}s` : 'Should I Buy It?'}
          loading={actionState.verdict === 'loading'}
          disabled={retryIn.verdict > 0}
          onPress={runVerdict}
        />
        {actionState.verdict === 'loading' && <Text style={s.loadingNote}>{verdictCopy}</Text>}
        {verdictResult && (
          <View style={s.resultCard}>
            <View style={s.resultHead}>
              <Text {...displayProps(16)} style={s.resultTag}>OUR VERDICT</Text>
              <Tag label={callLabel(verdictResult.call)} tone={callTone(verdictResult.call)} dot />
            </View>
            <Text style={s.verdictLine}>{verdictResult.verdict}</Text>
            {!!verdictResult.whyItWorks && verdictResult.whyItWorks !== '—' && (
              <View style={s.verdictGrid}>
                {([['Why it works', verdictResult.whyItWorks], ['The catch', verdictResult.theCatch], ['Wear it with', verdictResult.wearItWith]] as const).map(([label, body]) => (
                  <View key={label} style={s.verdictCell}>
                    <Text style={s.verdictLabel}>{label}</Text>
                    <Text style={s.resultBody}>{body}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  )

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <Page width={garment ? 'app' : 'reading'} gap={Space.xl}>
        {/* ── The question the app answers ── */}
        <View style={s.header}>
          <View style={s.headerTitleRow}>
            <Title size={width < 400 ? 'h1' : 'display'} style={{ flexShrink: 1 }}>Found Something You Love?</Title>
            <TouchableOpacity
              style={s.helpBadge}
              onPress={() => setHasSeenOnboarding(false)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="How it works"
            >
              <Icon name="help" size={16} color={Colors.textOnDark} />
            </TouchableOpacity>
          </View>
          <Text style={s.heroSub}>
            Show me a design and I’ll tell you how it looks on you, what size to get and whether it’s really yours.
          </Text>
        </View>

        {/* ── Two ways to add a piece (spec §3.3) ── */}
        {!garment && (
          <View style={s.intake}>
            <View style={s.uploadCard}>
              <Icon name="upload" size={44} color={Colors.textOnDark} />
              <Text style={s.uploadLabel}>Upload a photo</Text>
              <Text style={s.uploadHint}>A screenshot from any shopping app works</Text>
              <View style={s.uploadBtns}>
                <PillButton label="Take a photo" icon="takePhoto" variant="light" size="sm" onPress={() => pickImage('camera')} style={{ flexGrow: 1 }} />
                <PillButton label="Choose from gallery" icon="gallery" variant="gold" size="sm" onPress={() => pickImage('library')} style={{ flexGrow: 1 }} />
              </View>
            </View>

            <Text style={s.orText}>or paste a product link</Text>
            <View style={s.urlRow}>
              <Field
                pill
                value={urlInput}
                onChangeText={(v) => { setUrlInput(v); setUrlError(null) }}
                placeholder="e.g. www.myntra.com/…"
                autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go"
                onSubmitEditing={loadFromUrl}
                containerStyle={{ flex: 1, marginTop: 0 }}
                accessibilityLabel="Product link"
              />
              <PillButton label="Next" onPress={loadFromUrl} loading={urlLoading} disabled={!urlInput.trim()} size="md" style={{ minHeight: 50 }} />
            </View>
            <Text style={s.linkHint}>A link also brings in the size chart for Find My Size.</Text>

            {urlError && (
              <Notice tone="warning" text={urlError} actionLabel="Upload a screenshot instead" onAction={() => pickImage('library')} />
            )}
          </View>
        )}

        {garment && (
          <View style={[s.work, twoCol && s.workTwo]}>
            <View style={twoCol ? s.workLeft : null}>
              {garmentCard}
              {safetyWarning && (
                <Notice tone="warning" title="This piece may not be supported" text={safetyWarning}
                  onClose={() => setSafetyWarning(null)} style={{ marginTop: Space.base }} />
              )}
            </View>
            <View style={twoCol ? s.workRight : null}>{actions}</View>
          </View>
        )}
      </Page>
      {/* ── ONBOARDING OVERLAY ── inline so React 19 event delegation reaches it */}
      <OnboardingModal visible={!hasSeenOnboarding} onDismiss={dismissOnboarding} />
    </View>
  )
}

const s = StyleSheet.create({
  header:         { gap: Space.md },
  headerTitleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  helpBadge: {
    width: 28, height: 28, borderRadius: 14, marginTop: 10,
    backgroundColor: Colors.secondary, alignItems: 'center', justifyContent: 'center',
  },
  heroSub: { ...Typography.body, fontSize: 16, lineHeight: 25, color: Colors.text, maxWidth: 600 },

  intake: { gap: Space.base, width: '100%', maxWidth: 720 },
  uploadCard: {
    backgroundColor: Colors.bgDark, borderRadius: Radius.xl, paddingVertical: Space.xxl, paddingHorizontal: Space.lg,
    alignItems: 'center', gap: Space.sm,
  },
  uploadLabel: { ...Typography.h3, fontSize: 18, color: Colors.textOnDark, marginTop: Space.sm },
  uploadHint:  { ...Typography.body, color: Colors.primaryLight, textAlign: 'center' },
  uploadBtns:  { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: Space.sm, marginTop: Space.base, width: '100%', maxWidth: 420 },
  orText:   { ...Typography.body, color: Colors.text, textAlign: 'center', marginTop: Space.sm },
  urlRow:   { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  linkHint: { ...Typography.caption, textAlign: 'center' },

  work:      { gap: Space.xl },
  workTwo:   { flexDirection: 'row', alignItems: 'flex-start' },
  workLeft:  { flex: 1, minWidth: 0 },
  workRight: { flex: 1, minWidth: 0 },

  garmentCard: { backgroundColor: Colors.bgCard, borderRadius: Radius.xl, overflow: 'hidden', ...Shadow.card },
  garmentImg:  { width: '100%', aspectRatio: 3 / 4, backgroundColor: Colors.bgSubtle },
  trashBtn: {
    position: 'absolute', top: Space.md, right: Space.md, width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(66,61,58,0.88)', alignItems: 'center', justifyContent: 'center',
  },
  garmentBody:    { padding: Space.lg, gap: Space.sm },
  garmentBrand:   { fontFamily: FONT_DISPLAY, fontSize: 20, lineHeight: 26, letterSpacing: 2, color: Colors.text },
  garmentNameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: Space.base },
  garmentName:    { ...Typography.body, flex: 1 },
  garmentPrice:   { ...Typography.body, ...Weight.semibold },
  sourceRow:      { flexDirection: 'row', alignItems: 'center', gap: Space.sm, marginTop: Space.sm },
  sourcePill: {
    flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: Space.xs, minHeight: 40,
    paddingHorizontal: Space.base, borderRadius: Radius.full, backgroundColor: Colors.bgSubtle, borderWidth: 1.5, borderColor: Colors.secondary,
  },
  sourceText: { ...Typography.bodySmall, color: Colors.textMuted, flex: 1 },

  actions:       { gap: Space.lg },
  actionSection: { gap: Space.md },
  buyTitle:      { ...Typography.body, ...Weight.semibold },

  loadingNote: { ...Typography.bodySmall, textAlign: 'center', color: Colors.textMuted },
  inlineNote:  { flexDirection: 'row', alignItems: 'center', gap: Space.xs, justifyContent: 'center' },
  okNote:      { ...Typography.caption, color: Colors.success },

  resultCard: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.xl, borderWidth: 1.5, borderColor: Colors.secondary,
    padding: Space.lg, gap: Space.md, overflow: 'hidden',
  },
  resultHead:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Space.sm, flexWrap: 'wrap' },
  resultTag:    { fontFamily: FONT_DISPLAY, fontSize: 16, lineHeight: 20, letterSpacing: 2, color: Colors.text },
  resultBody:   { ...Typography.bodySmall, lineHeight: 21, color: Colors.text },
  resultCaveat: { ...Typography.caption, fontStyle: 'italic' },
  resultFoot:   { ...Typography.caption, textAlign: 'center' },
  tryOnImg:     { width: '100%', aspectRatio: 3 / 4, borderRadius: Radius.md, backgroundColor: Colors.bgSubtle },
  tryOnLoading: { width: '100%', aspectRatio: 3 / 4, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center', gap: Space.md, padding: Space.lg, overflow: 'hidden' },

  sizeHeader:  { flexDirection: 'row', alignItems: 'center', gap: Space.base },
  sizeBig:     { ...Typography.numeral, fontSize: 64, lineHeight: 68 },
  detectedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },

  verdictLine:  { ...Typography.h3, fontSize: 18, lineHeight: 27 },
  verdictGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: Space.base },
  verdictCell:  { flexBasis: 200, flexGrow: 1, gap: Space.xs },
  verdictLabel: { ...Typography.label },
})
