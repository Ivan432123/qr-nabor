// Сервер партнёрской программы «Цифровой набор для кафе»
// Cloudflare Worker + база D1 (привязка DB).
// Секреты в настройках Worker: ADMIN_PASSWORD, TOKEN_SECRET.

const RATES = {
  setup: { start: 1500, standard: 2500 },   // 50% от набора
  monthly: { start: 200, standard: 300 },   // 20% от поддержки
  maxMonths: 24,
  bonusEvery: 5,
  bonus: 2000
};
const PLANS = ['start', 'standard', 'unknown'];
const STATUSES = ['new', 'waiting', 'paid', 'lost'];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    try {
      if (!env.DB) return json({ error: 'База не подключена: добавьте привязку D1 с именем DB' }, 500);
      if (!env.TOKEN_SECRET || !env.ADMIN_PASSWORD) return json({ error: 'Не заданы секреты TOKEN_SECRET и ADMIN_PASSWORD' }, 500);

      if (request.method === 'GET' && (path === '' || path === '/api')) return json({ ok: true, service: 'nabor-api' });
      if (request.method === 'POST' && path === '/api/register') return await register(request, env);
      if (request.method === 'POST' && path === '/api/login') return await login(request, env);
      if (request.method === 'GET' && path === '/api/me') return await me(request, env);
      if (request.method === 'POST' && path === '/api/click') return await click(request, env);
      if (request.method === 'POST' && path === '/api/lead') return await lead(request, env);
      if (request.method === 'GET' && path === '/api/check-code') return await checkCode(url, env);
      if (request.method === 'POST' && path === '/api/admin/login') return await adminLogin(request, env);
      if (request.method === 'GET' && path === '/api/admin/data') return await adminData(request, env);
      if (request.method === 'POST' && path === '/api/admin/lead') return await adminLead(request, env);
      if (request.method === 'POST' && path === '/api/admin/payout') return await adminPayout(request, env);
      return json({ error: 'Не найдено' }, 404);
    } catch (e) {
      return json({ error: 'Ошибка сервера', detail: String(e && e.message || e) }, 500);
    }
  }
};

/* ---------- общие помощники ---------- */
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400'
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() } });
}
async function body(request) {
  const text = await request.text();
  if (text.length > 20000) throw new Error('Слишком большой запрос');
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}
const clean = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = s => b64u(enc.encode(s));
const fromB64uStr = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function signToken(payload, env, days = 30) {
  const data = b64uStr(JSON.stringify({ ...payload, exp: Date.now() + days * 864e5 }));
  const sig = b64u(await crypto.subtle.sign('HMAC', await hmacKey(env.TOKEN_SECRET), enc.encode(data)));
  return data + '.' + sig;
}
async function readToken(request, env) {
  const h = request.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [data, sig] = t.split('.');
  if (!data || !sig) return null;
  const good = b64u(await crypto.subtle.sign('HMAC', await hmacKey(env.TOKEN_SECRET), enc.encode(data)));
  if (!safeEqual(good, sig)) return null;
  const p = JSON.parse(fromB64uStr(data));
  return p.exp > Date.now() ? p : null;
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 20000 }, key, 256);
  return hex(bits);
}
async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
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
  const fromLeads = paid.reduce((s, l) => s + leadEarned(l), 0);
  const bonus = Math.floor(paid.length / RATES.bonusEvery) * RATES.bonus;
  const earned = fromLeads + bonus;
  const paidOut = payouts.reduce((s, p) => s + p.amount, 0);
  return { paidCount: paid.length, earned, bonus, paidOut, balance: earned - paidOut,
           nextBonusIn: RATES.bonusEvery - (paid.length % RATES.bonusEvery) };
}

/* ---------- партнёры ---------- */
async function register(request, env) {
  const b = await body(request);
  const name = clean(b.name, 80), email = clean(b.email, 120).toLowerCase(), phone = clean(b.phone, 30);
  const status = clean(b.status, 30), source = clean(b.source, 80), password = String(b.password || '');
  if (name.length < 2) return json({ error: 'Укажите имя' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Проверьте email' }, 400);
  if (phone.replace(/\D/g, '').length < 10) return json({ error: 'Проверьте телефон' }, 400);
  if (!['Самозанятый', 'ИП'].includes(status)) return json({ error: 'Нужен статус самозанятого или ИП' }, 400);
  if (password.length < 6) return json({ error: 'Пароль — не короче 6 символов' }, 400);
  if (!b.agree) return json({ error: 'Примите условия оферты' }, 400);

  const ih = await ipHash(request, env);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM partners WHERE ip_hash = ?').bind(ih).first();
  if (recent.n >= 5) return json({ error: 'Слишком много регистраций с этого устройства сегодня' }, 429);
  const exists = await env.DB.prepare('SELECT id FROM partners WHERE email = ?').bind(email).first();
  if (exists) return json({ error: 'Этот email уже зарегистрирован — войдите' }, 409);

  const base = translit(name);
  let code = '';
  for (let i = 0; i < 30; i++) {
    const c = base + String(10 + Math.floor(Math.random() * 90));
    if (!(await env.DB.prepare('SELECT id FROM partners WHERE code = ?').bind(c).first())) { code = c; break; }
  }
  if (!code) code = base + Date.now().toString().slice(-5);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const pass_hash = await hashPassword(password, salt);
  const r = await env.DB.prepare('INSERT INTO partners (name,email,phone,status,source,code,pass_hash,salt,ip_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(name, email, phone, status, source, code, pass_hash, salt, ih, now()).run();
  const id = r.meta.last_row_id;
  return json({ token: await signToken({ role: 'partner', id }, env), code });
}

async function login(request, env) {
  const b = await body(request);
  const email = clean(b.email, 120).toLowerCase(), password = String(b.password || '');
  const p = await env.DB.prepare('SELECT id, pass_hash, salt FROM partners WHERE email = ?').bind(email).first();
  if (!p || !safeEqual(await hashPassword(password, p.salt), p.pass_hash)) return json({ error: 'Неверный email или пароль' }, 401);
  return json({ token: await signToken({ role: 'partner', id: p.id }, env) });
}

async function me(request, env) {
  const t = await readToken(request, env);
  if (!t || t.role !== 'partner') return json({ error: 'Войдите заново' }, 401);
  const p = await env.DB.prepare('SELECT id,name,email,phone,status,code,created_at FROM partners WHERE id = ?').bind(t.id).first();
  if (!p) return json({ error: 'Войдите заново' }, 401);
  const leads = (await env.DB.prepare('SELECT id,created_at,cafe,plan,status,months FROM leads WHERE partner_id = ? ORDER BY created_at DESC').bind(p.id).all()).results;
  const payouts = (await env.DB.prepare('SELECT amount,note,check_received,created_at FROM payouts WHERE partner_id = ? ORDER BY created_at DESC').bind(p.id).all()).results;
  const from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const clickRows = (await env.DB.prepare('SELECT day, COUNT(*) AS n FROM clicks WHERE partner_id = ? AND day >= ? GROUP BY day').bind(p.id, from).all()).results;
  const clickMap = Object.fromEntries(clickRows.map(r => [r.day, r.n]));
  const leadMap = {};
  leads.forEach(l => { const d = l.created_at.slice(0, 10); if (d >= from) leadMap[d] = (leadMap[d] || 0) + 1; });
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    daily.push({ day: d, clicks: clickMap[d] || 0, leads: leadMap[d] || 0 });
  }
  const sum = summarize(leads, payouts);
  return json({
    partner: { name: p.name, email: p.email, phone: p.phone, code: p.code },
    stats: { ...sum, clicks30: daily.reduce((s, d) => s + d.clicks, 0), leads30: daily.reduce((s, d) => s + d.leads, 0), leadsTotal: leads.length },
    daily,
    leads: leads.map(l => ({ date: l.created_at, cafe: l.cafe, plan: l.plan, status: l.status, months: l.months, earned: leadEarned(l) })),
    payouts: payouts.map(x => ({ date: x.created_at, amount: x.amount, note: x.note, check: !!x.check_received })),
    rates: RATES
  });
}

async function checkCode(url, env) {
  const code = clean(url.searchParams.get('code'), 20).toUpperCase();
  const p = code && await env.DB.prepare('SELECT id FROM partners WHERE code = ?').bind(code).first();
  return json({ valid: !!p });
}

/* ---------- переходы и заявки ---------- */
async function click(request, env) {
  const b = await body(request);
  const code = clean(b.ref, 20).toUpperCase();
  const p = code && await env.DB.prepare('SELECT id FROM partners WHERE code = ?').bind(code).first();
  if (!p) return json({ ok: false });
  await env.DB.prepare('INSERT OR IGNORE INTO clicks (partner_id, day, ip_hash) VALUES (?,?,?)').bind(p.id, today(), await ipHash(request, env)).run();
  return json({ ok: true });
}

async function lead(request, env) {
  const b = await body(request);
  const name = clean(b.name, 80), cafe = clean(b.cafe, 120), phone = clean(b.phone, 30);
  const plan = PLANS.includes(b.plan) ? b.plan : 'unknown';
  if (!name || !cafe || phone.replace(/\D/g, '').length < 10) return json({ error: 'Заполните имя, название заведения и телефон' }, 400);
  if (b.website) return json({ ok: true }); // ловушка для ботов
  const ih = await ipHash(request, env);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM leads WHERE ip_hash = ?').bind(ih).first();
  if (n.n >= 5) return json({ error: 'Слишком много заявок сегодня. Позвоните нам.' }, 429);
  let partnerId = null;
  for (const c of [b.ref, b.promo]) {
    const code = clean(c, 20).toUpperCase();
    if (!code) continue;
    const p = await env.DB.prepare('SELECT id FROM partners WHERE code = ?').bind(code).first();
    if (p) { partnerId = p.id; break; }
  }
  await env.DB.prepare('INSERT INTO leads (created_at,name,cafe,phone,plan,partner_id,ip_hash) VALUES (?,?,?,?,?,?,?)')
    .bind(now(), name, cafe, phone, plan, partnerId, ih).run();
  return json({ ok: true, withPromo: !!partnerId });
}

/* ---------- админка ---------- */
async function adminLogin(request, env) {
  const b = await body(request);
  if (!safeEqual(String(b.password || ''), env.ADMIN_PASSWORD)) return json({ error: 'Неверный пароль' }, 401);
  return json({ token: await signToken({ role: 'admin' }, env, 7) });
}
async function requireAdmin(request, env) {
  const t = await readToken(request, env);
  return t && t.role === 'admin';
}
async function adminData(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Войдите заново' }, 401);
  const leads = (await env.DB.prepare('SELECT l.*, p.code AS partner_code, p.name AS partner_name FROM leads l LEFT JOIN partners p ON p.id = l.partner_id ORDER BY l.created_at DESC').all()).results;
  const partners = (await env.DB.prepare('SELECT id,name,email,phone,status,source,code,created_at FROM partners ORDER BY created_at DESC').all()).results;
  const payouts = (await env.DB.prepare('SELECT x.*, p.code AS partner_code FROM payouts x LEFT JOIN partners p ON p.id = x.partner_id ORDER BY x.created_at DESC').all()).results;
  const clicks = (await env.DB.prepare('SELECT partner_id, COUNT(*) AS n FROM clicks GROUP BY partner_id').all()).results;
  const clickMap = Object.fromEntries(clicks.map(c => [c.partner_id, c.n]));
  const partnersOut = partners.map(p => ({
    ...p, clicks: clickMap[p.id] || 0, leads: leads.filter(l => l.partner_id === p.id).length,
    ...summarize(leads.filter(l => l.partner_id === p.id), payouts.filter(x => x.partner_id === p.id))
  }));
  return json({
    leads: leads.map(l => ({ id: l.id, date: l.created_at, name: l.name, cafe: l.cafe, phone: l.phone, plan: l.plan, status: l.status, months: l.months, partner: l.partner_code, partnerName: l.partner_name, earned: l.partner_id ? leadEarned(l) : 0 })),
    partners: partnersOut,
    payouts: payouts.map(x => ({ id: x.id, date: x.created_at, partner: x.partner_code, amount: x.amount, note: x.note, check: !!x.check_received }))
  });
}
async function adminLead(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Войдите заново' }, 401);
  const b = await body(request);
  const id = Number(b.id);
  const cur = await env.DB.prepare('SELECT status, paid_at FROM leads WHERE id = ?').bind(id).first();
  if (!cur) return json({ error: 'Заявка не найдена' }, 404);
  const status = STATUSES.includes(b.status) ? b.status : cur.status;
  const plan = PLANS.includes(b.plan) ? b.plan : 'unknown';
  const months = Math.max(0, Math.min(120, parseInt(b.months, 10) || 0));
  const paidAt = status === 'paid' ? (cur.paid_at || now()) : null;
  await env.DB.prepare('UPDATE leads SET status = ?, plan = ?, months = ?, paid_at = ? WHERE id = ?').bind(status, plan, months, paidAt, id).run();
  return json({ ok: true });
}
async function adminPayout(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Войдите заново' }, 401);
  const b = await body(request);
  const code = clean(b.partner, 20).toUpperCase();
  const amount = parseInt(b.amount, 10);
  const p = await env.DB.prepare('SELECT id FROM partners WHERE code = ?').bind(code).first();
  if (!p) return json({ error: 'Партнёр не найден' }, 404);
  if (!(amount > 0)) return json({ error: 'Укажите сумму' }, 400);
  await env.DB.prepare('INSERT INTO payouts (partner_id, amount, note, check_received, created_at) VALUES (?,?,?,?,?)')
    .bind(p.id, amount, clean(b.note, 200), b.check ? 1 : 0, now()).run();
  return json({ ok: true });
}
