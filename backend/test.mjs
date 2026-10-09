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
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Auth': 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : '', isBase64Encoded: false, requestContext: { identity: { sourceIp: ip } } }, {});
    return { status: r.statusCode, data: r.body ? JSON.parse(r.body) : null };
  };
} else {
  const db = memoryDb();
  call = async (method, path, body, token, ip = '1.1.1.1', query = {}) => {
    const r = await handle({ method, path, query, headers: token ? { 'X-Auth': 'Bearer ' + token } : {}, body: body ? JSON.stringify(body) : '', ip }, db, env);
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
await step('команда: 10% с 1-го уровня и 5% со 2-го', async () => {
  const t = Date.now();
  const reg = async (name, mail, phone, pref, ip) => {
    const r = await call('POST', '/api/register', { name, email: mail, phone, status: 'ИП', password: 'secret1', agree: true, pref }, null, ip);
    assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data;
  };
  const A = await reg('Анна Смирнова', `a${t}@ex.com`, '+7 901 000-00-01', '', '10.0.0.1');
  const B = await reg('Борис Котов', `b${t}@ex.com`, '+7 901 000-00-02', A.code.toLowerCase(), '10.0.0.2');
  assert.equal(B.invited, true);
  const C = await reg('Вера Лис', `c${t}@ex.com`, '+7 901 000-00-03', B.code, '10.0.0.3');
  const self = await reg('Анна Вторая', `a2${t}@ex.com`, '8 (901) 000-00-01', A.code, '10.0.0.4');
  assert.equal(self.invited, false, 'нельзя пригласить самого себя (тот же телефон)');
  await call('POST', '/api/lead', { name: 'Пётр', cafe: 'Кафе команды', phone: '+7 913 222-22-22', plan: 'standard', ref: C.code }, null, '10.0.0.9');
  const d = (await call('GET', '/api/admin/data', null, admin)).data;
  const l = d.leads.find(x => x.partner === C.code);
  await call('POST', '/api/admin/lead', { id: l.id, status: 'paid', plan: 'standard', months: 2 }, admin);
  const meA = (await call('GET', '/api/me', null, A.token)).data;
  const meB = (await call('GET', '/api/me', null, B.token)).data;
  const meC = (await call('GET', '/api/me', null, C.token)).data;
  assert.equal(meC.stats.earned, 3100);
  assert.equal(meB.stats.teamIncome, 310); assert.equal(meB.stats.earned, 310); assert.equal(meB.team.invitedBy, 'Анна С.');
  assert.equal(meB.team.level1.length, 1); assert.equal(meB.team.level1[0].name, 'Вера Л.');
  assert.equal(meA.stats.teamIncome, 155); assert.equal(meA.stats.balance, 155);
  assert.equal(meA.team.level1.length, 1); assert.equal(meA.team.level2.length, 1); assert.equal(meA.team.level2[0].via, 'Борис К.');
  const d2 = (await call('GET', '/api/admin/data', null, admin)).data;
  const pa = d2.partners.find(x => x.code === A.code), pb = d2.partners.find(x => x.code === B.code);
  assert.equal(pb.referrer, A.code); assert.equal(pa.teamIncome, 155); assert.equal(pa.team1, 1); assert.equal(pa.team2, 1);
  assert.equal(d2.partners.find(x => x.code === self.code).referrer, null);
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
await step('удаление записей', async () => {
  let d = (await call('GET', '/api/admin/data', null, admin)).data;
  const p = d.partners.find(x => x.code === code);
  const x = d.payouts.find(y => y.partner === code);
  assert.equal((await call('POST', '/api/admin/delete', { type: 'payout', id: x.id }, token)).status, 401, 'партнёр не может удалять');
  assert.equal((await call('POST', '/api/admin/delete', { type: 'payout', id: x.id }, admin)).status, 200);
  assert.equal((await call('GET', '/api/me', null, token)).data.stats.balance, 3100);
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
console.log(useYdb ? 'Все проверки на YDB пройдены' : 'Все проверки пройдены');
process.exit(0);
