import { useState, useRef, useEffect } from 'react'
import {
  View, Text, TouchableOpacity, ScrollView, SafeAreaView,
  ActivityIndicator, StyleSheet, Animated, Easing, Platform,
} from 'react-native'
import * as FileSystem from 'expo-file-system'
import { useProfileStore } from '../../lib/store'
import { fetchColorAnalysis, fetchStyleAnalysis } from '../../lib/api'
import { supabase } from '../../lib/supabaseClient'
import { upsertProfile } from '../../lib/supabaseStorage'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon, IconName } from '../../lib/ui'
import type { ColorAnalysisResult, StyleResult } from '../../lib/types'

const SERIF = '"Alta", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif'
// Light text tones for the dark (#423D3A) Style page
const ON_DARK        = Colors.textOnDark
const ON_DARK_MUTED  = 'rgba(250,248,245,0.62)'
const ON_DARK_FAINT  = 'rgba(250,248,245,0.42)'
const ON_DARK_BODY   = 'rgba(250,248,245,0.80)'

// Slow breathing shimmer — gentle, draws the eye without gimmick
function useBreathingShimmer() {
  const anim = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1, duration: 3800,
          easing: Easing.inOut(Easing.sin), useNativeDriver: false,
        }),
        Animated.timing(anim, {
          toValue: 0, duration: 3800,
          easing: Easing.inOut(Easing.sin), useNativeDriver: false,
        }),
      ]),
    ).start()
  }, [anim])
  return anim
}

// ─── Gold pill button (4.svg) — gold fill, dark text, rounded pill ─────────────
function GoldButton({
  label, icon, loading, onPress,
}: { label: string; icon: IconName; loading: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[s.goldBtn, loading && s.goldBtnDisabled]}
      onPress={onPress} disabled={loading} activeOpacity={0.85}
    >
      {loading
        ? <ActivityIndicator color={Colors.secondary} />
        : (
          <View style={s.goldRow}>
            <Icon name={icon} size={20} color={Colors.secondary} />
            <Text style={s.goldText}>{label}</Text>
          </View>
        )}
    </TouchableOpacity>
  )
}

export default function StyleScreen() {
  const profile = useProfileStore()

  const [loading, setLoading]       = useState(false)
  // Results start null on every entry — user must tap to see them
  const [colorResult, setColorResult] = useState<ColorAnalysisResult | null>(null)
  const [styleResult, setStyleResult] = useState<StyleResult | null>(null)
  const [error, setError]           = useState<string | null>(null)

  const breathe = useBreathingShimmer()
  const ringOpacity = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.30] })
  const ringScale   = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1.03] })

  const hasPhoto   = !!profile.photoUri
  const hasResults = !!(colorResult || styleResult)

  async function readPhoto(): Promise<string> {
    const uri = profile.photoUri!
    if (uri.startsWith('data:')) return uri
    if (Platform.OS === 'web') {
      const res = await fetch(uri)
      const blob = await res.blob()
      return new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(blob)
      })
    }
    const raw = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
    return `data:image/jpeg;base64,${raw}`
  }

  async function runAnalysis() {
    if (!hasPhoto) return
    setLoading(true)
    setError(null)
    try {
      const photoBase64 = await readPhoto()
      const [color, style] = await Promise.all([
        fetchColorAnalysis(photoBase64),
        fetchStyleAnalysis({ photoBase64, measurements: profile.measurements ?? undefined }),
      ])
      setColorResult(color)
      setStyleResult(style)
      profile.setColorAnalysis(color)
      supabase.auth.getSession().then(({ data }) => {
        const user = data.session?.user
        if (user) upsertProfile(user.id, user.email ?? '', { colorAnalysis: color }).catch(() => {})
      })
    } catch (e: any) {
      setError(e.message ?? 'Analysis failed — make sure the API server is running.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <View style={s.page}>
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* ── Page heading (branding is in the shared app header) ── */}
        <Text style={s.pageHeading}>Your Style Profile</Text>
        <Text style={s.pageSub}>
          Your personal colour season, flattering palette, style archetype, and silhouette — read from your photo.
        </Text>

        {!hasPhoto ? (
          <View style={s.emptyState}>
            <Icon name="profile" size={44} color={ON_DARK_FAINT} />
            <Text style={s.emptyTitle}>Add a photo first</Text>
            <Text style={s.emptySub}>
              Go to the Profile tab, add a photo of yourself, and come back for your colour and style analysis.
            </Text>
          </View>
        ) : !hasResults ? (
          /* ── REVEAL HERO — centered gold button with radiating rings ── */
          <View style={s.hero}>
            <Animated.View style={[s.rings, { transform: [{ scale: ringScale }] }]} pointerEvents="none">
              <Animated.View style={[s.ring, s.ring1, { opacity: ringOpacity }]} />
              <Animated.View style={[s.ring, s.ring2, { opacity: ringOpacity }]} />
              <Animated.View style={[s.ring, s.ring3, { opacity: ringOpacity }]} />
            </Animated.View>

            <View style={s.btnBlock}>
              <Icon name="star" size={22} color={ON_DARK} style={s.sparkTR} />
              <Icon name="star" size={16} color={ON_DARK} style={s.sparkBL} />
              <GoldButton label="Reveal My Style" icon="reveal" loading={loading} onPress={runAnalysis} />
            </View>

            {loading && <Text style={s.loadingNote}>Reading your photo — this takes about 10 seconds…</Text>}
            {error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}
          </View>
        ) : (
          /* ── Results present — compact re-reveal control ── */
          <View style={s.btnWrap}>
            <GoldButton label="Re-reveal My Style" icon="refresh" loading={loading} onPress={runAnalysis} />
            {loading && <Text style={s.loadingNote}>Reading your photo — this takes about 10 seconds…</Text>}
            {error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}
          </View>
        )}

        {/* ── COLOR ANALYSIS ── */}
        {colorResult && (
          <View style={s.card}>
            <Text style={s.cardEyebrow}>COLOUR ANALYSIS</Text>

            {/* Stacked heading + subheading */}
            <Text style={s.seasonHeading}>{colorResult.season}</Text>
            <Text style={s.undertoneSubhead}>{colorResult.undertone} undertone</Text>

            <Text style={s.narrative}>{colorResult.narrative}</Text>

            <Text style={s.swatchLabel}>LOOKS GREAT ON YOU</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.swatchRow}>
              {colorResult.flatteringColors.map((c) => (
                <View key={c.name} style={s.swatchItem}>
                  <View style={[s.swatchDot, { backgroundColor: c.hex }]} />
                  <Text style={s.swatchName}>{c.name}</Text>
                </View>
              ))}
            </ScrollView>

            {colorResult.avoid && colorResult.avoid.length > 0 && (
              <>
                <Text style={[s.swatchLabel, { marginTop: Space.md }]}>AVOID</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.swatchRow}>
                  {colorResult.avoid.map((c) => (
                    <View key={c.name} style={s.swatchItem}>
                      <View style={[s.swatchDot, s.swatchDotAvoid, { backgroundColor: c.hex }]} />
                      <Text style={s.swatchName}>{c.name}</Text>
                    </View>
                  ))}
                </ScrollView>
              </>
            )}
          </View>
        )}

        {/* ── STYLE GUIDE ── */}
        {styleResult && (
          <View style={s.card}>
            <Text style={s.cardEyebrow}>STYLE GUIDE</Text>

            {/* Stacked heading + narrative subheading */}
            <Text style={s.archetype}>{styleResult.archetype}</Text>
            <Text style={s.archetypeNarrative}>{styleResult.narrative.split('\n')[0]}</Text>

            {/* Remaining narrative lines */}
            {styleResult.narrative.split('\n').slice(1).filter(Boolean).length > 0 && (
              <View style={s.narrativeBlock}>
                {styleResult.narrative.split('\n').slice(1).filter(Boolean).map((line, i) => {
                  const dashIdx = line.indexOf(' — ')
                  const label   = dashIdx > -1 ? line.slice(0, dashIdx) : null
                  const content = dashIdx > -1 ? line.slice(dashIdx + 3) : line
                  return (
                    <View key={i} style={s.narrativeLine}>
                      {label && <Text style={s.narrativeLineLabel}>{label} —</Text>}
                      <Text style={s.narrativeLineText}>{content}</Text>
                    </View>
                  )
                })}
              </View>
            )}

            {styleResult.silhouettes && styleResult.silhouettes.length > 0 && (
              <>
                <Text style={s.swatchLabel}>SILHOUETTES FOR YOU</Text>
                <View style={s.silhouetteList}>
                  {styleResult.silhouettes.map((sil, i) => (
                    <View key={i} style={s.silhouetteRow}>
                      <View style={s.silhouetteDot} />
                      <Text style={s.silhouetteText}>{sil}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}

            {styleResult.palettes && styleResult.palettes.length > 0 && (
              <>
                <Text style={[s.swatchLabel, { marginTop: Space.md }]}>YOUR PALETTE</Text>
                {styleResult.palettes.map((palette) => (
                  <View key={palette.name} style={s.paletteGroup}>
                    <Text style={s.paletteName}>{palette.name}</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.swatchRow}>
                      {palette.colors.map((c) => (
                        <View key={c.name} style={s.swatchItem}>
                          <View style={[s.swatchDot, { backgroundColor: c.hex }]} />
                          <Text style={s.swatchName}>{c.name}</Text>
                        </View>
                      ))}
                    </ScrollView>
                  </View>
                ))}
              </>
            )}
          </View>
        )}

      </ScrollView>
    </SafeAreaView>
    </View>
  )
}

const s = StyleSheet.create({
  page:   { flex: 1, backgroundColor: Colors.secondary }, // dark charcoal page (4.svg)
  safe:   { flex: 1 },
  scroll: { padding: Space.base, paddingBottom: Space.xxl, gap: Space.md },

  // Header — logo kept, adapted for dark; page heading in 4.svg treatment
  header:    { marginBottom: Space.sm },
  logoSub:   { ...Typography.label, color: Colors.primary, letterSpacing: 4, fontSize: 9 },
  logo:      { fontFamily: SERIF, fontSize: 22, letterSpacing: 5, marginTop: -2, color: ON_DARK },
  pageHeading: {
    fontFamily: SERIF, fontSize: 30, fontWeight: '400' as const,
    letterSpacing: 1, lineHeight: 40, color: ON_DARK,
    fontVariant: ['small-caps'],
  },
  pageSub: {
    fontFamily: SERIF, fontSize: 14, lineHeight: 22, letterSpacing: 0.2,
    color: ON_DARK_MUTED, marginTop: Space.xs,
  },

  // Reveal hero — centered button, radiating rings, sparkles
  hero:   { minHeight: 420, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  rings:  { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  ring:   { position: 'absolute', borderWidth: 1, borderColor: Colors.primary, borderRadius: 9999 },
  ring1:  { width: 190, height: 190 },
  ring2:  { width: 300, height: 300 },
  ring3:  { width: 420, height: 420 },

  btnBlock: { position: 'relative', alignItems: 'center' },
  sparkTR:  { position: 'absolute', top: -22, right: -18 },
  sparkBL:  { position: 'absolute', bottom: -18, left: -14 },

  goldBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.full,
    paddingVertical: 16, paddingHorizontal: Space.xl,
    alignItems: 'center', justifyContent: 'center', minWidth: 240,
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35, shadowRadius: 18, elevation: 6,
  },
  goldBtnDisabled: { opacity: 0.7 },
  goldRow:  { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  goldText: { fontFamily: SERIF, fontSize: 16, fontWeight: '600' as const, letterSpacing: 0.3, color: Colors.secondary },

  btnWrap:     { alignItems: 'center', gap: Space.sm, marginBottom: Space.sm },
  loadingNote: { ...Typography.caption, textAlign: 'center', color: ON_DARK_MUTED, marginTop: Space.md },
  errorBox:    { backgroundColor: 'rgba(185,60,42,0.15)', borderRadius: Radius.sm, padding: Space.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', marginTop: Space.md },
  errorText:   { ...Typography.caption, color: '#F3C9C2', lineHeight: 19 },

  emptyState: { alignItems: 'center', paddingVertical: Space.xxl, gap: Space.md, minHeight: 380, justifyContent: 'center' },
  emptyTitle: { ...Typography.h3, color: ON_DARK },
  emptySub:   { ...Typography.bodySmall, color: ON_DARK_MUTED, lineHeight: 22, textAlign: 'center', maxWidth: 280 },

  // Results cards — subtle raised surface on dark
  card: {
    backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: Radius.lg,
    borderWidth: 1, borderColor: 'rgba(250,248,245,0.10)', padding: Space.base, gap: Space.sm,
  },
  cardEyebrow: { ...Typography.label, color: Colors.primary, letterSpacing: 2, marginBottom: Space.xs },

  // Color analysis — stacked heading + subheading
  seasonHeading:    { fontFamily: SERIF, fontSize: 24, fontWeight: '400' as const, letterSpacing: 0.5, lineHeight: 30, color: ON_DARK },
  undertoneSubhead: { ...Typography.bodySmall, color: ON_DARK_MUTED, marginTop: -Space.xs },
  narrative:        { fontFamily: SERIF, fontSize: 15, lineHeight: 23, color: ON_DARK_BODY },

  swatchLabel: { ...Typography.label, letterSpacing: 1.5, color: ON_DARK_FAINT, marginBottom: -4 },
  swatchRow:   { flexDirection: 'row', gap: 14, paddingVertical: Space.sm },
  swatchItem:  { alignItems: 'center', gap: Space.xs, maxWidth: 68 },
  swatchDot: {
    width: 44, height: 44, borderRadius: 22,
    borderWidth: 1, borderColor: 'rgba(250,248,245,0.15)',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2, shadowRadius: 2, elevation: 2,
  },
  swatchDotAvoid: { opacity: 0.5 },
  swatchName: { ...Typography.caption, color: ON_DARK_MUTED, textAlign: 'center', lineHeight: 12 },

  // Style guide — stacked heading + subheading
  archetype:          { fontFamily: SERIF, fontSize: 24, fontWeight: '400' as const, letterSpacing: 0.5, lineHeight: 30, color: ON_DARK },
  archetypeNarrative: { fontFamily: SERIF, fontSize: 15, color: ON_DARK_MUTED, lineHeight: 22, marginTop: -Space.xs },
  narrativeBlock:     { gap: Space.sm, marginTop: Space.xs },
  narrativeLine:      { gap: 2 },
  narrativeLineLabel: { ...Typography.label, color: Colors.primary, letterSpacing: 1, marginBottom: 2 },
  narrativeLineText:  { fontFamily: SERIF, fontSize: 15, lineHeight: 22, color: ON_DARK_BODY },

  silhouetteList: { gap: Space.sm, marginBottom: Space.xs },
  silhouetteRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  silhouetteDot:  { width: 4, height: 4, borderRadius: 2, backgroundColor: Colors.primary, marginTop: 8 },
  silhouetteText: { flex: 1, ...Typography.bodySmall, color: ON_DARK_BODY, lineHeight: 20 },

  paletteGroup: { gap: Space.xs },
  paletteName:  { ...Typography.caption, color: ON_DARK_MUTED, fontStyle: 'italic' },
})
