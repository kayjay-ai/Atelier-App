import { useCallback, useMemo, useState } from 'react'
import { View, Text, FlatList, Image, Pressable, StyleSheet, useWindowDimensions } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { listFolders, useHiddenResults, availabilityLabel, expiringSoon, maskPhone, phoneMatches, SEARCH_INPUT_PROPS } from '../../lib/b2b'
import { Colors, Typography, Space, Radius, Layout, Shadow } from '../../lib/theme'
import { EmptyState, Icon, Initials, Notice, PageHeader, PillButton, SearchField, Skeleton, Tag } from '../../lib/ui'
import type { CustomerFolder } from '../../lib/types'

// Spec §2.8: every customer folder, newest first, searchable by name or phone.
// Expired folders (15 days) are hidden by the database and never listed.
const PHONE_MAX = 520

export default function CustomersScreen() {
  const { width } = useWindowDimensions()
  const phone = width < PHONE_MAX
  const [folders, setFolders] = useState<CustomerFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const hidden = useHiddenResults((st) => st.hidden)

  const load = useCallback(async () => {
    setError(null)
    try {
      setFolders(await listFolders())
    } catch (e: any) {
      setError(e?.message ?? 'Could not load customers.')
    } finally {
      setLoading(false)
    }
  }, [])

  useFocusEffect(useCallback(() => { load() }, [load]))

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return folders
    return folders.filter((f) => f.customerName.toLowerCase().includes(q) || phoneMatches(f.phone, q))
  }, [folders, query])

  const gutter = Layout.gutter(width)
  const columns = width >= 860 ? 2 : 1

  const header = (
    <View style={s.head}>
      <PageHeader
        title="Customers"
        subtitle={`${folders.length} active folder${folders.length === 1 ? '' : 's'}. Each is kept for 15 days.`}
        actions={<PillButton label={phone ? 'New' : 'New customer'} icon="newCustomer" size="md" onPress={() => router.push('/store/new-customer')} accessibilityLabel="New customer" />}
      />
      <SearchField value={query} onChangeText={setQuery} placeholder="Search by name or phone" {...SEARCH_INPUT_PROPS} />
    </View>
  )

  return (
    <View style={s.page}>
      {loading ? (
        <View style={[s.inner, { paddingHorizontal: gutter }]}>
          {header}
          {[0, 1, 2].map((i) => <Skeleton key={i} height={104} radius={Radius.lg} style={{ marginTop: Space.md }} />)}
        </View>
      ) : error ? (
        <View style={[s.inner, { paddingHorizontal: gutter }]}>
          {header}
          <Notice tone="error" text={`Couldn’t load customers — ${error}`} actionLabel="Retry" onAction={() => { setLoading(true); load() }} />
        </View>
      ) : (
        <FlatList
          key={columns}
          data={shown}
          numColumns={columns}
          keyExtractor={(f) => f.id}
          columnWrapperStyle={columns > 1 ? { gap: Space.md } : undefined}
          contentContainerStyle={[s.list, { paddingHorizontal: gutter, maxWidth: Layout.app + gutter * 2 }]}
          ListHeaderComponent={header}
          ListEmptyComponent={folders.length === 0 ? (
            <EmptyState icon="newCustomer" title="No customers yet" body="Each walk-in gets a folder with their photo and every try-on."
              action={{ label: 'New customer', icon: 'newCustomer', onPress: () => router.push('/store/new-customer') }} />
          ) : (
            <EmptyState icon="search" title={`No customer matches “${query}”`} body="Check the spelling, or search by phone number."
              secondary={{ label: 'Clear search', onPress: () => setQuery('') }} />
          )}
          renderItem={({ item }) => {
            const soon = expiringSoon(item.expiresAt)
            const tryons = Math.max(0, item.tryonCount - (hidden[item.id]?.length ?? 0))
            return (
              <View style={{ flex: 1 / columns }}>
                <Pressable
                  style={(st: any) => [s.card, st.hovered && s.cardHover]}
                  onPress={() => router.push(`/store/customer/${item.id}`)}
                  accessibilityRole="button" accessibilityLabel={`Open ${item.customerName}’s folder`}
                >
                  {item.photoUrl
                    ? <Image source={{ uri: item.photoUrl }} style={s.thumb} />
                    : <View style={[s.thumb, s.thumbEmpty]}><Initials name={item.customerName} size={22} /></View>}
                  <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
                    <Text style={s.name} numberOfLines={1}>{item.customerName}</Text>
                    <Text style={s.meta} numberOfLines={1}>
                      Added {new Date(item.createdAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}
                      {item.phone ? ` · ${maskPhone(item.phone)}` : ''}
                    </Text>
                    <View style={s.tags}>
                      <Tag label={`${tryons} try-on${tryons === 1 ? '' : 's'}`} />
                      <Tag label={availabilityLabel(item.expiresAt)} tone={soon ? 'warning' : 'neutral'} dot={soon} />
                    </View>
                  </View>
                  <Icon name="chevron" size={20} color={Colors.textMuted} />
                </Pressable>
              </View>
            )
          }}
        />
      )}
    </View>
  )
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: Colors.bg },
  inner: { width: '100%', maxWidth: Layout.app + 64, alignSelf: 'center', paddingTop: Space.lg, gap: Space.md },
  head: { gap: Space.lg, marginBottom: Space.sm },
  list: { width: '100%', alignSelf: 'center', paddingTop: Space.lg, gap: Space.md, paddingBottom: Space.xxl + Space.lg },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: Space.base,
    backgroundColor: Colors.bgCard, borderRadius: Radius.lg, padding: Space.md, paddingRight: Space.base,
    borderWidth: 1, borderColor: Colors.borderSubtle,
  },
  cardHover: { borderColor: Colors.border, ...Shadow.card },
  thumb: { width: 60, height: 80, borderRadius: Radius.sm, backgroundColor: Colors.bgSubtle },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  name: { ...Typography.h3 },
  meta: { ...Typography.caption },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs, marginTop: 2 },
})
