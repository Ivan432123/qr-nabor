// Проверка всей цепочки: регистрация → переход → заявка → оплата → начисление → выплата.
// Без YDB_CONNECTION_STRING — на базе в памяти; с ним — на настоящей YDB через index.js.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { handle } from './app.mjs';
import { memoryDb } from './db-memory.mjs';

const env = { ADMIN_PASSWORD: 'test-admin-password', TOKEN_SECRET: 'test-secret-1234567890' };
const useYdb = !!process.env.YDB_CONNECTION_STRING;
let call;
if (useYdb) {
  Object.assign(process.env, env);
  const { handler } = createRequire(import.meta.url)('./index.js');
  call = async (method, path, body, token, ip = '1.1.1.1', query = {}) => {
    const r = await handler({ httpMethod: method, queryStringParameters: { r: path, ...query },
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : '', isBase64Encoded: false, requestContext: { identity: { sourceIp: ip } } }, {});
    return { status: r.statusCode, data: r.body ? JSON.parse(r.body) : null };
  };
} else {
  const db = memoryDb();
  call = async (method, path, body, token, ip = '1.1.1.1', query = {}) => {
    const r = await handle({ method, path, query, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: body ? JSON.stringify(body) : '', ip }, db, env);
    return { status: r.status, data: r.body ? JSON.parse(r.body) : null };
  };
}

const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.error('✗', name, '\n', e); process.exit(1); } };
let token, code, admin, leadId;
const email = `test${Date.now()}@example.com`;

await step('сервер отвечает', async () => { const r = await call('GET', '/api'); assert.equal(r.data.ok, true); });
await step('создание таблиц', async () => {
  assert.equal((await call('POST', '/api/setup', {}, 'wrong')).status, 401);
  const r = await call('POST', '/api/setup', {}, env.ADMIN_PASSWORD); assert.equal(r.status, 200, JSON.stringify(r.data));
  const r2 = await call('POST', '/api/setup', {}, env.ADMIN_PASSWORD); assert.equal(r2.status, 200, 'повторно: ' + JSON.stringify(r2.data));
});
await step('регистрация партнёра', async () => {
  const bad = await call('POST', '/api/register', { name: 'Иван', email, phone: '+7 900 123-45-67', status: 'Самозанятый', password: '123456' });
  assert.equal(bad.status, 400);
  const r = await call('POST', '/api/register', { name: 'Иван Петров', email, phone: '+7 900 123-45-67', status: 'Самозанятый', source: 'Авито', password: 'secret1', agree: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)); token = r.data.token; code = r.data.code;
  assert.match(code, /^IVAN\d\d/);
  const dup = await call('POST', '/api/register', { name: 'Иван', email, phone: '+7 900 123-45-67', status: 'ИП', password: 'secret1', agree: true });
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
  const r = await call('POST', '/api/lead', { name: 'Анна', cafe: 'Кафе «Зерно»', phone: '+7 913 000-00-00', plan: 'standard', ref: code }, null, '2.2.2.2');
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
  const p = d.partners.find(x => x.code === code); assert.equal(p.clicks, 2); assert.equal(p.leads, 1); assert.equal(p.balance, 0);
});
await step('оплата: 2500 за набор + 2 мес × 300', async () => {
  const r = await call('POST', '/api/admin/lead', { id: leadId, status: 'paid', plan: 'standard', months: '2' }, admin); assert.equal(r.status, 200, JSON.stringify(r.data));
  const me = (await call('GET', '/api/me', null, token)).data;
  assert.equal(me.stats.earned, 3100); assert.equal(me.stats.balance, 3100); assert.equal(me.stats.paidCount, 1); assert.equal(me.leads[0].status, 'paid');
});
await step('выплата партнёру', async () => {
  assert.equal((await call('POST', '/api/admin/payout', { partner: code, amount: 0 }, admin)).status, 400);
  const r = await call('POST', '/api/admin/payout', { partner: code.toLowerCase(), amount: '3100', note: 'СБП', check: true }, admin); assert.equal(r.status, 200);
  const me = (await call('GET', '/api/me', null, token)).data;
  assert.equal(me.stats.paidOut, 3100); assert.equal(me.stats.balance, 0); assert.equal(me.payouts[0].check, true);
  const d = (await call('GET', '/api/admin/data', null, admin)).data;
  assert.equal(d.payouts.find(x => x.partner === code).amount, 3100);
});
await step('чужой токен не подходит', async () => {
  assert.equal((await call('GET', '/api/me', null, token.slice(0, -2) + 'xx')).status, 401);
});
console.log(useYdb ? 'Все проверки на YDB пройдены' : 'Все проверки пройдены');
process.exit(0);
