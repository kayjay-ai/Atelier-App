import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  View, Text, SectionList, ScrollView, TouchableOpacity, Pressable, Modal, StyleSheet, Animated, PanResponder,
  ActivityIndicator, useWindowDimensions,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import {
  deleteOwnerNotification, fetchOwnerNotifications, markAllOwnerNotificationsRead, setOwnerNotificationRead,
  type OwnerNotification, type OwnerNotificationCategory,
} from '../../../lib/api'
import { CATEGORY_META, fmtDate, fmtDateTime, inr, ownerErrorText, relativeTime, useOwnerStore } from '../../../lib/owner'
import { Colors, Typography, Space, Radius } from '../../../lib/theme'
import { Icon } from '../../../lib/ui'
import { Banner, Btn, Chip, RowMenu, Skeleton, toast, WIDE } from '../../../components/owner/kit'

// ─── Notifications: one feed of everything across the owner's stores ──────────

type Filter = 'all' | 'unread' | OwnerNotificationCategory
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'purchases', label: 'Purchases & credits' },
  { id: 'payments', label: 'Payments' },
  { id: 'store_activity', label: 'Store activity' },
  { id: 'deals', label: 'Deals & offers' },
  { id: 'gift_cards', label: 'Gift cards' },
  { id: 'account', label: 'Account' },
]

function groupOf(iso: string): string {
  const d = new Date(iso)
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const t = d.getTime()
  if (t >= start.getTime()) return 'Today'
  if (t >= start.getTime() - 86_400_000) return 'Yesterday'
  if (t >= start.getTime() - 6 * 86_400_000) return 'This week'
  return 'Earlier'
}

/** The message with the store name in bold. */
function Message({ n }: { n: OwnerNotification }) {
  const name = n.storeName
  const i = name ? n.body.indexOf(name) : -1
  if (!name || i < 0) return <Text style={x.body}>{n.body}</Text>
  return (
    <Text style={x.body}>
      {n.body.slice(0, i)}<Text style={x.bold}>{name}</Text>{n.body.slice(i + name.length)}
    </Text>
  )
}

/** Relative time; the full date and time while hovered (web). */
function When({ iso }: { iso: string }) {
  const [hover, setHover] = useState(false)
  return (
    <Pressable onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)} accessibilityLabel={fmtDateTime(iso)}>
      <Text style={x.when}>{hover ? fmtDateTime(iso) : relativeTime(iso)}</Text>
    </Pressable>
  )
}

/** Swipe left (touch) to reveal Mark as unread / Delete. */
function SwipeRow({ children, actions, enabled }: {
  children: ReactNode; actions: { label: string; onPress: () => void; danger?: boolean }[]; enabled: boolean
}) {
  const REVEAL = 168
  const dx = useRef(new Animated.Value(0)).current
  const openRef = useRef(false)
  const settle = (open: boolean) => {
    openRef.current = open
    Animated.spring(dx, { toValue: open ? -REVEAL : 0, useNativeDriver: false, bounciness: 0 }).start()
  }
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => enabled && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_e, g) => dx.setValue(Math.max(-REVEAL, Math.min(0, g.dx + (openRef.current ? -REVEAL : 0)))),
    onPanResponderRelease: (_e, g) => settle(g.dx + (openRef.current ? -REVEAL : 0) < -REVEAL / 2),
    onPanResponderTerminate: () => settle(openRef.current),
  }), [enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!enabled) return <>{children}</>
  return (
    <View style={{ overflow: 'hidden', borderRadius: Radius.md }}>
      <View style={x.swipeActions}>
        {actions.map((a) => (
          <TouchableOpacity key={a.label} style={[x.swipeBtn, a.danger && { backgroundColor: Colors.error }]}
            onPress={() => { settle(false); a.onPress() }} accessibilityRole="button">
            <Text style={x.swipeText}>{a.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Animated.View style={{ transform: [{ translateX: dx }] }} {...pan.panHandlers}>{children}</Animated.View>
    </View>
  )
}

export default function OwnerNotifications() {
  const { width } = useWindowDimensions()
  const wide = width >= WIDE
  const refreshUnread = useOwnerStore((s) => s.refreshUnread)
  const [filter, setFilter] = useState<Filter>('all')
  const [items, setItems] = useState<OwnerNotification[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<OwnerNotification | null>(null)
  const seq = useRef(0)

  const query = useCallback((c: string | null) => fetchOwnerNotifications({
    category: filter === 'all' || filter === 'unread' ? null : filter, unreadOnly: filter === 'unread', cursor: c,
  }), [filter])

  const loadFirst = useCallback(async (quiet = false) => {
    const mine = ++seq.current
    if (!quiet) setItems(null)
    try {
      const r = await query(null)
      if (mine !== seq.current) return
      // Keep pages already scrolled in when this is the 60-second refresh.
      setItems((prev) => {
        if (!quiet || !prev) return r.items
        const fresh = new Set(r.items.map((i) => i.id))
        return [...r.items, ...prev.filter((p) => !fresh.has(p.id) && Date.parse(p.createdAt) < Date.parse(r.items[r.items.length - 1]?.createdAt ?? '0'))]
      })
      if (!quiet) setCursor(r.nextCursor)
      setError(null)
    } catch (e) {
      if (mine === seq.current) { setError(ownerErrorText(e)); if (!quiet) setItems([]) }
    }
  }, [query])

  useFocusEffect(useCallback(() => {
    loadFirst()
    // New notifications arrive without a page refresh.
    const t = setInterval(() => { loadFirst(true); refreshUnread() }, 60_000)
    return () => clearInterval(t)
  }, [loadFirst, refreshUnread]))

  async function more() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await query(cursor)
      setItems((prev) => [...(prev ?? []), ...r.items.filter((i) => !(prev ?? []).some((p) => p.id === i.id))])
      setCursor(r.nextCursor)
    } catch (e) {
      toast(ownerErrorText(e), { tone: 'error' })
    } finally {
      setLoadingMore(false)
    }
  }

  const patch = (id: string, p: Partial<OwnerNotification> | null) =>
    setItems((prev) => (prev ?? []).flatMap((i) => (i.id !== id ? [i] : p ? [{ ...i, ...p }] : [])))

  async function setRead(n: OwnerNotification, read: boolean) {
    patch(n.id, { read })
    try { await setOwnerNotificationRead(n.id, read) } catch (e) { patch(n.id, { read: n.read }); toast(ownerErrorText(e), { tone: 'error' }) }
    refreshUnread()
  }
  async function remove(n: OwnerNotification) {
    patch(n.id, null)
    try { await deleteOwnerNotification(n.id) } catch (e) { toast(ownerErrorText(e), { tone: 'error' }); loadFirst(true) }
    refreshUnread()
  }
  async function readAll() {
    setItems((prev) => (prev ?? []).map((i) => ({ ...i, read: true })))
    try { await markAllOwnerNotificationsRead() } catch (e) { toast(ownerErrorText(e), { tone: 'error' }); loadFirst(true) }
    refreshUnread()
  }

  /** Tapping an item marks it read and opens what it is about. */
  function open(n: OwnerNotification) {
    if (!n.read) setRead(n, true)
    const l = n.link
    if (l?.screen === 'store' && l.storeId) router.navigate({ pathname: '/owner/home', params: { store: l.storeId, ...(l.section ? { section: l.section } : {}) } })
    else if (l?.screen === 'profile') router.navigate({ pathname: '/owner/profile', params: l.section ? { section: l.section } : {} })
    else if (l?.screen === 'add-store') router.navigate('/owner/add-store')
    else if (l?.screen === 'offer' || l?.screen === 'gift_card' || n.category === 'deals' || n.category === 'gift_cards') setDetail(n)
  }

  const sections = useMemo(() => {
    const out: { title: string; data: OwnerNotification[] }[] = []
    for (const n of items ?? []) {
      const g = groupOf(n.createdAt)
      const last = out[out.length - 1]
      if (last?.title === g) last.data.push(n)
      else out.push({ title: g, data: [n] })
    }
    return out
  }, [items])

  const renderItem = ({ item: n }: { item: OwnerNotification }) => {
    const meta = CATEGORY_META[n.category]
    const special = n.category === 'deals' || n.category === 'gift_cards'
    const menu = [
      { label: n.read ? 'Mark as unread' : 'Mark as read', icon: 'check' as const, onPress: () => setRead(n, !n.read) },
      { label: 'Delete', icon: 'trash' as const, danger: true, onPress: () => remove(n) },
    ]
    return (
      <View style={{ marginBottom: Space.sm }}>
        <SwipeRow enabled={!wide} actions={[
          { label: n.read ? 'Unread' : 'Read', onPress: () => setRead(n, !n.read) },
          { label: 'Delete', danger: true, onPress: () => remove(n) },
        ]}>
          <TouchableOpacity
            style={[x.item, special && x.special, !n.read && x.unread]} onPress={() => open(n)}
            accessibilityRole="button" accessibilityLabel={`${n.read ? '' : 'Unread. '}${meta.label}. ${n.body}`}
          >
            <View style={[x.dot, { opacity: n.read ? 0 : 1 }]} />
            <View style={[x.icon, special && { backgroundColor: Colors.secondary }]}>
              <Icon name={meta.icon} size={18} color={special ? Colors.textOnDark : Colors.secondary} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Message n={n} />
              <View style={x.metaRow}>
                <Text style={x.cat}>{meta.label}</Text>
                <Text style={x.when}> · </Text>
                <When iso={n.createdAt} />
              </View>
              {special && (
                <View style={x.specialFoot}>
                  {!!n.data?.expiresAt && <Text style={x.expiry}>Valid until {fmtDate(n.data.expiresAt)}</Text>}
                  <Btn small kind="secondary" label={n.category === 'gift_cards' ? 'View gift card' : (n.data?.cta || 'View offer')} onPress={() => open(n)} />
                </View>
              )}
            </View>
            <RowMenu items={menu} label="Notification actions" />
          </TouchableOpacity>
        </SwipeRow>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <View style={[x.head, wide && x.headWide]}>
        <View style={x.titleRow}>
          <Text style={x.title} accessibilityRole="header">Notifications</Text>
          <Btn small kind="secondary" icon="check" label="Mark all as read" onPress={readAll} disabled={!items?.some((i) => !i.read)} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Space.sm }}>
          {FILTERS.map((f) => <Chip key={f.id} label={f.label} selected={filter === f.id} onPress={() => setFilter(f.id)} />)}
        </ScrollView>
        {error && <Banner text={error} actionLabel="Retry" onAction={() => loadFirst()} />}
      </View>

      {items === null ? (
        <View style={[x.list, wide && x.listWide, { gap: Space.sm }]}>
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={64} radius={Radius.md} />)}
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(n) => n.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => <Text style={x.group}>{section.title.toUpperCase()}</Text>}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={[x.list, wide && x.listWide]}
          onEndReached={more}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={(
            <View style={x.empty}>
              <Icon name="bell" size={32} color={Colors.primary} />
              <Text style={x.emptyText}>
                {filter === 'all'
                  ? 'You’re all caught up. Store purchases, offers and updates will show up here.'
                  : 'Nothing here for this filter.'}
              </Text>
            </View>
          )}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={Colors.primary} style={{ margin: Space.lg }} /> : null}
        />
      )}

      {/* Offer / gift card detail */}
      <Modal transparent visible={!!detail} animationType="fade" onRequestClose={() => setDetail(null)}>
        <View style={x.scrim}>
          {detail && (
            <View style={x.dialog}>
              <View style={[x.icon, { backgroundColor: Colors.secondary, alignSelf: 'flex-start' }]}>
                <Icon name={CATEGORY_META[detail.category].icon} size={20} color={Colors.textOnDark} />
              </View>
              <Text style={x.dialogTitle}>{detail.title}</Text>
              <Text style={x.body}>{detail.body}</Text>
              {detail.data?.amountInr != null && <Text style={x.big}>{inr(detail.data.amountInr)}</Text>}
              {!!detail.data?.code && (
                <View style={x.code}><Text style={x.codeText} selectable>{detail.data.code}</Text></View>
              )}
              {!!detail.data?.expiresAt && <Text style={x.expiry}>Valid until {fmtDate(detail.data.expiresAt)}</Text>}
              <Text style={x.when}>Received {fmtDateTime(detail.createdAt)}</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: Space.md }}>
                <Btn small label="Close" onPress={() => setDetail(null)} />
              </View>
            </View>
          )}
        </View>
      </Modal>
    </View>
  )
}

const x = StyleSheet.create({
  head: { padding: Space.base, paddingTop: Space.lg, gap: Space.md },
  headWide: { paddingHorizontal: Space.xl, maxWidth: 900, width: '100%' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Space.md, flexWrap: 'wrap' },
  title: { ...Typography.h1 },
  list: { paddingHorizontal: Space.base, paddingBottom: Space.xxl },
  listWide: { paddingHorizontal: Space.xl, maxWidth: 900, width: '100%' },
  group: { ...Typography.label, marginTop: Space.base, marginBottom: Space.sm },
  item: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Space.md, padding: Space.md,
    backgroundColor: Colors.bgCard, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderSubtle,
  },
  unread: { borderColor: Colors.primaryLight },
  special: { backgroundColor: Colors.primarySubtle, borderColor: Colors.primary },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.error, marginTop: 14, marginLeft: -4 },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.bgSubtle, alignItems: 'center', justifyContent: 'center' },
  body: { ...Typography.bodySmall, lineHeight: 20 },
  bold: { fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  cat: { ...Typography.caption, color: Colors.textMuted },
  when: { ...Typography.caption, color: Colors.textFaint },
  specialFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Space.sm, marginTop: Space.sm, flexWrap: 'wrap' },
  expiry: { ...Typography.caption, color: Colors.warning, fontWeight: '700' },
  swipeActions: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'flex-end' },
  swipeBtn: { width: 84, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.secondary },
  swipeText: { ...Typography.caption, color: Colors.textOnDark, fontWeight: '700' },
  empty: { alignItems: 'center', gap: Space.md, padding: Space.xxl },
  emptyText: { ...Typography.body, color: Colors.textMuted, textAlign: 'center', maxWidth: 360 },
  scrim: { flex: 1, backgroundColor: 'rgba(42,39,37,0.45)', alignItems: 'center', justifyContent: 'center', padding: Space.base },
  dialog: { width: '100%', maxWidth: 420, backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, gap: Space.sm },
  dialogTitle: { ...Typography.h2 },
  big: { ...Typography.h1 },
  code: { backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, padding: Space.md, alignItems: 'center' },
  codeText: { ...Typography.h3, letterSpacing: 2 },
})
