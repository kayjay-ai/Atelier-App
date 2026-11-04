import { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, Alert, useWindowDimensions } from 'react-native'
import { createPayment, getPaymentStatus, fetchPricing } from './api'
import { openCashfreeCheckout } from './cashfreeCheckout'
import { PRICING_OPTIONS, inr } from './pricing'
import { useMembershipStore } from './store'
import type { Membership, PricingOption, PurchaseType } from './types'
import { Colors, Typography, Space, Radius } from './theme'

/** Plans from the server (admin-editable names / prices), with the built-in fallback. */
export function usePricingOptions(): PricingOption[] {
  const [options, setOptions] = useState<PricingOption[]>(PRICING_OPTIONS)
  useEffect(() => {
    fetchPricing().then((p) => { if (p?.options?.length) setOptions(p.options) })
  }, [])
  return options
}

// The three Premium plans side by side (stacked on narrow phones), recommended
// one highlighted. Reused on the Premium tab and in the out-of-credits paywall.
// Buying = server-created Cashfree order → hosted checkout → SERVER verifies →
// server grants credits → we sync the balance from the server response. Credits
// are never granted client-side.
export function PurchaseOptions({ onPurchased }: { onPurchased?: (m: Membership | null) => void }) {
  const options = usePricingOptions()
  const { width } = useWindowDimensions()
  // One row on iPad / desktop, stacked on phones — decided from the space the
  // cards actually get (the iPad side rail takes some), not the window.
  const [gridWidth, setGridWidth] = useState(0)
  const stack = (gridWidth || width) < 460
  const [busy, setBusy] = useState<PurchaseType | null>(null)
  const membershipStore = useMembershipStore()
  const recommended = options.find((o) => o.recommended)?.type ?? options[Math.min(1, options.length - 1)]?.type

  async function buy(opt: PricingOption) {
    if (busy) return
    if (Platform.OS !== 'web') {
      Alert.alert('Use the web app', 'Secure checkout runs in the Atelier web app. Please buy credits there.')
      return
    }
    setBusy(opt.type)
    try {
      const order = await createPayment(opt.type)          // amount computed server-side
      await openCashfreeCheckout(order.paymentSessionId, order.mode)
      const status = await getPaymentStatus(order.orderId) // server verifies + grants
      if (status.paid && status.membership) {
        membershipStore.setMembership(status.membership)
        Alert.alert('Credits added', `+${order.credits} credit${order.credits > 1 ? 's' : ''} added — you now have ${status.membership.creditsBalance}.`)
        onPurchased?.(status.membership)
      } else {
        Alert.alert('Payment not confirmed', `We haven't received confirmation yet (status: ${status.orderStatus}). If you were charged, it'll reflect shortly.`)
      }
    } catch (e: any) {
      Alert.alert('Checkout', e?.message || 'Payment was not completed. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <View style={{ gap: Space.sm }}>
      <View style={[s.grid, stack && s.gridStacked]} onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
        {options.map((opt) => {
          const featured = opt.type === recommended
          return (
            <View key={opt.type} style={[s.card, stack ? s.cardStack : s.cardRow, featured && s.cardFeatured]}>
              {featured && <Text style={s.badge}>RECOMMENDED</Text>}
              <Text style={s.name}>{opt.label}</Text>
              <Text style={s.price} numberOfLines={1}>{inr(opt.amountInr)}</Text>
              <Text style={s.credits}>{opt.credits} credit{opt.credits === 1 ? '' : 's'}</Text>
              <Text style={s.blurb}>
                {opt.credits > 1 ? `${inr(Math.round((opt.amountInr / opt.credits) * 10) / 10)} per try-on` : opt.blurb}
              </Text>
              <View style={s.spacer} />
              <TouchableOpacity
                style={[s.btn, featured ? s.btnSolid : s.btnOutline, !!busy && busy !== opt.type && { opacity: 0.5 }]}
                disabled={!!busy}
                onPress={() => buy(opt)}
              >
                {busy === opt.type
                  ? <ActivityIndicator color={featured ? Colors.textOnDark : Colors.secondary} />
                  : <Text style={[s.btnText, featured && { color: Colors.textOnDark }]}>Choose</Text>}
              </TouchableOpacity>
            </View>
          )
        })}
      </View>
      <Text style={s.note}>1 credit = 1 try-on. Credits stack and don’t expire.</Text>
    </View>
  )
}

const s = StyleSheet.create({
  grid: { flexDirection: 'row', gap: Space.md },
  gridStacked: { flexDirection: 'column' },
  // Row: equal thirds. Stacked: natural height (basis 0 in a column collapses the cards).
  cardRow:   { flexBasis: 0, flexGrow: 1 },
  cardStack: { alignSelf: 'stretch' },
  card: {
    minWidth: 0, backgroundColor: Colors.bgCard, borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border, padding: Space.base, gap: Space.xs,
  },
  cardFeatured: { borderColor: Colors.secondary, borderWidth: 2 },
  badge: {
    alignSelf: 'flex-start', ...Typography.label, fontSize: 9, letterSpacing: 1.5, color: Colors.textOnDark,
    backgroundColor: Colors.secondary, borderRadius: Radius.full, paddingHorizontal: Space.sm, paddingVertical: 3, overflow: 'hidden',
  },
  name:    { ...Typography.h3 },
  price:   { ...Typography.h1, fontSize: 28, lineHeight: 34, color: Colors.text },
  credits: { ...Typography.body, color: Colors.text },
  blurb:   { ...Typography.caption, color: Colors.textMuted },
  btn:     { marginTop: Space.sm, minHeight: 44, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },
  btnSolid:   { backgroundColor: Colors.secondary },
  btnOutline: { borderWidth: 1.5, borderColor: Colors.secondary },
  btnText: { ...Typography.bodySmall, fontWeight: '600', color: Colors.secondary },
  note:    { ...Typography.caption, color: Colors.textFaint, textAlign: 'center' },
  spacer:  { flexGrow: 1 }, // pins "Choose" to the bottom so the row's buttons line up
})
