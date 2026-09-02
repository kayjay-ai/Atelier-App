import { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, Alert } from 'react-native'
import { createPayment, getPaymentStatus, fetchPricing } from './api'
import { openCashfreeCheckout } from './cashfreeCheckout'
import { PRICING_OPTIONS, inr } from './pricing'
import { useCreditsStore, useMembershipStore } from './store'
import type { Membership, PricingOption, PurchaseType } from './types'
import { Colors, Typography, Space, Radius } from './theme'

// The three credit-purchase options. Reused on the Premium screen and in the
// out-of-credits flow. Buying = server-created Cashfree order → hosted checkout →
// SERVER verifies → server grants credits → we sync the balance from the server
// response. Credits are never granted client-side.
export function PurchaseOptions({ onPurchased }: { onPurchased?: (m: Membership | null) => void }) {
  const [options, setOptions] = useState<PricingOption[]>(PRICING_OPTIONS)
  const [busy, setBusy] = useState<PurchaseType | null>(null)
  const credits = useCreditsStore()
  const membershipStore = useMembershipStore()

  useEffect(() => {
    fetchPricing().then((p) => { if (p?.options?.length) setOptions(p.options) })
  }, [])

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
        credits.syncFromMembership(status.membership)      // balance set by the SERVER
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
    <View style={{ gap: Space.md }}>
      {options.map((opt) => {
        const perGen = opt.type === 'per_generation'
        return (
          <TouchableOpacity
            key={opt.type}
            style={[s.card, opt.type === 'pack_100' && s.cardFeatured]}
            activeOpacity={0.85}
            disabled={!!busy}
            onPress={() => buy(opt)}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.cardLabel}>{opt.label}</Text>
              <Text style={s.cardBlurb}>
                {perGen ? 'One generation, on demand' : `${opt.credits} credits`}
              </Text>
            </View>
            {busy === opt.type
              ? <ActivityIndicator color={Colors.primary} />
              : (
                <View style={s.priceTag}>
                  <Text style={s.priceTagText}>{inr(opt.amountInr)}</Text>
                  {!perGen && <Text style={s.priceTagSub}>{Math.round(opt.amountInr / opt.credits * 10) / 10}/credit</Text>}
                </View>
              )}
          </TouchableOpacity>
        )
      })}
      <Text style={s.note}>1 credit = 1 generation. Credits stack and don’t expire.</Text>
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: Space.md,
    backgroundColor: Colors.bgCard, borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border, padding: Space.lg,
  },
  cardFeatured: { borderColor: Colors.primary, borderWidth: 1.5 },
  cardLabel: { ...Typography.body, fontWeight: '600', color: Colors.text },
  cardBlurb: { ...Typography.caption, color: Colors.textMuted, marginTop: 2 },
  priceTag: { alignItems: 'flex-end' },
  priceTagText: { ...Typography.h3, color: Colors.primary },
  priceTagSub: { ...Typography.caption, color: Colors.textFaint, fontSize: 10 },
  note: { ...Typography.caption, color: Colors.textFaint, textAlign: 'center', marginTop: Space.xs },
})
