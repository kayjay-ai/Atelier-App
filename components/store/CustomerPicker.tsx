import { useMemo, useState } from 'react'
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList, Image, StyleSheet, ActivityIndicator,
} from 'react-native'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon } from '../../lib/ui'
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.headRow}>
            <Text style={s.title}>Which customer?</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel="Close">
              <Icon name="close" size={24} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={s.center}><ActivityIndicator color={Colors.primary} /></View>
          ) : folders.length === 0 ? (
            <View style={s.center}>
              <Text style={s.emptyTitle}>Create a customer first</Text>
              <Text style={s.emptyBody}>Every try-on is saved into a customer's folder.</Text>
              <TouchableOpacity style={s.newBtn} onPress={onNewCustomer}>
                <Icon name="newCustomer" size={18} color={Colors.textOnDark} />
                <Text style={s.newBtnText}>New customer</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={s.search}>
                <Icon name="search" size={18} color={Colors.textMuted} />
                <TextInput
                  style={s.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search name or phone"
                  placeholderTextColor={Colors.textFaint}
                  autoCorrect={false}
                  {...SEARCH_INPUT_PROPS}
                />
              </View>
              <FlatList
                data={shown}
                keyExtractor={(f) => f.id}
                style={{ flexGrow: 0 }}
                ListEmptyComponent={<Text style={s.noMatch}>No customer matches “{query}”.</Text>}
                renderItem={({ item }) => (
                  <TouchableOpacity style={s.row} onPress={() => onPick(item)}>
                    {item.photoUrl
                      ? <Image source={{ uri: item.photoUrl }} style={s.thumb} />
                      : <View style={[s.thumb, s.thumbEmpty]}><Icon name="profile" size={20} color={Colors.textFaint} /></View>}
                    <View style={{ flex: 1 }}>
                      <Text style={s.name} numberOfLines={1}>{item.customerName}</Text>
                      <Text style={s.meta}>
                        {timeAgo(item.createdAt)}{item.photoUrl ? '' : ' · no photo yet'}
                      </Text>
                    </View>
                    <Icon name="chevron" size={20} color={Colors.textFaint} />
                  </TouchableOpacity>
                )}
              />
              <TouchableOpacity style={s.newLink} onPress={onNewCustomer}>
                <Text style={s.newLinkText}>+ New customer</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: Space.base },
  sheet: {
    width: '100%', maxWidth: 520, maxHeight: '85%',
    backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, gap: Space.md,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...Typography.h2 },
  center: { alignItems: 'center', paddingVertical: Space.xl, gap: Space.sm },
  emptyTitle: { ...Typography.h3 },
  emptyBody: { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center' },
  newBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Space.sm, marginTop: Space.md,
    backgroundColor: Colors.secondary, borderRadius: Radius.full, paddingVertical: 12, paddingHorizontal: Space.lg,
  },
  newBtnText: { ...Typography.body, fontWeight: '600', color: Colors.textOnDark },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: Space.sm,
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, paddingHorizontal: Space.md,
  },
  searchInput: { flex: 1, ...Typography.body, color: Colors.text, paddingVertical: 10 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Space.md,
    paddingVertical: Space.md, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle,
  },
  thumb: { width: 48, height: 64, borderRadius: Radius.sm, backgroundColor: Colors.bgSubtle },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  name: { ...Typography.body, fontWeight: '600' },
  meta: { ...Typography.caption },
  noMatch: { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center', paddingVertical: Space.lg },
  newLink: { alignItems: 'center', paddingTop: Space.sm },
  newLinkText: { ...Typography.bodySmall, fontWeight: '600', color: Colors.secondary },
})
