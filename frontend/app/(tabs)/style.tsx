import { useState, useRef, useEffect } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Animated, Easing, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { useProfileStore } from '../../lib/store'
import { fetchColorAnalysis, fetchStyleAnalysis } from '../../lib/api'
import { supabase } from '../../lib/supabaseClient'
import { upsertProfile } from '../../lib/supabaseStorage'
import { imageToDataUri } from '../../lib/dataUri'
import { isFallback, isRetryable } from '../../lib/aiOutcome'
import { Colors, Typography, Space, Radius, Weight, FONT_DISPLAY, Shadow } from '../../lib/theme'
import { EmptyState, Icon, Notice, Page, PillButton, Title, displayProps, useReducedMotion } from '../../lib/ui'
import type { ColorSwatch, StyleReport } from '../../lib/types'

// Style tab (spec §3.4, docs/design/4.svg + 5.svg): one "Reveal My Style"
// button on the charcoal stage → a saved report read from the profile photo,
// in white cards: colours that suit / to avoid (with why), fits and
// silhouettes to wear / avoid, necklines, lengths and patterns, archetype +
// 3 outfit ideas. "Refresh My Style" reruns it (e.g. after a new photo).

// The rings behind the button breathe slowly — the one ambient motion in the
// app, and still for anyone who asked their device for less motion.
function useBreathingShimmer() {
  const reduced = useReducedMotion()
  const anim = useRef(new Animated.Value(0.5)).current
  useEffect(() => {
    if (reduced) return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 3800, easing: Easing.inOut(Easing.sin), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(anim, { toValue: 0, duration: 3800, easing: Easing.inOut(Easing.sin), useNativeDriver: Platform.OS !== 'web' }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [anim, reduced])
  return anim
}

/** Colour circles with their names underneath (docs/design/5.svg). */
function SwatchList({ colors, faded }: { colors: ColorSwatch[]; faded?: boolean }) {
  return (
    <View style={s.swatchGrid}>
      {colors.map((c) => (
        <View key={c.name} style={s.swatchItem} accessible accessibilityLabel={`${c.name}${c.why ? `. ${c.why}` : ''}`}>
          <View style={[s.swatchDot, { backgroundColor: c.hex }, faded && s.swatchDotAvoid]} />
          <Text style={s.swatchName}>{c.name}</Text>
          {!!c.why && <Text style={s.swatchWhy}>{c.why}</Text>}
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
          <Text style={s.body}>{it}</Text>
        </View>
      ))}
    </View>
  )
}

/** One white report card: a small label, then an optional display heading. */
function ReportCard({ label, heading, children }: { label: string; heading?: string; children: React.ReactNode }) {
  return (
    <View style={s.card}>
      <View style={{ gap: Space.xs }}>
        <Text style={s.cardLabel}>{label}</Text>
        {!!heading && <Text {...displayProps(30)} style={s.heading} accessibilityRole="header">{heading.toUpperCase()}</Text>}
      </View>
      {children}
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

  const readPhoto = () => imageToDataUri(profile.photoUri!)

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
      // A stand-in report (stylist unavailable) is never saved as the user's style.
      if (isFallback(color) || isFallback(style)) {
        setError(isRetryable(color) || isRetryable(style)
          ? 'The stylist is busy — please try again in a moment.'
          : 'Style analysis isn’t available right now — please try again later.')
        return
      }
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
  const hasDetails = !!(style && (style.necklines?.length || style.lengths?.length || style.patterns?.length))

  return (
    <Page tone="dark" width="reading" gap={Space.lg}>
      <View style={{ gap: Space.md }}>
        <Title tone="light" size="display">Reveal Your Style</Title>
        <Text style={s.pageSub}>Colours, cuts and looks that suit you — read from your photo.</Text>
      </View>

      {!hasPhoto ? (
        <EmptyState
          tone="dark" icon="profile" title="Add your photo first"
          body="Your Style report reads your colouring and proportions from a full-length photo."
          action={{ label: 'Add your photo', icon: 'takePhoto', onPress: () => router.navigate('/(tabs)/profile') }}
          style={{ minHeight: 380, justifyContent: 'center' }}
        />
      ) : !report ? (
        <View style={s.hero}>
          <Animated.View style={[s.rings, { transform: [{ scale: ringScale }], pointerEvents: 'none' }]}>
            <Animated.View style={[s.ring, s.ring1, { opacity: ringOpacity }]} />
            <Animated.View style={[s.ring, s.ring2, { opacity: ringOpacity }]} />
            <Animated.View style={[s.ring, s.ring3, { opacity: ringOpacity }]} />
            <Animated.View style={[s.ring, s.ring4, { opacity: ringOpacity }]} />
          </Animated.View>
          <View style={s.btnBlock}>
            <Icon name="star" size={24} color={Colors.textOnDark} style={s.sparkTR} />
            <Icon name="star" size={18} color={Colors.textOnDark} style={s.sparkBL} />
            <PillButton label="Reveal My Style" icon="style" variant="gold" size="lg" loading={loading} onPress={styleMe} style={s.revealBtn} />
          </View>
          {loading && <Text style={s.loadingNote} accessibilityLiveRegion="polite">{LOADING_LINES[line]}</Text>}
          {error && <Notice tone="error" text={error} style={s.notice} />}
        </View>
      ) : (
        <View style={s.refreshRow}>
          <PillButton label="Refresh My Style" icon="style" variant="gold" size="md" loading={loading} onPress={styleMe} />
          <Text style={s.reportDate}>
            From {new Date(report.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
          </Text>
          {loading && <Text style={s.loadingNote} accessibilityLiveRegion="polite">{LOADING_LINES[line]}</Text>}
          {error && <Notice tone="error" text={error} style={s.notice} />}
        </View>
      )}

      {color && (
        <ReportCard label="COLOUR ANALYSIS" heading={color.season}>
          <Text style={s.subhead}>{color.undertone} undertone</Text>
          <Text style={s.body}>{color.narrative}</Text>
          <Text style={s.sectionLabel}>YOUR PALETTE</Text>
          <SwatchList colors={color.flatteringColors} />
          {color.avoid?.length > 0 && (
            <>
              <Text style={s.sectionLabel}>AVOID</Text>
              <SwatchList colors={color.avoid} faded />
            </>
          )}
          {!!style?.palettes?.length && style.palettes.map((p) => (
            <View key={p.name} style={{ gap: Space.sm }}>
              <Text style={s.sectionLabel}>{p.name.toUpperCase()}</Text>
              <SwatchList colors={p.colors} />
            </View>
          ))}
        </ReportCard>
      )}

      {style && (
        <ReportCard label="STYLE GUIDE" heading={style.archetype}>
          {narrativeLines.map((l, i) => {
            const dash = l.indexOf(' — ')
            return (
              <View key={i} style={{ gap: 2 }}>
                {dash > -1 && <Text style={s.narrativeLabel}>{l.slice(0, dash)}</Text>}
                <Text style={s.body}>{dash > -1 ? l.slice(dash + 3) : l}</Text>
              </View>
            )
          })}
          <View style={s.divider} />
          <View style={s.twoCol}>
            <View style={s.col}>
              <Text style={s.sectionLabel}>WEAR</Text>
              <Bullets items={style.silhouettes} />
            </View>
            {!!style.silhouettesToAvoid?.length && (
              <View style={s.col}>
                <Text style={s.sectionLabel}>BEST AVOIDED</Text>
                <Bullets items={style.silhouettesToAvoid} />
              </View>
            )}
          </View>
          {hasDetails && (
            <>
              <View style={s.divider} />
              <View style={s.twoCol}>
                {!!style.necklines?.length && <View style={s.col}><Text style={s.sectionLabel}>NECKLINES</Text><Bullets items={style.necklines} /></View>}
                {!!style.lengths?.length && <View style={s.col}><Text style={s.sectionLabel}>LENGTHS</Text><Bullets items={style.lengths} /></View>}
                {!!style.patterns?.length && <View style={s.col}><Text style={s.sectionLabel}>PATTERNS</Text><Bullets items={style.patterns} /></View>}
              </View>
            </>
          )}
        </ReportCard>
      )}

      {!!style?.outfits?.length && (
        <ReportCard label="THREE LOOKS FOR YOU">
          <View style={s.outfitGrid}>
            {style.outfits.slice(0, 3).map((o, i) => (
              <View key={i} style={s.outfit}>
                <Text {...displayProps(20)} style={s.outfitName}>{o.name}</Text>
                <Text style={s.bodySmall}>{o.pieces}</Text>
              </View>
            ))}
          </View>
        </ReportCard>
      )}
    </Page>
  )
}

const s = StyleSheet.create({
  pageSub: { ...Typography.body, fontSize: 16, lineHeight: 25, color: Colors.textOnDarkMuted },

  hero:  { minHeight: 440, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  rings: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  ring:  { position: 'absolute', borderWidth: 1.5, borderColor: Colors.primary, borderRadius: 9999 },
  ring1: { width: 200, height: 200 },
  ring2: { width: 290, height: 290, opacity: 0.8 },
  ring3: { width: 380, height: 380, opacity: 0.6 },
  ring4: { width: 470, height: 470, opacity: 0.4 },
  btnBlock:  { position: 'relative', alignItems: 'center' },
  revealBtn: { minWidth: 260, ...Shadow.pop },
  sparkTR:   { position: 'absolute', top: -26, right: -20 },
  sparkBL:   { position: 'absolute', bottom: -22, left: -18 },
  loadingNote: { ...Typography.bodySmall, textAlign: 'center', color: Colors.textOnDarkMuted, marginTop: Space.xl },
  notice:      { marginTop: Space.lg, alignSelf: 'stretch' },

  refreshRow: { alignItems: 'flex-start', gap: Space.sm },
  reportDate: { ...Typography.caption, color: Colors.textOnDarkMuted },

  card:      { backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, gap: Space.base },
  cardLabel: { ...Typography.label, color: Colors.text },
  heading:   { fontFamily: FONT_DISPLAY, fontSize: 34, lineHeight: 40, letterSpacing: 1, color: Colors.text },
  subhead:   { ...Typography.bodySmall, ...Weight.medium, color: Colors.accentInk, textTransform: 'capitalize', marginTop: -Space.sm },
  body:      { ...Typography.body, flex: 1 },
  bodySmall: { ...Typography.bodySmall, color: Colors.textMuted },
  sectionLabel:   { ...Typography.label, color: Colors.text, marginTop: Space.sm },
  narrativeLabel: { ...Typography.label, color: Colors.accentInk },
  divider:   { height: 1.5, backgroundColor: Colors.primary, opacity: 0.6, marginVertical: Space.xs },

  swatchGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: Space.base, columnGap: Space.sm },
  swatchItem: { flexBasis: 76, flexGrow: 1, maxWidth: 140, alignItems: 'center', gap: 6 },
  swatchDot:  { width: 60, height: 60, borderRadius: 30, borderWidth: 1, borderColor: 'rgba(66,61,58,0.15)' },
  swatchDotAvoid: { opacity: 0.85 },
  swatchName: { ...Typography.bodySmall, textAlign: 'center' },
  swatchWhy:  { ...Typography.caption, fontSize: 11, lineHeight: 15, textAlign: 'center' },

  bulletList: { gap: Space.sm },
  bulletRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  bulletDot:  { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.primary, marginTop: 9 },

  twoCol: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.lg },
  col:    { flexBasis: 220, flexGrow: 1, gap: Space.sm },

  outfitGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  outfit:     { flexBasis: 180, flexGrow: 1, backgroundColor: Colors.bgSubtle, borderRadius: Radius.lg, padding: Space.base, gap: Space.xs },
  outfitName: { fontFamily: FONT_DISPLAY, fontSize: 20, lineHeight: 26, color: Colors.text },
})
