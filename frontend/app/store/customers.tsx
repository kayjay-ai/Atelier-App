import { useCallback, useMemo, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Image, StyleSheet, ActivityIndicator, useWindowDimensions,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { listFolders, useHiddenResults, availabilityLabel, expiringSoon, maskPhone, phoneMatches, SEARCH_INPUT_PROPS } from '../../lib/b2b'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon } from '../../lib/ui'
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

  return (
    <View style={[s.page, phone && s.pagePhone]}>
      {/* Title + button share one row (the title never wraps); the count sits
          on its own line so it never squeezes the title on phones. */}
      <View style={s.headRow}>
        <Text style={s.title} numberOfLines={1}>Customers</Text>
        <TouchableOpacity
          style={[s.newBtn, phone && s.newBtnPhone]}
          onPress={() => router.push('/store/new-customer')}
          accessibilityRole="button"
          accessibilityLabel="New customer"
        >
          <Icon name="newCustomer" size={phone ? 18 : 20} color={Colors.textOnDark} />
          <Text style={s.newBtnText}>{phone ? 'New' : 'New customer'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.sub}>
        {folders.length} active folder{folders.length === 1 ? '' : 's'} · each is kept for 15 days
      </Text>

      <View style={s.search}>
        <Icon name="search" size={18} color={Colors.textMuted} />
        <TextInput
          style={s.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name or phone"
          placeholderTextColor={Colors.textFaint}
          autoCorrect={false}
          {...SEARCH_INPUT_PROPS}
        />
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: Space.xl }} color={Colors.primary} />
      ) : error ? (
        <View style={s.center}>
          <Text style={s.errorText}>Couldn't load customers — {error}</Text>
          <TouchableOpacity onPress={() => { setLoading(true); load() }}><Text style={s.retry}>Retry</Text></TouchableOpacity>
        </View>
      ) : folders.length === 0 ? (
        <View style={s.center}>
          <Icon name="profile" size={44} color={Colors.border} />
          <Text style={s.emptyTitle}>No customers yet</Text>
          <Text style={s.emptyBody}>Tap New customer to start.</Text>
        </View>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(f) => f.id}
          contentContainerStyle={s.list}
          ListEmptyComponent={<Text style={s.emptyBody}>No customer matches “{query}”.</Text>}
          renderItem={({ item }) => {
            const soon = expiringSoon(item.expiresAt)
            const tryons = Math.max(0, item.tryonCount - (hidden[item.id]?.length ?? 0))
            return (
              <TouchableOpacity style={s.card} onPress={() => router.push(`/store/customer/${item.id}`)}>
                {item.photoUrl
                  ? <Image source={{ uri: item.photoUrl }} style={s.thumb} />
                  : <View style={[s.thumb, s.thumbEmpty]}><Icon name="profile" size={24} color={Colors.textFaint} /></View>}
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.name} numberOfLines={1}>{item.customerName}</Text>
                  <Text style={s.meta}>
                    {new Date(item.createdAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}
                    {item.phone ? ` · ${maskPhone(item.phone)}` : ''}
                  </Text>
                  <Text style={s.meta}>{tryons} try-on{tryons === 1 ? '' : 's'}</Text>
                </View>
                <View style={[s.expiry, soon && s.expirySoon]}>
                  <Text style={[s.expiryText, soon && { color: Colors.warning }]}>
                    {availabilityLabel(item.expiresAt)}
                  </Text>
                </View>
              </TouchableOpacity>
            )
          }}
        />
      )}
    </View>
  )
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: Colors.bg, padding: Space.lg, gap: Space.md },
  pagePhone: { padding: Space.base },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  title: { ...Typography.h1, flex: 1, flexShrink: 1 },
  sub: { ...Typography.bodySmall, color: Colors.textMuted, marginTop: -Space.sm },
  newBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Space.sm, flexShrink: 0,
    backgroundColor: Colors.secondary, borderRadius: Radius.full,
    minHeight: 48, paddingHorizontal: Space.lg,
  },
  newBtnPhone: { minHeight: 42, paddingHorizontal: Space.base, gap: Space.xs },
  newBtnText: { ...Typography.bodySmall, fontWeight: '600', color: Colors.textOnDark },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: Space.sm,
    backgroundColor: Colors.bgCard, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Space.md,
  },
  searchInput: { flex: 1, ...Typography.body, color: Colors.text, paddingVertical: 10 },
  list: { gap: Space.md, paddingBottom: Space.xxl },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: Space.md,
    backgroundColor: Colors.bgCard, borderRadius: Radius.lg, padding: Space.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  thumb: { width: 60, height: 80, borderRadius: Radius.sm, backgroundColor: Colors.bgSubtle },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  name: { ...Typography.h3 },
  meta: { ...Typography.caption },
  expiry: { backgroundColor: Colors.bgSubtle, borderRadius: Radius.full, paddingHorizontal: Space.md, paddingVertical: 6 },
  expirySoon: { backgroundColor: Colors.warningBg },
  expiryText: { ...Typography.caption, color: Colors.textMuted, fontWeight: '600' },
  center: { alignItems: 'center', paddingVertical: Space.xxl, gap: Space.sm },
  emptyTitle: { ...Typography.h3 },
  emptyBody: { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center' },
  errorText: { ...Typography.bodySmall, color: Colors.error, textAlign: 'center' },
  retry: { ...Typography.bodySmall, fontWeight: '700', color: Colors.secondary },
})
