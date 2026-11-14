#!/usr/bin/env node
// Загружает меню кафе из его страницы (cafes/<код>/index.html) на сервер и заводит кафе в кабинете.
// Запуск:  ADMIN_PASSWORD=... node tools/seed-menu.mjs zerno --owner mail@example.ru [--name "Зерно"] [--active] [--max 100] [--dry]
// Без --owner/--active у уже заведённого кафе эти поля не меняются. --dry — показать, что будет отправлено, и ничего не слать.
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), id = args[0];
const opt = k => { const i = args.indexOf('--' + k); return i > 0 ? args[i + 1] : undefined; };
if (!id || id.startsWith('--')) { console.error('Укажите код кафе: node tools/seed-menu.mjs zerno --owner mail@example.ru'); process.exit(2); }

const html = fs.readFileSync(path.join(root, 'cafes', id, 'index.html'), 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).pop();
const stub = () => ({ innerHTML: '', textContent: '', hidden: false, dataset: {}, addEventListener() {}, style: {} });
const ctx = { console: { log() {} }, document: { getElementById: stub, addEventListener() {} }, location: { hash: '' },
  localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, AbortController,
  fetch: () => Promise.resolve({ ok: false }), navigator: {} };
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(code + '\n;globalThis.__out = { name: CAFE.name, categories: CATEGORIES, items: MENU, promo: PROMO };', ctx);
const out = JSON.parse(JSON.stringify(ctx.__out));
const note = (html.match(/id="promo"[^>]*>\s*<span><small>([^<]*)<\/small>/) || [])[1] || '';
const real = out.promo && out.promo.name && out.promo.name !== '—' && out.promo.price > 0;
const menu = { categories: out.categories, items: out.items, promo: real ? { on: true, ...out.promo, note } : { on: false } };

const body = { id, name: opt('name') || out.name, menu };
if (opt('owner')) body.owner_email = opt('owner');
if (args.includes('--active')) body.active = 1;
if (opt('max')) body.max_items = Number(opt('max'));
if (args.includes('--json')) { process.stdout.write(JSON.stringify(body)); process.exit(0); }
console.log(`Кафе «${body.name}» (${id}): ${menu.categories.length} категорий, ${menu.items.length} блюд, акция: ${menu.promo.on ? menu.promo.name : 'нет'}`);
if (args.includes('--dry')) { console.log(JSON.stringify(body, null, 1).slice(0, 1500)); if (process.env.SEED_CHECK) { const { cleanMenu } = await import('../backend/app.mjs'); const r = cleanMenu(menu, 500); console.log(r.error ? 'ОШИБКА проверки: ' + r.error : 'проверка сервера: ок, блюд ' + r.menu.items.length); } process.exit(0); }

const pw = process.env.ADMIN_PASSWORD; if (!pw) { console.error('Задайте ADMIN_PASSWORD'); process.exit(2); }
const cfg = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
const api = (cfg.match(/API_URL:\s*'([^']+)'/) || [])[1];
const call = async (p, b, tok) => {
  const r = await fetch(`${api}?r=${encodeURIComponent(p)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-Auth': 'Bearer ' + tok } : {}) }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${r.status} ${d.error || ''}`); return d;
};
const { token } = await call('/api/admin/login', { password: pw });
const r = await call('/api/admin/cafe', body, token);
console.log('Готово: версия меню №' + r.version, '· владелец:', r.cafe.owner_email || '—', '· кабинет:', r.cafe.active ? 'включён' : 'выключен');
