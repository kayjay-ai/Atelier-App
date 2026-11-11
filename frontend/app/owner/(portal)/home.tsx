import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, ScrollView, TouchableOpacity, Pressable, StyleSheet, useWindowDimensions } from 'react-native'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import {
  fetchOwnerStores, fetchOwnerSummary,
  type OwnerSortKey, type OwnerStorePage, type OwnerStoreRow, type OwnerSummary,
} from '../../../lib/api'
import { fmtDate, num, ownerErrorText, preActive, STATUS_META, STATUS_ORDER, useOwnerStore } from '../../../lib/owner'
import { Colors, Typography, Space, Radius, Weight, Layout, Shadow } from '../../../lib/theme'
import { Card, EmptyState, Icon, PageHeader, type IconName } from '../../../lib/ui'
import type { MenuItem } from '../../../components/owner/kit'

/** Every row menu starts with View details, so the drawer is reachable from the keyboard. */
const withDetails = (items: MenuItem[], open: () => void): MenuItem[] =>
  items.some((i) => i.label === 'View details') ? items : [{ label: 'View details', icon: 'info', onPress: open }, ...items]
import { Banner, Btn, Chip, RowMenu, Skeleton, StatusPill, WIDE } from '../../../components/owner/kit'
import { StoreDrawer, type DrawerSection } from '../../../components/owner/StoreDrawer'
import { storeMenu, storeActions } from '../../../components/owner/storeActions'

// ─── Home: summary cards + every store the owner has invited ──────────────────

type Query = { search: string; status: string[]; sort: OwnerSortKey | null; dir: 'asc' | 'desc'; page: number }
const EMPTY: Query = { search: '', status: [], sort: null, dir: 'desc', page: 1 }
const LIVE = ['active', 'low_credits']

const COLUMNS: { key: OwnerSortKey | null; label: string; flex: number; align?: 'right' }[] = [
  { key: 'name', label: 'Store', flex: 1.5 },
  { key: 'location', label: 'Location', flex: 1.1 },
  { key: 'manager', label: 'Manager email', flex: 1.6 },
  { key: 'status', label: 'Status', flex: 1.1 },
  { key: 'devices', label: 'Devices', flex: 0.7, align: 'right' },
  { key: 'package', label: 'Package', flex: 0.9 },
  { key: 'credits', label: 'Credits used / total', flex: 1.4 },
  { key: 'lastPayment', label: 'Last payment', flex: 1 },
]
const TEXT_SORTS: OwnerSortKey[] = ['name', 'location', 'manager', 'status', 'package']
const SORT_LABEL: Record<OwnerSortKey, string> = {
  name: 'Store name', location: 'Location', manager: 'Manager email', status: 'Status', devices: 'Devices',
  package: 'Package', credits: 'Credits used', lastPayment: 'Last payment', created: 'Newest',
}

function breakdown(s: OwnerSummary): string {
  const parts: [number, string][] = [
    [s.byStatus.active + s.byStatus.low_credits, 'active'],
    [s.byStatus.invited, 'invited'],
    [s.byStatus.pending, 'pending'],
    [s.byStatus.expired, 'expired'],
    [s.byStatus.invite_expired, 'invite expired'],
    [s.byStatus.deactivated, 'deactivated'],
  ]
  const shown = parts.filter(([n]) => n > 0).map(([n, l]) => `${n} ${l}`)
  return shown.length ? shown.join(' · ') : 'No stores yet'
}

function SummaryCard({ icon, label, value, sub, active, onPress, tone }: {
  icon: IconName; label: string; value: string; sub: string; active?: boolean; onPress: () => void; tone?: 'warning'
}) {
  return (
    <TouchableOpacity
      style={[h.card, active && h.cardOn]} onPress={onPress} accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}. ${sub}`} accessibilityState={{ selected: !!active }}
    >
      <View style={h.cardHead}>
        <Text style={h.cardLabel}>{label.toUpperCase()}</Text>
        <Icon name={icon} size={18} color={tone === 'warning' ? Colors.warning : Colors.primary} />
      </View>
      <Text style={[h.cardValue, tone === 'warning' && { color: Colors.warning }]}>{value}</Text>
      <Text style={h.cardSub} numberOfLines={2}>{sub}</Text>
    </TouchableOpacity>
  )
}

function CreditsBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  return (
    <View style={{ gap: 4 }}>
      <Text style={h.cell}>{num(used)} / {num(total)}</Text>
      <View style={h.track} accessibilityLabel={`${pct}% used`}>
        <View style={[h.fill, { width: `${pct}%` }, pct >= 90 && { backgroundColor: Colors.warning }]} />
      </View>
    </View>
  )
}

const Dash = () => <Text style={h.cellMuted}>—</Text>

function StatusCell({ row, onResend }: { row: OwnerStoreRow; onResend: () => void }) {
  return (
    <View style={{ gap: 4 }}>
      <StatusPill status={row.status} />
      {row.emailNotDelivered && (
        <TouchableOpacity onPress={onResend} accessibilityRole="button">
          <Text style={h.flag}>Email not delivered — Resend</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

export default function OwnerHome() {
  const { width } = useWindowDimensions()
  const wide = width >= WIDE
  const params = useLocalSearchParams<{ store?: string; section?: string }>()
  const orgName = useOwnerStore((s) => s.me?.organization.name ?? '')
  const [query, setQuery] = useState<Query>(EMPTY)
  const [searchText, setSearchText] = useState('')
  const [summary, setSummary] = useState<OwnerSummary | null>(null)
  const [page, setPage] = useState<OwnerStorePage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ id: string; section: DrawerSection | null } | null>(null)
  const seq = useRef(0)

  const load = useCallback(async (q: Query) => {
    const mine = ++seq.current
    setLoading(true)
    try {
      const [s, p] = await Promise.all([fetchOwnerSummary(), fetchOwnerStores(q)])
      if (mine !== seq.current) return
      setSummary(s); setPage(p); setError(null)
    } catch (e) {
      if (mine === seq.current) setError(ownerErrorText(e)) // the last loaded data stays on screen
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  // On focus, and again whenever the query changes while this tab is open.
  useFocusEffect(useCallback(() => { load(query) }, [query, load]))

  // Search as you type (debounced).
  useEffect(() => {
    if (searchText === query.search) return
    const t = setTimeout(() => setQuery((q) => ({ ...q, search: searchText, page: 1 })), 300)
    return () => clearTimeout(t)
  }, [searchText, query.search])

  // From a notification: /owner/home?store=ID&section=credits
  useEffect(() => {
    if (!params.store) return
    const section = ['devices', 'credits', 'payments'].includes(params.section ?? '') ? params.section as DrawerSection : null
    setDrawer({ id: params.store, section })
    router.setParams({ store: undefined, section: undefined })
  }, [params.store, params.section])

  const reload = () => load(query)
  const set = (patch: Partial<Query>) => setQuery((q) => ({ ...q, page: 1, ...patch }))
  const clearAll = () => { setSearchText(''); setQuery(EMPTY) }
  const toggleStatus = (s: string) => set({ status: query.status.includes(s) ? query.status.filter((x) => x !== s) : [...query.status, s] })
  const sortBy = (key: OwnerSortKey) => {
    if (query.sort === key) set({ dir: query.dir === 'asc' ? 'desc' : 'asc' })
    else set({ sort: key, dir: TEXT_SORTS.includes(key) ? 'asc' : 'desc' })
  }
  const filtered = !!(query.search || query.status.length)
  const onlyStatus = (...wanted: string[]) =>
    query.status.length === wanted.length && wanted.every((s) => query.status.includes(s))
  const selectedCard: 'all' | 'devices' | 'credits' | 'attention' | null =
    query.search ? null
      : !query.status.length && !query.sort ? 'all'
        : !query.sort && onlyStatus(...LIVE) ? 'devices'
          : query.sort === 'credits' && !query.status.length ? 'credits'
            : !query.sort && onlyStatus('attention') ? 'attention'
              : null
  const showCard = (patch: Partial<Query>) => { setSearchText(''); setQuery({ ...EMPTY, ...patch }) }
  const firstLoad = loading && !page
  const noStores = summary?.totalStores === 0 && !filtered

  const sortItems = [
    { label: 'Needs attention first', onPress: () => set({ sort: null, dir: 'desc' }) },
    ...(['name', 'status', 'credits', 'devices', 'lastPayment', 'created'] as OwnerSortKey[]).map((k) => ({
      label: SORT_LABEL[k], onPress: () => set({ sort: k, dir: TEXT_SORTS.includes(k) ? 'asc' : 'desc' }),
    })),
  ]

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <ScrollView contentContainerStyle={[h.page, wide && h.pageWide]} keyboardShouldPersistTaps="handled">
        <PageHeader
          title="Home"
          subtitle={orgName ? `Every ${orgName} store: status, devices, credits and payments.` : 'Status, devices, credits and payments for every store.'}
          actions={<Btn icon="storePlus" label="Add store" onPress={() => router.navigate('/owner/add-store')} />}
        />

        {error && <Banner text={error} actionLabel="Retry" onAction={reload} />}

        {/* Summary cards */}
        <View style={[h.cards, wide && { flexWrap: 'nowrap' }]}>
          {!summary ? Array.from({ length: 4 }, (_, i) => (
            <View key={i} style={[h.card, { gap: Space.sm }]}>
              <Skeleton width="50%" height={10} /><Skeleton width="40%" height={28} /><Skeleton width="80%" height={10} />
            </View>
          )) : (
            <>
              <SummaryCard icon="company" label="Total stores" value={num(summary.totalStores)} sub={breakdown(summary)}
                active={selectedCard === 'all'} onPress={clearAll} />
              <SummaryCard icon="devices" label="Connected devices" value={num(summary.connectedDevices)} sub="Across active stores"
                active={selectedCard === 'devices'} onPress={() => showCard({ status: LIVE })} />
              <SummaryCard icon="credits" label="Credits used this month" value={num(summary.creditsUsedThisMonth)}
                sub={`${summary.creditsUsedPct}% of purchased credits`} active={selectedCard === 'credits'}
                onPress={() => showCard({ sort: 'credits', dir: 'desc' })} />
              <SummaryCard icon="alert" label="Needs attention" value={num(summary.needsAttention)}
                sub="Low credits, expired invites or overdue renewals" tone={summary.needsAttention > 0 ? 'warning' : undefined}
                active={selectedCard === 'attention'} onPress={() => showCard({ status: ['attention'] })} />
            </>
          )}
        </View>

        {noStores ? (
          <Card>
            <EmptyState icon="storePlus" title="Your first store is one invite away"
              body="Add a store and invite its manager. It shows up here straight away, with its devices, credits and payments."
              action={{ label: 'Add your first store', icon: 'storePlus', onPress: () => router.navigate('/owner/add-store') }} />
          </Card>
        ) : (
          <View style={h.tableCard}>
            {/* Toolbar: search, status filter, sort */}
            <View style={h.toolbar}>
              <View style={h.search}>
                <Icon name="search" size={18} color={Colors.textMuted} />
                <TextInput
                  value={searchText} onChangeText={setSearchText} placeholder="Search by store, location or manager email"
                  placeholderTextColor={Colors.textFaint} style={h.searchInput} accessibilityLabel="Search stores"
                  autoCapitalize="none" autoCorrect={false}
                />
                {!!searchText && (
                  <TouchableOpacity onPress={() => setSearchText('')} accessibilityLabel="Clear search" hitSlop={8}>
                    <Icon name="close" size={16} color={Colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
              {!wide && <RowMenu items={sortItems} label="Sort stores" triggerLabel={`Sort: ${query.sort ? SORT_LABEL[query.sort] : 'Needs attention'}`} />}
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={h.chips}>
              <Chip label="Needs attention" icon="alert" selected={query.status.includes('attention')} onPress={() => toggleStatus('attention')} />
              {STATUS_ORDER.map((s) => (
                <Chip key={s} label={STATUS_META[s].label} selected={query.status.includes(s)} onPress={() => toggleStatus(s)} />
              ))}
              {filtered && <Chip label="Clear filters" icon="close" onPress={clearAll} />}
            </ScrollView>

            <Text style={h.count}>
              {page ? `${num(page.total)} store${page.total === 1 ? '' : 's'}${filtered ? ' match' : ''}` : ' '}
            </Text>

            {firstLoad ? (
              <View style={{ gap: Space.md, padding: Space.base }}>
                {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={wide ? 22 : 86} />)}
              </View>
            ) : page && page.stores.length === 0 ? (
              <EmptyState icon="filter" title="No stores match these filters" body="Try another status, or clear the search."
                secondary={{ label: 'Clear filters', onPress: clearAll }} />
            ) : page && wide ? (
              <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ flexGrow: 1 }}>
                <View style={{ minWidth: 880, flex: 1 }}>
                  <View style={[h.tr, h.thead]}>
                    {COLUMNS.map((c) => {
                      const on = c.key !== null && query.sort === c.key
                      return (
                        <TouchableOpacity
                          key={c.label} style={[h.th, { flex: c.flex }]} disabled={!c.key} onPress={() => c.key && sortBy(c.key)}
                          accessibilityRole="button" accessibilityLabel={`Sort by ${c.label}`}
                        >
                          <Text style={[h.thText, on && { color: Colors.secondary }, c.align === 'right' && { textAlign: 'right', flex: 1 }]}>{c.label.toUpperCase()}</Text>
                          {on && <Icon name={query.dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} color={Colors.secondary} />}
                        </TouchableOpacity>
                      )
                    })}
                    <View style={{ width: 40 }} />
                  </View>
                  {page.stores.map((r) => {
                    const early = preActive(r.status)
                    const open = () => setDrawer({ id: r.id, section: null })
                    return (
                      <Pressable key={r.id} style={(st: any) => [h.tr, st.hovered && h.trHover, loading && { opacity: 0.6 }]} onPress={open} focusable={false}>
                        <View style={[h.td, { flex: 1.5 }]}>
                          <TouchableOpacity onPress={open} accessibilityRole="button" accessibilityLabel={`${r.name}, ${STATUS_META[r.status].label}. Open details`}>
                            <Text style={h.cellStrong} numberOfLines={1}>{r.name}</Text>
                          </TouchableOpacity>
                          <Text style={h.cellMuted}>{r.id}</Text>
                        </View>
                        <View style={[h.td, { flex: 1.1 }]}><Text style={h.cell} numberOfLines={2}>{r.location || '—'}</Text></View>
                        <View style={[h.td, { flex: 1.6 }]}><Text style={h.cell} numberOfLines={1}>{r.managerEmail || '—'}</Text></View>
                        <View style={[h.td, { flex: 1.1 }]}><StatusCell row={r} onResend={() => storeActions.resend(r, reload)} /></View>
                        <View style={[h.td, { flex: 0.7, alignItems: 'flex-end' }]}>{early ? <Dash /> : <Text style={h.cell}>{num(r.devices)}</Text>}</View>
                        <View style={[h.td, { flex: 0.9 }]}>{early || !r.packageName ? <Dash /> : <Text style={h.cell}>{r.packageName}</Text>}</View>
                        <View style={[h.td, { flex: 1.4 }]}>{early || !r.packageName ? <Dash /> : <CreditsBar used={r.creditsUsed} total={r.creditsTotal} />}</View>
                        <View style={[h.td, { flex: 1 }]}>{early || !r.lastPaymentAt ? <Dash /> : <Text style={h.cell}>{fmtDate(r.lastPaymentAt)}</Text>}</View>
                        <View style={{ width: 40, alignItems: 'center' }}>
                          <RowMenu items={withDetails(storeMenu(r, { reload, open }), open)} label={`Actions for ${r.name}`} />
                        </View>
                      </Pressable>
                    )
                  })}
                </View>
              </ScrollView>
            ) : page ? (
              <View style={{ gap: Space.sm, padding: Space.sm }}>
                {page.stores.map((r) => {
                  const early = preActive(r.status)
                  const open = () => setDrawer({ id: r.id, section: null })
                  return (
                    <Pressable key={r.id} style={[h.mCard, loading && { opacity: 0.6 }]} onPress={open} focusable={false}>
                      <View style={h.mHead}>
                        <TouchableOpacity style={{ flex: 1 }} onPress={open} accessibilityRole="button" accessibilityLabel={`${r.name}, ${STATUS_META[r.status].label}. Open details`}>
                          <Text style={h.mName} numberOfLines={1}>{r.name}</Text>
                          <Text style={h.cellMuted} numberOfLines={1}>{r.location || '—'}</Text>
                        </TouchableOpacity>
                        <RowMenu items={withDetails(storeMenu(r, { reload, open }), open)} label={`Actions for ${r.name}`} />
                      </View>
                      <StatusCell row={r} onResend={() => storeActions.resend(r, reload)} />
                      <Text style={h.cellMuted} numberOfLines={1}>{r.managerEmail}</Text>
                      <View style={h.mStats}>
                        <View style={h.mStat}><Text style={h.mLabel}>DEVICES</Text><Text style={h.cell}>{early ? '—' : num(r.devices)}</Text></View>
                        <View style={h.mStat}><Text style={h.mLabel}>PACKAGE</Text><Text style={h.cell} numberOfLines={1}>{early || !r.packageName ? '—' : r.packageName}</Text></View>
                        <View style={h.mStat}><Text style={h.mLabel}>LAST PAYMENT</Text><Text style={h.cell}>{early || !r.lastPaymentAt ? '—' : fmtDate(r.lastPaymentAt)}</Text></View>
                      </View>
                      {!early && !!r.packageName && <CreditsBar used={r.creditsUsed} total={r.creditsTotal} />}
                    </Pressable>
                  )
                })}
              </View>
            ) : null}

            {page && page.total > 0 && (
              <View style={h.pager}>
                <Text style={h.cellMuted}>
                  Showing {num((page.page - 1) * page.pageSize + 1)}–{num(Math.min(page.page * page.pageSize, page.total))} of {num(page.total)}
                </Text>
                <View style={{ flexDirection: 'row', gap: Space.sm }}>
                  <Btn small kind="secondary" icon="chevronLeft" label="Previous" disabled={page.page <= 1}
                    onPress={() => setQuery((q) => ({ ...q, page: q.page - 1 }))} />
                  <Btn small kind="secondary" label="Next" disabled={page.page >= page.pages}
                    onPress={() => setQuery((q) => ({ ...q, page: q.page + 1 }))} />
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <StoreDrawer storeId={drawer?.id ?? null} section={drawer?.section} onClose={() => setDrawer(null)} onChanged={reload} />
    </View>
  )
}

const h = StyleSheet.create({
  page: { padding: Space.base, paddingTop: Space.lg, gap: Space.base, paddingBottom: Space.xxl },
  pageWide: { padding: Space.xl, maxWidth: Layout.wide + 64, width: '100%', alignSelf: 'center', gap: Space.lg },

  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  card: {
    flexGrow: 1, flexBasis: 160, minWidth: 150, backgroundColor: Colors.bgCard, borderRadius: Radius.lg, padding: Space.lg,
    borderWidth: 1.5, borderColor: Colors.borderSubtle, gap: 2,
  },
  cardOn: { borderColor: Colors.secondary, ...Shadow.card },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: Space.sm },
  cardLabel: { ...Typography.label, fontSize: 10, flex: 1 },
  cardValue: { ...Typography.numeral, fontSize: 36, lineHeight: 44, marginTop: Space.sm },
  cardSub: { ...Typography.caption },

  tableCard: { backgroundColor: Colors.bgCard, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.borderSubtle, overflow: 'hidden' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, padding: Space.base, paddingBottom: Space.sm, flexWrap: 'wrap' },
  search: {
    flex: 1, minWidth: 220, flexDirection: 'row', alignItems: 'center', gap: Space.sm, backgroundColor: Colors.bgSubtle,
    borderRadius: Radius.full, paddingHorizontal: Space.base, borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, paddingVertical: 10, ...Typography.bodySmall, color: Colors.text },
  chips: { gap: Space.sm, paddingHorizontal: Space.base, paddingBottom: Space.sm },
  count: { ...Typography.caption, color: Colors.textMuted, paddingHorizontal: Space.base, paddingBottom: Space.sm },

  tr: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg, paddingVertical: Space.md, borderTopWidth: 1, borderTopColor: Colors.borderSubtle, gap: Space.sm },
  trHover: { backgroundColor: Colors.bg },
  thead: { paddingVertical: Space.sm, backgroundColor: Colors.bgSubtle },
  th: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  thText: { ...Typography.label, fontSize: 9 },
  td: { justifyContent: 'center' },
  cell: { ...Typography.bodySmall },
  cellStrong: { ...Typography.bodySmall, ...Weight.semibold },
  mName: { ...Typography.h3, fontSize: 16 },
  cellMuted: { ...Typography.caption, color: Colors.textMuted },
  flag: { ...Typography.caption, ...Weight.semibold, color: Colors.error, textDecorationLine: 'underline' },
  track: { height: 4, borderRadius: 2, backgroundColor: Colors.secondarySubtle, overflow: 'hidden', maxWidth: 140 },
  fill: { height: 4, backgroundColor: Colors.secondary, borderRadius: 2 },

  mCard: { borderWidth: 1, borderColor: Colors.borderSubtle, borderRadius: Radius.lg, padding: Space.base, gap: Space.sm, backgroundColor: Colors.bgCard },
  mHead: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm },
  mStats: { flexDirection: 'row', gap: Space.md },
  mStat: { flex: 1, gap: 2 },
  mLabel: { ...Typography.label, fontSize: 8 },

  pager: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: Space.sm,
    padding: Space.base, borderTopWidth: 1, borderTopColor: Colors.borderSubtle,
  },
  empty: { alignItems: 'center', padding: Space.xl, gap: Space.xs, backgroundColor: Colors.bgCard, borderRadius: Radius.lg },
  emptyTitle: { ...Typography.h3, textAlign: 'center', marginTop: Space.sm },
  emptyText: { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center', maxWidth: 420 },
})
