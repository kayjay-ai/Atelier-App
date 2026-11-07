import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View, Text, ScrollView, StyleSheet, Linking, TouchableOpacity, useWindowDimensions, Modal, ActivityIndicator, Platform,
} from 'react-native'
import { useFocusEffect, useGlobalSearchParams, useRouter } from 'expo-router'
import { supabase } from '../../lib/supabaseClient'
import { useAccountStore, usableCredits } from '../../lib/account'
import { DEMO_CLIENT_ID } from '../../lib/demoCompany'
import { SUPPORT_EMAIL } from '../../lib/b2b'
import { inr } from '../../lib/pricing'
import {
  fetchB2BBilling, createB2BOrder, type B2BBilling, type B2BPlanOption, type B2BTopupPack, type B2BPaymentStatus,
} from '../../lib/api'
import { openB2BCheckout, confirmB2BPayment } from '../../lib/b2bCheckout'
import { Colors, Typography, Space, Radius, Shadow } from '../../lib/theme'
import { Icon } from '../../lib/ui'

// Spec §2.9 — the store pays for its plan and credit top-ups here (Cashfree).
// Prices, credits and what may be bought come from the server (GET
// /api/b2b/billing); the app never decides an amount. Billing rules:
//   • plan credits expire at the end of each cycle;
//   • any plan payment (incl. upgrades, full price) starts a new cycle today;
//   • top-up credits never expire and are spent after plan credits;
//   • every payment needs the Terms ticked;
//   • prices are shown excl. GST; the store is charged price + 18% GST.

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

function requestChange(subject: string, company: string) {
  if (!SUPPORT_EMAIL) return
  const body = `Company: ${company}\n\n`
  Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`)
}

interface Invoice {
  id: string
  plan_id: string
  started_at: string
  renewal_at: string
  amount_inr: number
  payment_status: 'paid' | 'due' | 'overdue' | 'waived'
  invoice_url: string | null
}

// Billing periods (b2b_subscriptions; RLS → own store). Paid in-app plans add one too.
async function loadInvoices(clientId: string): Promise<Invoice[]> {
  if (clientId === DEMO_CLIENT_ID) return []
  const { data, error } = await supabase
    .from('b2b_subscriptions')
    .select('id, plan_id, started_at, renewal_at, amount_inr, payment_status, invoice_url')
    .eq('store_id', clientId)
    .order('started_at', { ascending: false })
    .limit(24)
  if (error) return [] // table not created yet → empty state
  return (data ?? []) as Invoice[]
}

const STATUS_LABEL: Record<Invoice['payment_status'], string> = { paid: 'Paid', due: 'Due', overdue: 'Overdue', waived: 'Waived' }

const PLAN_BUTTON: Record<NonNullable<B2BPlanOption['action']>, (name: string) => string> = {
  choose: (n) => `Choose ${n}`,
  upgrade: () => 'Upgrade',
  renew: () => 'Renew',
  switch: (n) => `Switch to ${n}`,
}

type Purchase = { kind: 'plan'; plan: B2BPlanOption } | { kind: 'topup'; pack: B2BTopupPack }
type Notice = { tone: 'ok' | 'info' | 'error'; text: string }

function noticeFor(st: B2BPaymentStatus): Notice {
  if (st.status === 'paid') {
    const r = st.result ?? {}
    return r.kind === 'topup'
      ? { tone: 'ok', text: `Payment received — ${Number(r.credits_added ?? 0).toLocaleString('en-IN')} top-up credits added.` }
      : { tone: 'ok', text: `Payment received — your plan is active until ${fmtDate((r.renewal_at as string) ?? null)}.` }
  }
  if (st.status === 'failed') return { tone: 'error', text: 'The payment was not completed. No money was taken for this order.' }
  if (st.status === 'review') return { tone: 'error', text: 'We received a payment we need to verify — Atelier support will contact you. Your credits will be added after the check.' }
  return { tone: 'info', text: 'We’re still confirming your payment with the bank. This can take a minute — refresh this page shortly.' }
}

// The three/four plans sit in one row on iPad / desktop; only narrow phones stack them.
const STACK_BELOW = 560

export default function PlanScreen() {
  const { width } = useWindowDimensions()
  const router = useRouter()
  // Global: this screen is also shown by the store layout while it is paused.
  const params = useGlobalSearchParams<{ order_id?: string }>()
  const [plansWidth, setPlansWidth] = useState(0)
  const stackPlans = (plansWidth || width) < STACK_BELOW
  const account = useAccountStore((st) => st.account)
  const session = useAccountStore((st) => st.session)
  const refresh = useAccountStore((st) => st.refresh)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [billing, setBilling] = useState<B2BBilling | null>(null)
  const [billingError, setBillingError] = useState<string | null>(null)
  const [purchase, setPurchase] = useState<Purchase | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const clientId = account?.type === 'b2b_company' ? account.client.id : null
  const isDemo = clientId === DEMO_CLIENT_ID

  const loadBilling = useCallback(async () => {
    if (!clientId || isDemo) return
    try {
      setBilling(await fetchB2BBilling())
      setBillingError(null)
    } catch (e: any) {
      setBillingError(e?.message ?? 'Could not load billing.')
    }
  }, [clientId, isDemo])

  const reloadAll = useCallback(() => {
    refresh(true)
    loadBilling()
    if (clientId) loadInvoices(clientId).then(setInvoices)
  }, [refresh, loadBilling, clientId])

  useFocusEffect(useCallback(() => { reloadAll() }, [reloadAll]))

  // Web checkout returns here with ?order_id= — confirm it once.
  const confirmedReturn = useRef<string | null>(null)
  useEffect(() => {
    const orderId = typeof params.order_id === 'string' ? params.order_id : null
    if (!orderId || confirmedReturn.current === orderId || !clientId || isDemo) return
    confirmedReturn.current = orderId
    confirmB2BPayment(orderId)
      .then((st) => setNotice(noticeFor(st)))
      .catch((e) => setNotice({ tone: 'error', text: e?.message ?? 'Could not check the payment.' }))
      .finally(() => { reloadAll(); router.setParams({ order_id: undefined }) })
  }, [params.order_id, clientId, isDemo, reloadAll, router])

  if (account?.type !== 'b2b_company') return null
  const { client, plan } = account
  const payEnabled = !!billing?.enabled

  // Balances: the server splits plan vs. top-up credits; before it answers,
  // show what the store can spend as plan credits.
  const planCredits = billing?.store.planCredits ?? usableCredits(client)
  const topupCredits = billing?.store.topupCredits ?? 0
  const total = planCredits + topupCredits
  const included = billing?.store.planCreditsIncluded ?? plan?.creditsIncluded ?? 0
  const lowPct = session?.settings.lowCreditPct ?? 20
  const pct = included > 0 ? Math.min(1, planCredits / included) : planCredits > 0 ? 1 : 0
  const low = included > 0 && (planCredits / included) * 100 <= lowPct && topupCredits === 0
  const renewalAt = billing?.store.renewalAt ?? client.renewalAt

  // Until the server answers, show the plans without GST totals or buttons —
  // GST and what may be bought come only from the server.
  const plans: (Omit<B2BPlanOption, 'gstInr' | 'totalInr'> & { gstInr: number | null; totalInr: number | null })[] =
    billing?.plans ?? account.plans.map((p) => ({
      id: p.id, name: p.name, priceInr: p.priceInr, gstInr: null, totalInr: null, cycle: p.cycle, credits: p.creditsIncluded,
      current: p.id === plan?.id, action: null, allowed: false, reason: null,
    }))
  const packs = billing?.packs ?? []

  // Why payment can't start yet (shown in the confirm step), or null when it can.
  const setupProblem = isDemo
    ? 'Payments aren’t available in the preview company.'
    : !billing
      ? `${billingError ?? 'Billing is not available right now.'} Please try again later or contact Atelier support.`
      : billing.setup?.database === false
        ? 'Online payment isn’t switched on yet (the billing database update hasn’t been applied). Contact Atelier support.'
      : !billing.setup?.cashfree
        ? 'Online payment isn’t switched on yet (Cashfree is not configured). Contact Atelier support.'
        : !billing.setup?.terms
          ? 'Online payment isn’t switched on yet (the Terms & Conditions are not published). Contact Atelier support.'
          : null

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <Text style={s.title}>Plan & Credits</Text>

      {notice && (
        <View style={[s.notice, notice.tone === 'ok' ? s.noticeOk : notice.tone === 'error' ? s.noticeError : s.noticeInfo]}>
          <Text style={s.noticeText}>{notice.text}</Text>
          <TouchableOpacity onPress={() => setNotice(null)} hitSlop={8}>
            <Icon name="close" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>
      )}

      <View style={[s.card, Shadow.card]}>
        <View style={s.planRow}>
          <Text style={s.planBadge}>{billing?.store.planName ?? plan?.name ?? 'No plan'}</Text>
          {client.status === 'trial' && <Text style={s.trial}>TRIAL{client.trialEndsAt ? ` · ends ${fmtDate(client.trialEndsAt)}` : ''}</Text>}
        </View>
        <Text style={s.big}>{total.toLocaleString('en-IN')}</Text>
        <Text style={s.muted}>credits available · shared by every iPad</Text>
        <View style={s.bar}>
          <View style={[s.barFill, { width: `${Math.round(pct * 100)}%` }, (low || total <= 0) && { backgroundColor: Colors.error }]} />
        </View>
        <View style={s.splitRow}>
          <View style={s.splitCell}>
            <Text style={s.splitNum}>{planCredits.toLocaleString('en-IN')}</Text>
            <Text style={s.muted}>
              plan credits{included > 0 ? ` of ${included.toLocaleString('en-IN')}` : ''} · expire {fmtDate(renewalAt)}
            </Text>
          </View>
          <View style={s.splitCell}>
            <Text style={s.splitNum}>{topupCredits.toLocaleString('en-IN')}</Text>
            <Text style={s.muted}>top-up credits · never expire</Text>
          </View>
        </View>
        {total <= 0
          ? <Text style={s.warn}>Credits used up — new try-ons are paused until you renew, upgrade or add credits.</Text>
          : low && <Text style={s.warn}>Running low — {lowPct}% or less of your plan credits left.</Text>}
        <Text style={s.muted}>Plan credits are used first. Your cycle renews {fmtDate(renewalAt)}.</Text>
      </View>

      {isDemo && <Text style={s.muted}>Payments aren’t available in the preview company.</Text>}
      {!!billingError && <Text style={s.warn}>{billingError}</Text>}

      <Text style={s.label}>PLANS · MONTHLY · PRICES EXCLUDE GST</Text>
      <View style={[s.plans, stackPlans && s.plansStacked]} onLayout={(e) => setPlansWidth(e.nativeEvent.layout.width)}>
        {plans.map((p) => (
          <View key={p.id} style={[s.planCard, stackPlans ? s.planCardStack : s.planCardRow, p.current && s.planCurrent]}>
            <Text style={s.planName}>{p.name}</Text>
            <Text style={s.planPrice} numberOfLines={1}>{inr(p.priceInr)}</Text>
            <Text style={s.muted}>
              per {p.cycle === 'annual' ? 'year' : 'month'} + GST{p.totalInr != null ? ` · ${inr(p.totalInr)} total` : ''}
            </Text>
            <Text style={s.body}>{p.credits.toLocaleString('en-IN')} credits / month</Text>
            <Text style={s.muted}>{inr(Math.round(p.priceInr / p.credits))} per credit</Text>
            {p.current && <Text style={s.currentTag}>Current plan</Text>}
            {!!p.action && (
              <>
                <TouchableOpacity
                  style={[p.current ? s.planBtn : s.planBtnSolid, !p.allowed && s.btnDisabled]}
                  disabled={!p.allowed}
                  onPress={() => { if (p.totalInr != null) setPurchase({ kind: 'plan', plan: p as B2BPlanOption }) }}
                >
                  <Text style={p.current ? s.planBtnText : s.planBtnSolidText}>{PLAN_BUTTON[p.action](p.name)}</Text>
                </TouchableOpacity>
                {!p.allowed && !!p.reason && <Text style={s.reason}>{p.reason}</Text>}
              </>
            )}
          </View>
        ))}
      </View>

      <Text style={s.label}>TOP-UP CREDITS · NEVER EXPIRE</Text>
      {packs.length > 0 ? (
        <View style={[s.plans, stackPlans && s.plansStacked]}>
          {packs.map((k) => (
            <View key={k.id} style={[s.planCard, stackPlans ? s.planCardStack : s.planCardRow]}>
              <Text style={s.planName}>{k.credits.toLocaleString('en-IN')} credits</Text>
              <Text style={s.planPrice} numberOfLines={1}>{inr(k.priceInr)}</Text>
              <Text style={s.muted}>{inr(Math.round(k.priceInr / k.credits))} per credit + 18% GST · {inr(k.totalInr)} total</Text>
              <TouchableOpacity
                style={[s.planBtn, !k.allowed && s.btnDisabled]}
                disabled={!k.allowed}
                onPress={() => setPurchase({ kind: 'topup', pack: k })}
              >
                <Text style={s.planBtnText}>Buy</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}
      {packs.length > 0 && !packs[0].allowed && !!packs[0].reason && (
        <Text style={s.reason}>{packs[0].reason}</Text>
      )}
      {packs.length === 0 && (
        <View style={s.card}>
          <Text style={s.body}>Top-up packs appear here once billing loads. They are added on top of your plan and never expire.</Text>
          {!payEnabled && !!SUPPORT_EMAIL && !isDemo && (
            <TouchableOpacity style={s.primaryBtn} onPress={() => requestChange('Add credits', client.companyName)}>
              <Icon name="star" size={18} color={Colors.textOnDark} />
              <Text style={s.primaryBtnText}>Request more credits</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {billing && billing.payments.length > 0 && (
        <>
          <Text style={s.label}>PAYMENTS</Text>
          <View style={s.card}>
            {billing.payments.map((x) => (
              <View key={x.orderId} style={s.invoiceRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.body}>{x.itemName}</Text>
                  <Text style={[s.muted, x.status !== 'paid' && { color: x.status === 'review' ? Colors.warning : Colors.error }]}>
                    {inr(x.amountInr)} incl. GST · {x.status === 'paid'
                      ? `Paid ${fmtDate(x.paidAt)}`
                      : x.status === 'review' ? 'Received — being checked by Atelier support' : 'Not completed'} · {x.orderId}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </>
      )}

      <Text style={s.label}>INVOICES · PLAN PRICE EXCL. GST</Text>
      <View style={s.card}>
        {invoices.length === 0 ? (
          <Text style={s.muted}>No invoices yet — they will appear here once billing is set up.</Text>
        ) : invoices.map((inv) => {
          const planName = plans.find((p) => p.id === inv.plan_id)?.name ?? inv.plan_id
          const late = inv.payment_status === 'overdue'
          return (
            <View key={inv.id} style={s.invoiceRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.body}>{planName} · {fmtDate(inv.started_at)} – {fmtDate(inv.renewal_at)}</Text>
                <Text style={[s.muted, late && { color: Colors.error }]}>{inr(inv.amount_inr)} · {STATUS_LABEL[inv.payment_status]}</Text>
              </View>
              {!!inv.invoice_url && (
                <TouchableOpacity onPress={() => Linking.openURL(inv.invoice_url!)}>
                  <Text style={s.link}>Invoice</Text>
                </TouchableOpacity>
              )}
            </View>
          )
        })}
      </View>

      {purchase && (
        <ConfirmPurchase
          purchase={purchase}
          billing={billing}
          setupProblem={setupProblem}
          credits={{ planCredits, topupCredits }}
          onClose={() => setPurchase(null)}
          onDone={(n) => { setPurchase(null); setNotice(n); reloadAll() }}
        />
      )}
    </ScrollView>
  )
}

// ─── Confirm + Terms + pay ───────────────────────────────────────────────────

function ConfirmPurchase({ purchase, billing, setupProblem, credits, onClose, onDone }: {
  purchase: Purchase
  billing: B2BBilling | null
  /** Why payment can't start yet (Cashfree / Terms not set up), or null. */
  setupProblem: string | null
  credits: { planCredits: number; topupCredits: number }
  onClose: () => void
  onDone: (notice: Notice) => void
}) {
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState<null | 'paying' | 'confirming'>(null)
  const [error, setError] = useState<string | null>(null)
  const terms = billing?.terms ?? null
  const { planCredits, topupCredits } = credits
  const canPay = !setupProblem && !!terms

  const isPlan = purchase.kind === 'plan'
  const title = isPlan ? `${purchase.plan.name} plan` : `${purchase.pack.credits.toLocaleString('en-IN')} top-up credits`
  const item = isPlan ? purchase.plan : purchase.pack
  const gstPct = billing ? Math.round(billing.gstRate * 100) : null
  const nextRenewal = new Date(Date.now() + 30 * 86_400_000).toISOString() // display only; the server sets it

  const effects: string[] = isPlan
    ? [
        `Starts a new monthly cycle today with ${purchase.plan.credits.toLocaleString('en-IN')} plan credits (renews around ${fmtDate(nextRenewal)}).`,
        ...(purchase.plan.action === 'upgrade' ? ['Charged at the full price of the new plan — no proration.'] : []),
        ...(planCredits > 0 ? [`Your ${planCredits.toLocaleString('en-IN')} unused plan credits from the current cycle will expire.`] : []),
        ...(topupCredits > 0 ? [`Your ${topupCredits.toLocaleString('en-IN')} top-up credits are kept.`] : []),
        'Plan credits expire at the end of each cycle and do not carry forward.',
      ]
    : [
        `Adds ${purchase.pack.credits.toLocaleString('en-IN')} credits that never expire.`,
        'Top-up credits are used after your monthly plan credits and are kept through renewals and upgrades.',
      ]

  async function pay() {
    setError(null)
    setBusy('paying')
    try {
      const order = await createB2BOrder({
        kind: purchase.kind,
        itemId: isPlan ? purchase.plan.id : purchase.pack.id,
        acceptTerms: agreed,
        termsVersion: terms!.version,
        platform: Platform.OS === 'web' ? 'web' : 'native',
      })
      try {
        await openB2BCheckout(order)
      } catch {
        // Closed or failed checkout — the server check below is the authority.
      }
      setBusy('confirming')
      onDone(noticeFor(await confirmB2BPayment(order.orderId)))
    } catch (e: any) {
      setError(e?.message ?? 'Could not start the payment. Please try again.')
      setBusy(null)
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={busy ? undefined : onClose}>
      <View style={s.backdrop}>
        <View style={[s.sheet, Shadow.card]}>
          <Text style={s.sheetTitle}>{title}</Text>
          <View style={s.priceTable}>
            <View style={s.priceRow}><Text style={s.body}>Price</Text><Text style={s.body}>{inr(item.priceInr)}</Text></View>
            <View style={s.priceRow}><Text style={s.body}>GST{gstPct != null ? ` (${gstPct}%)` : ''}</Text><Text style={s.body}>{inr(item.gstInr)}</Text></View>
            <View style={[s.priceRow, s.priceTotal]}><Text style={s.planName}>Total</Text><Text style={s.sheetAmount}>{inr(item.totalInr)}</Text></View>
          </View>
          <Text style={s.muted}>Paid securely via Cashfree</Text>

          <View style={s.effects}>
            {effects.map((e) => (
              <View key={e} style={s.effectRow}>
                <Text style={s.bullet}>•</Text>
                <Text style={s.body}>{e}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity style={s.termsRow} onPress={() => setAgreed((v) => !v)} disabled={!!busy} accessibilityRole="checkbox" accessibilityState={{ checked: agreed }}>
            <View style={[s.checkbox, agreed && s.checkboxOn]}>
              {agreed && <Icon name="check" size={16} color={Colors.textOnDark} />}
            </View>
            <Text style={[s.body, { flex: 1 }]}>
              I have read and agree to the{' '}
              {terms
                ? <Text style={s.link} onPress={() => Linking.openURL(terms.url)}>Terms & Conditions</Text>
                : <Text style={s.body}>Terms & Conditions</Text>}
              {' '}on behalf of my company.
            </Text>
          </TouchableOpacity>

          {!!setupProblem && (
            <View style={[s.notice, s.noticeError]}>
              <Text style={s.noticeText}>{setupProblem}</Text>
            </View>
          )}
          {!!error && <Text style={s.warn}>{error}</Text>}

          <TouchableOpacity
            style={[s.primaryBtn, (!agreed || !canPay || !!busy) && s.btnDisabled]}
            disabled={!agreed || !canPay || !!busy}
            onPress={pay}
          >
            {busy ? <ActivityIndicator color={Colors.textOnDark} /> : <Icon name="check" size={18} color={Colors.textOnDark} />}
            <Text style={s.primaryBtnText}>
              {busy === 'paying' ? 'Opening payment…' : busy === 'confirming' ? 'Confirming payment…' : `Pay ${inr(item.totalInr)}`}
            </Text>
          </TouchableOpacity>
          {!busy && (
            <TouchableOpacity style={s.cancelBtn} onPress={onClose}>
              <Text style={s.planBtnText}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  scroll: { padding: Space.lg, paddingBottom: Space.xxl, gap: Space.md, maxWidth: 1100, width: '100%', alignSelf: 'center' },
  title: { ...Typography.h1 },
  label: { ...Typography.label, marginTop: Space.md },
  card: { backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, gap: Space.sm },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  planBadge: {
    ...Typography.label, color: Colors.textOnDark, backgroundColor: Colors.secondary,
    paddingHorizontal: Space.md, paddingVertical: 4, borderRadius: Radius.full, overflow: 'hidden',
  },
  trial: { ...Typography.label, color: Colors.warning },
  big: { ...Typography.display, fontSize: 48, lineHeight: 56, letterSpacing: 2, color: Colors.secondary },
  body: { ...Typography.body },
  splitRow: { flexDirection: 'row', gap: Space.lg, flexWrap: 'wrap' },
  splitCell: { flexGrow: 1, flexBasis: 160, gap: 2 },
  splitNum: { ...Typography.h2, color: Colors.secondary },
  invoiceRow: {
    flexDirection: 'row', alignItems: 'center', gap: Space.md,
    paddingVertical: Space.sm, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle,
  },
  link: { ...Typography.bodySmall, fontWeight: '700', color: Colors.secondary, textDecorationLine: 'underline' },
  muted: { ...Typography.bodySmall, color: Colors.textMuted },
  warn: { ...Typography.bodySmall, color: Colors.error, fontWeight: '600' },
  reason: { ...Typography.bodySmall, color: Colors.textMuted, fontStyle: 'italic' },
  bar: { height: 10, borderRadius: Radius.full, backgroundColor: Colors.bgSubtle, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: Colors.primary, borderRadius: Radius.full },
  plans: { flexDirection: 'row', gap: Space.md },
  plansStacked: { flexDirection: 'column' },
  // Row: equal shares. Stacked: natural height (basis 0 in a column collapses the cards).
  planCardRow:   { flexBasis: 0, flexGrow: 1 },
  planCardStack: { alignSelf: 'stretch' },
  planCard: {
    minWidth: 0, backgroundColor: Colors.bgCard, borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border, padding: Space.base, gap: Space.xs,
  },
  planCurrent: { borderColor: Colors.secondary, borderWidth: 2 },
  planName: { ...Typography.h3 },
  planPrice: { ...Typography.h2, color: Colors.primaryDark },
  currentTag: { ...Typography.label, color: Colors.secondary, marginTop: Space.sm },
  planBtn: { marginTop: Space.sm, borderWidth: 1.5, borderColor: Colors.secondary, borderRadius: Radius.full, paddingVertical: 10, alignItems: 'center' },
  planBtnText: { ...Typography.bodySmall, fontWeight: '700', color: Colors.secondary },
  planBtnSolid: { marginTop: Space.sm, backgroundColor: Colors.secondary, borderRadius: Radius.full, paddingVertical: 11, alignItems: 'center' },
  planBtnSolidText: { ...Typography.bodySmall, fontWeight: '700', color: Colors.textOnDark },
  btnDisabled: { opacity: 0.4 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.sm,
    backgroundColor: Colors.secondary, borderRadius: Radius.full, paddingVertical: 14, marginTop: Space.sm,
  },
  primaryBtnText: { ...Typography.body, fontWeight: '600', color: Colors.textOnDark },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm, borderRadius: Radius.lg, padding: Space.base },
  noticeOk: { backgroundColor: '#E5F2EA' },
  noticeInfo: { backgroundColor: Colors.bgSubtle },
  noticeError: { backgroundColor: '#F8E4E0' },
  noticeText: { ...Typography.body, flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: Space.lg },
  sheet: { width: '100%', maxWidth: 520, backgroundColor: Colors.bgCard, borderRadius: Radius.xl, padding: Space.lg, gap: Space.sm },
  sheetTitle: { ...Typography.h2 },
  sheetAmount: { ...Typography.h2, color: Colors.secondary },
  priceTable: { gap: Space.xs, marginTop: Space.sm },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  priceTotal: { borderTopWidth: 1, borderTopColor: Colors.borderSubtle, paddingTop: Space.xs, marginTop: Space.xs },
  effects: { gap: Space.xs, marginVertical: Space.sm },
  effectRow: { flexDirection: 'row', gap: Space.sm },
  bullet: { ...Typography.body, color: Colors.textMuted },
  termsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md, paddingVertical: Space.sm },
  checkbox: {
    width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: Colors.secondary,
    alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  checkboxOn: { backgroundColor: Colors.secondary },
  cancelBtn: { alignItems: 'center', paddingVertical: Space.sm },
})
