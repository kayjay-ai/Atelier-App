import { useState, useRef, useEffect } from 'react'
import {
  View, Text, TouchableOpacity, ScrollView, SafeAreaView,
  ActivityIndicator, StyleSheet, Animated, Easing, Platform,
} from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import { useRouter } from 'expo-router'
import { useProfileStore } from '../../lib/store'
import { fetchColorAnalysis, fetchStyleAnalysis } from '../../lib/api'
import { supabase } from '../../lib/supabaseClient'
import { upsertProfile } from '../../lib/supabaseStorage'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon, IconName } from '../../lib/ui'
import type { ColorSwatch, StyleReport } from '../../lib/types'

// Style tab (spec §3.4): one "Style me" button → a saved report read from the
// profile photo: colours that suit / to avoid (with why), fits and silhouettes
// to wear / avoid, necklines, lengths and patterns, archetype + 3 outfit ideas.
// "Refresh analysis" reruns it (e.g. after a new photo).

const SERIF = '"Alta", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif'
const ON_DARK        = Colors.textOnDark
const ON_DARK_MUTED  = 'rgba(250,248,245,0.62)'
const ON_DARK_FAINT  = 'rgba(250,248,245,0.42)'
const ON_DARK_BODY   = 'rgba(250,248,245,0.80)'

function useBreathingShimmer() {
  const anim = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 3800, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        Animated.timing(anim, { toValue: 0, duration: 3800, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      ]),
    ).start()
  }, [anim])
  return anim
}

function GoldButton({ label, icon, loading, onPress }: { label: string; icon: IconName; loading: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[s.goldBtn, loading && s.goldBtnDisabled]} onPress={onPress} disabled={loading} activeOpacity={0.85}>
      {loading
        ? <ActivityIndicator color={Colors.secondary} />
        : <View style={s.goldRow}><Icon name={icon} size={20} color={Colors.secondary} /><Text style={s.goldText}>{label}</Text></View>}
    </TouchableOpacity>
  )
}

function SwatchList({ colors, faded }: { colors: ColorSwatch[]; faded?: boolean }) {
  return (
    <View style={s.swatchGrid}>
      {colors.map((c) => (
        <View key={c.name} style={s.swatchItem}>
          <View style={[s.swatchDot, faded && s.swatchDotAvoid, { backgroundColor: c.hex }]} />
          <View style={{ flex: 1 }}>
            <Text style={s.swatchName}>{c.name}</Text>
            {!!c.why && <Text style={s.swatchWhy}>{c.why}</Text>}
          </View>
        </View>
      ))}
    </View>
  )
}

function Bullets({ items }: { items?: string[] }) {
  if (!items?.length) return null
  return (
    <View style={s.bulletList}>
      {items.map((it, i) => (
        <View key={i} style={s.bulletRow}>
          <View style={s.bulletDot} />
          <Text style={s.bulletText}>{it}</Text>
        </View>
      ))}
    </View>
  )
}

const LOADING_LINES = ['Reading your colouring…', 'Studying your proportions…', 'Building your palette…', 'Styling three looks…']

export default function StyleScreen() {
  const profile = useProfileStore()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [line, setLine] = useState(0)

  const breathe = useBreathingShimmer()
  const ringOpacity = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.30] })
  const ringScale   = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1.03] })

  useEffect(() => {
    if (!loading) { setLine(0); return }
    const t = setInterval(() => setLine((i) => (i + 1) % LOADING_LINES.length), 2400)
    return () => clearInterval(t)
  }, [loading])

  const report = profile.styleReport
  const hasPhoto = !!profile.photoUri

  async function readPhoto(): Promise<string> {
    const uri = profile.photoUri!
    if (uri.startsWith('data:')) return uri
    if (Platform.OS === 'web') {
      const blob = await (await fetch(uri)).blob()
      return new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(blob)
      })
    }
    const raw = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
    return `data:image/jpeg;base64,${raw}`
  }

  async function styleMe() {
    if (!hasPhoto || loading) return
    setLoading(true)
    setError(null)
    try {
      const photoBase64 = await readPhoto()
      const [color, style] = await Promise.all([
        fetchColorAnalysis(photoBase64),
        fetchStyleAnalysis({ photoBase64, measurements: profile.measurements ?? undefined }),
      ])
      const next: StyleReport = { color, style, createdAt: new Date().toISOString() }
      profile.setStyleReport(next)
      const { data } = await supabase.auth.getSession()
      const user = data.session?.user
      if (user) {
        upsertProfile(user.id, user.email ?? '', { styleReport: next, colorAnalysis: color })
          .catch((e) => console.warn('[Atelier] style report save failed:', e))
      }
    } catch (e: any) {
      setError(e?.message ?? 'The analysis failed — please try again.')
    } finally {
      setLoading(false)
    }
  }

  const style = report?.style
  const color = report?.color
  const narrativeLines = style?.narrative?.split('\n').filter(Boolean) ?? []

  return (
    <View style={s.page}>
      <SafeAreaView style={s.safe}>
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          <View style={s.column}>
            <Text style={s.pageHeading}>Your Style Report</Text>
            <Text style={s.pageSub}>Colours, cuts and looks that suit you — read from your photo.</Text>

            {!hasPhoto ? (
              <View style={s.emptyState}>
                <Icon name="profile" size={44} color={ON_DARK_FAINT} />
                <Text style={s.emptyTitle}>Add your photo first</Text>
                <Text style={s.emptySub}>Style me reads your colouring and proportions from a full-body photo.</Text>
                <TouchableOpacity style={s.outlineBtn} onPress={() => router.navigate('/(tabs)/profile')}>
                  <Text style={s.outlineBtnText}>Add your photo</Text>
                </TouchableOpacity>
              </View>
            ) : !report ? (
              <View style={s.hero}>
                <Animated.View style={[s.rings, { transform: [{ scale: ringScale }] }]} pointerEvents="none">
                  <Animated.View style={[s.ring, s.ring1, { opacity: ringOpacity }]} />
                  <Animated.View style={[s.ring, s.ring2, { opacity: ringOpacity }]} />
                  <Animated.View style={[s.ring, s.ring3, { opacity: ringOpacity }]} />
                </Animated.View>
                <View style={s.btnBlock}>
                  <Icon name="star" size={22} color={ON_DARK} style={s.sparkTR} />
                  <Icon name="star" size={16} color={ON_DARK} style={s.sparkBL} />
                  <GoldButton label="Style me" icon="reveal" loading={loading} onPress={styleMe} />
                </View>
                {loading && <Text style={s.loadingNote}>{LOADING_LINES[line]}</Text>}
                {error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}
              </View>
            ) : (
              <View style={s.refreshRow}>
                <Text style={s.reportDate}>
                  Report from {new Date(report.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                </Text>
                <GoldButton label="Refresh analysis" icon="refresh" loading={loading} onPress={styleMe} />
                {loading && <Text style={s.loadingNote}>{LOADING_LINES[line]}</Text>}
                {error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}
              </View>
            )}

            {style && (
              <View style={s.card}>
                <Text style={s.cardEyebrow}>YOUR STYLE ARCHETYPE</Text>
                <Text style={s.heading}>{style.archetype}</Text>
                {narrativeLines.map((l, i) => {
                  const dash = l.indexOf(' — ')
                  return (
                    <View key={i} style={s.narrativeLine}>
                      {dash > -1 && <Text style={s.narrativeLabel}>{l.slice(0, dash)}</Text>}
                      <Text style={s.body}>{dash > -1 ? l.slice(dash + 3) : l}</Text>
                    </View>
                  )
                })}
              </View>
            )}

            {color && (
              <View style={s.card}>
                <Text style={s.cardEyebrow}>COLOURS THAT SUIT YOU</Text>
                <Text style={s.heading}>{color.season}</Text>
                <Text style={s.subhead}>{color.undertone} undertone</Text>
                <Text style={s.body}>{color.narrative}</Text>
                <SwatchList colors={color.flatteringColors} />
                {color.avoid?.length > 0 && (
                  <>
                    <Text style={[s.sectionLabel, { marginTop: Space.md }]}>COLOURS TO AVOID</Text>
                    <SwatchList colors={color.avoid} faded />
                  </>
                )}
              </View>
            )}

            {style && (
              <View style={s.card}>
                <Text style={s.cardEyebrow}>FITS & SILHOUETTES</Text>
                <Text style={s.sectionLabel}>FLATTER YOU</Text>
                <Bullets items={style.silhouettes} />
                {!!style.silhouettesToAvoid?.length && (
                  <>
                    <Text style={[s.sectionLabel, { marginTop: Space.sm }]}>BEST AVOIDED</Text>
                    <Bullets items={style.silhouettesToAvoid} />
                  </>
                )}
              </View>
            )}

            {style && (style.necklines?.length || style.lengths?.length || style.patterns?.length) ? (
              <View style={s.card}>
                <Text style={s.cardEyebrow}>DETAILS FOR YOUR PROPORTIONS</Text>
                <View style={s.detailGrid}>
                  {!!style.necklines?.length && <View style={s.detailCol}><Text style={s.sectionLabel}>NECKLINES</Text><Bullets items={style.necklines} /></View>}
                  {!!style.lengths?.length && <View style={s.detailCol}><Text style={s.sectionLabel}>LENGTHS</Text><Bullets items={style.lengths} /></View>}
                  {!!style.patterns?.length && <View style={s.detailCol}><Text style={s.sectionLabel}>PATTERNS</Text><Bullets items={style.patterns} /></View>}
                </View>
              </View>
            ) : null}

            {!!style?.outfits?.length && (
              <View style={s.card}>
                <Text style={s.cardEyebrow}>3 OUTFIT IDEAS</Text>
                <View style={s.outfitGrid}>
                  {style.outfits.slice(0, 3).map((o, i) => (
                    <View key={i} style={s.outfit}>
                      <Text style={s.outfitNum}>{i + 1}</Text>
                      <Text style={s.outfitName}>{o.name}</Text>
                      <Text style={s.body}>{o.pieces}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {style && !!style.palettes?.length && (
              <View style={s.card}>
                <Text style={s.cardEyebrow}>YOUR PALETTE</Text>
                {style.palettes.map((p) => (
                  <View key={p.name} style={{ gap: Space.xs }}>
                    <Text style={s.paletteName}>{p.name}</Text>
                    <SwatchList colors={p.colors} />
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  )
}

const s = StyleSheet.create({
  page:   { flex: 1, backgroundColor: Colors.secondary },
  safe:   { flex: 1 },
  scroll: { padding: Space.base, paddingBottom: Space.xxl },
  column: { width: '100%', maxWidth: 760, alignSelf: 'center', gap: Space.md },

  pageHeading: { fontFamily: SERIF, fontSize: 30, fontWeight: '400', letterSpacing: 1, lineHeight: 40, color: ON_DARK, fontVariant: ['small-caps'] },
  pageSub:     { fontFamily: SERIF, fontSize: 14, lineHeight: 22, color: ON_DARK_MUTED },

  hero:  { minHeight: 400, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  rings: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  ring:  { position: 'absolute', borderWidth: 1, borderColor: Colors.primary, borderRadius: 9999 },
  ring1: { width: 190, height: 190 },
  ring2: { width: 290, height: 290 },
  ring3: { width: 390, height: 390 },
  btnBlock: { position: 'relative', alignItems: 'center' },
  sparkTR:  { position: 'absolute', top: -22, right: -18 },
  sparkBL:  { position: 'absolute', bottom: -18, left: -14 },

  goldBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.full, minHeight: 52,
    paddingVertical: 15, paddingHorizontal: Space.xl, alignItems: 'center', justifyContent: 'center', minWidth: 220,
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 18, elevation: 6,
  },
  goldBtnDisabled: { opacity: 0.7 },
  goldRow:  { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  goldText: { fontFamily: SERIF, fontSize: 16, fontWeight: '600', letterSpacing: 0.3, color: Colors.secondary },

  refreshRow:  { alignItems: 'center', gap: Space.sm, paddingVertical: Space.md },
  reportDate:  { ...Typography.caption, color: ON_DARK_FAINT },
  loadingNote: { ...Typography.caption, textAlign: 'center', color: ON_DARK_MUTED, marginTop: Space.md },
  errorBox:    { backgroundColor: 'rgba(185,60,42,0.15)', borderRadius: Radius.sm, padding: Space.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', marginTop: Space.md, alignSelf: 'stretch' },
  errorText:   { ...Typography.caption, color: '#F3C9C2', lineHeight: 19 },

  emptyState: { alignItems: 'center', paddingVertical: Space.xxl, gap: Space.md, minHeight: 360, justifyContent: 'center' },
  emptyTitle: { ...Typography.h3, color: ON_DARK },
  emptySub:   { ...Typography.bodySmall, color: ON_DARK_MUTED, lineHeight: 22, textAlign: 'center', maxWidth: 300 },
  outlineBtn: { borderWidth: 1.5, borderColor: Colors.primary, borderRadius: Radius.full, paddingHorizontal: Space.lg, paddingVertical: 12, marginTop: Space.sm },
  outlineBtnText: { ...Typography.body, color: Colors.primary, fontWeight: '600' },

  card: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: Radius.lg, borderWidth: 1, borderColor: 'rgba(250,248,245,0.10)', padding: Space.base, gap: Space.sm },
  cardEyebrow: { ...Typography.label, color: Colors.primary, letterSpacing: 2 },
  heading:     { fontFamily: SERIF, fontSize: 24, lineHeight: 30, color: ON_DARK },
  subhead:     { ...Typography.bodySmall, color: ON_DARK_MUTED, marginTop: -Space.xs, textTransform: 'capitalize' },
  body:        { fontFamily: SERIF, fontSize: 15, lineHeight: 22, color: ON_DARK_BODY },
  sectionLabel: { ...Typography.label, letterSpacing: 1.5, color: ON_DARK_FAINT },

  narrativeLine:  { gap: 2 },
  narrativeLabel: { ...Typography.label, color: Colors.primary, letterSpacing: 1 },

  swatchGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md, marginTop: Space.xs },
  swatchItem: { flexDirection: 'row', alignItems: 'center', gap: Space.md, flexBasis: 220, flexGrow: 1 },
  swatchDot:  { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(250,248,245,0.18)' },
  swatchDotAvoid: { opacity: 0.55 },
  swatchName: { ...Typography.bodySmall, color: ON_DARK, fontWeight: '600' },
  swatchWhy:  { ...Typography.caption, color: ON_DARK_MUTED, lineHeight: 16 },

  bulletList: { gap: Space.sm },
  bulletRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  bulletDot:  { width: 5, height: 5, borderRadius: 3, backgroundColor: Colors.primary, marginTop: 8 },
  bulletText: { flex: 1, ...Typography.bodySmall, color: ON_DARK_BODY, lineHeight: 20 },

  detailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.lg },
  detailCol:  { flexBasis: 200, flexGrow: 1, gap: Space.sm },

  outfitGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  outfit:     { flexBasis: 200, flexGrow: 1, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: Radius.md, padding: Space.md, gap: Space.xs },
  outfitNum:  { ...Typography.label, color: Colors.primary },
  outfitName: { fontFamily: SERIF, fontSize: 17, color: ON_DARK },

  paletteName: { ...Typography.caption, color: ON_DARK_MUTED, fontStyle: 'italic' },
})
