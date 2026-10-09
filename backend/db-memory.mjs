// Хранилище в памяти — только для проверок.
export function memoryDb() {
  const t = { partners: [], clicks: [], leads: [], payouts: [] };
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
    async deleteLead(id) { t.leads = t.leads.filter(l => l.id !== id); },
    async deletePayout(id) { t.payouts = t.payouts.filter(x => x.id !== id); },
    async deletePartner(id) {
      t.clicks = t.clicks.filter(c => c.partner_id !== id);
      t.payouts = t.payouts.filter(x => x.partner_id !== id);
      t.leads.forEach(l => { if (l.partner_id === id) l.partner_id = ''; });
      t.partners = t.partners.filter(p => p.id !== id);
    },
    async allPayouts() { return copy(t.payouts); }
  };
}
