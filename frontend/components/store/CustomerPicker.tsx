import { useMemo, useState } from 'react'
import { View, Text, FlatList, Image, Pressable, StyleSheet } from 'react-native'
import { Colors, Typography, Space, Radius, Weight } from '../../lib/theme'
import { EmptyState, Icon, Initials, PillButton, SearchField, Sheet, Skeleton } from '../../lib/ui'
import { timeAgo, phoneMatches, SEARCH_INPUT_PROPS } from '../../lib/b2b'
import type { CustomerFolder } from '../../lib/types'

// "Which customer?" sheet (spec §2.6): folders newest first, with search, so the
// most recent walk-in is always at the top.
export function CustomerPicker({
  visible, folders, loading, onPick, onNewCustomer, onClose,
}: {
  visible: boolean
  folders: CustomerFolder[]
  loading: boolean
  onPick: (folder: CustomerFolder) => void
  onNewCustomer: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return folders
    return folders.filter((f) => f.customerName.toLowerCase().includes(q) || phoneMatches(f.phone, q))
  }, [folders, query])

  return (
    <Sheet visible={visible} title="Which customer?" onClose={onClose}>
      {loading ? (
        <View style={{ gap: Space.sm }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={64} radius={Radius.md} />)}</View>
      ) : folders.length === 0 ? (
        <EmptyState icon="newCustomer" title="Create a customer first" body="Every try-on is saved into a customer’s folder."
          action={{ label: 'New customer', icon: 'newCustomer', onPress: onNewCustomer }} style={{ paddingVertical: Space.lg }} />
      ) : (
        <>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search name or phone" tone="light" {...SEARCH_INPUT_PROPS} />
          <FlatList
            data={shown}
            keyExtractor={(f) => f.id}
            style={{ flexGrow: 0 }}
            ListEmptyComponent={<Text style={s.noMatch}>No customer matches “{query}”.</Text>}
            renderItem={({ item }) => (
              <Pressable
                style={(st: any) => [s.row, st.hovered && { backgroundColor: Colors.bgSubtle }]} onPress={() => onPick(item)}
                accessibilityRole="button" accessibilityLabel={`Choose ${item.customerName}`}
              >
                {item.photoUrl
                  ? <Image source={{ uri: item.photoUrl }} style={s.thumb} />
                  : <View style={[s.thumb, s.thumbEmpty]}><Initials name={item.customerName} size={18} /></View>}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.name} numberOfLines={1}>{item.customerName}</Text>
                  <Text style={[s.meta, !item.photoUrl && { color: Colors.warning }]}>
                    {timeAgo(item.createdAt)}{item.photoUrl ? '' : ' · no photo yet'}
                  </Text>
                </View>
                <Icon name="chevron" size={20} color={Colors.textMuted} />
              </Pressable>
            )}
          />
          <PillButton label="New customer" icon="plus" variant="outline" size="md" onPress={onNewCustomer} />
        </>
      )}
    </Sheet>
  )
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.sm, paddingHorizontal: Space.sm,
    borderRadius: Radius.md,
  },
  thumb: { width: 48, height: 64, borderRadius: Radius.sm, backgroundColor: Colors.bgSubtle },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  name: { ...Typography.body, ...Weight.semibold },
  meta: { ...Typography.caption },
  noMatch: { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center', paddingVertical: Space.lg },
})
