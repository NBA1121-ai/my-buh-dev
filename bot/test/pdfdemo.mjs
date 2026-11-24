import fs from 'fs';
import { renderPdf } from '../src/pdf.js';
const [dbPath, out] = process.argv.slice(2);
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const fonts = { regular: fs.readFileSync(new URL('../src/fonts/DejaVuSans.ttf', import.meta.url)), bold: fs.readFileSync(new URL('../src/fonts/DejaVuSans-Bold.ttf', import.meta.url)) };
const inv = db.trade.docs.filter(d => d.type === 'customer_invoice').pop();
const sale = db.trade.docs.filter(d => d.type === 'sale' && d.goods.length).pop();
for (const [d, form] of [[inv, 'invoice'], [sale, 'waybill'], [sale, 'transfer'], [Object.assign({}, sale, { sf: { number: '1', date: sale.date, code: '01' } }), 'sf']]) {
  const bytes = await renderPdf(db, d, form, fonts); fs.writeFileSync(`${out}/${form}.pdf`, bytes); console.log(form, bytes.length);
}
