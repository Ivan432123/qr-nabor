// Сервер партнёрской программы «Цифровой набор для кафе».
// Логика не зависит от площадки: получает запрос {method, path, query, headers, body, ip}
// и хранилище db (Яндекс YDB — db-ydb.mjs, в тестах — db-memory.mjs).

export const RATES = {
  setup: { start: 1500, standard: 2500 },   // 50% от набора
  monthly: { start: 200, standard: 300 },   // 20% от поддержки
  maxMonths: 24,
  bonusEvery: 5,
  bonus: 2000
};
const PLANS = ['start', 'standard', 'unknown'];
const STATUSES = ['new', 'waiting', 'paid', 'lost'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400'
};
const json = (data, status = 200) => ({ status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }, body: JSON.stringify(data) });

export async function handle(req, db, env) {
  if (req.method === 'OPTIONS') return { status: 204, headers: CORS, body: '' };
  const path = String(req.path || '').replace(/\/+$/, '');
  const m = req.method;
  try {
    if (!env.TOKEN_SECRET || !env.ADMIN_PASSWORD) return json({ error: 'Не заданы секреты TOKEN_SECRET и ADMIN_PASSWORD' }, 500);
    if (m === 'GET' && (path === '' || path === '/api')) return json({ ok: true, service: 'nabor-api' });
    const ctx = { req, db, env, b: parseBody(req.body) };
    if (m === 'POST' && path === '/api/setup') return await setup(ctx);
    if (m === 'POST' && path === '/api/register') return await register(ctx);
    if (m === 'POST' && path === '/api/login') return await login(ctx);
    if (m === 'GET' && path === '/api/me') return await me(ctx);
    if (m === 'POST' && path === '/api/click') return await click(ctx);
    if (m === 'POST' && path === '/api/lead') return await lead(ctx);
    if (m === 'GET' && path === '/api/check-code') return await checkCode(ctx);
    if (m === 'POST' && path === '/api/admin/login') return await adminLogin(ctx);
    if (m === 'GET' && path === '/api/admin/data') return await adminData(ctx);
    if (m === 'POST' && path === '/api/admin/lead') return await adminLead(ctx);
    if (m === 'POST' && path === '/api/admin/payout') return await adminPayout(ctx);
    return json({ error: 'Не найдено' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: 'Ошибка сервера', detail: String(e && e.message || e).slice(0, 300) }, 500);
  }
}

/* ---------- помощники ---------- */
function parseBody(text) {
  text = String(text || '');
  if (text.length > 20000) return {};
  try { const v = JSON.parse(text || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
const header = (req, name) => {
  const h = req.headers || {};
  const k = Object.keys(h).find(x => x.toLowerCase() === name.toLowerCase());
  return k ? String(h[k]) : '';
};
const clean = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const newId = () => Date.now().toString(36) + hex(crypto.getRandomValues(new Uint8Array(5)));
const enc = new TextEncoder();
const b64u = buf => Buffer.from(buf).toString('base64url');
const hex = buf => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString('hex');

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function signToken(payload, env, days = 30) {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + days * 864e5 })).toString('base64url');
  return data + '.' + await hmac(env.TOKEN_SECRET, data);
}
async function readToken({ req, env }) {
  const h = header(req, 'Authorization');
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [data, sig] = t.split('.');
  if (!data || !sig) return null;
  if (!safeEqual(await hmac(env.TOKEN_SECRET, data), sig)) return null;
  try { const p = JSON.parse(Buffer.from(data, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
async function ipHash({ req, env }) {
  const ip = req.ip || 'local';
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(ip + '|' + env.TOKEN_SECRET + '|' + today()))).slice(0, 24);
}
function translit(name) {
  const tr = { а:'A',б:'B',в:'V',г:'G',д:'D',е:'E',ё:'E',ж:'ZH',з:'Z',и:'I',й:'Y',к:'K',л:'L',м:'M',н:'N',о:'O',п:'P',р:'R',с:'S',т:'T',у:'U',ф:'F',х:'H',ц:'C',ч:'CH',ш:'SH',щ:'SH',ы:'Y',э:'E',ю:'YU',я:'YA' };
  return [...name.split(/\s+/)[0].toLowerCase()].map(c => tr[c] ?? c.toUpperCase()).join('').replace(/[^A-Z]/g, '').slice(0, 6) || 'PARTNER';
}

/* ---------- начисления ---------- */
function leadEarned(l) {
  if (l.status !== 'paid') return 0;
  const plan = l.plan === 'standard' ? 'standard' : 'start';
  return RATES.setup[plan] + Math.min(Number(l.months) || 0, RATES.maxMonths) * RATES.monthly[plan];
}
function summarize(leads, payouts) {
  const paid = leads.filter(l => l.status === 'paid');
  const bonus = Math.floor(paid.length / RATES.bonusEvery) * RATES.bonus;
  const earned = paid.reduce((s, l) => s + leadEarned(l), 0) + bonus;
  const paidOut = payouts.reduce((s, p) => s + Number(p.amount), 0);
  return { paidCount: paid.length, earned, bonus, paidOut, balance: earned - paidOut,
           nextBonusIn: RATES.bonusEvery - (paid.length % RATES.bonusEvery) };
}
const byDateDesc = (a, b) => (a.created_at < b.created_at ? 1 : -1);

/* ---------- служебное ---------- */
async function setup({ req, db, env }) {
  if (!safeEqual(header(req, 'Authorization'), 'Bearer ' + env.ADMIN_PASSWORD)) return json({ error: 'Нет доступа' }, 401);
  await db.setup();
  return json({ ok: true });
}

/* ---------- партнёры ---------- */
async function register(ctx) {
  const { b, db, env } = ctx;
  const name = clean(b.name, 80), email = clean(b.email, 120).toLowerCase(), phone = clean(b.phone, 30);
  const status = clean(b.status, 30), source = clean(b.source, 80), password = String(b.password || '');
  if (name.length < 2) return json({ error: 'Укажите имя' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Проверьте email' }, 400);
  if (phone.replace(/\D/g, '').length < 10) return json({ error: 'Проверьте телефон' }, 400);
  if (!['Самозанятый', 'ИП'].includes(status)) return json({ error: 'Нужен статус самозанятого или ИП' }, 400);
  if (password.length < 6) return json({ error: 'Пароль — не короче 6 символов' }, 400);
  if (!b.agree) return json({ error: 'Примите условия оферты' }, 400);

  const ih = await ipHash(ctx);
  if (await db.countPartnersByIp(ih) >= 5) return json({ error: 'Слишком много регистраций с этого устройства сегодня' }, 429);
  if (await db.partnerByEmail(email)) return json({ error: 'Этот email уже зарегистрирован — войдите' }, 409);

  const base = translit(name);
  let code = '';
  for (let i = 0; i < 20; i++) {
    const c = base + String(10 + Math.floor(Math.random() * 90));
    if (!(await db.partnerByCode(c))) { code = c; break; }
  }
  if (!code) code = base + Date.now().toString().slice(-5);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const id = newId();
  await db.insertPartner({ id, name, email, phone, status, source, code, pass_hash: await hashPassword(password, salt), salt, ip_hash: ih, created_at: now() });
  return json({ token: await signToken({ role: 'partner', id }, env), code });
}

async function login({ b, db, env }) {
  const email = clean(b.email, 120).toLowerCase(), password = String(b.password || '');
  const p = await db.partnerByEmail(email);
  if (!p || !safeEqual(await hashPassword(password, p.salt), p.pass_hash)) return json({ error: 'Неверный email или пароль' }, 401);
  return json({ token: await signToken({ role: 'partner', id: p.id }, env) });
}

async function me(ctx) {
  const { db } = ctx;
  const t = await readToken(ctx);
  if (!t || t.role !== 'partner') return json({ error: 'Войдите заново' }, 401);
  const p = await db.partnerById(String(t.id));
  if (!p) return json({ error: 'Войдите заново' }, 401);
  const from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const [leads, payouts, clickRows] = await Promise.all([db.leadsByPartner(p.id), db.payoutsByPartner(p.id), db.clicksByPartnerSince(p.id, from)]);
  leads.sort(byDateDesc); payouts.sort(byDateDesc);
  const clickMap = Object.fromEntries(clickRows.map(r => [r.day, r.n]));
  const leadMap = {};
  leads.forEach(l => { const d = l.created_at.slice(0, 10); if (d >= from) leadMap[d] = (leadMap[d] || 0) + 1; });
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    daily.push({ day: d, clicks: clickMap[d] || 0, leads: leadMap[d] || 0 });
  }
  return json({
    partner: { name: p.name, email: p.email, phone: p.phone, code: p.code },
    stats: { ...summarize(leads, payouts), clicks30: daily.reduce((s, d) => s + d.clicks, 0), leads30: daily.reduce((s, d) => s + d.leads, 0), leadsTotal: leads.length },
    daily,
    leads: leads.map(l => ({ date: l.created_at, cafe: l.cafe, plan: l.plan, status: l.status, months: l.months, earned: leadEarned(l) })),
    payouts: payouts.map(x => ({ date: x.created_at, amount: x.amount, note: x.note, check: !!x.check_received })),
    rates: RATES
  });
}

async function checkCode({ req, db }) {
  const code = clean((req.query || {}).code, 20).toUpperCase();
  return json({ valid: !!(code && await db.partnerByCode(code)) });
}

/* ---------- переходы и заявки ---------- */
async function click(ctx) {
  const code = clean(ctx.b.ref, 20).toUpperCase();
  const p = code && await ctx.db.partnerByCode(code);
  if (!p) return json({ ok: false });
  await ctx.db.addClick(p.id, today(), await ipHash(ctx));
  return json({ ok: true });
}

async function lead(ctx) {
  const { b, db } = ctx;
  const name = clean(b.name, 80), cafe = clean(b.cafe, 120), phone = clean(b.phone, 30);
  const plan = PLANS.includes(b.plan) ? b.plan : 'unknown';
  if (!name || !cafe || phone.replace(/\D/g, '').length < 10) return json({ error: 'Заполните имя, название заведения и телефон' }, 400);
  if (b.website) return json({ ok: true }); // ловушка для ботов
  const ih = await ipHash(ctx);
  if (await db.countLeadsByIp(ih) >= 5) return json({ error: 'Слишком много заявок сегодня. Позвоните нам.' }, 429);
  let partnerId = '';
  for (const c of [b.ref, b.promo]) {
    const code = clean(c, 20).toUpperCase();
    if (!code) continue;
    const p = await db.partnerByCode(code);
    if (p) { partnerId = p.id; break; }
  }
  await db.insertLead({ id: newId(), created_at: now(), name, cafe, phone, plan, partner_id: partnerId, status: 'new', months: 0, paid_at: '', ip_hash: ih });
  return json({ ok: true, withPromo: !!partnerId });
}

/* ---------- админка ---------- */
async function adminLogin({ b, env }) {
  if (!safeEqual(String(b.password || ''), env.ADMIN_PASSWORD)) return json({ error: 'Неверный пароль' }, 401);
  return json({ token: await signToken({ role: 'admin' }, env, 7) });
}
async function isAdmin(ctx) { const t = await readToken(ctx); return !!(t && t.role === 'admin'); }

async function adminData(ctx) {
  if (!(await isAdmin(ctx))) return json({ error: 'Войдите заново' }, 401);
  const { db } = ctx;
  const [leads, partners, payouts, clicks] = await Promise.all([db.allLeads(), db.allPartners(), db.allPayouts(), db.clickCounts()]);
  leads.sort(byDateDesc); partners.sort(byDateDesc); payouts.sort(byDateDesc);
  const pById = Object.fromEntries(partners.map(p => [p.id, p]));
  const clickMap = Object.fromEntries(clicks.map(c => [c.partner_id, c.n]));
  return json({
    leads: leads.map(l => ({ id: l.id, date: l.created_at, name: l.name, cafe: l.cafe, phone: l.phone, plan: l.plan, status: l.status, months: l.months,
      partner: pById[l.partner_id]?.code || null, partnerName: pById[l.partner_id]?.name || null, earned: l.partner_id ? leadEarned(l) : 0 })),
    partners: partners.map(p => {
      const pl = leads.filter(l => l.partner_id === p.id);
      return { id: p.id, name: p.name, email: p.email, phone: p.phone, status: p.status, source: p.source, code: p.code, created_at: p.created_at,
        clicks: clickMap[p.id] || 0, leads: pl.length, ...summarize(pl, payouts.filter(x => x.partner_id === p.id)) };
    }),
    payouts: payouts.map(x => ({ id: x.id, date: x.created_at, partner: pById[x.partner_id]?.code || null, amount: x.amount, note: x.note, check: !!x.check_received }))
  });
}

async function adminLead(ctx) {
  if (!(await isAdmin(ctx))) return json({ error: 'Войдите заново' }, 401);
  const { b, db } = ctx;
  const id = clean(b.id, 40);
  const cur = id && await db.leadById(id);
  if (!cur) return json({ error: 'Заявка не найдена' }, 404);
  const status = STATUSES.includes(b.status) ? b.status : cur.status;
  const plan = PLANS.includes(b.plan) ? b.plan : 'unknown';
  const months = Math.max(0, Math.min(120, parseInt(b.months, 10) || 0));
  const paid_at = status === 'paid' ? (cur.paid_at || now()) : '';
  await db.updateLead(id, { status, plan, months, paid_at });
  return json({ ok: true });
}

async function adminPayout(ctx) {
  if (!(await isAdmin(ctx))) return json({ error: 'Войдите заново' }, 401);
  const { b, db } = ctx;
  const code = clean(b.partner, 20).toUpperCase();
  const amount = parseInt(b.amount, 10);
  const p = code && await db.partnerByCode(code);
  if (!p) return json({ error: 'Партнёр не найден' }, 404);
  if (!(amount > 0 && amount < 10000000)) return json({ error: 'Укажите сумму' }, 400);
  await db.insertPayout({ id: newId(), partner_id: p.id, amount, note: clean(b.note, 200), check_received: b.check ? 1 : 0, created_at: now() });
  return json({ ok: true });
}
