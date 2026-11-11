import { useEffect, useState } from 'react'
import { View, Text, StyleSheet, Platform, useWindowDimensions } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createPayment, getPaymentStatus, fetchPricing } from './api'
import { showAlert } from './notify'
import { openCashfreeCheckout } from './cashfreeCheckout'
import { PRICING_OPTIONS, inr } from './pricing'
import { useMembershipStore } from './store'
import type { Membership, PricingOption, PurchaseType } from './types'
import { Colors, Typography, Space, Radius, Shadow, Weight } from './theme'
import { Field, PillButton, Tag } from './ui'

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
const PHONE_KEY = 'atelier.checkoutPhone'

/** A 10-digit Indian mobile number from what was typed (+91 / 0 prefixes allowed), or null. */
export function tenDigitMobile(input: string): string | null {
  const digits = input.replace(/\D/g, '').replace(/^(?:91|0)(?=\d{10}$)/, '')
  return /^[6-9]\d{9}$/.test(digits) ? digits : null
}

export function PurchaseOptions({ onPurchased }: { onPurchased?: (m: Membership | null) => void }) {
  const options = usePricingOptions()
  const { width } = useWindowDimensions()
  // One row on iPad / desktop, stacked on phones — decided from the space the
  // cards actually get (the iPad side rail takes some), not the window.
  const [gridWidth, setGridWidth] = useState(0)
  const stack = (gridWidth || width) < 460
  const [busy, setBusy] = useState<PurchaseType | null>(null)
  // Cashfree needs the payer's mobile number; remembered on this device.
  const [phone, setPhone] = useState('')
  const [phoneError, setPhoneError] = useState<string | null>(null)
  useEffect(() => {
    AsyncStorage.getItem(PHONE_KEY).then((v) => { if (v) setPhone(v) }).catch(() => {})
  }, [])
  const membershipStore = useMembershipStore()
  const recommended = options.find((o) => o.recommended)?.type ?? options[Math.min(1, options.length - 1)]?.type

  async function buy(opt: PricingOption) {
    if (busy) return
    if (Platform.OS !== 'web') {
      showAlert('Use the web app', 'Secure checkout runs in the Atelier web app. Please buy credits there.')
      return
    }
    const mobile = tenDigitMobile(phone)
    if (!mobile) { setPhoneError('Enter your 10-digit mobile number to pay.'); return }
    setPhoneError(null)
    AsyncStorage.setItem(PHONE_KEY, mobile).catch(() => {})
    setBusy(opt.type)
    try {
      const order = await createPayment(opt.type, mobile)  // amount computed server-side
      await openCashfreeCheckout(order.paymentSessionId, order.mode)
      const status = await getPaymentStatus(order.orderId) // server verifies + grants
      if (status.paid && status.membership) {
        membershipStore.setMembership(status.membership)
        showAlert('Credits added', `+${order.credits} credit${order.credits > 1 ? 's' : ''} added — you now have ${status.membership.creditsBalance}.`, 'success')
        onPurchased?.(status.membership)
      } else {
        showAlert('Payment not confirmed', `We haven't received confirmation yet (status: ${status.orderStatus}). If you were charged, it'll reflect shortly.`)
      }
    } catch (e: any) {
      showAlert('Payment not completed', e?.message || 'No money was taken. Please try again.', 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <View style={{ gap: Space.base }}>
      {Platform.OS === 'web' && (
        <Field
          label="Mobile number"
          hint="The payment provider needs it. It’s remembered on this device."
          value={phone}
          onChangeText={(t) => { setPhone(t); setPhoneError(null) }}
          placeholder="10-digit mobile number"
          keyboardType="phone-pad"
          autoComplete="tel"
          maxLength={16}
          error={phoneError}
          tone="card"
          containerStyle={{ marginTop: 0, maxWidth: 360 }}
        />
      )}
      <View style={[s.grid, stack && s.gridStacked]} onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
        {options.map((opt) => {
          const featured = opt.type === recommended
          const perTry = opt.credits > 1 ? `${inr(Math.round((opt.amountInr / opt.credits) * 10) / 10)} per try-on` : opt.blurb
          return (
            <View key={opt.type} style={[s.card, stack ? s.cardStack : s.cardRow, featured && s.cardFeatured]}>
              <View style={s.cardHead}>
                <Text style={[s.name, featured && s.onDark]}>{opt.label}</Text>
                {featured && <Tag label="Recommended" tone="dark" />}
              </View>
              <Text style={[s.price, featured && s.onDark]} numberOfLines={1}>{inr(opt.amountInr)}</Text>
              <Text style={[s.credits, featured && s.onDark]}>{opt.credits} try-on credit{opt.credits === 1 ? '' : 's'}</Text>
              {!!perTry && <Text style={[s.blurb, featured && s.onDarkMuted]}>{perTry}</Text>}
              <View style={s.spacer} />
              <PillButton
                label={`Choose ${opt.label}`}
                variant={featured ? 'gold' : 'outline'}
                size="md"
                loading={busy === opt.type}
                disabled={!!busy && busy !== opt.type}
                onPress={() => buy(opt)}
                style={{ marginTop: Space.base }}
              />
            </View>
          )
        })}
      </View>
      <Text style={s.note}>1 credit = 1 try-on. Credits stack and never expire. Size advice and style tips are free.</Text>
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
    minWidth: 0, backgroundColor: Colors.bgCard, borderRadius: Radius.xl,
    borderWidth: 1, borderColor: Colors.border, padding: Space.lg, gap: Space.xs,
  },
  cardFeatured: { backgroundColor: Colors.bgDark, borderColor: Colors.bgDark, ...Shadow.card },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Space.sm, minHeight: 26 },
  name:    { ...Typography.h3 },
  price:   { ...Typography.numeral, fontSize: 36, lineHeight: 44, marginTop: Space.sm },
  credits: { ...Typography.body, ...Weight.medium },
  blurb:   { ...Typography.caption },
  onDark:  { color: Colors.textOnDark },
  onDarkMuted: { color: Colors.textOnDarkMuted },
  note:    { ...Typography.caption, textAlign: 'center' },
  spacer:  { flexGrow: 1 }, // pins the button to the bottom so the row's buttons line up
})
