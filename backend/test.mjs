// Проверка всей цепочки: регистрация → переход → заявка → оплата → начисление → выплата.
// Без YDB_CONNECTION_STRING — на базе в памяти; с ним — на настоящей YDB через index.js.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { handle } from './app.mjs';
import { memoryDb } from './db-memory.mjs';
import { createMail } from './mail.mjs';

const env = { ADMIN_PASSWORD: 'test-admin-password', TOKEN_SECRET: 'test-secret-1234567890' };
const useYdb = !!process.env.YDB_CONNECTION_STRING;
let call;
if (useYdb) {
  Object.assign(process.env, env, { MAIL_MODE: 'capture' });
  const { handler } = createRequire(import.meta.url)('./index.js');
  call = async (method, path, body, token, ip = '1.1.1.1', query = {}) => {
    const r = await handler({ httpMethod: method, queryStringParameters: { r: path, ...query },
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Auth': 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : '', isBase64Encoded: false, requestContext: { identity: { sourceIp: ip } } }, {});
    return { status: r.statusCode, data: r.body ? JSON.parse(r.body) : null };
  };
} else {
  const db = memoryDb();
  const mail = createMail({ MAIL_MODE: 'capture' });
  call = async (method, path, body, token, ip = '1.1.1.1', query = {}) => {
    const r = await handle({ method, path, query, headers: token ? { 'X-Auth': 'Bearer ' + token } : {}, body: body ? JSON.stringify(body) : '', ip }, db, env, mail);
    return { status: r.status, data: r.body ? JSON.parse(r.body) : null };
  };
}

// регистрация с кодом из письма
const lastCode = to => { const m = [...(globalThis.__outbox || [])].reverse().find(x => x.to === to); return m && m.text.match(/\d{6}/)[0]; };
async function register(body, ip = '1.1.1.1') {
  const first = await call('POST', '/api/register', body, null, ip);
  if (first.status !== 200 || !first.data.needCode) return first;
  return call('POST', '/api/register', { ...body, emailCode: lastCode(body.email) }, null, ip);
}
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.error('✗', name, '\n', e); process.exit(1); } };
let token, code, admin, leadId;
const email = `test${Date.now()}@example.ru`;

await step('сервер отвечает', async () => { const r = await call('GET', '/api'); assert.equal(r.data.ok, true); });
await step('создание таблиц', async () => {
  assert.equal((await call('POST', '/api/setup', {}, 'wrong')).status, 401);
  const r = await call('POST', '/api/setup', {}, env.ADMIN_PASSWORD); assert.equal(r.status, 200, JSON.stringify(r.data));
  const r2 = await call('POST', '/api/setup', {}, env.ADMIN_PASSWORD); assert.equal(r2.status, 200, 'повторно: ' + JSON.stringify(r2.data));
});
await step('регистрация партнёра', async () => {
  const bad = await call('POST', '/api/register', { name: 'Иван', city: 'Омск', email, phone: '+7 900 123-45-67', status: 'Самозанятый', password: '123456' });
  assert.equal(bad.status, 400);
  const gmail = await call('POST', '/api/register', { name: 'Иван', city: 'Омск', email: 'ivan@gmail.com', phone: '+7 900 123-45-67', status: 'ИП', password: '123456', agree: true });
  assert.equal(gmail.status, 400, 'зарубежная почта не принимается');
  const foreign = await call('POST', '/api/register', { name: 'Иван', city: 'Омск', email: 'ivan@mail.ru', phone: '+1 202 555 0100', status: 'ИП', password: '123456', agree: true });
  assert.equal(foreign.status, 400, 'зарубежный телефон не принимается');
  const body = { name: 'Иван Петров', city: 'Омск', email, phone: '+7 900 123-45-67', status: 'Самозанятый', source: 'Авито', password: 'secret1', agree: true };
  const first = await call('POST', '/api/register', body);
  assert.equal(first.data.needCode, true, 'сначала должен прийти код');
  assert.equal((await call('POST', '/api/register', body)).status, 429, 'повторный код — не раньше чем через минуту');
  assert.equal((await call('POST', '/api/register', { ...body, emailCode: '000000' })).data.error, 'Неверный код');
  const r = await call('POST', '/api/register', { ...body, emailCode: lastCode(email) });
  assert.equal(r.status, 200, JSON.stringify(r.data)); token = r.data.token; code = r.data.code;
  assert.match(code, /^IVAN\d\d/);
  const dup = await call('POST', '/api/register', { name: 'Иван', city: 'Омск', email, phone: '+7 900 123-45-67', status: 'ИП', password: 'secret1', agree: true });
  assert.equal(dup.status, 409);
});
await step('вход партнёра', async () => {
  assert.equal((await call('POST', '/api/login', { email, password: 'wrong' })).status, 401);
  const r = await call('POST', '/api/login', { email: email.toUpperCase(), password: 'secret1' }); assert.equal(r.status, 200); token = r.data.token;
});
await step('проверка промокода', async () => {
  assert.equal((await call('GET', '/api/check-code', null, null, '1.1.1.1', { code: code.toLowerCase() })).data.valid, true);
  assert.equal((await call('GET', '/api/check-code', null, null, '1.1.1.1', { code: 'NOPE00' })).data.valid, false);
});
await step('переходы по ссылке (повтор с того же IP не считается)', async () => {
  await call('POST', '/api/click', { ref: code }, null, '2.2.2.2');
  await call('POST', '/api/click', { ref: code }, null, '2.2.2.2');
  await call('POST', '/api/click', { ref: code }, null, '3.3.3.3');
  const me = await call('GET', '/api/me', null, token); assert.equal(me.data.stats.clicks30, 2);
});
await step('заявка от кафе', async () => {
  assert.equal((await call('POST', '/api/lead', { name: 'Анна', cafe: 'Зерно', phone: '123' })).status, 400);
  const r = await call('POST', '/api/lead', { name: 'Анна', cafe: 'Кафе «Зерно»', city: 'Омск', phone: '+7 913 000-00-00', plan: 'standard', ref: code }, null, '2.2.2.2');
  assert.equal(r.status, 200); assert.equal(r.data.withPromo, true);
  const r2 = await call('POST', '/api/lead', { name: 'Олег', cafe: 'Без партнёра', phone: '+7 913 111-11-11', plan: 'start' }, null, '4.4.4.4');
  assert.equal(r2.data.withPromo, false);
});
await step('вход в админку', async () => {
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  const r = await call('POST', '/api/admin/login', { password: env.ADMIN_PASSWORD }); assert.equal(r.status, 200); admin = r.data.token;
  assert.equal((await call('GET', '/api/admin/data', null, token)).status, 401, 'партнёр не должен попасть в админку');
});
await step('админка видит заявку и партнёра', async () => {
  const d = (await call('GET', '/api/admin/data', null, admin)).data;
  const l = d.leads.find(x => x.partner === code); assert.ok(l, 'нет заявки партнёра'); leadId = l.id;
  assert.equal(l.status, 'new'); assert.equal(l.partnerName, 'Иван Петров');
  assert.deepEqual(d.partners.find(x => x.code === code).cities, [{ city: 'Омск', n: 1 }], 'города заявок партнёра видны в админке');
  assert.equal(d.leads.find(l => l.cafe === 'Кафе «Зерно»').city, 'Омск', 'город заявки виден в админке');
  const p = d.partners.find(x => x.code === code); assert.equal(p.clicks, 2); assert.equal(p.leads, 1); assert.equal(p.balance, 0);
});
await step('оплата: 4450 за набор + 2 мес × 158', async () => {
  const r = await call('POST', '/api/admin/lead', { id: leadId, status: 'paid', plan: 'standard', months: '2' }, admin); assert.equal(r.status, 200, JSON.stringify(r.data));
  const me = (await call('GET', '/api/me', null, token)).data;
  assert.equal(me.stats.earned, 4766); assert.equal(me.stats.balance, 4766); assert.equal(me.stats.paidCount, 1); assert.equal(me.leads[0].status, 'paid');
});
await step('выплата партнёру', async () => {
  assert.equal((await call('POST', '/api/admin/payout', { partner: code, amount: 0 }, admin)).status, 400);
  const r = await call('POST', '/api/admin/payout', { partner: code.toLowerCase(), amount: '4766', note: 'СБП', check: true }, admin); assert.equal(r.status, 200);
  const me = (await call('GET', '/api/me', null, token)).data;
  assert.equal(me.stats.paidOut, 4766); assert.equal(me.stats.balance, 0); assert.equal(me.payouts[0].check, true);
  const d = (await call('GET', '/api/admin/data', null, admin)).data;
  assert.equal(d.payouts.find(x => x.partner === code).amount, 4766);
});
await step('команда: 10% с 1-го уровня и 5% со 2-го', async () => {
  const t = Date.now();
  const reg = async (name, mail, phone, pref, ip) => {
    const r = await register({ name, email: mail, phone, status: 'ИП', password: 'secret1', agree: true, pref }, ip);
    assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data;
  };
  const A = await reg('Анна Смирнова', `a${t}@ex.ru`, '+7 901 000-00-01', '', '10.0.0.1');
  const B = await reg('Борис Котов', `b${t}@ex.ru`, '+7 901 000-00-02', A.code.toLowerCase(), '10.0.0.2');
  assert.equal(B.invited, true);
  const C = await reg('Вера Лис', `c${t}@ex.ru`, '+7 901 000-00-03', B.code, '10.0.0.3');
  const self = await reg('Анна Вторая', `a2${t}@ex.ru`, '8 (901) 000-00-01', A.code, '10.0.0.4');
  assert.equal(self.invited, false, 'нельзя пригласить самого себя (тот же телефон)');
  await call('POST', '/api/lead', { name: 'Пётр', cafe: 'Кафе команды', phone: '+7 913 222-22-22', plan: 'standard', ref: C.code }, null, '10.0.0.9');
  const d = (await call('GET', '/api/admin/data', null, admin)).data;
  const l = d.leads.find(x => x.partner === C.code);
  await call('POST', '/api/admin/lead', { id: l.id, status: 'paid', plan: 'standard', months: 2 }, admin);
  const meA = (await call('GET', '/api/me', null, A.token)).data;
  const meB = (await call('GET', '/api/me', null, B.token)).data;
  const meC = (await call('GET', '/api/me', null, C.token)).data;
  assert.equal(meC.stats.earned, 4766);
  assert.equal(meB.stats.teamIncome, 477); assert.equal(meB.stats.earned, 477); assert.equal(meB.team.invitedBy, 'Анна С.');
  assert.equal(meB.team.level1.length, 1); assert.equal(meB.team.level1[0].name, 'Вера Л.');
  assert.equal(meA.stats.teamIncome, 238); assert.equal(meA.stats.balance, 238);
  assert.equal(meA.team.level1.length, 1); assert.equal(meA.team.level2.length, 1); assert.equal(meA.team.level2[0].via, 'Борис К.');
  const d2 = (await call('GET', '/api/admin/data', null, admin)).data;
  const pa = d2.partners.find(x => x.code === A.code), pb = d2.partners.find(x => x.code === B.code);
  assert.equal(pb.referrer, A.code); assert.equal(pa.teamIncome, 238); assert.equal(pa.team1, 1); assert.equal(pa.team2, 1);
  assert.equal(d2.partners.find(x => x.code === self.code).referrer, null);
});
await step('статусы: 5 кафе за 3 месяца → «Профи», выплаты 36 месяцев', async () => {
  const t = Date.now();
  const P = await register({ name: 'Глеб Сомов', email: `g${t}@ex.ru`, phone: '+7 902 000-00-09', status: 'ИП', password: 'secret1', agree: true }, '20.0.0.1');
  assert.equal(P.status, 200);
  const tok = P.data.token, pc = P.data.code;
  const ids = [];
  for (let i = 0; i < 5; i++) {
    await call('POST', '/api/lead', { name: 'Кафе', cafe: `Кафе статуса ${i}`, phone: '+7 913 333-33-3' + i, plan: 'start', ref: pc }, null, '20.1.0.' + i);
  }
  const d = (await call('GET', '/api/admin/data', null, admin)).data;
  for (const l of d.leads.filter(x => x.partner === pc)) ids.push(l.id);
  assert.equal(ids.length, 5);
  // первое кафе платит поддержку уже 30 месяцев
  await call('POST', '/api/admin/lead', { id: ids[0], status: 'paid', plan: 'start', months: 30 }, admin);
  // оплачен только набор, поддержки нет — набор уже засчитан (поддержка необязательна)
  await call('POST', '/api/admin/lead', { id: ids[1], status: 'paid', plan: 'start', months: 0 }, admin);
  let pre = (await call('GET', '/api/me', null, tok)).data;
  assert.equal(pre.stats.paidCount, 2); assert.equal(pre.leads.find(l => l.status === 'paid' && Number(l.months) === 0).earned, 2950, 'без поддержки начисляется только набор');
  for (let i = 1; i < 4; i++) await call('POST', '/api/admin/lead', { id: ids[i], status: 'paid', plan: 'start', months: 1 }, admin);
  let me = (await call('GET', '/api/me', null, tok)).data;
  assert.equal(me.tier.key, 'partner'); assert.equal(me.tier.next.left, 1);
  assert.equal(me.stats.fromLeads, 2950 + 24 * 158 + 3 * 3108, 'до статуса — не больше 24 месяцев');
  await call('POST', '/api/admin/lead', { id: ids[4], status: 'paid', plan: 'start', months: 1 }, admin);
  me = (await call('GET', '/api/me', null, tok)).data;
  assert.equal(me.tier.key, 'pro'); assert.equal(me.tier.months, 36);
  assert.equal(me.tier.next.key, 'amb'); assert.equal(me.tier.next.left, 15);
  assert.equal(me.stats.fromLeads, 2950 + 30 * 158 + 4 * 3108, '«Профи» — до 36 месяцев, в том числе по старым клиентам');
  assert.equal(me.stats.bonus, undefined, 'бонус за каждое 5-е заведение убран');
  const pa = (await call('GET', '/api/admin/data', null, admin)).data.partners.find(x => x.code === pc);
  assert.equal(pa.tier, 'Профи');
  // оплата поддержки за год: 132 ₽ за месяц вместо 158
  await call('POST', '/api/admin/lead', { id: ids[1], status: 'paid', plan: 'start', months: 12, billing: 'year' }, admin);
  me = (await call('GET', '/api/me', null, tok)).data;
  assert.equal(me.stats.fromLeads, 2950 + 30 * 158 + 3 * 3108 + 2950 + 12 * 132, 'годовая оплата — 132 ₽ в месяц');
  assert.equal((await call('GET', '/api/admin/data', null, admin)).data.leads.find(l => l.id === ids[1]).billing, 'year');
});
await step('акция: акционные пакеты считаются от акционной цены и не выбираются с публичной формы', async () => {
  const t = Date.now();
  const r = await register({ name: 'Акция Тест', email: `promo${t}@ex.ru`, phone: '+7 902 111-11-11', status: 'ИП', password: 'secret1', agree: true }, '10.0.1.1');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const pc = r.data.code, tok = r.data.token;
  // публичная форма не принимает акционный пакет
  await call('POST', '/api/lead', { name: 'Хитрый', cafe: 'Кафе А', phone: '+7 913 333-33-33', plan: 'start_promo', ref: pc }, null, '10.0.1.2');
  await call('POST', '/api/lead', { name: 'Честный', cafe: 'Кафе Б', phone: '+7 913 444-44-44', plan: 'standard', ref: pc }, null, '10.0.1.3');
  const d = (await call('GET', '/api/admin/data', null, admin)).data;
  const mine = d.leads.filter(x => x.partner === pc);
  assert.ok(mine.length >= 1 && mine.every(l => l.plan !== 'start_promo' && l.plan !== 'standard_promo'), 'акционный пакет прошёл с публичной формы');
  // админ ставит акционные пакеты → 50% от акционной цены (+1 мес × 158)
  await call('POST', '/api/admin/lead', { id: mine[0].id, status: 'paid', plan: 'start_promo', months: 1 }, admin);
  let me = (await call('GET', '/api/me', null, tok)).data;
  assert.equal(me.stats.fromLeads, 1500 + 158, 'Старт-акция: 1500 + месяц поддержки');
  await call('POST', '/api/admin/lead', { id: mine[0].id, status: 'paid', plan: 'standard_promo', months: 1 }, admin);
  me = (await call('GET', '/api/me', null, tok)).data;
  assert.equal(me.stats.fromLeads, 2250 + 158, 'Стандарт-акция: 2250 + месяц поддержки');
});
await step('новый пароль партнёру', async () => {
  const d = (await call('GET', '/api/admin/data', null, admin)).data;
  const p = d.partners.find(x => x.code === code);
  assert.equal((await call('POST', '/api/admin/reset-password', { id: p.id }, token)).status, 401);
  const r = await call('POST', '/api/admin/reset-password', { id: p.id }, admin);
  assert.equal(r.status, 200); assert.equal(r.data.password.length, 10);
  assert.equal((await call('POST', '/api/login', { email, password: 'secret1' })).status, 401, 'старый пароль больше не подходит');
  const l = await call('POST', '/api/login', { email, password: r.data.password }); assert.equal(l.status, 200); token = l.data.token;
});
await step('смена пароля по коду из письма', async () => {
  assert.equal((await call('POST', '/api/password/code', { email: 'nobody@mail.ru' })).status, 200, 'не выдаём, есть ли такой email');
  assert.equal((await call('POST', '/api/password/code', { email })).status, 200);
  assert.equal((await call('POST', '/api/password/reset', { email, code: '111111', password: 'newpass1' })).status, 400);
  const r = await call('POST', '/api/password/reset', { email, code: lastCode(email), password: 'newpass1' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); token = r.data.token;
  assert.equal((await call('POST', '/api/login', { email, password: 'newpass1' })).status, 200);
  assert.equal((await call('POST', '/api/password/reset', { email, code: lastCode(email), password: 'again11' })).status, 400, 'код одноразовый');
});
await step('удаление записей', async () => {
  let d = (await call('GET', '/api/admin/data', null, admin)).data;
  const p = d.partners.find(x => x.code === code);
  const x = d.payouts.find(y => y.partner === code);
  assert.equal((await call('POST', '/api/admin/delete', { type: 'payout', id: x.id }, token)).status, 401, 'партнёр не может удалять');
  assert.equal((await call('POST', '/api/admin/delete', { type: 'payout', id: x.id }, admin)).status, 200);
  assert.equal((await call('GET', '/api/me', null, token)).data.stats.balance, 4766);
  assert.equal((await call('POST', '/api/admin/delete', { type: 'partner', id: p.id }, admin)).status, 200);
  d = (await call('GET', '/api/admin/data', null, admin)).data;
  assert.ok(!d.partners.some(y => y.code === code), 'партнёр не удалён');
  const l = d.leads.find(y => y.id === leadId); assert.ok(l, 'заявка должна остаться'); assert.equal(l.partner, null);
  assert.equal((await call('GET', '/api/me', null, token)).status, 401, 'кабинет удалённого партнёра закрыт');
  assert.equal((await call('POST', '/api/admin/delete', { type: 'lead', id: leadId }, admin)).status, 200);
  d = (await call('GET', '/api/admin/data', null, admin)).data;
  assert.ok(!d.leads.some(y => y.id === leadId), 'заявка не удалена');
});
await step('чужой токен не подходит', async () => {
  assert.equal((await call('GET', '/api/me', null, token.slice(0, -2) + 'xx')).status, 401);
});

await step('кабинет «Сам себе админ»: партнёру 198 ₽/мес (165 при оплате за год), срок по статусу', async () => {
  const em = `cab${Date.now()}@example.ru`, ip = '9.9.9.9';
  const reg = await register({ name: 'Кабинет Тест', email: em, phone: '+7 902 000-00-11', status: 'ИП', password: 'secret1', agree: true }, ip);
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const tk = reg.data.token, pc = (await call('GET', '/api/me', null, tk)).data.partner.code;
  await call('POST', '/api/lead', { name: 'Клиент', cafe: 'Кафе К', phone: '+79993332211', plan: 'start', ref: pc, city: 'Омск' }, null, '8.8.8.8');
  const adm = (await call('POST', '/api/admin/login', { password: env.ADMIN_PASSWORD })).data.token;
  const lead = (await call('GET', '/api/admin/data', null, adm)).data.leads.find(l => l.cafe === 'Кафе К');
  assert.ok(lead, 'заявка не найдена');
  await call('POST', '/api/admin/lead', { id: lead.id, status: 'paid', plan: 'start', months: 0, cabMonths: 3, cabBilling: 'month' }, adm);
  assert.equal((await call('GET', '/api/me', null, tk)).data.stats.earned, 2950 + 3 * 198, 'набор + 3 мес × 198');
  await call('POST', '/api/admin/lead', { id: lead.id, status: 'paid', plan: 'start', months: 2, billing: 'month', cabMonths: 12, cabBilling: 'year' }, adm);
  assert.equal((await call('GET', '/api/me', null, tk)).data.stats.earned, 2950 + 2 * 158 + 12 * 165, 'поддержка и кабинет считаются отдельно');
  await call('POST', '/api/admin/lead', { id: lead.id, status: 'paid', plan: 'start', months: 0, cabMonths: 100 }, adm);
  assert.equal((await call('GET', '/api/me', null, tk)).data.stats.earned, 2950 + 24 * 198, 'потолок 24 месяца для статуса «Партнёр»');
  const mine = (await call('GET', '/api/me', null, tk)).data.leads[0]; assert.equal(mine.cabMonths, 100);
});
// ---------- кабинет владельца: меню ----------
{
  const cafeId = 'tcafe' + Date.now().toString(36), owner = `owner${Date.now()}@example.ru`;
  const base = { categories: [{ id: 'coffee', name: 'Кофе' }, { id: 'food', name: 'Еда' }],
    items: [{ id: 'cap', cat: 'coffee', name: 'Капучино', desc: 'Эспрессо и пена', price: 220, bg: '#FFE0D9', ink: '#C2412D', icon: 'cup', sizes: [{ label: '250 мл', add: 0 }, { label: '350 мл', add: 40 }] },
            { id: 'cake', cat: 'food', name: 'Чизкейк', desc: '', price: 290, bg: '#FFF1D6', ink: '#A86A00', icon: 'cake' }],
    promo: { on: true, name: 'Кофе + круассан', note: 'До 11:00', price: 290 } };
  let ownerToken, ver;
  const ownerLogin = async email => {
    await call('POST', '/api/owner/code', { email }, null, '5.5.5.' + Math.floor(Math.random() * 200));
    const c = lastCode(email); if (!c) return null;
    return (await call('POST', '/api/owner/login', { email, code: c })).data.token;
  };
  await step('меню: админ создаёт кафе со стартовым меню, публично видно без скрытых', async () => {
    admin = admin || (await call('POST', '/api/admin/login', { password: env.ADMIN_PASSWORD })).data.token;
    assert.equal((await call('POST', '/api/admin/cafe', { id: cafeId, owner_email: owner, menu: base })).status, 401, 'без админа нельзя');
    const r = await call('POST', '/api/admin/cafe', { id: cafeId, name: 'Тест', owner_email: owner, active: 1, max_items: 5, menu: { ...base, items: [...base.items, { id: 'x', cat: 'food', name: 'Скрытое', price: 1, hidden: true }] } }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.version, 1);
    const pub = await call('GET', '/api/menu', null, null, '1.1.1.1', { cafe: cafeId });
    assert.equal(pub.status, 200); assert.equal(pub.data.data.items.length, 2, 'скрытое не должно уходить гостям');
    assert.equal(pub.data.data.promo.on, true);
    assert.equal((await call('GET', '/api/menu', null, null, '1.1.1.1', { cafe: 'net-takogo' })).status, 404);
    assert.ok(!JSON.stringify(pub.data).includes(owner), 'e-mail владельца не должен быть в публичном ответе');
  });
  await step('меню: добавление оплатившего кафе из админки (пустое меню + название), дубль кода запрещён', async () => {
    const nid = cafeId + 'n', ne = `new${Date.now()}@example.ru`;
    assert.equal((await call('POST', '/api/admin/cafe', { id: nid, name: 'Новое', owner_email: ne, create: true })).status, 401);
    assert.equal((await call('POST', '/api/admin/cafe', { id: nid, name: 'Новое', create: true }, admin)).status, 400, 'без e-mail нельзя');
    const r = await call('POST', '/api/admin/cafe', { id: nid, name: 'Новое кафе', owner_email: ne, active: 1, max_items: 40, create: true }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.cafe.active, 1);
    assert.equal((await call('POST', '/api/admin/cafe', { id: nid, name: 'Чужое', owner_email: 'x@example.ru', create: true }, admin)).status, 409, 'код занят');
    const pub = (await call('GET', '/api/menu', null, null, '1.1.1.1', { cafe: nid })).data.data;
    assert.equal(pub.items.length, 0); assert.equal(pub.brand.name, 'Новое кафе');
    const tk = await ownerLogin(ne); assert.ok(tk, 'владелец входит по своей почте');
    const m = (await call('GET', '/api/owner/menu', null, tk, '1.1.1.1', { cafe: nid })).data;
    assert.equal(m.cafe.maxItems, 40); m.menu.items.push({ cat: 'main', name: 'Чай', price: 100 }); m.menu.brand = { name: 'Новое кафе', sub: 'Омск, ул. Ленина 1' };
    assert.equal((await call('POST', '/api/owner/menu', { cafe: nid, menu: m.menu, baseVersion: m.version }, tk)).status, 200);
    assert.equal((await call('GET', '/api/menu', null, null, '1.1.1.1', { cafe: nid })).data.data.brand.sub, 'Омск, ул. Ленина 1');
  });
  await step('меню: вход по коду; чужой email ничего не получает', async () => {
    const before = (globalThis.__outbox || []).length;
    const r = await call('POST', '/api/owner/code', { email: 'stranger@example.ru' }, null, '6.6.6.6');
    assert.equal(r.status, 200); assert.equal((globalThis.__outbox || []).length, before, 'письмо чужому уходить не должно');
    assert.equal((await call('POST', '/api/owner/login', { email: 'stranger@example.ru', code: '123456' })).status, 400);
    assert.equal((await call('POST', '/api/owner/login', { email: owner, code: '000000' })).status, 400, 'неверный код');
    ownerToken = await ownerLogin(owner); assert.ok(ownerToken);
    assert.equal((await call('GET', '/api/owner/menu', null, null, '1.1.1.1', { cafe: cafeId })).status, 401);
    const m = (await call('GET', '/api/owner/menu', null, ownerToken, '1.1.1.1', { cafe: cafeId })).data;
    assert.equal((await call('GET', '/api/owner/menu', null, ownerToken)).data.cafe.id, cafeId, 'без кафе в запросе — первое кафе владельца');
    assert.equal(m.menu.items.length, 3, 'владелец видит и скрытое блюдо'); assert.equal(m.cafe.active, true); ver = m.version;
  });
  await step('меню: правка цены, стоп-лист, конфликт версий, откат', async () => {
    const m = (await call('GET', '/api/owner/menu', null, ownerToken, '1.1.1.1', { cafe: cafeId })).data.menu;
    m.items.find(i => i.id === 'cap').price = 250; m.items.find(i => i.id === 'cake').hidden = true;
    let r = await call('POST', '/api/owner/menu', { cafe: cafeId, menu: m, baseVersion: ver }, ownerToken);
    assert.equal(r.status, 200, JSON.stringify(r.data)); const v2 = r.data.version; assert.equal(v2, ver + 1);
    let pub = (await call('GET', '/api/menu', null, null, '1.1.1.1', { cafe: cafeId })).data;
    assert.equal(pub.data.items.find(i => i.id === 'cap').price, 250); assert.ok(!pub.data.items.some(i => i.id === 'cake'), 'стоп-лист');
    assert.equal((await call('POST', '/api/owner/menu', { cafe: cafeId, menu: m, baseVersion: ver }, ownerToken)).status, 409, 'устаревшая версия');
    r = await call('POST', '/api/owner/rollback', { cafe: cafeId, ver }, ownerToken);
    assert.equal(r.status, 200); assert.equal(r.data.version, v2 + 1);
    pub = (await call('GET', '/api/menu', null, null, '1.1.1.1', { cafe: cafeId })).data;
    assert.equal(pub.data.items.find(i => i.id === 'cap').price, 220, 'после отката цена прежняя');
    assert.equal((await call('POST', '/api/owner/rollback', { cafe: cafeId, ver: 999 }, ownerToken)).status, 404);
    ver = r.data.version;
  });
  await step('меню: проверка данных (цвета, фото, цена, лимит, категории)', async () => {
    const send = async mut => { const m = JSON.parse(JSON.stringify(base)); mut(m); return call('POST', '/api/owner/menu', { cafe: cafeId, menu: m, baseVersion: ver }, ownerToken); };
    assert.equal((await send(m => { m.items[0].photo = 'javascript:alert(1)'; })).status, 400, 'фото только https');
    assert.equal((await send(m => { m.items[0].photo = 'img/../../x.jpg'; })).status, 400, 'выход из папки img');
    assert.equal((await send(m => { m.items[0].price = -5; })).status, 400);
    assert.equal((await send(m => { m.items[0].price = 'abc'; })).status, 400);
    assert.equal((await send(m => { m.items[0].cat = 'нет'; })).status, 400, 'несуществующая категория');
    assert.equal((await send(m => { m.items[0].name = ''; })).status, 400);
    assert.equal((await send(m => { for (let i = 0; i < 6; i++) m.items.push({ cat: 'food', name: 'Блюдо ' + i, price: 10 }); })).status, 400, 'лимит позиций тарифа (5)');
    assert.equal((await send(m => { m.items[0].photo = 'img/plov1.jpg'; })).status, 200, 'фото из папки кафе допускается');
    ver = (await call('GET', '/api/owner/menu', null, ownerToken, '1.1.1.1', { cafe: cafeId })).data.version;
    const r = await send(m => { m.items[0].bg = 'red;background:url(//evil)'; m.items[0].ink = '"><script>'; m.items[0].evil = 'x'; m.items[1].name = '<b>Торт</b>'; });
    assert.equal(r.status, 200, JSON.stringify(r.data)); ver = r.data.version;
    const it = (await call('GET', '/api/menu', null, null, '1.1.1.1', { cafe: cafeId })).data.data.items;
    assert.equal(it[0].bg, '#EFE2CC', 'плохой цвет заменён'); assert.equal(it[0].ink, '#5E6B6A'); assert.equal(it[0].evil, undefined, 'лишние поля отброшены');
  });
  await step('меню: подписка выключена — правки закрыты, меню работает; чужое кафе закрыто', async () => {
    await call('POST', '/api/admin/cafe', { id: cafeId, active: 0 }, admin);
    const m = (await call('GET', '/api/owner/menu', null, ownerToken, '1.1.1.1', { cafe: cafeId })).data;
    assert.equal(m.cafe.active, false);
    assert.equal((await call('POST', '/api/owner/menu', { cafe: cafeId, menu: m.menu, baseVersion: m.version }, ownerToken)).status, 402);
    assert.equal((await call('POST', '/api/owner/rollback', { cafe: cafeId, ver: 1 }, ownerToken)).status, 402);
    assert.equal((await call('GET', '/api/menu', null, null, '1.1.1.1', { cafe: cafeId })).status, 200, 'гости по-прежнему видят меню');
    await call('POST', '/api/admin/cafe', { id: cafeId, active: 1 }, admin);
    const otherId = cafeId + 'b', other = `other${Date.now()}@example.ru`;
    await call('POST', '/api/admin/cafe', { id: otherId, owner_email: other, active: 1, menu: base }, admin);
    assert.equal((await call('GET', '/api/owner/menu', null, ownerToken, '1.1.1.1', { cafe: otherId })).status, 403, 'чужое кафе');
    assert.equal((await call('POST', '/api/owner/menu', { cafe: otherId, menu: base, baseVersion: 1 }, ownerToken)).status, 403);
    assert.equal((await call('POST', '/api/owner/menu', { cafe: cafeId, menu: base, baseVersion: 1 }, admin)).status, 401, 'токен админа не годится владельцу');
    assert.equal((await call('POST', '/api/admin/delete', { type: 'cafe', id: otherId }, ownerToken)).status, 401, 'владелец удалять не может');
    assert.equal((await call('POST', '/api/admin/delete', { type: 'cafe', id: otherId }, admin)).status, 200);
    assert.equal((await call('GET', '/api/menu', null, null, '1.1.1.1', { cafe: otherId })).status, 404, 'меню удалённого кафе исчезло');
    assert.ok(!(await call('GET', '/api/admin/data', null, admin)).data.cafes.some(c => c.id === otherId), 'кафе пропало из админки');
    assert.equal((await call('POST', '/api/admin/delete', { type: 'cafe', id: otherId }, admin)).status, 404, 'повторное удаление');
    await call('POST', '/api/admin/cafe', { id: otherId, owner_email: other, active: 1, menu: base }, admin);   // вернуть для проверки ниже
    // смена владельца отзывает старый токен
    await call('POST', '/api/admin/cafe', { id: cafeId, owner_email: other }, admin);
    assert.equal((await call('GET', '/api/owner/menu', null, ownerToken, '1.1.1.1', { cafe: cafeId })).status, 403, 'после смены владельца старый токен не работает');
  });
}
console.log(useYdb ? 'Все проверки на YDB пройдены' : 'Все проверки пройдены');
process.exit(0);
