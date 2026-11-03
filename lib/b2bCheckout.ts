import { Platform } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { b2bCheckoutUrl, fetchB2BPaymentStatus, type B2BOrder, type B2BPaymentStatus } from './api'
import { openCashfreeCheckout } from './cashfreeCheckout'

// Opens Cashfree checkout for a server-created B2B order and returns once the
// shopper is back in the app. The outcome is NOT taken from the checkout — the
// caller asks the server (confirmB2BPayment), which verifies with Cashfree.
export async function openB2BCheckout(order: B2BOrder): Promise<void> {
  if (Platform.OS === 'web') {
    await openCashfreeCheckout(order.paymentSessionId, order.mode)
    return
  }
  // iPad: a secure in-app browser on the API's hosted checkout page; Cashfree's
  // return page redirects to atelier://store/plan, which closes the browser.
  await WebBrowser.openAuthSessionAsync(b2bCheckoutUrl(order.paymentSessionId), 'atelier://store/plan')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Ask the server whether the order is paid (it verifies with Cashfree and
 * applies the credits). Retries briefly, since Cashfree can take a few seconds
 * to mark an order PAID after the checkout closes.
 */
export async function confirmB2BPayment(orderId: string, attempts = 6): Promise<B2BPaymentStatus> {
  let last: B2BPaymentStatus = { status: 'pending', result: null }
  for (let i = 0; i < attempts; i++) {
    last = await fetchB2BPaymentStatus(orderId)
    if (last.status !== 'pending') return last
    await sleep(2000)
  }
  return last
}
