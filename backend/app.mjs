// Сервер партнёрской программы «Цифровой набор для кафе».
// Логика не зависит от площадки: получает запрос {method, path, query, headers, body, ip}
// и хранилище db (Яндекс YDB — db-ydb.mjs, в тестах — db-memory.mjs).

export const RATES = {
  setup: { start: 2950, standard: 4450,     // 50% от набора: «Старт» 5 890 ₽, «Стандарт» 8 890 ₽
           start_promo: 1500, standard_promo: 2250 },  // акция для первых 10 заведений: 2 990 ₽ / 4 490 ₽ (тоже 50%)
  monthly: { start: 158, standard: 158, start_promo: 158, standard_promo: 158 },   // 20% от поддержки 790 ₽/мес (поддержка необязательна)
  monthlyYear: 132,
  cabinet: 198, cabinetYear: 165,           // 20% от кабинета «Сам себе админ»: 990 ₽/мес или 9 900 ₽/год (825 ₽/мес)                         // при оплате за год (7 900 ₽ ≈ 658 ₽/мес) — 20%
  maxMonths: 24,
  team: [0.10, 0.05]                        // доля от заработка приглашённых партнёров: 1-й и 2-й уровень
};
const PLANS = ['start', 'standard', 'start_promo', 'standard_promo', 'unknown'];
// Акционные пакеты ставит только админ при оплате; с публичной формы и из кабинета их выбрать нельзя
const PUBLIC_PLANS = ['start', 'standard', 'unknown'];
const STATUSES = ['new', 'waiting', 'paid', 'lost'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Auth',
  'Access-Control-Max-Age': '86400'
};
const json = (data, status = 200) => ({ status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }, body: JSON.stringify(data) });

// mail: { enabled: bool, send(to, subject, text) } — отправка писем с кодами (см. mail.mjs)
export async function handle(req, db, env, mail = { enabled: false }) {
  if (req.method === 'OPTIONS') return { status: 204, headers: CORS, body: '' };
  const path = String(req.path || '').replace(/\/+$/, '');
  const m = req.method;
  try {
    if (!env.TOKEN_SECRET || !env.ADMIN_PASSWORD) return json({ error: 'Не заданы секреты TOKEN_SECRET и ADMIN_PASSWORD' }, 500);
    if (m === 'GET' && (path === '' || path === '/api')) return json({ ok: true, service: 'nabor-api', emailCodes: !!mail.enabled });
    const ctx = { req, db, env, mail, b: parseBody(req.body, /^\/api\/(owner\/menu|admin\/cafe)$/.test(path) ? 200000 : 20000) };
    if (m === 'POST' && path === '/api/setup') return await setup(ctx);
    if (m === 'POST' && path === '/api/tg-test') return await tgTest(ctx);
    if (m === 'POST' && path === '/api/register') return await register(ctx);
    if (m === 'POST' && path === '/api/login') return await login(ctx);
    if (m === 'POST' && path === '/api/password/code') return await passwordCode(ctx);
    if (m === 'POST' && path === '/api/password/reset') return await passwordReset(ctx);
    if (m === 'GET' && path === '/api/me') return await me(ctx);
    if (m === 'POST' && path === '/api/click') return await click(ctx);
    if (m === 'POST' && path === '/api/lead') return await lead(ctx);
    if (m === 'GET' && path === '/api/check-code') return await checkCode(ctx);
    if (m === 'POST' && path === '/api/admin/login') return await adminLogin(ctx);
    if (m === 'GET' && path === '/api/admin/data') return await adminData(ctx);
    if (m === 'POST' && path === '/api/admin/lead') return await adminLead(ctx);
    if (m === 'POST' && path === '/api/admin/payout') return await adminPayout(ctx);
    if (m === 'POST' && path === '/api/admin/delete') return await adminDelete(ctx);
    if (m === 'POST' && path === '/api/admin/reset-password') return await adminResetPassword(ctx);
    if (m === 'POST' && path === '/api/admin/test-mail') return await adminTestMail(ctx);
    if (m === 'GET' && path === '/api/menu') return await publicMenu(ctx);
    if (m === 'POST' && path === '/api/owner/code') return await ownerCode(ctx);
    if (m === 'POST' && path === '/api/owner/login') return await ownerLogin(ctx);
    if (m === 'GET' && path === '/api/owner/menu') return await ownerMenu(ctx);
    if (m === 'POST' && path === '/api/owner/menu') return await ownerSave(ctx);
    if (m === 'POST' && path === '/api/owner/rollback') return await ownerRollback(ctx);
    if (m === 'GET' && path === '/api/admin/cafes') return await adminCafes(ctx);
    if (m === 'POST' && path === '/api/admin/cafe') return await adminCafe(ctx);
    return json({ error: 'Не найдено' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: 'Ошибка сервера', detail: String(e && e.message || e).slice(0, 300) }, 500);
  }
}

/* ---------- уведомления в Telegram ---------- */
// Заявки и новые партнёры дублируются в Telegram. Без TG_BOT_TOKEN/TG_CHAT_ID — молча выключено.
// Сбой Telegram никогда не ломает заявку: ждём не дольше 3 секунд (функция может завершиться раньше, чем уйдёт запрос без await).
async function notify(ctx, text, timeoutMs = 3000) {
  const [tg, email] = await Promise.all([notifyTelegram(ctx.env, text, timeoutMs), notifyEmail(ctx, text)]);
  return { telegram: tg, email };
}

// Дубль на почту: Telegram из облака Яндекса может быть недоступен, а SMTP работает. Адрес — NOTIFY_EMAIL или сам ящик отправителя.
async function notifyEmail({ env, mail }, text) {
  const to = env.NOTIFY_EMAIL || env.SMTP_USER;
  if (!mail || !mail.enabled || !to) return { ok: false, error: 'почта не настроена' };
  const t0 = Date.now();
  try {
    const info = await mail.send(to, String(text).split('\n')[0].slice(0, 100), String(text).slice(0, 3500));
    const mask = a => String(a || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
    return { ok: true, ms: Date.now() - t0, from: mask(env.SMTP_USER), to: mask(to), accepted: info && info.accepted ? info.accepted.map(mask) : undefined, rejected: info && info.rejected ? info.rejected.map(mask) : undefined, smtp: info && info.response ? String(info.response).slice(0, 120) : undefined };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 120);
    console.error('notify email', msg);
    return { ok: false, error: msg, ms: Date.now() - t0 };
  }
}

async function notifyTelegram(env, text, timeoutMs) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return { ok: false, error: 'нет TG_BOT_TOKEN / TG_CHAT_ID в окружении функции' };
  const t0 = Date.now();
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: String(text).slice(0, 3500), disable_web_page_preview: true }), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).replace(/bot\d+:[\w-]+/g, 'bot***').slice(0, 200);
      console.error('telegram http', r.status, body);
      return { ok: false, status: r.status, error: body, ms: Date.now() - t0 };
    }
    return { ok: true, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 120) + (e && e.cause ? ' / ' + String(e.cause.code || e.cause.message || e.cause).slice(0, 80) : '');
    console.error('telegram', msg);
    return { ok: false, error: msg, ms: Date.now() - t0 };
  }
}

/* ---------- помощники ---------- */
function parseBody(text, max = 20000) {
  text = String(text || '');
  if (text.length > max) return {};
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
  // Яндекс забирает заголовок Authorization себе, поэтому токен идёт в X-Auth
  const h = header(req, 'X-Auth') || header(req, 'Authorization');
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
// Статусы партнёра: срок выплат с поддержки растёт за число оплаченных кафе за период. Статус не сгорает.
export const TIERS = [
  { key: 'partner', name: 'Партнёр', months: 24 },
  { key: 'pro', name: 'Профи', need: 5, days: 92, months: 36 },          // 5 кафе за 3 месяца
  { key: 'amb', name: 'Амбассадор', need: 20, days: 366, months: null }  // 20 кафе за 12 месяцев — бессрочно
];
function bestWindow(dates, days) {
  let best = 0, j = 0;
  for (let i = 0; i < dates.length; i++) { while (dates[i] - dates[j] > days * 864e5) j++; best = Math.max(best, i - j + 1); }
  return best;
}
// Заведение «оплачено» для партнёра, когда оплачены набор и хотя бы 1 месяц поддержки
// Заведение засчитано, когда оплатило набор. Поддержка необязательна: 20% идёт за каждый оплаченный месяц (months), если клиент подписан
const qualified = l => l.status === 'paid';
function tierOf(leads) {
  const dates = leads.filter(qualified).map(l => Date.parse(l.paid_at || l.created_at)).filter(n => !isNaN(n)).sort((a, b) => a - b);
  let cur = TIERS[0];
  for (const t of TIERS.slice(1)) if (bestWindow(dates, t.days) >= t.need) cur = t;
  const next = TIERS[TIERS.indexOf(cur) + 1];
  let progress = null;
  if (next) {
    const have = dates.filter(d => d >= Date.now() - next.days * 864e5).length;
    progress = { key: next.key, name: next.name, need: next.need, months: next.months, windowMonths: Math.round(next.days / 30.5), have, left: Math.max(0, next.need - have) };
  }
  return { key: cur.key, name: cur.name, months: cur.months, next: progress };
}
// города заявок партнёра: [{ city, n }], по убыванию
function cityCounts(ls) {
  const m = {};
  for (const l of ls) { const c = String(l.city || '').trim(); if (c) m[c] = (m[c] || 0) + 1; }
  return Object.entries(m).map(([city, n]) => ({ city, n })).sort((a, b) => b.n - a.n);
}
function tierMap(leads) {
  const by = {};
  for (const l of leads) if (l.partner_id) (by[l.partner_id] = by[l.partner_id] || []).push(l);
  return Object.fromEntries(Object.entries(by).map(([id, ls]) => [id, tierOf(ls)]));
}
// Начисление по заявке; срок поддержки ограничен статусом партнёра (tiers — карта статусов)
function leadEarned(l, tiers) {
  if (!qualified(l)) return 0;
  const plan = ['standard', 'start_promo', 'standard_promo'].includes(l.plan) ? l.plan : 'start';
  const t = tiers && tiers[l.partner_id];
  const cap = t ? (t.months == null ? Infinity : t.months) : RATES.maxMonths;
  const perMonth = l.billing === 'year' ? RATES.monthlyYear : RATES.monthly[plan];
  const perCab = l.cab_billing === 'year' ? RATES.cabinetYear : RATES.cabinet;
  return RATES.setup[plan] + Math.min(Number(l.months) || 0, cap) * perMonth + Math.min(Number(l.cab_months) || 0, cap) * perCab;
}
function summarize(leads, payouts, teamIncome = 0, tiers) {
  const paid = leads.filter(qualified);
  const fromLeads = paid.reduce((s, l) => s + leadEarned(l, tiers), 0);
  const earned = fromLeads + teamIncome;
  const paidOut = payouts.reduce((s, p) => s + Number(p.amount), 0);
  return { paidCount: paid.length, fromLeads, teamIncome, earned, paidOut, balance: earned - paidOut };
}
const shortName = n => { const [a = '', b = ''] = String(n || '').trim().split(/\s+/); return b ? `${a} ${b[0]}.` : a; };
// Команда партнёра: приглашённые им (1-й уровень) и приглашённые ими (2-й уровень).
// Доля считается только с заработка за подключённые кафе — без их собственной команды.
function teamFor(pid, partners, leads, tiers = tierMap(leads)) {
  const own = {};
  for (const l of leads) if (l.partner_id) own[l.partner_id] = (own[l.partner_id] || 0) + leadEarned(l, tiers);
  const kids = id => partners.filter(p => p.id !== pid && (p.referrer_id || '') === id);
  const row = (p, rate) => ({ name: shortName(p.name), joined: p.created_at, earned: own[p.id] || 0, share: Math.round((own[p.id] || 0) * rate) });
  const l1 = kids(pid);
  const level1 = l1.map(p => row(p, RATES.team[0]));
  const level2 = l1.flatMap(p => kids(p.id).map(c => ({ ...row(c, RATES.team[1]), via: shortName(p.name) })));
  const income1 = level1.reduce((s, r) => s + r.share, 0), income2 = level2.reduce((s, r) => s + r.share, 0);
  return { level1, level2, income1, income2, income: income1 + income2 };
}
// По закону вход на российские сайты — через российские сервисы. Принимаем почту российских сервисов
// и адреса на российских доменах (.ru, .рф, .su), телефон — только российский.
const RU_MAIL = ['yandex.ru','ya.ru','yandex.com','narod.ru','mail.ru','bk.ru','list.ru','inbox.ru','internet.ru','vk.com','rambler.ru','ro.ru','lenta.ru','myrambler.ru','autorambler.ru','rambler.ua'];
function isRussianEmail(e) {
  const d = String(e).split('@')[1] || '';
  return RU_MAIL.includes(d) || /\.(ru|su|xn--p1ai|рф)$/.test(d);
}
function isRussianPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return (d.length === 11 && (d[0] === '7' || d[0] === '8') && d[1] === '9') || (d.length === 10 && d[0] === '9');
}
const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
const byDateDesc = (a, b) => (a.created_at < b.created_at ? 1 : -1);

/* ---------- служебное ---------- */
async function setup(ctx) {
  const { req, db, env } = ctx;
  const viaBody = safeEqual(String(ctx.b.password || ''), env.ADMIN_PASSWORD);
  if (!viaBody && !safeEqual(header(req, 'X-Auth') || header(req, 'Authorization'), 'Bearer ' + env.ADMIN_PASSWORD)) return json({ error: 'Нет доступа' }, 401);
  await db.setup();
  return json({ ok: true });
}

// Диагностика уведомлений: админ-пароль в теле, ответ показывает, что именно вернул Telegram (токен не раскрывается).
async function tgTest(ctx) {
  const { req, env } = ctx;
  const ok = safeEqual(String(ctx.b.password || ''), env.ADMIN_PASSWORD) || safeEqual(header(req, 'X-Auth') || header(req, 'Authorization'), 'Bearer ' + env.ADMIN_PASSWORD);
  if (!ok) return json({ error: 'Нет доступа' }, 401);
  const r = await notify(ctx, '🔧 Проверка уведомлений из функции nabor-api', 10000);
  return json({ tokenSet: !!env.TG_BOT_TOKEN, chatSet: !!env.TG_CHAT_ID, ...r });
}

/* ---------- партнёры ---------- */
async function register(ctx) {
  const { b, db, env } = ctx;
  const name = clean(b.name, 80), email = clean(b.email, 120).toLowerCase(), phone = clean(b.phone, 30);
  const status = clean(b.status, 30), source = clean(b.source, 80), city = clean(b.city, 60), password = String(b.password || '');
  if (name.length < 2) return json({ error: 'Укажите имя' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Проверьте email' }, 400);
  if (!isRussianEmail(email)) return json({ error: 'Нужна российская почта: Яндекс, Mail.ru, Рамблер или адрес на домене .ru' }, 400);
  if (!isRussianPhone(phone)) return json({ error: 'Нужен российский номер телефона: +7 и 10 цифр' }, 400);
  if (!['Самозанятый', 'ИП'].includes(status)) return json({ error: 'Нужен статус самозанятого или ИП' }, 400);
  if (password.length < 6) return json({ error: 'Пароль — не короче 6 символов' }, 400);
  if (!b.agree) return json({ error: 'Примите условия оферты' }, 400);

  const ih = await ipHash(ctx);
  if (await db.countPartnersByIp(ih) >= 5) return json({ error: 'Слишком много регистраций с этого устройства сегодня' }, 429);
  if (await db.partnerByEmail(email)) return json({ error: 'Этот email уже зарегистрирован — войдите' }, 409);

  // подтверждение почты: сначала отправляем код, регистрация — со вторым запросом, где код указан
  if (ctx.mail.enabled) {
    if (!b.emailCode) {
      const sent = await sendCode(ctx, email, 'reg', 'Код подтверждения регистрации',
        c => `Ваш код для регистрации в партнёрской программе «Цифровой набор для кафе»: ${c}\n\nКод действует 15 минут. Если вы не регистрировались — просто удалите это письмо.`);
      return sent.error ? json(sent, sent.status) : json({ needCode: true, email });
    }
    const v = await verifyEmailCode(ctx, email, 'reg', b.emailCode);
    if (v) return json({ error: v }, 400);
  }

  let referrer_id = '';
  const inviteCode = clean(b.pref, 20).toUpperCase();
  if (inviteCode) {
    const inv = await db.partnerByCode(inviteCode);
    // самого себя пригласить нельзя — сверяем email и телефон
    if (inv && inv.email !== email && digits(inv.phone) !== digits(phone)) referrer_id = inv.id;
  }

  const base = translit(name);
  let code = '';
  for (let i = 0; i < 20; i++) {
    const c = base + String(10 + Math.floor(Math.random() * 90));
    if (!(await db.partnerByCode(c))) { code = c; break; }
  }
  if (!code) code = base + Date.now().toString().slice(-5);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const id = newId();
  await db.insertPartner({ id, name, email, phone, status, source, city, code, pass_hash: await hashPassword(password, salt), salt, ip_hash: ih, created_at: now(), referrer_id });
  await notify(ctx, `🤝 Новый партнёр: ${name}\n${status}${city ? ' · ' + city : ''}\nИсточник: ${source || '—'}\nКод: ${code}${referrer_id ? ' (приглашён партнёром)' : ''}`);
  return json({ token: await signToken({ role: 'partner', id }, env), code, invited: !!referrer_id });
}

/* ---------- коды на почту ---------- */
const CODE_TTL = 15 * 60e3;
const codeHash = (env, email, purpose, code) => crypto.subtle.digest('SHA-256', enc.encode([purpose, email, String(code).trim(), env.TOKEN_SECRET].join('|'))).then(hex);
async function sendCode(ctx, email, purpose, subject, textFn) {
  const { db, env, mail } = ctx;
  const prev = await db.getCode(email, purpose);
  if (prev && Date.now() - Date.parse(prev.sent_at) < 60e3) return { error: 'Код уже отправлен. Повторно — через минуту.', status: 429 };
  const ih = await ipHash(ctx);
  if (await db.countCodesByIp(ih) >= 10) return { error: 'Слишком много писем сегодня. Напишите нам.', status: 429 };
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await db.putCode({ email, purpose, code_hash: await codeHash(env, email, purpose, code), expires: new Date(Date.now() + CODE_TTL).toISOString(), tries: 0, sent_at: now(), ip_hash: ih });
  try { await mail.send(email, subject, textFn(code)); }
  catch (e) { console.error('mail', e); return { error: 'Не получилось отправить письмо. Проверьте адрес или попробуйте позже.', status: 502 }; }
  return { ok: true };
}
async function verifyEmailCode(ctx, email, purpose, code) {
  const { db, env } = ctx;
  const c = await db.getCode(email, purpose);
  if (!c || Date.parse(c.expires) < Date.now()) return 'Код устарел — запросите новый';
  if (c.tries >= 5) return 'Слишком много попыток — запросите новый код';
  if (!safeEqual(await codeHash(env, email, purpose, code), c.code_hash)) { await db.bumpCodeTries(email, purpose, c.tries + 1); return 'Неверный код'; }
  await db.deleteCode(email, purpose);
  return '';
}
// Забыли пароль: код на почту → новый пароль. Отвечаем одинаково, есть такой email или нет.
async function passwordCode(ctx) {
  const { b, db, mail } = ctx;
  if (!mail.enabled) return json({ error: 'manual' }, 400);
  const email = clean(b.email, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Проверьте email' }, 400);
  if (await db.partnerByEmail(email)) {
    const sent = await sendCode(ctx, email, 'reset', 'Код для смены пароля',
      c => `Код для смены пароля в кабинете партнёра: ${c}\n\nКод действует 15 минут. Если вы не запрашивали смену пароля — просто удалите это письмо, пароль останется прежним.`);
    if (sent.error && sent.status === 429) return json(sent, 429);
  }
  return json({ ok: true });
}
async function passwordReset(ctx) {
  const { b, db, env, mail } = ctx;
  if (!mail.enabled) return json({ error: 'manual' }, 400);
  const email = clean(b.email, 120).toLowerCase(), password = String(b.password || '');
  if (password.length < 6) return json({ error: 'Пароль — не короче 6 символов' }, 400);
  const p = await db.partnerByEmail(email);
  const v = await verifyEmailCode(ctx, email, 'reset', b.code);
  if (v || !p) return json({ error: v || 'Неверный код' }, 400);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await db.setPassword(p.id, await hashPassword(password, salt), salt);
  return json({ token: await signToken({ role: 'partner', id: p.id }, env) });
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
  const [allLeads, allPartners, payouts, clickRows] = await Promise.all([db.allLeads(), db.allPartners(), db.payoutsByPartner(p.id), db.clicksByPartnerSince(p.id, from)]);
  const leads = allLeads.filter(l => l.partner_id === p.id);
  const tiers = tierMap(allLeads);
  const tier = tiers[p.id] || tierOf([]);
  const team = teamFor(p.id, allPartners, allLeads, tiers);
  const inviter = allPartners.find(x => x.id === (allPartners.find(y => y.id === p.id)?.referrer_id || '-'));
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
    stats: { ...summarize(leads, payouts, team.income, tiers), clicks30: daily.reduce((s, d) => s + d.clicks, 0), leads30: daily.reduce((s, d) => s + d.leads, 0), leadsTotal: leads.length },
    daily,
    leads: leads.map(l => ({ date: l.created_at, cafe: l.cafe, city: l.city || '', plan: l.plan, status: l.status, months: l.months, cabMonths: l.cab_months || 0, cabBilling: l.cab_billing || 'month', billing: l.billing || 'month', cabMonths: l.cab_months || 0, cabBilling: l.cab_billing || 'month', earned: leadEarned(l, tiers), pending: l.status === 'paid' && !qualified(l) })),
    payouts: payouts.map(x => ({ date: x.created_at, amount: x.amount, note: x.note, check: !!x.check_received })),
    tier,
    team: { ...team, invitedBy: inviter ? shortName(inviter.name) : null },
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
  const name = clean(b.name, 80), cafe = clean(b.cafe, 120), phone = clean(b.phone, 30), city = clean(b.city, 60);
  const plan = PUBLIC_PLANS.includes(b.plan) ? b.plan : 'unknown';
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
  await db.insertLead({ id: newId(), created_at: now(), name, cafe, city, phone, plan, partner_id: partnerId, status: 'new', months: 0, paid_at: '', ip_hash: ih, billing: 'month' });
  const PL = { start: 'Старт', standard: 'Стандарт', unknown: 'не выбран' };
  const refCode = partnerId ? (await db.partnerById(partnerId))?.code : '';
  await notify(ctx, `🆕 Новая заявка\nЗаведение: ${cafe}${city ? ' · ' + city : ''}\nКонтакт: ${name}, ${phone}\nПакет: ${PL[plan] || plan}\nПартнёр: ${refCode || 'нет (прямая заявка)'}`);
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
  const tiers = tierMap(leads);
  const cafes = await db.allCafes().catch(() => []);   // таблица появляется после /api/setup — админка работает и без неё
  return json({
    cafes: cafes.sort((a, b) => (a.id < b.id ? -1 : 1)),
    leads: leads.map(l => ({ id: l.id, date: l.created_at, name: l.name, cafe: l.cafe, city: l.city || '', phone: l.phone, plan: l.plan, billing: l.billing || 'month', cabMonths: l.cab_months || 0, cabBilling: l.cab_billing || 'month', status: l.status, months: l.months,
      partner: pById[l.partner_id]?.code || null, partnerName: pById[l.partner_id]?.name || null, earned: l.partner_id ? leadEarned(l, tiers) : 0 })),
    partners: partners.map(p => {
      const pl = leads.filter(l => l.partner_id === p.id);
      const team = teamFor(p.id, partners, leads, tiers);
      const tier = tiers[p.id] || tierOf([]);
      return { id: p.id, tier: tier.name, tierMonths: tier.months, name: p.name, email: p.email, phone: p.phone, status: p.status, source: p.source, city: p.city || '', cities: cityCounts(pl), code: p.code, created_at: p.created_at,
        referrer: pById[p.referrer_id]?.code || null, team1: team.level1.length, team2: team.level2.length,
        clicks: clickMap[p.id] || 0, leads: pl.length, ...summarize(pl, payouts.filter(x => x.partner_id === p.id), team.income, tiers) };
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
  const billing = b.billing === 'year' ? 'year' : 'month';
  const cab_months = Math.max(0, Math.min(120, parseInt(b.cabMonths, 10) || 0));
  const cab_billing = b.cabBilling === 'year' ? 'year' : 'month';
  const paid_at = status === 'paid' ? (cur.paid_at || now()) : '';
  await db.updateLead(id, { status, plan, months, paid_at, billing, cab_months, cab_billing });
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

// Удаление записей (для тестовых данных и ошибок). Партнёр удаляется вместе с его переходами и выплатами,
// его заявки остаются, но отвязываются от партнёра.
async function adminDelete(ctx) {
  if (!(await isAdmin(ctx))) return json({ error: 'Войдите заново' }, 401);
  const { b, db } = ctx;
  const id = clean(b.id, 40);
  if (!id) return json({ error: 'Не указана запись' }, 400);
  if (b.type === 'lead') await db.deleteLead(id);
  else if (b.type === 'payout') await db.deletePayout(id);
  else if (b.type === 'partner') await db.deletePartner(id);
  else if (b.type === 'cafe') { if (!(await db.cafeById(slug(id)))) return json({ error: 'Кафе не найдено' }, 404); await db.deleteCafe(slug(id)); }
  else return json({ error: 'Неизвестный тип' }, 400);
  return json({ ok: true });
}

// Новый пароль партнёру (забыл пароль): админ получает его один раз и пересылает партнёру.
async function adminResetPassword(ctx) {
  if (!(await isAdmin(ctx))) return json({ error: 'Войдите заново' }, 401);
  const { b, db } = ctx;
  const p = await db.partnerById(clean(b.id, 40));
  if (!p) return json({ error: 'Партнёр не найден' }, 404);
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const password = [...crypto.getRandomValues(new Uint8Array(10))].map(x => abc[x % abc.length]).join('');
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await db.setPassword(p.id, await hashPassword(password, salt), salt);
  return json({ ok: true, password, email: p.email, phone: p.phone, name: p.name });
}

// Проверка почты: письмо самому себе (на адрес отправителя)
async function adminTestMail(ctx) {
  if (!(await isAdmin(ctx))) return json({ error: 'Войдите заново' }, 401);
  if (!ctx.mail.enabled) return json({ ok: false, enabled: false });
  try { await ctx.mail.send(ctx.env.SMTP_USER || 'test@local', 'Проверка почты партнёрской программы', 'Почта работает: коды подтверждения будут приходить партнёрам.'); }
  catch (e) { return json({ ok: false, enabled: true, error: String(e && e.message || e).slice(0, 300) }); }
  return json({ ok: true, enabled: true });
}


/* ---------- кабинет владельца: меню ---------- */
// Меню лежит на сервере целиком (категории, блюда, акция); страница кафе забирает его и подменяет вшитое.
const MENU_ICONS = ['cup', 'tea', 'cake', 'plate'];
const COLOR = /^#[0-9a-fA-F]{6}$/;
const slug = (v, max = 40) => String(v ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, max);
const money = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : null; };

// Проверка и очистка меню от владельца: в страницу кафе попадают только известные поля нужной формы
export function cleanMenu(m, maxItems = 100) {
  if (!m || typeof m !== 'object') return { error: 'Пустое меню' };
  const cats = Array.isArray(m.categories) ? m.categories : [];
  if (!cats.length || cats.length > 20) return { error: 'Нужна от 1 до 20 категорий' };
  const categories = [], catIds = new Set();
  for (const c of cats) {
    const id = slug(c && c.id, 30), name = clean(c && c.name, 40);
    if (!id || !name) return { error: 'У каждой категории должно быть название' };
    if (catIds.has(id)) return { error: 'Две категории с одним кодом: ' + id };
    catIds.add(id); categories.push({ id, name });
  }
  const list = Array.isArray(m.items) ? m.items : [];
  if (list.length > maxItems) return { error: `В вашем тарифе до ${maxItems} позиций, а в меню ${list.length}` };
  const items = [], ids = new Set();
  for (const it of list) {
    if (!it || typeof it !== 'object') return { error: 'Неверная позиция' };
    const id = slug(it.id, 30) || newId(), name = clean(it.name, 60), price = money(it.price);
    if (!name) return { error: 'У каждого блюда должно быть название' };
    if (price === null) return { error: `«${name}»: цена должна быть числом от 0 до 100 000` };
    if (ids.has(id)) return { error: 'Повторяется код блюда: ' + id };
    if (!catIds.has(slug(it.cat, 30))) return { error: `«${name}»: выберите категорию` };
    ids.add(id);
    const o = { id, cat: slug(it.cat, 30), name, desc: clean(it.desc, 160), price,
      bg: COLOR.test(it.bg) ? it.bg : '#EFE2CC', ink: COLOR.test(it.ink) ? it.ink : '#5E6B6A',
      icon: MENU_ICONS.includes(it.icon) ? it.icon : 'plate' };
    const tag = clean(it.tag, 16); if (tag) o.tag = tag;
    const photo = String(it.photo || '').trim();
    if (photo) { if (!/^(https:\/\/[^\s"'<>]{4,300}|img\/[\w.-]{1,100})$/.test(photo)) return { error: `«${name}»: ссылка на фото должна начинаться с https://` }; o.photo = photo; }
    if (it.hidden === true) o.hidden = true;
    if (Array.isArray(it.sizes) && it.sizes.length) {
      if (it.sizes.length > 6) return { error: `«${name}»: не больше 6 размеров` };
      o.sizes = it.sizes.map(x => ({ label: clean(x && x.label, 20), add: money(x && x.add) }));
      if (o.sizes.some(x => !x.label || x.add === null)) return { error: `«${name}»: у размера нужны название и доплата` };
    }
    if (Array.isArray(it.extras) && it.extras.length) {
      if (it.extras.length > 10) return { error: `«${name}»: не больше 10 добавок` };
      o.extras = it.extras.map(x => ({ label: clean(x && x.label, 40), price: money(x && x.price) }));
      if (o.extras.some(x => !x.label || x.price === null)) return { error: `«${name}»: у добавки нужны название и цена` };
    }
    items.push(o);
  }
  const out = { categories, items };
  if (m.brand && typeof m.brand === 'object') out.brand = { name: clean(m.brand.name, 60), sub: clean(m.brand.sub, 100) };
  if (m.promo && typeof m.promo === 'object') {
    const pr = money(m.promo.price), name = clean(m.promo.name, 60);
    if (m.promo.on === true) {
      if (!name || pr === null) return { error: 'Акция: нужны название и цена' };
      out.promo = { on: true, id: 'promo', name, note: clean(m.promo.note, 40), desc: clean(m.promo.desc, 120), price: pr,
        bg: COLOR.test(m.promo.bg) ? m.promo.bg : '#FFE7B8', ink: COLOR.test(m.promo.ink) ? m.promo.ink : '#9A5B00',
        icon: MENU_ICONS.includes(m.promo.icon) ? m.promo.icon : 'cup' };
    } else out.promo = { on: false };
  }
  return { menu: out };
}

// Импорт готового QR-меню: берём страницу <код>.qrstol.ru, достаём блок настроек (категории, блюда, акция) и выполняем его в пустой песочнице.
// Адрес строго https://<код>.qrstol.ru/ — наши собственные страницы, больше никуда сервер не ходит.
const ENT = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unent = t => String(t).replace(/&(nbsp|amp|lt|gt|quot|#39);/g, m => ENT[m]).trim();
export async function importPageMenu(code) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(code)) throw new Error('Код для готового меню — только маленькие латинские буквы, цифры и дефис (как в адресе страницы)');
  const base = `https://${code}.qrstol.ru/`;
  let html;
  try { const r = await fetch(base, { signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(String(r.status)); html = await r.text(); }
  catch (e) { throw new Error(`Не удалось открыть страницу ${base} (${String(e.message || e).slice(0, 80)}). Готовое меню должно быть выложено по этому адресу.`); }
  const a = html.indexOf('/* ===== НАСТРОЙКИ'), z = html.indexOf('/* ===== конец настроек');
  if (a < 0 || z < a) throw new Error('На странице не найден блок настроек меню — это не наш шаблон QR-меню. Заполните меню в кабинете вручную.');
  const vm = await import('node:vm');
  let d;
  try { d = JSON.parse(JSON.stringify(vm.runInNewContext(html.slice(a, z) + '\n;({ name: CAFE.name, categories: CATEGORIES, items: MENU, promo: typeof PROMO === "undefined" ? null : PROMO })', Object.create(null), { timeout: 1000 }))); }
  catch (e) { throw new Error('Не получилось прочитать меню со страницы: ' + String(e.message || e).slice(0, 100)); }
  const abs = u => /^(https:|img\/)/.test(String(u || '')) ? (String(u).startsWith('img/') ? base + u : u) : '';   // относительные фото → полный адрес страницы кафе
  d.items = (d.items || []).map(it => (it && it.photo ? { ...it, photo: abs(it.photo) } : it));
  const note = (html.match(/id="promo"[^>]*>\s*<span>\s*<small>([^<]*)<\/small>/) || [])[1] || '';
  const sub = (html.match(/<div class="sub"[^>]*>([^<]*)<\/div>/) || [])[1] || '';
  const real = d.promo && d.promo.name && d.promo.name !== '—' && Number(d.promo.price) > 0;
  return { categories: d.categories, items: d.items, brand: { name: unent(d.name || ''), sub: unent(sub) },
    promo: real ? { on: true, ...d.promo, note: unent(note) } : { on: false } };
}

// Публичное меню для страницы кафе: без скрытых блюд (стоп-лист)
async function publicMenu({ req, db }) {
  const id = slug((req.query || {}).cafe);
  const v = id && await db.latestMenu(id);
  if (!v) return json({ error: 'Меню не найдено' }, 404);
  const data = JSON.parse(v.data);
  return json({ version: v.ver, data: { ...data, items: data.items.filter(i => !i.hidden) } });
}

async function ownerCode(ctx) {
  const { b, db, mail } = ctx;
  if (!mail.enabled) return json({ error: 'manual' }, 400);
  const email = clean(b.email, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Проверьте email' }, 400);
  if ((await db.cafesByEmail(email)).length) {
    const sent = await sendCode(ctx, email, 'owner', 'Код для входа в кабинет меню',
      c => `Код для входа в кабинет меню: ${c}\n\nКод действует 15 минут. Если вы не запрашивали вход — просто удалите это письмо.`);
    if (sent.error && sent.status) return json(sent, sent.status);
  }
  return json({ ok: true });   // отвечаем одинаково, есть такой владелец или нет
}
async function ownerLogin(ctx) {
  const { b, db, env } = ctx;
  const email = clean(b.email, 120).toLowerCase();
  const cafes = await db.cafesByEmail(email);
  const v = await verifyEmailCode(ctx, email, 'owner', b.code);
  if (v || !cafes.length) return json({ error: v || 'Неверный код' }, 400);
  return json({ token: await signToken({ role: 'owner', email }, env, 14), cafes: cafes.map(c => ({ id: c.id, name: c.name, active: !!c.active })) });
}
// Доступ к кафе: токен владельца + e-mail кафе не изменился с момента входа
async function ownedCafe(ctx, cafeId) {
  const t = await readToken(ctx);
  if (!t || t.role !== 'owner') return { res: json({ error: 'Войдите заново' }, 401) };
  // без кафе в запросе — первое кафе владельца (автовход в кабинет)
  const cafe = slug(cafeId) ? await ctx.db.cafeById(slug(cafeId)) : (await ctx.db.cafesByEmail(t.email)).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (!cafe || cafe.owner_email !== t.email) return { res: json({ error: 'Нет доступа к этому кафе' }, 403) };
  return { cafe, token: t };
}
async function ownerMenu(ctx) {
  const o = await ownedCafe(ctx, (ctx.req.query || {}).cafe);
  if (o.res) return o.res;
  const v = await ctx.db.latestMenu(o.cafe.id);
  const mine = (await ctx.db.cafesByEmail(o.token.email)).map(c => ({ id: c.id, name: c.name }));
  return json({ cafe: { id: o.cafe.id, name: o.cafe.name, active: !!o.cafe.active, maxItems: o.cafe.max_items || 100 }, cafes: mine,
    version: v ? v.ver : 0, menu: v ? JSON.parse(v.data) : { categories: [], items: [] },
    versions: (await ctx.db.menuVersions(o.cafe.id)).map(x => ({ ver: x.ver, at: x.created_at, author: x.author })) });
}
async function saveMenu(db, cafe, menu, author, baseVer) {
  const last = await db.latestMenu(cafe.id);
  const ver = (last ? last.ver : 0) + 1;
  await db.insertMenu({ cafe_id: cafe.id, ver, data: JSON.stringify(menu), created_at: now(), author });
  if (ver > 30) await db.trimMenus(cafe.id, ver - 29);   // храним последние 30 версий
  return ver;
}
async function ownerSave(ctx) {
  const o = await ownedCafe(ctx, ctx.b.cafe);
  if (o.res) return o.res;
  if (!o.cafe.active) return json({ error: 'Кабинет не подключён или подписка закончилась. Меню продолжает работать, а правки — через нас.' }, 402);
  const r = cleanMenu(ctx.b.menu, o.cafe.max_items || 100);
  if (r.error) return json({ error: r.error }, 400);
  const last = await ctx.db.latestMenu(o.cafe.id);
  if (last && Number(ctx.b.baseVersion) !== last.ver) return json({ error: 'Меню уже изменили в другой вкладке или на другом телефоне. Обновите страницу.' }, 409);
  return json({ ok: true, version: await saveMenu(ctx.db, o.cafe, r.menu, o.token.email) });
}
async function ownerRollback(ctx) {
  const o = await ownedCafe(ctx, ctx.b.cafe);
  if (o.res) return o.res;
  if (!o.cafe.active) return json({ error: 'Кабинет не подключён или подписка закончилась' }, 402);
  const old = await ctx.db.menuByVer(o.cafe.id, Number(ctx.b.ver));
  if (!old) return json({ error: 'Такой версии нет' }, 404);
  return json({ ok: true, version: await saveMenu(ctx.db, o.cafe, JSON.parse(old.data), o.token.email + ' (откат к №' + old.ver + ')') });
}

// Админ: список кафе и создание/правка кафе (владелец, доступ к кабинету, лимит позиций, стартовое меню)
async function adminCafes(ctx) {
  if (!(await isAdmin(ctx))) return json({ error: 'Войдите заново' }, 401);
  return json({ cafes: await ctx.db.allCafes() });
}
async function adminCafe(ctx) {
  if (!(await isAdmin(ctx))) return json({ error: 'Войдите заново' }, 401);
  const { b, db } = ctx;
  const id = slug(b.id), prev = id && await db.cafeById(id);
  if (!id) return json({ error: 'Нужен код кафе (латиница, как в адресе zerno.qrstol.ru)' }, 400);
  const email = clean(b.owner_email ?? (prev && prev.owner_email), 120).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Проверьте email владельца' }, 400);
  const cafe = { id, name: clean(b.name ?? (prev && prev.name), 80) || id, owner_email: email,
    active: b.active === undefined ? (prev ? prev.active : 0) : (b.active ? 1 : 0),
    max_items: Math.min(500, Math.max(1, Math.round(Number(b.max_items ?? (prev && prev.max_items) ?? 100)) || 100)),
    created_at: prev ? prev.created_at : now() };
  if (b.create && prev) return json({ error: `Кафе с кодом «${id}» уже есть. Выберите другой код.` }, 409);
  if (!email && b.create) return json({ error: 'Укажите e-mail владельца' }, 400);
  let ver = null;
  if (b.importFromPage) {
    try { b.menu = await importPageMenu(id); } catch (e) { return json({ error: String(e.message || e) }, 400); }
    if (!b.name && !prev) cafe.name = b.menu.brand.name || id;
  }
  if (!b.menu && !(await db.latestMenu(id))) b.menu = { categories: [{ id: 'main', name: 'Меню' }], items: [], brand: { name: cafe.name, sub: '' } };   // новое кафе: пустое меню, владелец заполнит в кабинете
  if (b.menu) {
    const r = cleanMenu(b.menu, 500);
    if (r.error) return json({ error: r.error }, 400);
    await db.upsertCafe(cafe);
    ver = await saveMenu(db, cafe, r.menu, 'admin');
  } else await db.upsertCafe(cafe);
  return json({ ok: true, cafe, version: ver });
}
