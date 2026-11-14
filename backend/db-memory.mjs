// Хранилище в памяти — только для проверок.
export function memoryDb() {
  const t = { partners: [], clicks: [], leads: [], payouts: [], codes: [], cafes: [], menus: [] };
  const copy = x => x.map(o => ({ ...o }));
  const one = x => (x ? { ...x } : null);
  const groupCount = (arr, key) => Object.entries(arr.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {})).map(([k, n]) => ({ [key]: k, n }));
  return {
    t,
    async setup() {},
    async countPartnersByIp(ih) { return t.partners.filter(p => p.ip_hash === ih).length; },
    async partnerByEmail(e) { return one(t.partners.find(p => p.email === e)); },
    async partnerByCode(c) { return one(t.partners.find(p => p.code === c)); },
    async partnerById(id) { return one(t.partners.find(p => p.id === id)); },
    async insertPartner(p) { t.partners.push({ ...p }); },
    async allPartners() { return copy(t.partners); },
    async addClick(pid, day, ih) { if (!t.clicks.some(c => c.partner_id === pid && c.day === day && c.ip_hash === ih)) t.clicks.push({ partner_id: pid, day, ip_hash: ih }); },
    async clicksByPartnerSince(pid, from) { return groupCount(t.clicks.filter(c => c.partner_id === pid && c.day >= from), 'day'); },
    async clickCounts() { return groupCount(t.clicks, 'partner_id'); },
    async countLeadsByIp(ih) { return t.leads.filter(l => l.ip_hash === ih).length; },
    async insertLead(l) { t.leads.push({ ...l }); },
    async leadsByPartner(pid) { return copy(t.leads.filter(l => l.partner_id === pid)); },
    async allLeads() { return copy(t.leads); },
    async leadById(id) { return one(t.leads.find(l => l.id === id)); },
    async updateLead(id, f) { Object.assign(t.leads.find(l => l.id === id), f); },
    async insertPayout(x) { t.payouts.push({ ...x }); },
    async payoutsByPartner(pid) { return copy(t.payouts.filter(x => x.partner_id === pid)); },
    async getCode(email, purpose) { return one(t.codes.find(c => c.email === email && c.purpose === purpose)); },
    async putCode(c) { t.codes = t.codes.filter(x => !(x.email === c.email && x.purpose === c.purpose)); t.codes.push({ ...c }); },
    async bumpCodeTries(email, purpose, tries) { const c = t.codes.find(x => x.email === email && x.purpose === purpose); if (c) c.tries = tries; },
    async deleteCode(email, purpose) { t.codes = t.codes.filter(x => !(x.email === email && x.purpose === purpose)); },
    async countCodesByIp(ih) { return t.codes.filter(c => c.ip_hash === ih).length; },
    async setPassword(id, hash, salt) { Object.assign(t.partners.find(p => p.id === id), { pass_hash: hash, salt }); },
    async deleteLead(id) { t.leads = t.leads.filter(l => l.id !== id); },
    async deletePayout(id) { t.payouts = t.payouts.filter(x => x.id !== id); },
    async deletePartner(id) {
      t.clicks = t.clicks.filter(c => c.partner_id !== id);
      t.payouts = t.payouts.filter(x => x.partner_id !== id);
      t.leads.forEach(l => { if (l.partner_id === id) l.partner_id = ''; });
      t.partners = t.partners.filter(p => p.id !== id);
    },
    async allPayouts() { return copy(t.payouts); },
    async cafeById(id) { return one(t.cafes.find(c => c.id === id)); },
    async cafesByEmail(e) { return copy(t.cafes.filter(c => c.owner_email === e)); },
    async allCafes() { return copy(t.cafes); },
    async upsertCafe(c) { t.cafes = t.cafes.filter(x => x.id !== c.id); t.cafes.push({ ...c }); },
    async latestMenu(id) { const v = t.menus.filter(m => m.cafe_id === id).sort((a, b) => b.ver - a.ver)[0]; return one(v); },
    async menuByVer(id, ver) { return one(t.menus.find(m => m.cafe_id === id && m.ver === ver)); },
    async menuVersions(id) { return copy(t.menus.filter(m => m.cafe_id === id)).sort((a, b) => b.ver - a.ver).slice(0, 20).map(({ cafe_id, ver, created_at, author }) => ({ cafe_id, ver, created_at, author })); },
    async insertMenu(m) { t.menus.push({ ...m }); },
    async trimMenus(id, keepFromVer) { t.menus = t.menus.filter(m => !(m.cafe_id === id && m.ver < keepFromVer)); }
  };
}
