// Хранилище в Яндекс YDB (serverless). Все id и даты — строки, числа — Int32.
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { CredentialsProvider } from '@ydbjs/auth';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';

// Токен сервисного аккаунта приходит в каждом вызове функции (context.token).
class FunctionTokenProvider extends CredentialsProvider {
  token = '';
  fallback = new MetadataCredentialsProvider();
  getToken(force, signal) { return this.token ? Promise.resolve(this.token) : this.fallback.getToken(force, signal); }
}
export const tokenProvider = new FunctionTokenProvider();

let sqlPromise = null;
function getSql() {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const cs = process.env.YDB_CONNECTION_STRING;
      if (!cs) throw new Error('Не задан YDB_CONNECTION_STRING');
      const credentialsProvider = process.env.YDB_ANONYMOUS === '1' ? new AnonymousCredentialsProvider() : tokenProvider;
      const driver = new Driver(cs, { credentialsProvider });
      await driver.ready(AbortSignal.timeout(15000));
      return query(driver);
    })().catch(e => { sqlPromise = null; throw e; });
  }
  return sqlPromise;
}
async function rows(strings, ...values) {
  const sql = await getSql();
  const rs = await sql(strings, ...values).idempotent(true);
  return (rs[0] || []).map(normalize);
}
async function exec(strings, ...values) {
  const sql = await getSql();
  await sql(strings, ...values);
}
function normalize(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v;
  return o;
}

const P_COLS = 'id, name, email, phone, status, source, code, pass_hash, salt, ip_hash, created_at';

export const db = {
  async setup() {
    const sql = await getSql();
    const ddl = [
      `CREATE TABLE IF NOT EXISTS partners (id Utf8 NOT NULL, name Utf8, email Utf8, phone Utf8, status Utf8, source Utf8, code Utf8, pass_hash Utf8, salt Utf8, ip_hash Utf8, created_at Utf8, PRIMARY KEY (id))`,
      `CREATE TABLE IF NOT EXISTS clicks (partner_id Utf8 NOT NULL, day Utf8 NOT NULL, ip_hash Utf8 NOT NULL, PRIMARY KEY (partner_id, day, ip_hash))`,
      `CREATE TABLE IF NOT EXISTS leads (id Utf8 NOT NULL, created_at Utf8, name Utf8, cafe Utf8, phone Utf8, plan Utf8, partner_id Utf8, status Utf8, months Int32, paid_at Utf8, ip_hash Utf8, PRIMARY KEY (id))`,
      `CREATE TABLE IF NOT EXISTS payouts (id Utf8 NOT NULL, partner_id Utf8, amount Int32, note Utf8, check_received Int32, created_at Utf8, PRIMARY KEY (id))`
    ];
    for (const q of ddl) await sql([q]);
    // новые столбцы для уже созданных таблиц (повторно — пропускаем)
    for (const q of ['ALTER TABLE partners ADD COLUMN referrer_id Utf8']) {
      try { await sql([q]); } catch (e) { if (!/exist|duplicate|already/i.test(String(e && e.message))) throw e; }
    }
  },

  async countPartnersByIp(ih) { return (await rows`SELECT COUNT(*) AS n FROM partners WHERE ip_hash = ${ih}`)[0]?.n || 0; },
  async partnerByEmail(email) { return (await rows`SELECT id, pass_hash, salt FROM partners WHERE email = ${email} LIMIT 1`)[0] || null; },
  async partnerByCode(code) { return (await rows`SELECT id, code, name, email, phone FROM partners WHERE code = ${code} LIMIT 1`)[0] || null; },
  async partnerById(id) { return (await rows`SELECT id, name, email, phone, status, code, created_at FROM partners WHERE id = ${id}`)[0] || null; },
  async insertPartner(p) {
    await exec`UPSERT INTO partners (id, name, email, phone, status, source, code, pass_hash, salt, ip_hash, created_at, referrer_id)
      VALUES (${p.id}, ${p.name}, ${p.email}, ${p.phone}, ${p.status}, ${p.source}, ${p.code}, ${p.pass_hash}, ${p.salt}, ${p.ip_hash}, ${p.created_at}, ${p.referrer_id || ''})`;
  },
  async allPartners() { return rows`SELECT id, name, email, phone, status, source, code, created_at, referrer_id FROM partners`; },

  async addClick(pid, day, ih) { await exec`UPSERT INTO clicks (partner_id, day, ip_hash) VALUES (${pid}, ${day}, ${ih})`; },
  async clicksByPartnerSince(pid, from) { return rows`SELECT day, COUNT(*) AS n FROM clicks WHERE partner_id = ${pid} AND day >= ${from} GROUP BY day`; },
  async clickCounts() { return rows`SELECT partner_id, COUNT(*) AS n FROM clicks GROUP BY partner_id`; },

  async countLeadsByIp(ih) { return (await rows`SELECT COUNT(*) AS n FROM leads WHERE ip_hash = ${ih}`)[0]?.n || 0; },
  async insertLead(l) {
    await exec`UPSERT INTO leads (id, created_at, name, cafe, phone, plan, partner_id, status, months, paid_at, ip_hash)
      VALUES (${l.id}, ${l.created_at}, ${l.name}, ${l.cafe}, ${l.phone}, ${l.plan}, ${l.partner_id}, ${l.status}, ${l.months}, ${l.paid_at}, ${l.ip_hash})`;
  },
  async leadsByPartner(pid) { return rows`SELECT id, created_at, cafe, plan, status, months FROM leads WHERE partner_id = ${pid}`; },
  async allLeads() { return rows`SELECT id, created_at, name, cafe, phone, plan, partner_id, status, months, paid_at FROM leads`; },
  async leadById(id) { return (await rows`SELECT id, status, paid_at FROM leads WHERE id = ${id}`)[0] || null; },
  async updateLead(id, f) { await exec`UPDATE leads SET status = ${f.status}, plan = ${f.plan}, months = ${f.months}, paid_at = ${f.paid_at} WHERE id = ${id}`; },

  async insertPayout(x) {
    await exec`UPSERT INTO payouts (id, partner_id, amount, note, check_received, created_at)
      VALUES (${x.id}, ${x.partner_id}, ${x.amount}, ${x.note}, ${x.check_received}, ${x.created_at})`;
  },
  async payoutsByPartner(pid) { return rows`SELECT amount, note, check_received, created_at FROM payouts WHERE partner_id = ${pid}`; },
  async deleteLead(id) { await exec`DELETE FROM leads WHERE id = ${id}`; },
  async deletePayout(id) { await exec`DELETE FROM payouts WHERE id = ${id}`; },
  async deletePartner(id) {
    const sql = await getSql();
    await sql.begin(async tx => {
      await tx`DELETE FROM clicks WHERE partner_id = ${id}`;
      await tx`DELETE FROM payouts WHERE partner_id = ${id}`;
      await tx`UPDATE leads SET partner_id = '' WHERE partner_id = ${id}`;
      await tx`DELETE FROM partners WHERE id = ${id}`;
    });
  },
  async allPayouts() { return rows`SELECT id, partner_id, amount, note, check_received, created_at FROM payouts`; }
};
