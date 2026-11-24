// Печатные формы в PDF: счёт на оплату, накладная, акт приёма-передачи, акт выполненных работ, счёт-фактура.
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { formatAmount, formatQty, formatDate, amountInWords, nom, contractor, docById } from './logic.js';

let SUBSET = true;
export function setSubset(v) { SUBSET = v; }
const A4 = [595.28, 841.89];
const M = 40; // поля
const BLACK = rgb(0, 0, 0), GREY = rgb(0.4, 0.4, 0.4), LINE = rgb(0.55, 0.55, 0.55), FILL = rgb(0.94, 0.94, 0.94);

// «Камбаров Артур Майсалбекович» → «Камбаров А.М.»
function initials(full) {
    const p = String(full || '').trim().split(/\s+/);
    return p.length > 1 ? p[0] + ' ' + p.slice(1).map(x => x[0] + '.').join('') : (p[0] || '');
}

class Page {
    constructor(pdf, fonts) {
        this.pdf = pdf; this.f = fonts; this.page = pdf.addPage(A4); this.y = A4[1] - M; this.w = A4[0] - 2 * M;
    }
    ensure(h) { if (this.y - h < M + 20) { this.page = this.pdf.addPage(A4); this.y = A4[1] - M; } }
    width(t, size, bold) { return (bold ? this.f.b : this.f.r).widthOfTextAtSize(String(t), size); }
    wrap(text, size, maxW, bold) {
        const out = [];
        String(text == null ? '' : text).split('\n').forEach(par => {
            const words = par.split(/\s+/); let line = '';
            words.forEach(w => {
                const t = line ? line + ' ' + w : w;
                if (this.width(t, size, bold) <= maxW) line = t;
                else {
                    if (line) out.push(line);
                    // слово длиннее строки — режем
                    let rest = w;
                    while (this.width(rest, size, bold) > maxW && rest.length > 1) { let k = rest.length; while (k > 1 && this.width(rest.slice(0, k), size, bold) > maxW) k--; out.push(rest.slice(0, k)); rest = rest.slice(k); }
                    line = rest;
                }
            });
            out.push(line);
        });
        return out;
    }
    text(t, { x = M, size = 10, bold = false, color = BLACK, maxW = null, align = 'left', lh = 1.3 } = {}) {
        const lines = this.wrap(t, size, maxW || (this.w - (x - M)), bold);
        lines.forEach(l => {
            this.ensure(size * lh);
            let xx = x; const mw = maxW || (this.w - (x - M));
            if (align === 'center') xx = x + (mw - this.width(l, size, bold)) / 2;
            if (align === 'right') xx = x + mw - this.width(l, size, bold);
            this.page.drawText(l, { x: xx, y: this.y - size, size, font: bold ? this.f.b : this.f.r, color });
            this.y -= size * lh;
        });
    }
    // «Подпись: значение» в одну строку с переносом значения
    pair(label, value, { size = 10 } = {}) {
        const lw = this.width(label + ' ', size, true);
        const lines = this.wrap(value || '—', size, this.w - lw, false);
        lines.forEach((l, i) => {
            this.ensure(size * 1.35);
            if (i === 0) this.page.drawText(label, { x: M, y: this.y - size, size, font: this.f.b, color: BLACK });
            this.page.drawText(l, { x: M + lw, y: this.y - size, size, font: this.f.r, color: BLACK });
            this.y -= size * 1.35;
        });
    }
    gap(h) { this.y -= h; }
    hline(x1 = M, x2 = M + this.w, th = 0.6) { this.page.drawLine({ start: { x: x1, y: this.y }, end: { x: x2, y: this.y }, thickness: th, color: LINE }); }
    // Таблица: cols = [{ title, w (доля), align }]
    table(cols, rows, { size = 9, head = true, footer = null } = {}) {
        const W = this.w, pad = 3;
        const widths = cols.map(c => c.w * W);
        const xs = []; let acc = M; widths.forEach(w => { xs.push(acc); acc += w; });
        const drawRow = (cells, { bold = false, fill = null } = {}) => {
            const wrapped = cells.map((c, i) => this.wrap(c, size, widths[i] - 2 * pad, bold));
            const h = Math.max(...wrapped.map(l => l.length)) * size * 1.25 + 2 * pad;
            this.ensure(h);
            const top = this.y;
            if (fill) this.page.drawRectangle({ x: M, y: top - h, width: W, height: h, color: fill });
            wrapped.forEach((lines, i) => {
                lines.forEach((l, j) => {
                    const al = cols[i].align || 'left';
                    let x = xs[i] + pad;
                    if (al === 'right') x = xs[i] + widths[i] - pad - this.width(l, size, bold);
                    if (al === 'center') x = xs[i] + (widths[i] - this.width(l, size, bold)) / 2;
                    this.page.drawText(l, { x, y: top - pad - size - j * size * 1.25 + 1, size, font: bold ? this.f.b : this.f.r, color: BLACK });
                });
            });
            // рамки
            this.page.drawRectangle({ x: M, y: top - h, width: W, height: h, borderColor: LINE, borderWidth: 0.6 });
            xs.slice(1).forEach(x => this.page.drawLine({ start: { x, y: top }, end: { x, y: top - h }, thickness: 0.6, color: LINE }));
            this.y = top - h;
        };
        if (head) drawRow(cols.map(c => c.title), { bold: true, fill: FILL });
        rows.forEach(r => drawRow(r));
        if (footer) footer.forEach(f => drawRow(f, { bold: true }));
    }
    // Итоговые строки справа
    totals(list, { size = 10 } = {}) {
        list.forEach(([label, value, bold]) => {
            this.ensure(size * 1.5);
            const vw = this.width(value, size, true);
            this.page.drawText(value, { x: M + this.w - vw, y: this.y - size - 2, size, font: this.f.b });
            const lw = this.width(label, size, bold);
            this.page.drawText(label, { x: M + this.w - 130 - lw, y: this.y - size - 2, size, font: bold ? this.f.b : this.f.r });
            this.y -= size * 1.5;
        });
    }
    // Подписи в две колонки
    signatures(left, right, { size = 10 } = {}) {
        this.gap(18); this.ensure(60);
        const colW = this.w / 2 - 10;
        [[left, M], [right, M + this.w / 2 + 10]].forEach(([s, x]) => {
            if (!s) return;
            let y = this.y;
            this.page.drawText(s.title, { x, y: y - size, size, font: this.f.b });
            y -= size * 2.6;
            this.page.drawLine({ start: { x, y }, end: { x: x + colW * 0.55, y }, thickness: 0.6, color: BLACK });
            if (s.name) this.page.drawText('/ ' + initials(s.name) + ' /', { x: x + colW * 0.58, y: y + 2, size: size - 1, font: this.f.r });
            this.page.drawText('(подпись)', { x: x + colW * 0.15, y: y - 9, size: 7, font: this.f.r, color: GREY });
            if (s.stamp) this.page.drawText('М.П.', { x, y: y - 22, size: 8, font: this.f.r, color: GREY });
        });
        this.y -= size * 2.6 + 30;
    }
    box(lines, { size = 9 } = {}) {
        const h = lines.length * size * 1.45 + 8;
        this.ensure(h);
        this.page.drawRectangle({ x: M, y: this.y - h, width: this.w, height: h, borderColor: LINE, borderWidth: 0.6 });
        let y = this.y - 4;
        lines.forEach(([label, value]) => {
            const lw = this.width(label + ' ', size, false);
            this.page.drawText(label, { x: M + 6, y: y - size, size, font: this.f.r, color: GREY });
            this.page.drawText(String(value || '—'), { x: M + 6 + lw, y: y - size, size, font: this.f.b, maxWidth: this.w - lw - 12 });
            y -= size * 1.45;
        });
        this.y -= h;
    }
}

function parties(db, d) {
    const org = db.trade.org || {};
    const c = contractor(db, d.contractor) || { name: '—' };
    const bankAcc = (db.accounts || []).find(a => a.type === 'bank' && a.number && !a.currency) || (db.accounts || []).find(a => a.type === 'bank') || {};
    const bankInfo = (db.banks || []).find(b => b.name === bankAcc.bank) || {};
    return { org, c, bankAcc, bankInfo };
}
const partyText = (x) => [x.name, x.inn ? 'ИНН ' + x.inn : '', x.address, x.phone ? 'тел. ' + x.phone : ''].filter(Boolean).join(', ');
const rowsOf = (d) => [...(d.goods || []), ...(d.services || [])];
const unitOf = (db, r) => { const n = nom(db, r.nom) || {}; return n.unit || (n.kind === 'Услуга' ? 'усл' : 'шт'); };
const nameOf = (db, r) => { const n = nom(db, r.nom); return ((n ? n.name : '—') + (r.content ? ' (' + r.content + ')' : '')).trim(); };
const vatNote = (d) => {
    const rates = [...new Set(rowsOf(d).map(r => Number(r.vat)))];
    if (rates.every(v => !(v >= 0)) || !d.vatTotal) return ['Без НДС', '—'];
    return [d.vatMode === 'in' ? 'В том числе НДС:' : 'НДС:', formatAmount(d.vatTotal)];
};

function goodsTable(p, db, d, { vatCols = false } = {}) {
    const rows = rowsOf(d);
    if (!vatCols) {
        p.table([
            { title: '№', w: 0.05, align: 'center' }, { title: 'Наименование товаров (работ, услуг)', w: 0.45 }, { title: 'Кол-во', w: 0.11, align: 'right' },
            { title: 'Ед.', w: 0.07, align: 'center' }, { title: 'Цена', w: 0.15, align: 'right' }, { title: 'Сумма', w: 0.17, align: 'right' },
        ], rows.map((r, i) => [String(i + 1), nameOf(db, r), formatQty(r.qty), unitOf(db, r), formatAmount(r.price), formatAmount(r.sum)]));
    } else {
        p.table([
            { title: '№', w: 0.04, align: 'center' }, { title: 'Наименование', w: 0.27 }, { title: 'Ед.', w: 0.05, align: 'center' }, { title: 'Кол-во', w: 0.08, align: 'right' },
            { title: 'Цена без НДС', w: 0.11, align: 'right' }, { title: 'Стоимость без НДС', w: 0.12, align: 'right' }, { title: 'Ставка НДС', w: 0.08, align: 'center' },
            { title: 'Сумма НДС', w: 0.11, align: 'right' }, { title: 'Стоимость с НДС', w: 0.14, align: 'right' },
        ], rows.map((r, i) => {
            const net = Math.round(((r.total || 0) - (r.vatSum || 0)) * 100) / 100;
            return [String(i + 1), nameOf(db, r), unitOf(db, r), formatQty(r.qty), formatAmount((Number(r.qty) ? net / Number(r.qty) : 0)), formatAmount(net), Number(r.vat) >= 0 ? r.vat + '%' : 'Без НДС', formatAmount(r.vatSum || 0), formatAmount(r.total || 0)];
        }), { size: 8, footer: [['', 'Всего к оплате', '', '', '', formatAmount((d.total || 0) - (d.vatTotal || 0)), '', formatAmount(d.vatTotal || 0), formatAmount(d.total || 0)]] });
    }
}
function totalsBlock(p, d) {
    const [vl, vv] = vatNote(d);
    p.gap(4);
    p.totals([['Итого:', formatAmount(d.total)], [vl, vv], ['Всего к оплате:', formatAmount(d.total), true]]);
    p.gap(4);
    p.text(`Всего наименований ${rowsOf(d).length}, на сумму ${formatAmount(d.total)} сом`, { size: 9 });
    p.text(amountInWords(d.total), { size: 10, bold: true });
}

export async function renderPdf(db, d, form, fonts) {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const f = { r: await pdf.embedFont(fonts.regular, { subset: SUBSET }), b: await pdf.embedFont(fonts.bold, { subset: SUBSET }) };
    const p = new Page(pdf, f);
    const { org, c, bankAcc, bankInfo } = parties(db, d);
    const title = (t) => { p.gap(6); p.text(t, { size: 14, bold: true }); p.gap(2); p.hline(M, M + p.w, 1.2); p.gap(8); };

    if (form === 'invoice') {
        pdf.setTitle(`Счёт на оплату ${d.number}`);
        p.box([
            ['Получатель:', org.name], ['ИНН:', org.inn],
            ['Банк получателя:', bankAcc.bank || bankAcc.name || ''], ['БИК:', bankInfo.bik || ''], ['Расчётный счёт:', bankAcc.number || ''],
        ]);
        title(`Счёт на оплату № ${d.number} от ${formatDate(d.date)}`);
        p.pair('Поставщик:', partyText(org)); p.gap(2);
        p.pair('Покупатель:', partyText(c)); p.gap(8);
        goodsTable(p, db, d);
        totalsBlock(p, d);
        if (d.payUntil) { p.gap(4); p.text(`Оплатить до ${formatDate(d.payUntil)}.`, { size: 9 }); }
        p.gap(4); p.text('Оплата данного счёта означает согласие с условиями поставки товара (оказания услуг).', { size: 8, color: GREY });
        p.signatures({ title: 'Руководитель', name: org.director, stamp: true }, { title: 'Бухгалтер', name: org.accountant });
    } else if (form === 'waybill') {
        pdf.setTitle(`Накладная ${d.number}`);
        title(`Накладная № ${d.number} от ${formatDate(d.date)}`);
        p.pair('Поставщик (грузоотправитель):', partyText(org)); p.gap(2);
        p.pair('Покупатель (грузополучатель):', partyText(c)); p.gap(2);
        const b = d.basis ? docById(db, d.basis) : null;
        p.pair('Основание:', b ? `Счёт на оплату № ${b.number} от ${formatDate(b.date)}` : '—'); p.gap(8);
        goodsTable(p, db, d);
        totalsBlock(p, d);
        p.signatures({ title: 'Отпустил', name: org.director, stamp: true }, { title: 'Получил', name: '', stamp: true });
    } else if (form === 'transfer') {
        pdf.setTitle(`Акт приёма-передачи ${d.number}`);
        p.text('АКТ ПРИЁМА-ПЕРЕДАЧИ ТОВАРА', { size: 14, bold: true, align: 'center' });
        p.text(`№ ${d.number} от ${formatDate(d.date)}`, { size: 11, align: 'center' }); p.gap(10);
        p.text(`${org.name || 'Продавец'}${org.director ? ', в лице руководителя ' + org.director : ''} (далее — Продавец), передал, а ${c.name} (далее — Покупатель) принял следующий товар:`, { size: 10 });
        p.gap(8);
        goodsTable(p, db, d);
        totalsBlock(p, d);
        p.gap(6);
        p.text('Товар передан в полном объёме. Покупатель претензий по количеству, качеству и комплектности товара не имеет.', { size: 9 });
        p.text('Акт составлен в двух экземплярах, по одному для каждой из сторон.', { size: 9 });
        p.signatures({ title: 'Передал (Продавец)', name: org.director, stamp: true }, { title: 'Принял (Покупатель)', name: '', stamp: true });
    } else if (form === 'works') {
        pdf.setTitle(`Акт выполненных работ ${d.number}`);
        p.text('АКТ ВЫПОЛНЕННЫХ РАБОТ (ОКАЗАННЫХ УСЛУГ)', { size: 14, bold: true, align: 'center' });
        p.text(`№ ${d.number} от ${formatDate(d.date)}`, { size: 11, align: 'center' }); p.gap(10);
        p.pair('Исполнитель:', partyText(org)); p.gap(2);
        p.pair('Заказчик:', partyText(c)); p.gap(8);
        goodsTable(p, db, d);
        totalsBlock(p, d);
        p.gap(6);
        p.text('Вышеперечисленные работы (услуги) выполнены полностью и в срок. Заказчик претензий по объёму, качеству и срокам выполнения работ (оказания услуг) не имеет.', { size: 9 });
        p.signatures({ title: 'Исполнитель', name: org.director, stamp: true }, { title: 'Заказчик', name: '', stamp: true });
    } else if (form === 'sf') {
        const sf = d.sf || {};
        pdf.setTitle(`Счёт-фактура ${sf.number}`);
        title(`Счёт-фактура № ${sf.number || '—'} от ${formatDate(sf.date || d.date)}`);
        p.pair('К документу:', `${d.opKind && d.opKind.startsWith('Услуги') ? 'Акт выполненных работ' : 'Накладная'} № ${d.number} от ${formatDate(d.date)}`);
        p.pair('Код вида операции:', sf.code || '01');
        p.gap(4);
        p.pair('Продавец:', partyText(org)); p.gap(2);
        p.pair('Покупатель:', partyText(c)); p.gap(2);
        p.pair('Валюта:', 'сом (KGS)'); p.gap(8);
        goodsTable(p, db, d, { vatCols: true });
        p.gap(6);
        p.text(amountInWords(d.total), { size: 10, bold: true });
        p.signatures({ title: 'Руководитель организации', name: org.director, stamp: true }, { title: 'Главный бухгалтер', name: org.accountant });
    } else throw new Error('Неизвестная форма ' + form);

    // нижний колонтитул
    pdf.getPages().forEach((pg, i, all) => {
        pg.drawText(`${org.name || ''} · сформировано в EsepOnline${all.length > 1 ? ' · стр. ' + (i + 1) + ' из ' + all.length : ''}`, { x: M, y: 22, size: 7, font: f.r, color: GREY });
    });
    return await pdf.save();
}

export const FORM_NAMES = { invoice: 'Счёт на оплату', waybill: 'Накладная', transfer: 'Акт приёма-передачи', works: 'Акт выполненных работ', sf: 'Счёт-фактура' };
