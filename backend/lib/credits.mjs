import { serviceDb } from './db.mjs'

/** Credits consumed per AI action (size assistant is free). */
export const CREDIT_COSTS = {
  tryon: 1,
  style: 1,
  color: 1,
  size: 0,
}

const INSUFFICIENT_COMPANY = 'This partner has used all their Atelier credits.'
const INSUFFICIENT_USER = 'You have reached your try-on limit for this store.'
const UNKNOWN_COMPANY = 'Unknown partner — credits could not be verified.'

/** In-memory fallback when Supabase service role is not configured (local dev). */
const memoryCompanies = new Map([
  [
    'verve',
    {
      id: 'verve',
      name: 'VERVE',
      credit_balance: Number(process.env.VERVE_CREDIT_BALANCE ?? 100),
      credit_pool: Number(process.env.VERVE_CREDIT_POOL ?? 100),
      user_credit_limit: Number(process.env.VERVE_USER_CREDIT_LIMIT ?? -1),
      allowed_origins: ['http://localhost:5199', 'http://127.0.0.1:5199'],
      active: true,
    },
  ],
])

const memoryLedger = []

function normalizeOrigin(origin) {
  if (!origin) return null
  try {
    const u = new URL(origin)
    return `${u.protocol}//${u.host}`
  } catch {
    return origin.replace(/\/$/, '')
  }
}

function originAllowed(company, referrerOrigin) {
  if (!referrerOrigin) return true
  const normalized = normalizeOrigin(referrerOrigin)
  if (!company.allowed_origins?.length) return true
  return company.allowed_origins.some((o) => normalizeOrigin(o) === normalized)
}

async function fetchCompany(companyId, referrerOrigin) {
  const admin = serviceDb()
  if (admin) {
    const { data, error } = await admin
      .from('companies')
      .select('id, name, credit_balance, credit_pool, user_credit_limit, allowed_origins, active')
      .eq('id', companyId)
      .eq('active', true)
      .maybeSingle()
    if (error) throw error
    if (!data) return null
    if (!originAllowed(data, referrerOrigin)) return null
    return data
  }

  const mem = memoryCompanies.get(companyId)
  if (!mem?.active) return null
  if (!originAllowed(mem, referrerOrigin)) return null
  return mem
}

async function sumUserCredits(companyId, userId, guestId) {
  const admin = serviceDb()
  if (admin) {
    let q = admin.from('credit_ledger').select('credits').eq('company_id', companyId)
    if (userId) q = q.eq('user_id', userId)
    else if (guestId) q = q.eq('guest_id', guestId)
    else return 0
    const { data, error } = await q
    if (error) throw error
    return (data ?? []).reduce((n, row) => n + row.credits, 0)
  }

  return memoryLedger
    .filter((row) => {
      if (row.company_id !== companyId) return false
      if (userId) return row.user_id === userId
      if (guestId) return row.guest_id === guestId
      return false
    })
    .reduce((n, row) => n + row.credits, 0)
}

export async function getCreditStatus({ companyId, userId, guestId, referrerOrigin }) {
  if (!companyId) {
    return { enabled: false, companyId: null, companyRemaining: null, userUsed: 0, userLimit: -1, userRemaining: null }
  }

  const company = await fetchCompany(companyId, referrerOrigin)
  if (!company) {
    return {
      enabled: true,
      companyId,
      error: UNKNOWN_COMPANY,
      companyRemaining: 0,
      companyPool: 0,
      userUsed: 0,
      userLimit: -1,
      userRemaining: null,
    }
  }

  const userUsed = userId || guestId ? await sumUserCredits(companyId, userId ?? null, guestId ?? null) : 0
  const userLimit = company.user_credit_limit ?? -1
  const userRemaining = userLimit === -1 ? null : Math.max(0, userLimit - userUsed)

  return {
    enabled: true,
    companyId: company.id,
    companyName: company.name,
    companyRemaining: company.credit_balance,
    companyPool: company.credit_pool,
    userUsed,
    userLimit,
    userRemaining,
    referrerOrigin: normalizeOrigin(referrerOrigin) ?? referrerOrigin ?? null,
  }
}

export async function consumeCredits({
  companyId,
  userId,
  guestId,
  referrerOrigin,
  action,
}) {
  const cost = CREDIT_COSTS[action] ?? 1
  if (!companyId || cost <= 0) {
    return { ok: true, charged: 0, status: await getCreditStatus({ companyId, userId, guestId, referrerOrigin }) }
  }

  if (!userId && !guestId) {
    return {
      ok: false,
      charged: 0,
      error: 'Missing user or guest id for credit tracking.',
      code: 'MissingActor',
    }
  }

  const company = await fetchCompany(companyId, referrerOrigin)
  if (!company) {
    return { ok: false, charged: 0, error: UNKNOWN_COMPANY, code: 'UnknownCompany' }
  }

  const userUsed = await sumUserCredits(companyId, userId ?? null, guestId ?? null)
  const userLimit = company.user_credit_limit ?? -1
  if (userLimit !== -1 && userUsed + cost > userLimit) {
    return {
      ok: false,
      charged: 0,
      error: INSUFFICIENT_USER,
      code: 'UserLimitExceeded',
      status: await getCreditStatus({ companyId, userId, guestId, referrerOrigin }),
    }
  }

  if (company.credit_balance < cost) {
    return {
      ok: false,
      charged: 0,
      error: INSUFFICIENT_COMPANY,
      code: 'CompanyBalanceExceeded',
      status: await getCreditStatus({ companyId, userId, guestId, referrerOrigin }),
    }
  }

  const admin = serviceDb()
  if (admin) {
    const newBalance = company.credit_balance - cost
    const { error: updateError } = await admin
      .from('companies')
      .update({ credit_balance: newBalance, updated_at: new Date().toISOString() })
      .eq('id', companyId)
      .eq('credit_balance', company.credit_balance)

    if (updateError) throw updateError

    const { error: insertError } = await admin.from('credit_ledger').insert({
      company_id: companyId,
      user_id: userId ?? null,
      guest_id: guestId ?? null,
      referrer_origin: normalizeOrigin(referrerOrigin) ?? referrerOrigin ?? '',
      action,
      credits: cost,
    })
    if (insertError) {
      await admin.from('companies').update({ credit_balance: company.credit_balance }).eq('id', companyId)
      throw insertError
    }

    company.credit_balance = newBalance
  } else {
    company.credit_balance -= cost
    memoryCompanies.set(companyId, company)
    memoryLedger.push({
      company_id: companyId,
      user_id: userId ?? null,
      guest_id: guestId ?? null,
      referrer_origin: normalizeOrigin(referrerOrigin) ?? referrerOrigin ?? '',
      action,
      credits: cost,
    })
  }

  return {
    ok: true,
    charged: cost,
    status: {
      enabled: true,
      companyId: company.id,
      companyName: company.name,
      companyRemaining: company.credit_balance,
      companyPool: company.credit_pool,
      userUsed: userUsed + cost,
      userLimit,
      userRemaining: userLimit === -1 ? null : Math.max(0, userLimit - userUsed - cost),
      referrerOrigin: normalizeOrigin(referrerOrigin) ?? referrerOrigin ?? null,
    },
  }
}

export function creditContextFromBody(body = {}) {
  return {
    companyId: body.companyId ?? body.company ?? null,
    userId: body.userId ?? null,
    guestId: body.guestId ?? null,
    referrerOrigin: body.referrerOrigin ?? body.store ?? null,
  }
}

export function creditDeniedResponse(res, result) {
  return res.status(402).json({
    fallback: true,
    message: result.error ?? INSUFFICIENT_COMPANY,
    error: { status: 402, type: result.code ?? 'CreditsExceeded', message: result.error },
    credits: result.status ?? null,
  })
}
