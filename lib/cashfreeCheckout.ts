// Cashfree hosted checkout (web). Loads the official v3 JS SDK on demand and opens
// the payment modal for a server-created payment session. The App ID / Secret are
// NEVER here — only the payment_session_id (created server-side) and the public
// `mode` are used. Web-only: on native this rejects and the caller falls back to a
// "use the web app" message.
//
// SDK: https://sdk.cashfree.com/js/v3/cashfree.js → global `Cashfree({ mode }).checkout(...)`

let sdkPromise: Promise<any> | null = null

function loadSdk(): Promise<any> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return Promise.reject(new Error('Checkout is available on the web app.'))
  }
  const w = window as any
  if (w.Cashfree) return Promise.resolve(w.Cashfree)
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const sc = document.createElement('script')
      sc.src = 'https://sdk.cashfree.com/js/v3/cashfree.js'
      sc.async = true
      sc.onload = () => (w.Cashfree ? resolve(w.Cashfree) : reject(new Error('Payment SDK failed to initialise.')))
      sc.onerror = () => { sdkPromise = null; reject(new Error('Could not load the payment SDK.')) }
      document.head.appendChild(sc)
    })
  }
  return sdkPromise
}

/**
 * Open Cashfree checkout for a payment session. Resolves when the modal closes.
 * The RESULT IS NOT TRUSTED for granting anything — the caller must still ask the
 * server to verify (getPaymentStatus). Throws if the user could not complete.
 */
export async function openCashfreeCheckout(
  paymentSessionId: string,
  mode: 'sandbox' | 'production',
): Promise<void> {
  const Cashfree = await loadSdk()
  const cashfree = Cashfree({ mode })
  const result = await cashfree.checkout({ paymentSessionId, redirectTarget: '_modal' })
  if (result?.error) {
    throw new Error(result.error.message || 'Payment was not completed.')
  }
  // result.paymentDetails may be present on success — ignored on purpose; the
  // server is the only authority on whether the payment actually succeeded.
}
