// Учётная логика EsepOnline, перенесённая с сайта (app.html), чтобы бот считал так же, как сайт.

export const DOC_TYPES = {
    customer_invoice: { label: 'Счёт на оплату', prefix: 'СЧ' },
    sale: { label: 'Реализация', prefix: 'РТ' },
};

// Виды документов, которые создаёт бот
export const BOT_DOCS = {
    invoice: { type: 'customer_invoice', label: 'Счёт на оплату', icon: '🧾', tab: 'goods', form: 'invoice' },
    waybill: { type: 'sale', label: 'Накладная', icon: '🚚', tab: 'goods', form: 'waybill', opKind: 'Товары (накладная, УПД)' },
    transfer: { type: 'sale', label: 'Акт приёма-передачи', icon: '📦', tab: 'goods', form: 'transfer', opKind: 'Товары (накладная, УПД)' },
    works: { type: 'sale', label: 'Акт выполненных работ', icon: '🛠', tab: 'services', form: 'works', opKind: 'Услуги (акт, УПД)' },
};

export const MONEY_IN_TYPES = ['payment_in', 'pko'];
export const MONEY_OUT_TYPES = ['payment_out', 'rko', 'payment_order', 'statement', 'directbank'];

export function uid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
export function today() {
    // Дата по Бишкеку (UTC+6)
    const d = new Date(Date.now() + 6 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
}
export function formatDate(s) { if (!s) return '—'; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}.${m}.${y}`; }
export function formatAmount(n) {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    const [i, f] = Math.abs(v).toFixed(2).split('.');
    return (v < 0 ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + f;
}
export function formatQty(n) {
    const v = Math.round((Number(n) || 0) * 1000) / 1000;
    return String(v).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
export function normName(s) {
    return String(s || '').trim().toLowerCase().replace(/[«»""„‟''‛‹›"']/g, '').replace(/\s+/g, ' ');
}
export function matchContractor(a, b) { return normName(a) === normName(b); }

// ---------- Справочники ----------
export const nom = (db, id) => (db.trade.nomenclature || []).find(n => n.id === id);
export const nomName = (db, id) => { const n = nom(db, id); return n ? n.name.trim() : '—'; };
export const contractor = (db, id) => (db.trade.contractors || []).find(c => c.id === id);
export const contractorName = (db, id) => { const c = contractor(db, id); return c ? c.name.trim() : '—'; };
export const docById = (db, id) => (db.trade.docs || []).find(d => d.id === id);

export function search(list, text, field = 'name') {
    const q = normName(text);
    if (!q) return [];
    const words = q.split(' ');
    return list.filter(x => { const n = normName(x[field]); return words.every(w => n.includes(w)); })
        .sort((a, b) => normName(a[field]).indexOf(words[0]) - normName(b[field]).indexOf(words[0]));
}

// ---------- Нумерация (как tNextNumber на сайте) ----------
export function nextNumber(db, type) {
    let max = 0;
    (db.trade.docs || []).filter(d => d.type === type).forEach(d => { const m = String(d.number).match(/(\d+)$/); if (m) max = Math.max(max, parseInt(m[1])); });
    return DOC_TYPES[type].prefix + '-' + String(max + 1).padStart(6, '0');
}

// ---------- Расчёт сумм (как tCalcRow / tCalcDoc) ----------
export function calcRow(row, vatMode) {
    const qty = Number(row.qty) || 0, price = Number(row.price) || 0, rate = Number(row.vat);
    row.sum = Math.round(qty * price * 100) / 100;
    if (!(rate >= 0)) { row.vatSum = 0; row.total = row.sum; }
    else if (vatMode === 'in') { row.vatSum = Math.round(row.sum * rate / (100 + rate) * 100) / 100; row.total = row.sum; }
    else { row.vatSum = Math.round(row.sum * rate / 100 * 100) / 100; row.total = Math.round((row.sum + row.vatSum) * 100) / 100; }
    return row;
}
export function calcDoc(d) {
    let total = 0, vat = 0, sum = 0;
    ['goods', 'services', 'agent', 'tara'].forEach(tab => (d[tab] || []).forEach(r => { calcRow(r, d.vatMode); total += r.total; vat += r.vatSum; sum += r.sum; }));
    d.total = Math.round(total * 100) / 100; d.vatTotal = Math.round(vat * 100) / 100; d.sumTotal = Math.round(sum * 100) / 100;
    return d;
}

// Новый документ в том же формате, что создаёт сайт (tMkDoc)
export function makeDoc(db, type, o) {
    const org = db.trade.org || {};
    const d = {
        id: uid(), type, number: nextNumber(db, type), date: o.date || today(), status: o.status || 'posted', opKind: o.opKind || '',
        contractor: o.contractor || '', contract: '', warehouse: o.warehouse || 'w1', basis: o.basis || '', payTerm: '',
        settle: { acc: '62.01', adv: '62.02', offset: 'Автоматически' },
        priceType: 'pt1', vatMode: o.vatMode || 'in', discount: 0, payUntil: o.payUntil || '', invoiceStatus: '',
        goods: [], services: [], agent: [], tara: [],
        extra: { consignor: '', consignee: '', address: '', responsible: '', comment: o.comment || '', signHead: org.director || '', signAcc: org.accountant || '', signRelease: '', signGave: '' },
        sf: null, gtdData: { number: '', customsValue: 0, dutyPct: 0, vatPct: 12, fee: 0, deposit: '' }, poa: { person: '', position: '', passport: '', validTo: '' },
        recon: { from: '', to: '', rows: [], openBal: 0 }, payCash: 0, payCard: 0, rewardPct: 10, corrKind: '',
        created: new Date().toISOString(),
        history: [{ ts: new Date().toISOString(), user: o.user || 'Telegram-бот', action: 'Создание (Telegram-бот)' }],
        source: 'telegram',
    };
    (o.rows || []).forEach(r => {
        const n = nom(db, r.nom) || {};
        const row = { nom: r.nom, qty: Number(r.qty) || 0, price: Number(r.price) || 0, vat: r.vat != null ? r.vat : (o.vat != null ? o.vat : n.vat), account: n.account || (o.tab === 'services' ? '' : '43'), content: r.content || '', country: '', gtd: '' };
        d[o.tab || 'goods'].push(row);
    });
    calcDoc(d);
    return d;
}

// ---------- Остатки на складе (как stockMoves на сайте; только количества) ----------
export function stockMoves(db, untilDate, excludeId) {
    const moves = [];
    const push = (d, n, wh, qty) => { if (!n || !qty) return; moves.push({ date: d.date, nom: n, wh: wh || 'w1', qty: Number(qty) || 0, docId: d.id }); };
    (db.trade.docs || []).forEach(d => {
        if (d.status !== 'posted' || d.id === excludeId) return;
        if (untilDate && d.date > untilDate) return;
        switch (d.type) {
            case 'purchase': (d.goods || []).forEach(r => push(d, r.nom, d.warehouse, +r.qty)); (d.tara || []).forEach(r => push(d, r.nom, d.warehouse, +r.qty)); break;
            case 'purchase_return': (d.goods || []).forEach(r => push(d, r.nom, d.warehouse, -r.qty)); break;
            case 'sale': case 'retail_report': case 'commission_report': (d.goods || []).forEach(r => push(d, r.nom, d.warehouse, -r.qty)); (d.tara || []).forEach(r => push(d, r.nom, d.warehouse, -r.qty)); break;
            case 'sale_return': (d.goods || []).forEach(r => push(d, r.nom, d.warehouse, +r.qty)); break;
            case 'stock_opening': case 'stock_in': (d.goods || []).forEach(r => push(d, r.nom, d.warehouse, +r.qty)); break;
            case 'stock_out': (d.goods || []).forEach(r => push(d, r.nom, d.warehouse, -r.qty)); break;
            case 'transfer': (d.goods || []).forEach(r => { push(d, r.nom, d.warehouse, -r.qty); push(d, r.nom, d.warehouseTo, +r.qty); }); break;
            case 'assembly': {
                const sign = d.opKind === 'Разукомплектация' ? -1 : 1;
                (d.goods || []).forEach(r => push(d, r.nom, d.warehouse, -sign * r.qty));
                if (d.kitNom) push(d, d.kitNom, d.warehouse, sign * (Number(d.kitQty) || 1));
                break; }
            case 'requisition': case 'to_processing': (d.materials || []).forEach(r => push(d, r.nom, d.warehouse, -r.qty)); break;
            case 'shift_report': (d.products || []).forEach(r => push(d, r.nom, d.warehouse, +r.qty)); (d.materials || []).forEach(r => push(d, r.nom, d.warehouse, -r.qty)); (d.waste || []).forEach(r => push(d, r.nom, d.warehouse, +r.qty)); break;
            case 'from_processing': (d.products || []).forEach(r => push(d, r.nom, d.warehouse, +r.qty)); break;
            default: break;
        }
    });
    return moves;
}
export function stockBalances(db, untilDate, excludeId) {
    const bal = {};
    stockMoves(db, untilDate, excludeId).forEach(m => { const k = m.nom + '|' + m.wh; bal[k] = bal[k] || { nom: m.nom, wh: m.wh, qty: 0 }; bal[k].qty = Math.round((bal[k].qty + m.qty) * 1000) / 1000; });
    return Object.values(bal);
}
export function stockQty(db, n, wh, untilDate) { const b = stockBalances(db, untilDate).find(x => x.nom === n && x.wh === (wh || 'w1')); return b ? b.qty : 0; }
// Чего не хватит, если провести документ (по дате документа и на все более поздние даты)
export function shortages(db, d) {
    const need = {};
    (d.goods || []).forEach(r => { const n = nom(db, r.nom); if (!n || n.kind === 'Услуга') return; const k = r.nom + '|' + (d.warehouse || 'w1'); need[k] = (need[k] || 0) + (Number(r.qty) || 0); });
    const out = [];
    Object.entries(need).forEach(([k, q]) => {
        const [n, wh] = k.split('|');
        const ms = stockMoves(db).filter(m => m.nom === n && m.wh === wh).sort((a, b) => (a.date || '').localeCompare(b.date || '') || (b.qty - a.qty));
        let run = 0, min = Infinity;
        let applied = false;
        ms.forEach(m => {
            if (!applied && m.date > d.date) { run -= q; applied = true; min = Math.min(min, run); }
            run = Math.round((run + m.qty) * 1000) / 1000;
            if (applied) min = Math.min(min, run);
        });
        if (!applied) { run -= q; min = Math.min(min, run); }
        if (min < -1e-9) out.push({ nom: n, wh, need: q, have: Math.round((q + min) * 1000) / 1000 });
    });
    return out;
}

// ---------- Долги (как tContractorDebt на сайте, с вводом остатков по расчетам) ----------
const DEBT_TYPES = {
    sale: { sale: 1, production_services: 1, commission_report: 1, sale_return: -1, sale_correction: 'delta' },
    purchase: { purchase: 1, add_expenses: 1, purchase_return: -1, purchase_correction: 'delta' },
};
function corrDelta(d) {
    let oldTotal = 0, hasOld = false;
    ['goods', 'services'].forEach(tab => (d[tab] || []).forEach(r => {
        if (r.qtyOld == null && r.priceOld == null) return;
        hasOld = true;
        const o = calcRow({ qty: Number(r.qtyOld != null ? r.qtyOld : r.qty) || 0, price: Number(r.priceOld != null ? r.priceOld : r.price) || 0, vat: r.vat }, d.vatMode);
        oldTotal += o.total || 0;
    }));
    return hasOld ? Math.round(((d.total || 0) - oldTotal) * 100) / 100 : (d.total || 0);
}
function debtAmount(d, side) {
    const k = (DEBT_TYPES[side] || {})[d.type];
    if (!k) return 0;
    return k === 'delta' ? corrDelta(d) : k * (Number(d.total) || 0);
}
function settleCut(db, asOf) {
    const list = ((db.trade && db.trade.settlementOpenings) || []).filter(o => !asOf || o.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
    return list.length ? list[list.length - 1] : null;
}
export function contractorDebt(db, c, side, toDate) {
    const o = settleCut(db, toDate || today());
    const cut = o ? o.date : '';
    const r = o ? (o.rows || []).find(x => x.contractor === c.id) : null;
    const opening = r ? (Number(r[side]) || 0) : 0;
    let charged = 0, returned = 0;
    (db.trade.docs || []).filter(d => d.contractor === c.id && d.status === 'posted' && DEBT_TYPES[side][d.type] && (!toDate || d.date <= toDate) && (!cut || d.date > cut))
        .forEach(d => { const a = debtAmount(d, side); if (a > 0) charged += a; else returned -= a; });
    const types = side === 'sale' ? MONEY_IN_TYPES : MONEY_OUT_TYPES;
    const paid = [...(db.bankDocuments || []), ...(db.cashDocuments || [])]
        .filter(p => p.status === 'posted' && types.includes(p.type) && (p.contractorId === c.id || matchContractor(p.contractor, c.name)) && (!toDate || p.date <= toDate) && (!cut || p.date > cut))
        .reduce((s, p) => s + Number(p.sum || 0) * (Number(p.rate) || 1), 0);
    const debt = Math.round((opening + charged - returned - paid) * 100) / 100;
    return { opening, charged, returned, paid, debt };
}
// Сальдо по всем: нам должны (sale > 0, авансы поставщикам) и мы должны
export function allDebts(db) {
    const owe = [], weOwe = [];
    (db.trade.contractors || []).forEach(c => {
        const s = contractorDebt(db, c, 'sale').debt, p = contractorDebt(db, c, 'purchase').debt;
        const net = Math.round((s - p) * 100) / 100;
        if (net > 0.004) owe.push({ c, sum: net, s, p });
        else if (net < -0.004) weOwe.push({ c, sum: -net, s, p });
    });
    owe.sort((a, b) => b.sum - a.sum); weOwe.sort((a, b) => b.sum - a.sum);
    return { owe, weOwe };
}

// ---------- Сумма прописью ----------
export function amountInWords(n) {
    n = Math.abs(Number(n || 0));
    const units = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
    const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
    const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
    const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
    const totalKop = Math.round(n * 100), intPart = Math.floor(totalKop / 100), kop = totalKop % 100;
    const group = (num) => { let r = hundreds[Math.floor(num / 100)]; const rem = num % 100; if (rem >= 10 && rem < 20) r += (r ? ' ' : '') + teens[rem - 10]; else { if (tens[Math.floor(rem / 10)]) r += (r ? ' ' : '') + tens[Math.floor(rem / 10)]; if (units[rem % 10]) r += (r ? ' ' : '') + units[rem % 10]; } return r; };
    const groupFem = (num) => group(num).replace(/один$/, 'одна').replace(/два$/, 'две');
    const plural = (num, one, few, many) => { const a = num % 10, b = num % 100; if (a === 1 && b !== 11) return one; if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few; return many; };
    if (intPart === 0) return 'Ноль сом ' + String(kop).padStart(2, '0') + ' тыйын';
    let r = '';
    const bil = Math.floor(intPart / 1e9), mil = Math.floor((intPart % 1e9) / 1e6), th = Math.floor((intPart % 1e6) / 1000), rest = intPart % 1000;
    if (bil) r += group(bil) + ' ' + plural(bil, 'миллиард', 'миллиарда', 'миллиардов') + ' ';
    if (mil) r += group(mil) + ' ' + plural(mil, 'миллион', 'миллиона', 'миллионов') + ' ';
    if (th) r += groupFem(th) + ' ' + plural(th, 'тысяча', 'тысячи', 'тысяч') + ' ';
    if (rest) r += group(rest);
    r = r.trim();
    return r.charAt(0).toUpperCase() + r.slice(1) + ' сом ' + String(kop).padStart(2, '0') + ' тыйын';
}

// НДС по умолчанию — как в последних документах продажи (у вас обычно «без НДС»)
export function defaultVat(db) {
    const rows = (db.trade.docs || []).filter(d => ['customer_invoice', 'sale'].includes(d.type)).slice(-20).flatMap(d => [...(d.goods || []), ...(d.services || [])]);
    const cnt = {}; rows.forEach(r => { const k = String(r.vat); cnt[k] = (cnt[k] || 0) + 1; });
    const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : -1;
}
// Последняя цена позиции (для этого контрагента, иначе в любых продажах, иначе из карточки)
export function lastPrice(db, nomId, contractorId) {
    const docs = (db.trade.docs || []).filter(d => ['customer_invoice', 'sale'].includes(d.type) && d.status !== 'deleted').slice().reverse();
    const find = (list) => { for (const d of list) { const r = [...(d.goods || []), ...(d.services || [])].find(x => x.nom === nomId && Number(x.price) > 0); if (r) return Number(r.price); } return null; };
    return find(docs.filter(d => d.contractor === contractorId)) ?? find(docs) ?? (Number((nom(db, nomId) || {}).price) || 0);
}
// Часто используемые позиции и контрагенты (для быстрых кнопок)
export function frequentNoms(db, tab, limit = 8) {
    const cnt = {};
    (db.trade.docs || []).filter(d => ['customer_invoice', 'sale'].includes(d.type)).slice(-80).forEach(d => (d[tab] || []).forEach(r => { cnt[r.nom] = (cnt[r.nom] || 0) + 1; }));
    return Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([id]) => nom(db, id)).filter(Boolean).slice(0, limit);
}
export function frequentContractors(db, limit = 8) {
    const seen = []; const list = (db.trade.docs || []).filter(d => ['customer_invoice', 'sale'].includes(d.type) && d.contractor).slice().reverse();
    for (const d of list) { if (!seen.includes(d.contractor)) seen.push(d.contractor); if (seen.length >= limit) break; }
    return seen.map(id => contractor(db, id)).filter(Boolean);
}
