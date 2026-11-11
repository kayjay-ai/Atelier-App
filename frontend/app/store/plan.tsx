import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, Linking, useWindowDimensions, Platform } from 'react-native'
import { useFocusEffect, useGlobalSearchParams, useRouter } from 'expo-router'
import { supabase } from '../../lib/supabaseClient'
import { useAccountStore, usableCredits } from '../../lib/account'
import { SUPPORT_EMAIL } from '../../lib/b2b'
import { inr } from '../../lib/pricing'
import {
  fetchB2BBilling, createB2BOrder, type B2BBilling, type B2BPlanOption, type B2BTopupPack, type B2BPaymentStatus,
} from '../../lib/api'
import { openB2BCheckout, confirmB2BPayment } from '../../lib/b2bCheckout'
import { Colors, Typography, Space, Radius, Weight } from '../../lib/theme'
import { Card, Checkbox, Notice, Page, PageHeader, PillButton, SectionHeader, Sheet, Tag, TextLink } from '../../lib/ui'

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

// Bigger than the current plan → "Upgrade"; smaller (or no current plan) →
// "Choose". The current plan has no button while it's live; once it has lapsed
// it shows "Renew", since a store pays for each cycle (nothing auto-renews yet).
// What each button may do still comes from the server (action / allowed).
function planButtonLabel(p: { priceInr: number; current: boolean }, currentPrice: number | null): string {
  if (p.current) return 'Renew'
  return currentPrice != null && p.priceInr > currentPrice ? 'Upgrade' : 'Choose'
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

  const loadBilling = useCallback(async () => {
    if (!clientId) return
    try {
      setBilling(await fetchB2BBilling())
      setBillingError(null)
    } catch (e: any) {
      setBillingError(e?.message ?? 'Could not load billing.')
    }
  }, [clientId])

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
    if (!orderId || confirmedReturn.current === orderId || !clientId) return
    confirmedReturn.current = orderId
    confirmB2BPayment(orderId)
      .then((st) => setNotice(noticeFor(st)))
      .catch((e) => setNotice({ tone: 'error', text: e?.message ?? 'Could not check the payment.' }))
      .finally(() => { reloadAll(); router.setParams({ order_id: undefined }) })
  }, [params.order_id, clientId, reloadAll, router])

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
  const currentPrice = plans.find((p) => p.current)?.priceInr ?? null
  const nowMs = Date.now()
  const trialEnded = !!client.trialEndsAt && !renewalAt && Date.parse(client.trialEndsAt) < nowMs
  const planLapsed = client.status === 'suspended' || trialEnded || (!!renewalAt && Date.parse(renewalAt) < nowMs)

  // Why payment can't start yet (shown in the confirm step), or null when it can.
  const setupProblem = !billing
      ? `${billingError ?? 'Billing is not available right now.'} Please try again later or contact Atelier support.`
      : billing.setup?.database === false
        ? 'Online payment isn’t switched on yet (the billing database update hasn’t been applied). Contact Atelier support.'
      : !billing.setup?.cashfree
        ? 'Online payment isn’t switched on yet (Cashfree is not configured). Contact Atelier support.'
        : !billing.setup?.terms
          ? 'Online payment isn’t switched on yet (the Terms & Conditions are not published). Contact Atelier support.'
          : null

  const statusTone = (st: string) => (st === 'paid' ? 'success' : st === 'review' ? 'warning' : 'error') as 'success' | 'warning' | 'error'

  return (
    <Page width="wide">
      <PageHeader title="Plan & Credits" subtitle="Credits are shared by every iPad in this store." />

      {notice && (
        <Notice tone={notice.tone === 'ok' ? 'success' : notice.tone === 'error' ? 'error' : 'info'} text={notice.text} onClose={() => setNotice(null)} />
      )}

      <View style={s.hero}>
        <View style={s.heroMain}>
          <View style={s.planRow}>
            <Tag label={billing?.store.planName ?? plan?.name ?? 'No plan'} tone="neutral" />
            {client.status === 'trial' && <Tag label={`Trial${client.trialEndsAt ? ` · ends ${fmtDate(client.trialEndsAt)}` : ''}`} tone="warning" />}
          </View>
          <Text style={s.big}>{total.toLocaleString('en-IN')}</Text>
          <Text style={s.heroLine}>credits available</Text>
          <View style={s.bar} accessibilityLabel={`${Math.round(pct * 100)}% of plan credits left`}>
            <View style={[s.barFill, { width: `${Math.round(pct * 100)}%` }, (low || total <= 0) && { backgroundColor: '#E58C7B' }]} />
          </View>
        </View>
        <View style={s.heroSplit}>
          <View style={s.splitCell}>
            <Text style={s.splitNum}>{planCredits.toLocaleString('en-IN')}</Text>
            <Text style={s.heroMuted}>plan credits{included > 0 ? ` of ${included.toLocaleString('en-IN')}` : ''} · expire {fmtDate(renewalAt)}</Text>
          </View>
          <View style={s.splitCell}>
            <Text style={s.splitNum}>{topupCredits.toLocaleString('en-IN')}</Text>
            <Text style={s.heroMuted}>top-up credits · never expire</Text>
          </View>
          <Text style={s.heroMuted}>Plan credits are used first. Your cycle renews {fmtDate(renewalAt)}.</Text>
        </View>
      </View>

      {total <= 0
        ? <Notice tone="error" title="Credits used up" text="New try-ons are paused until you renew, upgrade or add top-up credits." />
        : low && <Notice tone="warning" text={`Running low — ${lowPct}% or less of your plan credits are left.`} />}
      {!!billingError && <Notice tone="error" text={billingError} actionLabel="Try again" onAction={reloadAll} />}

      <View style={s.block}>
        <SectionHeader title="Plans" detail="Monthly. Prices exclude 18% GST." />
        <View style={[s.plans, stackPlans && s.plansStacked]} onLayout={(e) => setPlansWidth(e.nativeEvent.layout.width)}>
          {plans.map((p) => {
            const showButton = !!p.action && !(p.current && !planLapsed)
            const upgrade = planButtonLabel(p, currentPrice) === 'Upgrade'
            return (
              <View key={p.id} style={[s.planCard, stackPlans ? s.planCardStack : s.planCardRow, p.current && s.planCurrent]}>
                <View style={s.cardHead}>
                  <Text style={s.planName}>{p.name}</Text>
                  {p.current && <Tag label="Current plan" tone="dark" />}
                </View>
                <Text style={s.planPrice} numberOfLines={1}>{inr(p.priceInr)}</Text>
                <Text style={s.muted}>per {p.cycle === 'annual' ? 'year' : 'month'} + GST{p.totalInr != null ? ` · ${inr(p.totalInr)} total` : ''}</Text>
                <Text style={s.planCredits}>{p.credits.toLocaleString('en-IN')} credits a month</Text>
                <View style={{ flexGrow: 1 }} />
                {showButton && (
                  <PillButton
                    label={planButtonLabel(p, currentPrice)} size="md"
                    variant={upgrade ? 'secondary' : 'outline'}
                    disabled={!p.allowed}
                    onPress={() => { if (p.totalInr != null) setPurchase({ kind: 'plan', plan: p as B2BPlanOption }) }}
                    style={{ marginTop: Space.base }}
                  />
                )}
                {showButton && !p.allowed && !!p.reason && <Text style={s.reason}>{p.reason}</Text>}
              </View>
            )
          })}
        </View>
      </View>

      <View style={s.block}>
        <SectionHeader title="Top-up credits" detail="Added on top of your plan. They never expire." />
        {packs.length > 0 ? (
          <>
            <View style={[s.plans, stackPlans && s.plansStacked]}>
              {packs.map((k) => (
                <View key={k.id} style={[s.planCard, s.packCard, stackPlans ? s.planCardStack : s.planCardRow]}>
                  <View style={{ flex: 1, minWidth: 140, gap: 2 }}>
                    <Text style={s.planName}>{k.credits.toLocaleString('en-IN')} credits</Text>
                    <Text style={s.muted}>{inr(k.priceInr)} + 18% GST · {inr(k.totalInr)} total</Text>
                  </View>
                  <PillButton label="Buy" size="sm" variant="outline" disabled={!k.allowed} onPress={() => setPurchase({ kind: 'topup', pack: k })} style={{ minWidth: 96 }} />
                </View>
              ))}
            </View>
            {!packs[0].allowed && !!packs[0].reason && <Text style={s.reason}>{packs[0].reason}</Text>}
          </>
        ) : (
          <Card variant="sunken">
            <Text style={s.body}>Top-up packs appear here once billing loads.</Text>
            {!payEnabled && !!SUPPORT_EMAIL && (
              <PillButton label="Request more credits" icon="mail" size="md" onPress={() => requestChange('Add credits', client.companyName)} style={{ alignSelf: 'flex-start' }} />
            )}
          </Card>
        )}
      </View>

      {billing && billing.payments.length > 0 && (
        <View style={s.block}>
          <SectionHeader title="Payments" detail="Amounts include GST." />
          <Card padded={false}>
            {billing.payments.map((x, i) => (
              <View key={x.orderId} style={[s.listRow, i > 0 && s.listBorder]}>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={s.bodyStrong}>{x.itemName}</Text>
                  <Text style={s.muted} numberOfLines={1}>
                    {x.status === 'paid' ? `Paid ${fmtDate(x.paidAt)}` : x.status === 'review' ? 'Received — being checked by Atelier support' : 'Not completed'} · {x.orderId}
                  </Text>
                </View>
                <View style={s.listRight}>
                  <Text style={s.amount}>{inr(x.amountInr)}</Text>
                  <Tag label={x.status === 'paid' ? 'Paid' : x.status === 'review' ? 'In review' : 'Failed'} tone={statusTone(x.status)} />
                </View>
              </View>
            ))}
          </Card>
        </View>
      )}

      <View style={s.block}>
        <SectionHeader title="Invoices" detail="Plan price, excluding GST." />
        <Card padded={false}>
          {invoices.length === 0 ? (
            <Text style={[s.muted, { padding: Space.lg }]}>No invoices yet. They appear here after your first plan payment.</Text>
          ) : invoices.map((inv, i) => {
            const planName = plans.find((p) => p.id === inv.plan_id)?.name ?? inv.plan_id
            const tone = inv.payment_status === 'paid' ? 'success' : inv.payment_status === 'overdue' ? 'error' : inv.payment_status === 'due' ? 'warning' : 'neutral'
            return (
              <View key={inv.id} style={[s.listRow, i > 0 && s.listBorder]}>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={s.bodyStrong}>{planName}</Text>
                  <Text style={s.muted}>{fmtDate(inv.started_at)} – {fmtDate(inv.renewal_at)}</Text>
                </View>
                <View style={s.listRight}>
                  <Text style={s.amount}>{inr(inv.amount_inr)}</Text>
                  <Tag label={STATUS_LABEL[inv.payment_status]} tone={tone as any} />
                  {!!inv.invoice_url && <TextLink label="Invoice" icon="download" onPress={() => Linking.openURL(inv.invoice_url!)} />}
                </View>
              </View>
            )
          })}
        </Card>
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
    </Page>
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
    <Sheet visible title={title} onClose={onClose} closeDisabled={!!busy}>
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: Space.base }}>
        <View style={s.priceTable}>
          <View style={s.priceRow}><Text style={s.body}>Price</Text><Text style={s.body}>{inr(item.priceInr)}</Text></View>
          <View style={s.priceRow}><Text style={s.body}>GST{gstPct != null ? ` (${gstPct}%)` : ''}</Text><Text style={s.body}>{inr(item.gstInr)}</Text></View>
          <View style={[s.priceRow, s.priceTotal]}><Text style={s.bodyStrong}>Total</Text><Text style={s.sheetAmount}>{inr(item.totalInr)}</Text></View>
        </View>

        <View style={s.effects}>
          {effects.map((e) => (
            <View key={e} style={s.effectRow}>
              <View style={s.effectDot} />
              <Text style={[s.bodySmall, { flex: 1 }]}>{e}</Text>
            </View>
          ))}
        </View>

        <Checkbox checked={agreed} onChange={setAgreed} disabled={!!busy}>
          <Text style={s.bodySmall}>
            I have read and agree to the{' '}
            {terms
              ? <Text style={s.link} onPress={() => Linking.openURL(terms.url)}>Terms & Conditions</Text>
              : 'Terms & Conditions'}
            {' '}on behalf of my company.
          </Text>
        </Checkbox>

        {!!setupProblem && <Notice tone="error" text={setupProblem} />}
        {!!error && <Notice tone="error" text={error} />}

        <PillButton
          icon={busy ? undefined : 'lock'}
          label={busy === 'paying' ? 'Opening payment…' : busy === 'confirming' ? 'Confirming payment…' : `Pay ${inr(item.totalInr)}`}
          loading={!!busy}
          disabled={!agreed || !canPay || !!busy}
          onPress={pay}
        />
        <Text style={s.secure}>Paid securely through Cashfree.</Text>
      </ScrollView>
    </Sheet>
  )
}

const s = StyleSheet.create({
  block: { gap: Space.base },
  hero: {
    flexDirection: 'row', flexWrap: 'wrap', gap: Space.xl, backgroundColor: Colors.bgDark, borderRadius: Radius.xl, padding: Space.xl,
  },
  heroMain: { flexBasis: 280, flexGrow: 1.4, gap: Space.xs },
  heroSplit: { flexBasis: 260, flexGrow: 1, gap: Space.base, justifyContent: 'flex-end' },
  planRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Space.sm, marginBottom: Space.sm },
  big: { ...Typography.numeral, fontSize: 64, lineHeight: 70, color: Colors.textOnDark },
  heroLine: { ...Typography.body, color: Colors.textOnDarkMuted },
  heroMuted: { ...Typography.bodySmall, color: Colors.textOnDarkMuted },
  bar: { height: 8, borderRadius: 4, backgroundColor: 'rgba(250,248,245,0.14)', overflow: 'hidden', marginTop: Space.base },
  barFill: { height: '100%', backgroundColor: Colors.primary, borderRadius: 4 },
  splitCell: { gap: 2 },
  splitNum: { ...Typography.numeral, fontSize: 28, lineHeight: 34, color: Colors.textOnDark },

  plans: { flexDirection: 'row', gap: Space.md },
  plansStacked: { flexDirection: 'column' },
  // Row: equal shares. Stacked: natural height (basis 0 in a column collapses the cards).
  planCardRow:   { flexBasis: 0, flexGrow: 1 },
  planCardStack: { alignSelf: 'stretch' },
  planCard: {
    minWidth: 0, backgroundColor: Colors.bgCard, borderRadius: Radius.xl,
    borderWidth: 1, borderColor: Colors.border, padding: Space.lg, gap: Space.xs,
  },
  planCurrent: { borderColor: Colors.secondary, borderWidth: 2 },
  packCard: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Space.base, borderRadius: Radius.lg },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Space.sm, minHeight: 26 },
  planName: { ...Typography.h3 },
  planPrice: { ...Typography.numeral, fontSize: 34, lineHeight: 42, marginTop: Space.sm },
  planCredits: { ...Typography.body, ...Weight.medium, marginTop: Space.xs },
  reason: { ...Typography.caption, marginTop: Space.xs },

  body: { ...Typography.body },
  bodySmall: { ...Typography.bodySmall },
  bodyStrong: { ...Typography.body, ...Weight.semibold },
  muted: { ...Typography.bodySmall, color: Colors.textMuted },
  amount: { ...Typography.body, ...Weight.semibold, fontVariant: ['tabular-nums'] },
  link: { ...Weight.semibold, color: Colors.secondary, textDecorationLine: 'underline' },
  listRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Space.md, paddingVertical: Space.base, paddingHorizontal: Space.lg },
  listBorder: { borderTopWidth: 1, borderTopColor: Colors.borderSubtle },
  listRight: { flexDirection: 'row', alignItems: 'center', gap: Space.md },

  priceTable: { gap: Space.sm, backgroundColor: Colors.bgSubtle, borderRadius: Radius.lg, padding: Space.base },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  priceTotal: { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: Space.sm, marginTop: Space.xs },
  sheetAmount: { ...Typography.numeral, fontSize: 26, lineHeight: 32 },
  effects: { gap: Space.sm },
  effectRow: { flexDirection: 'row', gap: Space.md, alignItems: 'flex-start' },
  effectDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.primary, marginTop: 8 },
  secure: { ...Typography.caption, textAlign: 'center' },
})
