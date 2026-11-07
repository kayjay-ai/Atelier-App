import { useState, useRef, useEffect, useCallback } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, Image, StyleSheet,
  SafeAreaView, ScrollView, ActivityIndicator, Alert, Platform,
} from 'react-native'
import { pickImageDataUri } from '../../lib/imageInput'
import { useRouter, useFocusEffect } from 'expo-router'
import { useProfileStore, useGarmentStore, useMembershipStore, useTryOnCacheStore, tryOnCacheKey, isPremium } from '../../lib/store'
import { imageToDataUri } from '../../lib/dataUri'
import { isFallback, isRetryable } from '../../lib/aiOutcome'
import { runTryOnAttempt } from '../../lib/tryOnAttempt'
import { PurchaseOptions } from '../../lib/purchaseOptions'
import {
  fetchGarmentFromUrl, fetchTryOn, fetchSizeAssist,
  fetchVerdict, checkGarmentSafety, postEvent,
} from '../../lib/api'
import { getCurrentUserId, saveTryOnToCloud, saveHistoryResults } from '../../lib/supabaseStorage'
import { Colors, Typography, Space, Radius, Shadow, FONT } from '../../lib/theme'
import { PillButton, Icon } from '../../lib/ui'
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
const PANELS = [
  { src: '/hero.jpg',                       label: 'YOU',          hint: 'Your photo' },
  { src: '/catalog/cascade-silk-blouse.jpg', label: 'A PIECE',     hint: 'Something you love' },
  { src: '/catalog/oraline-midi-dress.jpg',  label: 'YOUR FITTING', hint: 'Virtually on you' },
]

function OnboardingModal({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  if (!visible) return null
  return (
    <View style={[StyleSheet.absoluteFill, m.overlay]}>
      <View style={m.card}>
          <View style={m.brandRow}>
            <Text style={m.brandSub}>QUASAR'S</Text>
            <Text style={m.brand}>ATELIER</Text>
          </View>

          <Text style={m.headline}>How it works</Text>
          <Text style={m.sub}>See any piece on yourself — before you buy.</Text>

          <View style={m.panelRow}>
            {PANELS.flatMap((p, i) => {
              const imgSrc = Platform.OS === 'web' ? { uri: p.src } : null
              const panel = (
                <View key={`panel-${i}`} style={m.panel}>
                  {imgSrc
                    ? <Image source={imgSrc} style={m.panelImg} resizeMode="cover" />
                    : <View style={[m.panelImg, { backgroundColor: Colors.bgSubtle }]} />
                  }
                  <Text style={m.panelLabel}>{p.label}</Text>
                  <Text style={m.panelHint}>{p.hint}</Text>
                </View>
              )
              return i < PANELS.length - 1
                ? [panel, <Text key={`arrow-${i}`} style={m.arrow}>→</Text>]
                : [panel]
            })}
          </View>

          <TouchableOpacity style={m.startBtn} onPress={onDismiss}>
            <Text style={m.startBtnText}>Get started</Text>
          </TouchableOpacity>
          <TouchableOpacity style={m.skipBtn} onPress={onDismiss}>
            <Text style={m.skipText}>Skip</Text>
          </TouchableOpacity>
      </View>
    </View>
  )
}

const m = StyleSheet.create({
  overlay: {
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'center', alignItems: 'center',
    padding: Space.base,
    zIndex: 100,
  },
  card: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.xl,
    padding: Space.lg, width: '100%', maxWidth: 420,
    alignItems: 'center', gap: Space.sm,
  },
  brandRow:  { alignItems: 'center', marginBottom: Space.xs },
  brandSub:  { ...Typography.label, color: Colors.primary, letterSpacing: 4, fontSize: 9 },
  brand:     { ...Typography.h2, letterSpacing: 5, marginTop: -2 },
  headline:  { ...Typography.h3, textAlign: 'center' },
  sub:       { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center', lineHeight: 20 },

  panelRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    width: '100%', marginVertical: Space.md,
  },
  panel: { flex: 1, alignItems: 'center', gap: Space.xs },
  panelImg: {
    width: '100%', aspectRatio: 3 / 4,
    borderRadius: Radius.md, overflow: 'hidden' as const,
    backgroundColor: Colors.border,
  },
  panelLabel: { ...Typography.label, letterSpacing: 1.5, color: Colors.text, textAlign: 'center' },
  panelHint:  { ...Typography.caption, color: Colors.textMuted, textAlign: 'center' },
  arrow: {
    fontSize: 18, color: Colors.primaryLight,
    alignSelf: 'center', paddingHorizontal: Space.xs,
    marginTop: -Space.lg,
  },

  startBtn: {
    backgroundColor: Colors.secondary, borderRadius: Radius.md,
    paddingVertical: 15, alignItems: 'center', width: '100%',
  },
  startBtnText: { ...Typography.body, color: Colors.textOnDark, fontWeight: '600' as const, letterSpacing: 0.5 },
  skipBtn:  { alignItems: 'center', paddingVertical: Space.sm, width: '100%' },
  skipText: { ...Typography.caption, color: Colors.textFaint },
})

export default function HomeScreen() {
  const profile       = useProfileStore()
  const garmentStore  = useGarmentStore()
  const membershipStore = useMembershipStore()
  const tryOnCache    = useTryOnCacheStore()
  const router        = useRouter()

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
      Alert.alert('Photo', e?.message ?? 'Could not open the camera or gallery.')
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

  const callColor = (call?: string) =>
    call === 'Yes' ? Colors.success : call === 'Skip' ? Colors.error : Colors.warning
  const callBg = (call?: string) =>
    call === 'Yes' ? Colors.successBg : call === 'Skip' ? Colors.errorBg : Colors.warningBg

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
    <SafeAreaView style={s.safe}>

      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.column}>

        {/* ── Header: persistent hero ── */}
        <View style={s.header}>
          <View style={s.headerTitleRow}>
            <Text style={s.heroHeading}>Found Something You Love?</Text>
            <TouchableOpacity
              style={s.helpBadge}
              onPress={() => setHasSeenOnboarding(false)}
              activeOpacity={0.8}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={s.helpBadgeText}>?</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.heroSub}>
            Show me a design and I'll tell you how it looks on you, what size to get and whether it's really yours.
          </Text>
          {garment && (
            <TouchableOpacity
              style={s.newPieceBtn}
              onPress={() => { setGarment(null); setUrlInput(''); setSafetyWarning(null) }}
            >
              <Text style={s.newPiece}>New piece</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── INTAKE — two ways to add a garment (spec §3.3) ── */}
        {!garment && (
          <View style={s.intake}>
            <View style={[s.intakeCard, s.uploadCard]}>
              <Icon name="imageUpload" size={40} color={Colors.bgSubtle} />
              <Text style={s.uploadLabel}>Upload a picture or screenshot</Text>
              <Text style={s.uploadHint}>From any shopping app or website</Text>
              <View style={s.uploadBtns}>
                <TouchableOpacity style={s.lightBtn} onPress={() => pickImage('camera')}>
                  <Icon name="takePhoto" size={18} color={Colors.secondary} />
                  <Text style={s.lightBtnText}>Camera</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.lightBtn} onPress={() => pickImage('library')}>
                  <Icon name="gallery" size={18} color={Colors.secondary} />
                  <Text style={s.lightBtnText}>Gallery</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={[s.intakeCard, s.linkCard]}>
              <Icon name="link" size={36} color={Colors.secondary} />
              <Text style={s.linkLabel}>Paste a link</Text>
              <Text style={s.linkHint}>A product link also unlocks Size Assist and "Should I Buy It?"</Text>
              <View style={s.urlField}>
                <TextInput
                  style={s.urlInput}
                  placeholder="https://www.myntra.com/…"
                  placeholderTextColor={Colors.textFaint}
                  value={urlInput}
                  onChangeText={(v) => { setUrlInput(v); setUrlError(null) }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="go"
                  onSubmitEditing={loadFromUrl}
                />
              </View>
              <TouchableOpacity
                style={[s.urlBtn, (urlLoading || !urlInput.trim()) && { opacity: 0.55 }]}
                onPress={loadFromUrl}
                disabled={urlLoading || !urlInput.trim()}
              >
                {urlLoading ? <ActivityIndicator color={Colors.textOnDark} size="small" /> : <Text style={s.urlBtnText}>Next</Text>}
              </TouchableOpacity>
            </View>

            {urlError && (
              <View style={s.urlErrorBox}>
                <Text style={s.urlErrorText}>{urlError}</Text>
                <TouchableOpacity style={s.uploadAltBtn} onPress={() => pickImage('library')}>
                  <Text style={s.uploadAltText}>Upload a screenshot instead</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* ── GARMENT CARD ── */}
        {garment && (
          <View style={s.garmentCard}>
            <View style={s.garmentImgWrap}>
              <Image source={{ uri: garment.imageBase64 }} style={s.garmentImg} resizeMode="cover" />
              <TouchableOpacity
                style={s.trashBtn}
                onPress={() => { setGarment(null); setUrlInput(''); setSafetyWarning(null) }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Icon name="trash" size={22} color={Colors.textOnDark} />
              </TouchableOpacity>
            </View>

            <View style={s.garmentBody}>
              {garment.brand && <Text style={s.garmentBrand}>{garment.brand.toUpperCase()}</Text>}
              {(garment.name || garment.price) && (
                <View style={s.garmentNameRow}>
                  <Text style={s.garmentName} numberOfLines={3}>{garment.name || 'Garment'}</Text>
                  {garment.price && <Text style={s.garmentPrice}>{garment.price}</Text>}
                </View>
              )}

              <Text style={s.garmentSource} numberOfLines={1}>
                {garment.sourceUrl
                  ? garment.sourceUrl.replace(/^https?:\/\/(www\.)?/, '')
                  : garment.source === 'upload' ? 'Uploaded photo' : 'Garment'}
              </Text>
            </View>
          </View>
        )}

        {/* ── SAFETY WARNING (dismissible, never blocks buttons) ── */}
        {safetyWarning && (
          <View style={s.safetyBox}>
            <View style={s.safetyRow}>
              <Text style={s.safetyTitle}>Item not supported</Text>
              <TouchableOpacity onPress={() => setSafetyWarning(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={s.safetyDismiss}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.safetyBody}>{safetyWarning}</Text>
          </View>
        )}

        {/* ── THREE ACTIONS — always visible when garment is loaded ── */}
        {garment && (
          <View style={s.actions}>

            {/* ── Cloud save failed — cloud-only: surface + retry, never silent ── */}
            {cloudError && (
              <View style={s.cloudErrorBox}>
                <Text style={s.cloudErrorText}>{cloudError}</Text>
                <TouchableOpacity onPress={() => { const r = cloudRetry.current; setCloudError(null); r?.() }}>
                  <Text style={s.cloudRetryText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── Out of credits — show the three purchase options inline ── */}
            {(creditNote || paywall) && (
              <View style={s.buyBox}>
                <Text style={s.buyBoxText}>{creditNote ?? "You're out of credits. Buy more to keep generating:"}</Text>
                <PurchaseOptions onPurchased={() => { setCreditNote(null); setPaywall(false) }} />
              </View>
            )}

            {/* ── TRY IT ON — PRIMARY ── */}
            <View style={s.actionSection}>
              <PillButton
                variant="primary"
                icon={retryIn.tryon > 0 ? 'refresh' : 'tryOn'}
                label={retryIn.tryon > 0 ? `Retry in ${retryIn.tryon}s` : 'Try It On'}
                loading={actionState.tryon === 'loading'}
                disabled={retryIn.tryon > 0}
                onPress={runTryOn}
              />
              {actionState.tryon === 'loading' && (
                <Text style={s.loadingNote}>{tryOnCopy}</Text>
              )}
              {photoHint && !profile.photoUri && (
                <View style={s.prereqHint}>
                  <Text style={s.prereqHintText}>A photo of yourself is needed for virtual try-on.</Text>
                  <TouchableOpacity onPress={() => router.navigate('/(tabs)/profile')}>
                    <Text style={s.prereqHintLink}>Set up Profile →</Text>
                  </TouchableOpacity>
                </View>
              )}
              {tryOnResult && !paywall && (
                <View style={s.resultBox}>
                  {tryOnResult.image && !tryOnResult.fallback ? (
                    <>
                      <Text style={[s.resultTag, tryOnResult.debug && { color: Colors.error }]}>
                        {tryOnResult.debug ? 'DEBUG MODE — STUB (not a real generation)' : tryOnResult.cached ? 'SAVED · NO CREDIT USED' : tryOnResult.demo ? 'DEMO' : 'AI TRY-ON'}
                      </Text>
                      <View>
                        <Image source={{ uri: tryOnResult.image }} style={s.tryOnImg} resizeMode="contain" />
                        {tryOnResult.debug && (
                          <View style={s.debugBadge}><Text style={s.debugBadgeText}>DEBUG MODE</Text></View>
                        )}
                      </View>
                    </>
                  ) : (
                    <View style={s.softErrorBox}>
                      <Text style={s.softErrorText}>{tryOnResult.message ?? 'Try-on unavailable right now.'}</Text>
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* ── FIND MY SIZE — SECONDARY ── */}
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
                <Text style={s.sizeChartNote}>✓  Size chart loaded from product page</Text>
              )}
              {measHint && !profile.measurements && (
                <View style={s.prereqHint}>
                  <Text style={s.prereqHintText}>Add your measurements on the Profile tab for an accurate size recommendation.</Text>
                  <TouchableOpacity onPress={() => router.navigate('/(tabs)/profile')}>
                    <Text style={s.prereqHintLink}>Add measurements →</Text>
                  </TouchableOpacity>
                </View>
              )}

              {sizeResult && (
                <View style={s.resultBox}>
                  <View style={s.sizeHeader}>
                    <Text style={s.sizeBig}>{sizeResult.size}</Text>
                    <View style={[s.confidencePill, {
                      backgroundColor: sizeResult.confidence === 'high' ? Colors.successBg
                        : sizeResult.confidence === 'medium' ? Colors.warningBg : Colors.errorBg,
                    }]}>
                      <Text style={[s.confidenceText, {
                        color: sizeResult.confidence === 'high' ? Colors.success
                          : sizeResult.confidence === 'medium' ? Colors.warning : Colors.error,
                      }]}>
                        {sizeResult.confidence} confidence
                      </Text>
                    </View>
                  </View>
                  {sizeResult.detected && (
                    <View style={s.detectedRow}>
                      {sizeResult.detected.garmentType && <Text style={s.detectedChip}>{sizeResult.detected.garmentType}</Text>}
                      {sizeResult.detected.fabric      && <Text style={s.detectedChip}>{sizeResult.detected.fabric}</Text>}
                      {sizeResult.detected.fit         && <Text style={s.detectedChip}>{sizeResult.detected.fit} fit</Text>}
                    </View>
                  )}
                  <Text style={s.sizeExplain}>{sizeResult.explanation}</Text>
                  {sizeResult.caveat && <Text style={s.sizeCaveat}>{sizeResult.caveat}</Text>}
                </View>
              )}
            </View>

            {/* ── SHOULD I BUY IT? — OUTLINE ── */}
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
                <View style={[s.verdictCard, { backgroundColor: callBg(verdictResult.call) }]}>
                  <View style={[s.callPill, { backgroundColor: callColor(verdictResult.call) }]}>
                    <Text style={s.callPillText}>{verdictResult.call}</Text>
                  </View>
                  <Text style={s.verdictLine}>{verdictResult.verdict}</Text>
                  {verdictResult.whyItWorks && verdictResult.whyItWorks !== '—' && (
                    <>
                      <Text style={s.verdictLabel}>WHY IT WORKS</Text>
                      <Text style={s.verdictBody}>{verdictResult.whyItWorks}</Text>
                      <Text style={s.verdictLabel}>THE CATCH</Text>
                      <Text style={s.verdictBody}>{verdictResult.theCatch}</Text>
                      <Text style={s.verdictLabel}>WEAR IT WITH</Text>
                      <Text style={s.verdictBody}>{verdictResult.wearItWith}</Text>
                    </>
                  )}
                </View>
              )}
            </View>

          </View>
        )}
        </View>
      </ScrollView>
    </SafeAreaView>
    {/* ── ONBOARDING OVERLAY ── inline so React 19 event delegation reaches it */}
    <OnboardingModal visible={!hasSeenOnboarding} onDismiss={dismissOnboarding} />
    </View>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Colors.bg },
  scroll: { paddingHorizontal: Space.lg, paddingTop: Space.base, paddingBottom: Space.xxl },
  column: { width: '100%', maxWidth: 720, alignSelf: 'center' },

  header: {
    marginBottom: Space.xl,
    gap: Space.md,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.sm,
  },
  heroHeading: {
    flex: 1,
    fontFamily: FONT,
    fontSize: 30,
    fontWeight: '400' as const,
    letterSpacing: 1,
    lineHeight: 40,
    color: Colors.secondary,
    fontVariant: ['small-caps'],
  },
  // A real round button — an inline <Text> background paints the full line box
  // on native, which rendered as a tall black bar.
  helpBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    marginTop: 6,
    backgroundColor: Colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  helpBadgeText: {
    fontFamily: FONT,
    fontSize: 14,
    fontWeight: '700' as const,
    lineHeight: 18,
    color: Colors.textOnDark,
  },
  newPieceBtn: { alignSelf: 'flex-start' },
  newPiece: {
    fontFamily: FONT,
    fontSize: 12, letterSpacing: 1.5,
    color: Colors.primary,
  },

  intake:   { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  heroSub:  {
    fontFamily: FONT,
    fontSize: 14,
    fontWeight: '400' as const,
    lineHeight: 22,
    letterSpacing: 0.2,
    color: Colors.textMuted,
  },

  // Two equal cards, side by side when there's room (iPad / desktop).
  intakeCard: {
    flexBasis: 280, flexGrow: 1, borderRadius: Radius.xl,
    padding: Space.lg, alignItems: 'center', gap: Space.sm,
  },
  uploadCard: { backgroundColor: Colors.secondary },
  linkCard:   { backgroundColor: Colors.bgCard, borderWidth: 1.5, borderColor: Colors.secondary },
  uploadLabel: { fontFamily: FONT, fontSize: 16, fontWeight: '700' as const, letterSpacing: 0.3, color: Colors.textOnDark, textAlign: 'center' },
  uploadHint:  { fontFamily: FONT, fontSize: 12, color: 'rgba(242,239,232,0.6)', textAlign: 'center' },
  uploadBtns:  { flexDirection: 'row', gap: Space.sm, marginTop: Space.sm, alignSelf: 'stretch' },
  lightBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.xs,
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.full, minHeight: 46,
  },
  lightBtnText: { ...Typography.bodySmall, fontWeight: '600' as const, color: Colors.secondary },

  linkLabel: { fontFamily: FONT, fontSize: 16, fontWeight: '700' as const, letterSpacing: 0.3, color: Colors.text },
  linkHint:  { fontFamily: FONT, fontSize: 12, color: Colors.textMuted, textAlign: 'center' },
  urlField:  { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', marginTop: Space.sm },
  urlInput: {
    // minWidth 0: a web <input> otherwise won't shrink and sticks out past the Next button.
    flex: 1, minWidth: 0, width: '100%', backgroundColor: Colors.bgSubtle, borderRadius: Radius.full,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Space.base, paddingVertical: 13,
    fontFamily: FONT, fontSize: 14, color: Colors.text, letterSpacing: 0.2,
  },
  urlBtn: {
    alignSelf: 'stretch', backgroundColor: Colors.secondary, borderRadius: Radius.full,
    minHeight: 46, justifyContent: 'center', alignItems: 'center',
  },
  urlBtnText: { fontFamily: FONT, fontSize: 14, fontWeight: '600' as const, letterSpacing: 0.5, color: Colors.textOnDark },

  urlErrorBox: {
    flexBasis: '100%', backgroundColor: Colors.warningBg, borderRadius: Radius.md,
    padding: Space.base, borderWidth: 1, borderColor: '#F5DEB3', gap: Space.md,
  },
  urlErrorText:  { ...Typography.bodySmall, color: Colors.warning, lineHeight: 22 },
  uploadAltBtn:  { backgroundColor: Colors.secondary, borderRadius: Radius.md, paddingVertical: 12, alignItems: 'center' },
  uploadAltText: { ...Typography.bodySmall, color: Colors.textOnDark, fontWeight: '600' as const },

  garmentCard: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.lg,
    overflow: 'hidden', marginBottom: Space.lg, ...Shadow.card,
  },
  garmentImgWrap: { position: 'relative' },
  garmentImg:     { width: '100%', aspectRatio: 3 / 4 },
  trashBtn: {
    position: 'absolute', top: Space.md, right: Space.md,
    width: 44, height: 44, borderRadius: Radius.md,
    backgroundColor: Colors.secondary,
    alignItems: 'center', justifyContent: 'center',
  },
  garmentBody:  { padding: Space.base, gap: Space.sm },
  garmentBrand: {
    fontFamily: FONT,
    fontSize: 13, letterSpacing: 3, color: Colors.text, fontWeight: '500' as const,
  },
  garmentNameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: Space.md },
  garmentName:    { ...Typography.body, flex: 1, lineHeight: 22, color: Colors.text },
  garmentPrice:   { ...Typography.body, color: Colors.text, fontWeight: '500' as const },
  garmentSource:  { ...Typography.bodySmall, color: Colors.textMuted, marginTop: Space.xs },

  // Safety warning — dismissible, non-blocking
  safetyBox: {
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Space.base, gap: Space.xs, marginBottom: Space.base,
  },
  safetyRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  safetyTitle:  { ...Typography.bodySmall, fontWeight: '600' as const, color: Colors.textMuted },
  safetyDismiss: { ...Typography.body, color: Colors.textFaint, lineHeight: 20 },
  safetyBody:   { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 20 },

  actions:       { gap: Space.md },
  actionSection: { gap: Space.sm },
  actionBtnDisabled: { opacity: 0.55 },

  tryOnBtn:      { borderRadius: Radius.full, overflow: 'hidden' },
  tryOnBtnInner: { paddingVertical: 18, alignItems: 'center' },
  tryOnText: {
    fontFamily: FONT,
    fontSize: 14, fontWeight: '600' as const,
    letterSpacing: 3, color: Colors.textOnPrimary,
  },

  secondaryBtn: {
    backgroundColor: Colors.bgCard,
    borderRadius: Radius.full, borderWidth: 1.5, borderColor: Colors.secondarySubtle,
    paddingVertical: 14, alignItems: 'center',
  },
  secondaryBtnText: {
    fontFamily: FONT,
    fontSize: 13, fontWeight: '500' as const,
    color: Colors.text, letterSpacing: 1.5,
  },

  loadingNote:    { ...Typography.caption, textAlign: 'center', color: Colors.textMuted },
  sizeChartNote:  { ...Typography.caption, color: Colors.success },

  naBox: {
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md,
    padding: Space.base, gap: Space.xs,
    borderWidth: 1, borderColor: Colors.border,
  },
  naTitle: { ...Typography.bodySmall, fontWeight: '600' as const, color: Colors.textMuted },
  naBody:  { ...Typography.caption, color: Colors.textMuted, lineHeight: 18 },

  paywallBox: {
    backgroundColor: Colors.warningBg, borderRadius: Radius.md,
    padding: Space.base, gap: Space.md, borderWidth: 1, borderColor: '#F5DEB3',
  },
  paywallText:    { ...Typography.bodySmall, color: Colors.warning },
  paywallBtn:     { backgroundColor: Colors.secondary, borderRadius: Radius.md, paddingVertical: 10, alignItems: 'center' },
  paywallBtnText: { ...Typography.bodySmall, color: Colors.textOnDark, fontWeight: '600' as const },

  buyBox: {
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.lg,
    padding: Space.base, gap: Space.md, borderWidth: 1, borderColor: Colors.border,
  },
  buyBoxText: { ...Typography.bodySmall, color: Colors.text, fontWeight: '600' as const },

  cloudErrorBox: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.errorBg, borderRadius: Radius.md, borderWidth: 1, borderColor: '#F3C9C2',
    padding: Space.md, gap: Space.md,
  },
  cloudErrorText: { ...Typography.bodySmall, color: Colors.error, flex: 1 },
  cloudRetryText: { ...Typography.bodySmall, color: Colors.error, fontWeight: '700' as const },

  resultBox: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.md,
    overflow: 'hidden', borderWidth: 1, borderColor: Colors.border,
  },
  resultTag:   { ...Typography.label, color: Colors.primary, padding: Space.md, paddingBottom: Space.xs },
  tryOnImg:    { width: '100%', aspectRatio: 3 / 4 },
  debugBadge:  { position: 'absolute', top: Space.sm, left: Space.sm, backgroundColor: Colors.error, borderRadius: Radius.sm, paddingHorizontal: Space.sm, paddingVertical: 3 },
  debugBadgeText: { ...Typography.label, color: '#FFF', letterSpacing: 1.5, fontSize: 9 },

  softErrorBox:  { padding: Space.md },
  softErrorText: { ...Typography.bodySmall, color: Colors.warning, lineHeight: 20 },

  sizeHeader:    { flexDirection: 'row', alignItems: 'center', gap: Space.md, padding: Space.base, paddingBottom: Space.sm },
  sizeBig:       { ...Typography.h1, fontSize: 42, lineHeight: 46 },
  confidencePill: { borderRadius: Radius.full, paddingHorizontal: Space.md, paddingVertical: 4 },
  confidenceText: { ...Typography.caption, fontWeight: '600' as const, letterSpacing: 0.4 },
  sizeExplain:    { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 21, paddingHorizontal: Space.base, paddingBottom: Space.sm },
  sizeCaveat:     { ...Typography.caption, color: Colors.textFaint, paddingHorizontal: Space.base, paddingBottom: Space.base, fontStyle: 'italic' },
  detectedRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm, paddingHorizontal: Space.base, paddingBottom: Space.sm },
  detectedChip: {
    ...Typography.caption, color: Colors.textMuted, backgroundColor: Colors.bgSubtle,
    borderRadius: Radius.sm, paddingHorizontal: Space.sm, paddingVertical: 3, overflow: 'hidden',
  },

  verdictCard:  { borderRadius: Radius.md, padding: Space.base, gap: Space.sm },
  callPill:     { alignSelf: 'flex-start', borderRadius: Radius.full, paddingHorizontal: Space.md, paddingVertical: 5, marginBottom: Space.xs },
  callPillText: { ...Typography.bodySmall, color: '#FFF', fontWeight: '700' as const, letterSpacing: 0.5 },
  verdictLine:  { ...Typography.h3, fontSize: 17, lineHeight: 26 },
  verdictLabel: { ...Typography.label, marginTop: Space.md },
  verdictBody:  { ...Typography.bodySmall, color: Colors.text, lineHeight: 21 },

  prereqHint: {
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Space.base, gap: Space.sm,
  },
  prereqHintText: { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 20 },
  prereqHintLink: { ...Typography.bodySmall, color: Colors.secondary, fontWeight: '600' as const },
})
