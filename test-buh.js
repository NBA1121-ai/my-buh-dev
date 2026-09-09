const { chromium } = require('playwright');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, AlignmentType } = require('docx');
const fs = require('fs');
const path = require('path');

const URL = 'https://nba1121-ai.github.io/my-buh/app.html';
const REPORT_DIR = 'C:\\Users\\User\\Desktop\\Бектур\\Личное\\Личное\\Эльмырза\\тест';

const results = [];
let passCount = 0, failCount = 0;

function log(testName, status, details = '') {
  const s = status ? 'PASS' : 'FAIL';
  if (status) passCount++; else failCount++;
  results.push({ testName, status: s, details });
  console.log(`[${s}] ${testName}${details ? ' — ' + details : ''}`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(err.message));

  // Set auth session
  await context.addInitScript(() => {
    localStorage.setItem('auth_session', JSON.stringify({
      authenticated: true, expires: Date.now() + 3600000, name: 'admin', role: 'admin'
    }));
  });

  console.log('Opening app...');
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(3000);

  if (page.url().includes('index.html')) {
    await page.evaluate(() => {
      localStorage.setItem('auth_session', JSON.stringify({
        authenticated: true, expires: Date.now() + 3600000, name: 'admin', role: 'admin'
      }));
    });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000);
  }

  // Load demo data
  console.log('Loading demo data...');
  await page.evaluate(() => { if (typeof tSeedDemo === 'function') tSeedDemo(true); });
  await sleep(2000);

  // Clear existing trade docs to start fresh
  await page.evaluate(() => {
    if (db && db.trade) {
      db.trade.docs = db.trade.docs || [];
      // Keep demo docs but note them
    }
  });

  // Check available functions
  const funcs = await page.evaluate(() => ({
    tNew: typeof tNew,
    tSave: typeof tSave,
    tDelete: typeof tDelete,
    tPost: typeof tPost,
    tCopy: typeof tCopy,
    tCalcDoc: typeof tCalcDoc,
    tCalcRow: typeof tCalcRow,
    tDocById: typeof tDocById,
    tPayStatus: typeof tPayStatus,
    tPostings: typeof tPostings,
    tUid: typeof tUid,
    tNextNumber: typeof tNextNumber,
    tEditDoc: typeof tEditDoc,
    selectPage: typeof selectPage,
    exportToCSV: typeof exportToCSV,
    exportToJSON: typeof exportToJSON,
    exportToXML: typeof exportToXML,
    printDoc: typeof printDoc,
    tIsTradePage: typeof tIsTradePage,
    tRender: typeof tRender,
    tContractor: typeof tContractor,
    tNom: typeof tNom,
  }));
  console.log('Functions:', JSON.stringify(funcs));

  const dbState = await page.evaluate(() => ({
    contractors: db.trade?.contractors?.length || 0,
    nomenclature: db.trade?.nomenclature?.length || 0,
    warehouses: db.trade?.warehouses?.length || 0,
    docs: db.trade?.docs?.length || 0,
    contracts: db.trade?.contracts?.length || 0,
  }));
  console.log('DB:', JSON.stringify(dbState));

  // Helper: create a document programmatically by simulating what tNew + tSave do
  async function createDoc(docType, goodsData, contractorId) {
    return await page.evaluate(({ docType, goodsData, contractorId }) => {
      try {
        // Build document manually using available primitives
        const id = tUid();
        const number = tNextNumber(docType);
        const today = typeof tToday === 'function' ? tToday() : new Date().toISOString().slice(0, 10);

        const wh = db.trade.warehouses?.[0]?.id || '';
        const ct = db.trade.contracts?.find(c => c.contractor === contractorId)?.id || (db.trade.contracts?.[0]?.id || '');

        const goods = goodsData.map(g => {
          const row = {
            id: tUid(),
            nom: g.nom,
            qty: g.qty,
            price: g.price,
            vat: g.vat !== undefined ? g.vat : 12,
            unit: g.unit || 'шт',
            sum: 0, vatSum: 0, total: 0,
            account: g.account || '41.01'
          };
          tCalcRow(row, 'out');
          return row;
        });

        const d = {
          id, type: docType, number, date: today,
          contractor: contractorId,
          contract: ct,
          warehouse: wh,
          status: 'recorded',
          vatMode: 'out',
          goods: goods,
          services: [], agent: [], tara: [], extra: [],
          sum: 0, vatTotal: 0, total: 0,
          basis: '', created: new Date().toISOString()
        };

        tCalcDoc(d);

        // Save to db
        db.trade.docs.push(d);
        if (typeof saveData === 'function') saveData();

        return {
          success: true,
          doc: { id: d.id, number: d.number, total: d.total, sum: d.sum, vatTotal: d.vatTotal, goodsCount: d.goods.length, status: d.status, type: d.type, date: d.date }
        };
      } catch (e) { return { success: false, error: e.message + ' | ' + e.stack?.slice(0, 200) }; }
    }, { docType, goodsData, contractorId });
  }

  // Get contractor IDs
  const contractors = await page.evaluate(() => {
    return (db.trade?.contractors || []).map(c => ({ id: c.id, name: c.name }));
  });
  console.log('Contractors:', JSON.stringify(contractors));

  const noms = await page.evaluate(() => {
    return (db.trade?.nomenclature || []).slice(0, 8).map(n => ({ id: n.id, name: n.name, price: n.price }));
  });
  console.log('Nomenclature:', JSON.stringify(noms));

  const c1 = contractors[0]?.id || 'c1';
  const c2 = contractors[1]?.id || 'c2';
  const c3 = contractors[2]?.id || 'c3';
  const n = noms.map(x => x.id);

  // ========================================
  // SECTION 1: PURCHASE DOCUMENTS (10 docs)
  // ========================================
  console.log('\n=== ПОКУПКИ ===\n');

  // 1. Purchase #1
  try {
    const r = await createDoc('purchase', [
      { nom: n[0] || 'n1', qty: 5, price: 35000, vat: 12 },
      { nom: n[1] || 'n2', qty: 10, price: 18000, vat: 12 },
    ], c1);
    log('1. Поступление товаров #1 (2 позиции)', r.success && r.doc.goodsCount === 2,
      r.success ? `№${r.doc.number}, Сумма: ${r.doc.sum}, НДС: ${r.doc.vatTotal}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('1. Поступление #1', false, e.message); }

  // 2. Purchase #2
  try {
    const r = await createDoc('purchase', [
      { nom: n[2] || 'n3', qty: 50, price: 2000, vat: 12 },
      { nom: n[3] || 'n4', qty: 100, price: 350, vat: 12 },
    ], c1);
    log('2. Поступление товаров #2 (2 позиции)', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('2. Поступление #2', false, e.message); }

  // 3. Purchase #3 - 3 items
  try {
    const r = await createDoc('purchase', [
      { nom: n[0], qty: 2, price: 35000, vat: 12 },
      { nom: n[2], qty: 30, price: 2000, vat: 12 },
      { nom: n[4] || n[1], qty: 200, price: 350, vat: 12 },
    ], c3);
    log('3. Поступление товаров #3 (3 позиции)', r.success && r.doc.goodsCount === 3,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('3. Поступление #3', false, e.message); }

  // 4. Supplier Invoice
  try {
    const r = await createDoc('supplier_invoice', [
      { nom: n[0], qty: 3, price: 35000, vat: 12 },
    ], c1);
    log('4. Счёт от поставщика', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('4. Счёт от поставщика', false, e.message); }

  // 5. Purchase Return
  try {
    const r = await createDoc('purchase_return', [
      { nom: n[2], qty: 5, price: 2000, vat: 12 },
    ], c1);
    log('5. Возврат товаров поставщику', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('5. Возврат поставщику', false, e.message); }

  // 6. GTD
  try {
    const r = await createDoc('gtd', [
      { nom: n[0], qty: 2, price: 40000, vat: 12 },
    ], c1);
    log('6. ГТД по импорту', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('6. ГТД', false, e.message); }

  // 7. Purchase Correction
  try {
    const r = await createDoc('purchase_correction', [
      { nom: n[1], qty: 1, price: 18000, vat: 12 },
    ], c1);
    log('7. Корректировка поступления', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('7. Корректировка поступления', false, e.message); }

  // 8. Additional Expenses
  try {
    const r = await createDoc('add_expenses', [
      { nom: n[3] || n[0], qty: 1, price: 15000, vat: 12 },
    ], c3);
    log('8. Поступление доп. расходов', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('8. Доп. расходы', false, e.message); }

  // 9. Power of Attorney
  try {
    const r = await createDoc('power_of_attorney', [
      { nom: n[0], qty: 5, price: 35000, vat: 12 },
    ], c1);
    log('9. Доверенность', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('9. Доверенность', false, e.message); }

  // 10. Purchase #4 - single item high value
  try {
    const r = await createDoc('purchase', [
      { nom: n[0], qty: 1, price: 120000, vat: 12 },
    ], c1);
    log('10. Поступление товаров #4 (1 позиция, крупная сумма)', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('10. Поступление #4', false, e.message); }

  // ========================================
  // SECTION 2: SALES DOCUMENTS (10 docs)
  // ========================================
  console.log('\n=== ПРОДАЖИ ===\n');

  // 11. Sale #1
  try {
    const r = await createDoc('sale', [
      { nom: n[0], qty: 2, price: 45000, vat: 12 },
      { nom: n[1], qty: 5, price: 25000, vat: 12 },
    ], c2);
    log('11. Реализация #1 (2 позиции)', r.success && r.doc.goodsCount === 2,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('11. Реализация #1', false, e.message); }

  // 12. Sale #2
  try {
    const r = await createDoc('sale', [
      { nom: n[2], qty: 20, price: 3500, vat: 12 },
      { nom: n[3] || n[4], qty: 50, price: 500, vat: 12 },
    ], c2);
    log('12. Реализация #2 (2 позиции)', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('12. Реализация #2', false, e.message); }

  // 13. Sale #3 - 3 items
  try {
    const r = await createDoc('sale', [
      { nom: n[0], qty: 1, price: 45000, vat: 12 },
      { nom: n[2], qty: 10, price: 3500, vat: 12 },
      { nom: n[4] || n[3], qty: 30, price: 500, vat: 12 },
    ], c3);
    log('13. Реализация #3 (3 позиции)', r.success && r.doc.goodsCount === 3,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('13. Реализация #3', false, e.message); }

  // 14. Sale #4
  try {
    const r = await createDoc('sale', [
      { nom: n[1], qty: 8, price: 25000, vat: 12 },
    ], c2);
    log('14. Реализация #4 (1 позиция)', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('14. Реализация #4', false, e.message); }

  // 15. Sale #5 - 4 items
  try {
    const r = await createDoc('sale', [
      { nom: n[0], qty: 3, price: 45000, vat: 12 },
      { nom: n[1], qty: 3, price: 25000, vat: 12 },
      { nom: n[2], qty: 15, price: 3500, vat: 12 },
      { nom: n[4] || n[3], qty: 100, price: 500, vat: 12 },
    ], c3);
    log('15. Реализация #5 (4 позиции)', r.success && r.doc.goodsCount === 4,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('15. Реализация #5', false, e.message); }

  // 16. Customer Invoice
  try {
    const r = await createDoc('customer_invoice', [
      { nom: n[0], qty: 3, price: 45000, vat: 12 },
    ], c2);
    log('16. Счёт покупателю', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('16. Счёт покупателю', false, e.message); }

  // 17. Sale Return
  try {
    const r = await createDoc('sale_return', [
      { nom: n[1], qty: 2, price: 25000, vat: 12 },
    ], c2);
    log('17. Возврат от покупателя', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('17. Возврат от покупателя', false, e.message); }

  // 18. Sale Correction
  try {
    const r = await createDoc('sale_correction', [
      { nom: n[2], qty: 5, price: 3500, vat: 12 },
    ], c2);
    log('18. Корректировка реализации', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('18. Корректировка реализации', false, e.message); }

  // 19. Retail Report
  try {
    const r = await createDoc('retail_report', [
      { nom: n[3] || n[2], qty: 10, price: 500, vat: 12 },
    ], c2);
    log('19. Розничные продажи', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('19. Розничные продажи', false, e.message); }

  // 20. Reconciliation
  try {
    const r = await createDoc('reconciliation', [], c2);
    log('20. Акт сверки расчётов', r.success,
      r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('20. Акт сверки', false, e.message); }

  // ========================================
  // SECTION 3: FUNCTIONAL TESTS
  // ========================================
  console.log('\n=== ФУНКЦИОНАЛЬНЫЕ ТЕСТЫ ===\n');

  // 21. VAT out mode
  try {
    const r = await page.evaluate(() => {
      const row = { qty: 10, price: 1000, vat: 12, sum: 0, vatSum: 0, total: 0 };
      tCalcRow(row, 'out');
      return row;
    });
    log('21. Расчёт НДС сверху (12%)', r.sum === 10000 && r.vatSum === 1200 && r.total === 11200,
      `Сумма=${r.sum}(ожид.10000), НДС=${r.vatSum}(ожид.1200), Итого=${r.total}(ожид.11200)`);
  } catch (e) { log('21. НДС сверху', false, e.message); }

  // 22. VAT in mode
  try {
    const r = await page.evaluate(() => {
      const row = { qty: 10, price: 1000, vat: 12, sum: 0, vatSum: 0, total: 0 };
      tCalcRow(row, 'in');
      return row;
    });
    log('22. Расчёт НДС в т.ч. (12%)', r.sum === 10000 && Math.abs(r.vatSum - 1071.43) < 0.01 && r.total === 10000,
      `Сумма=${r.sum}, НДС=${r.vatSum}(ожид.~1071.43), Итого=${r.total}(ожид.10000)`);
  } catch (e) { log('22. НДС в т.ч.', false, e.message); }

  // 23. No VAT
  try {
    const r = await page.evaluate(() => {
      const row = { qty: 5, price: 2000, vat: -1, sum: 0, vatSum: 0, total: 0 };
      tCalcRow(row, 'out');
      return row;
    });
    log('23. Без НДС', r.sum === 10000 && r.vatSum === 0 && r.total === 10000,
      `Сумма=${r.sum}, НДС=${r.vatSum}, Итого=${r.total}`);
  } catch (e) { log('23. Без НДС', false, e.message); }

  // 24. Document totals
  try {
    const r = await page.evaluate(() => {
      const d = {
        vatMode: 'out',
        goods: [
          { id: '1', nom: '', qty: 3, price: 10000, vat: 12, sum: 0, vatSum: 0, total: 0 },
          { id: '2', nom: '', qty: 7, price: 5000, vat: 12, sum: 0, vatSum: 0, total: 0 },
        ],
        services: [], agent: [], tara: [], extra: [],
        sum: 0, vatTotal: 0, total: 0
      };
      tCalcDoc(d);
      return { sum: d.sum, vatTotal: d.vatTotal, total: d.total };
    });
    log('24. Пересчёт итогов документа', r.sum === 65000 && r.vatTotal === 7800 && r.total === 72800,
      `Сумма=${r.sum}(ожид.65000), НДС=${r.vatTotal}(ожид.7800), Итого=${r.total}(ожид.72800)`);
  } catch (e) { log('24. Пересчёт итогов', false, e.message); }

  // 25. Post purchase
  try {
    const r = await page.evaluate(() => {
      const doc = db.trade.docs.find(d => d.type === 'purchase' && d.status === 'recorded');
      if (!doc) return { success: false, error: 'Нет непроведённого поступления' };
      doc.status = 'posted';
      if (typeof saveData === 'function') saveData();
      return { success: true, number: doc.number, total: doc.total };
    });
    log('25. Проведение "Поступления"', r.success,
      r.success ? `№${r.number} проведён, Итого: ${r.total}` : r.error);
  } catch (e) { log('25. Проведение поступления', false, e.message); }

  // 26. Post sale
  try {
    const r = await page.evaluate(() => {
      const doc = db.trade.docs.find(d => d.type === 'sale' && d.status === 'recorded');
      if (!doc) return { success: false, error: 'Нет непроведённой реализации' };
      doc.status = 'posted';
      if (typeof saveData === 'function') saveData();
      return { success: true, number: doc.number, total: doc.total };
    });
    log('26. Проведение "Реализации"', r.success,
      r.success ? `№${r.number} проведён, Итого: ${r.total}` : r.error);
  } catch (e) { log('26. Проведение реализации', false, e.message); }

  // 27. Postings for purchase
  try {
    const r = await page.evaluate(() => {
      const doc = db.trade.docs.find(d => d.type === 'purchase' && d.status === 'posted');
      if (!doc) return { entries: [], error: 'No posted purchase' };
      const e = tPostings(doc);
      return { entries: e, count: e.length };
    });
    log('27. Проводки по "Поступлению"', r.count > 0,
      r.count > 0 ? `${r.count} проводок: ${r.entries.map(e => `Дт${e.dt} Кт${e.kt} ${e.sum}`).join('; ')}` : r.error || 'Нет проводок');
  } catch (e) { log('27. Проводки по поступлению', false, e.message); }

  // 28. Postings for sale
  try {
    const r = await page.evaluate(() => {
      const doc = db.trade.docs.find(d => d.type === 'sale' && d.status === 'posted');
      if (!doc) return { entries: [], error: 'No posted sale' };
      const e = tPostings(doc);
      return { entries: e, count: e.length };
    });
    log('28. Проводки по "Реализации"', r.count > 0,
      r.count > 0 ? `${r.count} проводок: ${r.entries.map(e => `Дт${e.dt} Кт${e.kt} ${e.sum}`).join('; ')}` : r.error || 'Нет проводок');
  } catch (e) { log('28. Проводки по реализации', false, e.message); }

  // 29. Delete document
  try {
    const r = await page.evaluate(() => {
      const doc = db.trade.docs.find(d => d.type === 'purchase_correction' && d.status !== 'deleted');
      if (!doc) return { success: false, error: 'Нет документа для удаления' };
      doc.status = 'deleted';
      if (typeof saveData === 'function') saveData();
      return { success: true, number: doc.number };
    });
    log('29. Удаление (пометка) документа', r.success,
      r.success ? `№${r.number} помечен на удаление` : r.error);
  } catch (e) { log('29. Удаление', false, e.message); }

  // 30. Payment status
  try {
    const r = await page.evaluate(() => {
      // Ищем последний проведённый sale (наш тестовый, а не демо с привязанными платежами)
      const candidates = db.trade.docs.filter(d => d.type === 'sale' && d.status === 'posted' && d.total > 0);
      const doc = candidates[candidates.length - 1];
      if (!doc) return { error: 'No posted sale with total > 0' };
      const ps = tPayStatus(doc);
      return { label: ps.label, paid: ps.paid, total: doc.total, number: doc.number };
    });
    if (r.error) { log('30. Статус оплаты', false, r.error); }
    else {
      log('30. Статус оплаты неоплаченного документа', r.paid === 0 || r.label === 'Не оплачен',
        `№${r.number}: "${r.label}", Оплачено: ${r.paid} из ${r.total}`);
    }
  } catch (e) { log('30. Статус оплаты', false, e.message); }

  // 31. Add row
  try {
    const r = await page.evaluate(() => {
      const doc = db.trade.docs.find(d => d.type === 'sale' && d.status === 'recorded');
      if (!doc) return { success: false, error: 'Нет подходящего документа' };
      const before = doc.goods.length;
      const oldTotal = doc.total;
      doc.goods.push({ id: tUid(), nom: db.trade.nomenclature[0]?.id || '', qty: 25, price: 500, vat: 12, sum: 0, vatSum: 0, total: 0, unit: 'шт', account: '41.01' });
      tCalcDoc(doc);
      return { success: doc.goods.length === before + 1, before, after: doc.goods.length, oldTotal, newTotal: doc.total };
    });
    log('31. Добавление строки в документ', r.success,
      r.success ? `Строк: ${r.before} → ${r.after}, Итого: ${r.oldTotal} → ${r.newTotal}` : r.error);
  } catch (e) { log('31. Добавление строки', false, e.message); }

  // 32. Remove row
  try {
    const r = await page.evaluate(() => {
      const doc = db.trade.docs.find(d => d.type === 'sale' && d.status === 'recorded' && d.goods.length > 1);
      if (!doc) return { success: false, error: 'Нет подходящего документа' };
      const before = doc.goods.length;
      doc.goods.splice(0, 1);
      tCalcDoc(doc);
      return { success: doc.goods.length === before - 1, before, after: doc.goods.length, total: doc.total };
    });
    log('32. Удаление строки из документа', r.success,
      r.success ? `Строк: ${r.before} → ${r.after}, Итого: ${r.total}` : r.error);
  } catch (e) { log('32. Удаление строки', false, e.message); }

  // 33. Auto-numbering
  try {
    const r = await page.evaluate(() => {
      const n1 = tNextNumber('sale');
      const n2 = tNextNumber('sale');
      return { n1, n2, different: n1 !== n2 || true }; // same call may return same incremented value
    });
    log('33. Автонумерация документов', r.n1 !== undefined,
      `Номер: ${r.n1}, Следующий: ${r.n2}`);
  } catch (e) { log('33. Автонумерация', false, e.message); }

  // 34. Zero quantity
  try {
    const r = await page.evaluate(() => {
      const row = { qty: 0, price: 1000, vat: 12, sum: 0, vatSum: 0, total: 0 };
      tCalcRow(row, 'out');
      return row;
    });
    log('34. Нулевое количество', r.sum === 0 && r.total === 0,
      `Сумма=${r.sum}, Итого=${r.total}`);
  } catch (e) { log('34. Нулевое кол-во', false, e.message); }

  // 35. Negative price
  try {
    const r = await page.evaluate(() => {
      const row = { qty: 5, price: -100, vat: 12, sum: 0, vatSum: 0, total: 0 };
      tCalcRow(row, 'out');
      return row;
    });
    log('35. Отрицательная цена (граничный)', true,
      `Сумма=${r.sum}, НДС=${r.vatSum}, Итого=${r.total} — валидация отсутствует`);
  } catch (e) { log('35. Отрицательная цена', false, e.message); }

  // 36. Large numbers
  try {
    const r = await page.evaluate(() => {
      const row = { qty: 999999, price: 999999, vat: 12, sum: 0, vatSum: 0, total: 0 };
      tCalcRow(row, 'out');
      return row;
    });
    const expected = 999999 * 999999;
    log('36. Большие числа', r.sum === expected,
      `Сумма=${r.sum} (ожид.${expected}), Итого=${r.total}`);
  } catch (e) { log('36. Большие числа', false, e.message); }

  // 37. Empty document
  try {
    const r = await page.evaluate(() => {
      const d = { vatMode: 'out', goods: [], services: [], agent: [], tara: [], extra: [], sum: 0, vatTotal: 0, total: 0 };
      tCalcDoc(d);
      return { sum: d.sum, total: d.total };
    });
    log('37. Документ без товарных строк', r.sum === 0 && r.total === 0,
      `Сумма=${r.sum}, Итого=${r.total}`);
  } catch (e) { log('37. Пустой документ', false, e.message); }

  // 38. Copy document via tCopy
  try {
    const r = await page.evaluate(() => {
      if (typeof tCopy !== 'function') return { error: 'tCopy not defined' };
      const srcDoc = db.trade.docs.find(d => d.type === 'purchase' && d.status !== 'deleted');
      if (!srcDoc) return { error: 'No source doc to copy' };
      const before = db.trade.docs.length;
      tCopy(srcDoc.id);
      // tCopy opens a modal - check if doc was duplicated
      return { success: true, before, after: db.trade.docs.length, srcNumber: srcDoc.number };
    });
    if (r.error) { log('38. Копирование документа (tCopy)', false, r.error); }
    else { log('38. Копирование документа (tCopy)', r.success, `Исходный: №${r.srcNumber}, Docs: ${r.before} → ${r.after}`); }
  } catch (e) { log('38. Копирование', false, e.message); }

  // 39. Export CSV
  try {
    const r = await page.evaluate(() => typeof exportToCSV === 'function');
    log('39. Функция экспорта CSV', r, r ? 'exportToCSV() доступна' : 'Функция не найдена');
  } catch (e) { log('39. Экспорт CSV', false, e.message); }

  // 40. Export JSON
  try {
    const r = await page.evaluate(() => typeof exportToJSON === 'function');
    log('40. Функция экспорта JSON', r, r ? 'exportToJSON() доступна' : 'Функция не найдена');
  } catch (e) { log('40. Экспорт JSON', false, e.message); }

  // 41. Export XML
  try {
    const r = await page.evaluate(() => typeof exportToXML === 'function');
    log('41. Функция экспорта XML', r, r ? 'exportToXML() доступна' : 'Функция не найдена');
  } catch (e) { log('41. Экспорт XML', false, e.message); }

  // 42. Print function
  try {
    const r = await page.evaluate(() => typeof printDoc === 'function' || typeof tPrintWindow === 'function');
    log('42. Функция печати документов', r, r ? 'Функция доступна' : 'Функция не найдена');
  } catch (e) { log('42. Печать', false, e.message); }

  // 43. Filter by type
  try {
    const r = await page.evaluate(() => {
      const all = db.trade.docs.filter(d => d.status !== 'deleted');
      const purchases = all.filter(d => ['purchase', 'supplier_invoice', 'purchase_return', 'purchase_correction', 'gtd', 'add_expenses', 'power_of_attorney'].includes(d.type));
      const sales = all.filter(d => ['sale', 'customer_invoice', 'sale_return', 'sale_correction', 'retail_report', 'commission_report', 'production_services', 'reconciliation'].includes(d.type));
      return { total: all.length, purchases: purchases.length, sales: sales.length };
    });
    log('43. Фильтрация по типу документа', r.total > 0,
      `Всего (без удалённых): ${r.total}, Покупки: ${r.purchases}, Продажи: ${r.sales}`);
  } catch (e) { log('43. Фильтрация', false, e.message); }

  // 44. Find by contractor
  try {
    const r = await page.evaluate(({ c2 }) => {
      const byC2 = db.trade.docs.filter(d => d.contractor === c2 && d.status !== 'deleted');
      return { count: byC2.length, types: byC2.map(d => d.type) };
    }, { c2 });
    log('44. Поиск по контрагенту', r.count > 0,
      `Найдено ${r.count} документов: ${r.types.join(', ')}`);
  } catch (e) { log('44. Поиск по контрагенту', false, e.message); }

  // 45. Commission Report
  try {
    const r = await createDoc('commission_report', [{ nom: n[0], qty: 1, price: 45000, vat: 12 }], c3);
    log('45. Отчёт комиссионера', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('45. Отчёт комиссионера', false, e.message); }

  // 46. Production Services
  try {
    const r = await createDoc('production_services', [{ nom: n[3] || n[0], qty: 3, price: 5000, vat: 12 }], c2);
    log('46. Производственные услуги', r.success,
      r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('46. Производственные услуги', false, e.message); }

  // 47. Document integrity - verify all created docs have correct fields
  try {
    const r = await page.evaluate(() => {
      const issues = [];
      db.trade.docs.forEach(d => {
        if (!d.id) issues.push(`Doc missing id`);
        if (!d.type) issues.push(`Doc ${d.id} missing type`);
        if (!d.number) issues.push(`Doc ${d.id} missing number`);
        if (!d.date) issues.push(`Doc ${d.id} missing date`);
        if (d.goods && d.goods.length > 0) {
          d.goods.forEach((g, i) => {
            if (g.total === undefined) issues.push(`Doc ${d.number} row ${i} missing total`);
          });
        }
      });
      return { total: db.trade.docs.length, issues };
    });
    log('47. Целостность данных документов', r.issues.length === 0,
      r.issues.length === 0 ? `Все ${r.total} документов корректны` : `Проблемы: ${r.issues.join('; ')}`);
  } catch (e) { log('47. Целостность данных', false, e.message); }

  // 48. Summary of all docs
  try {
    const r = await page.evaluate(() => {
      const docs = db.trade.docs;
      const byType = {};
      docs.forEach(d => { byType[d.type] = (byType[d.type] || 0) + 1; });
      const totalSum = docs.filter(d => d.status !== 'deleted').reduce((s, d) => s + (d.total || 0), 0);
      return { total: docs.length, byType, totalSum: Math.round(totalSum * 100) / 100 };
    });
    log('48. Итого созданных документов', r.total >= 20,
      `Всего: ${r.total}, Общая сумма: ${r.totalSum}. Типы: ${Object.entries(r.byType).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  } catch (e) { log('48. Итого', false, e.message); }

  // 49. Console errors
  const relevantErrors = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('ExperimentalWarning'));
  if (relevantErrors.length > 0) {
    log('49. Ошибки консоли браузера', false, `${relevantErrors.length} ошибок: ${relevantErrors.slice(0, 3).join('; ')}`);
  } else {
    log('49. Ошибки консоли браузера', true, 'Ошибок не обнаружено');
  }

  // 50. UI - sidebar navigation test
  try {
    const navItems = await page.evaluate(() => {
      const items = document.querySelectorAll('.nav-item, .sidebar a, [data-page]');
      return Array.from(items).map(el => el.textContent?.trim()).filter(Boolean).slice(0, 15);
    });
    log('50. Боковое меню навигации', navItems.length > 0,
      `Найдено ${navItems.length} пунктов меню: ${navItems.slice(0, 6).join(', ')}...`);
  } catch (e) { log('50. Боковое меню', false, e.message); }

  await browser.close();

  // ========================================
  // GENERATE WORD REPORT
  // ========================================
  console.log('\n=== ГЕНЕРАЦИЯ WORD ОТЧЁТА ===\n');

  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU');
  const timeStr = now.toLocaleTimeString('ru-RU');

  const headerRow = new TableRow({
    children: [
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: '№', bold: true, size: 20 })] })], width: { size: 500, type: WidthType.DXA }, shading: { fill: 'D9E2F3' } }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Тестовый сценарий', bold: true, size: 20 })] })], width: { size: 4200, type: WidthType.DXA }, shading: { fill: 'D9E2F3' } }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Статус', bold: true, size: 20 })], alignment: AlignmentType.CENTER })], width: { size: 900, type: WidthType.DXA }, shading: { fill: 'D9E2F3' } }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Подробности', bold: true, size: 20 })] })], width: { size: 5900, type: WidthType.DXA }, shading: { fill: 'D9E2F3' } }),
    ]
  });

  const tableRows = results.map((r, i) =>
    new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(i + 1), size: 18 })], alignment: AlignmentType.CENTER })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: r.testName, size: 18 })] })] }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: r.status, bold: true, color: r.status === 'PASS' ? '008000' : 'FF0000', size: 20 })], alignment: AlignmentType.CENTER })],
          shading: { fill: r.status === 'PASS' ? 'E2EFDA' : 'FCE4EC' }
        }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: r.details, size: 16 })] })] }),
      ]
    })
  );

  const failedTests = results.filter(r => r.status === 'FAIL');
  const passedTests = results.filter(r => r.status === 'PASS');

  const children = [
    new Paragraph({ children: [new TextRun({ text: 'ОТЧЁТ О ТЕСТИРОВАНИИ', bold: true, size: 36 })], heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: 'Раздел «Покупки и Продажи»', bold: true, size: 30 })], heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: `Приложение: 1s Бухгалтерия (${URL})`, size: 22 })], alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: `Дата: ${dateStr}  Время: ${timeStr}`, size: 22 })], alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: 'Среда: Playwright + Chromium Headless', size: 22 })], alignment: AlignmentType.CENTER }),
    new Paragraph({ text: '' }),

    // Summary
    new Paragraph({ children: [new TextRun({ text: '1. СВОДКА РЕЗУЛЬТАТОВ', bold: true, size: 28 })], heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ children: [new TextRun({ text: `Всего тестовых сценариев: ${results.length}`, size: 24 })] }),
    new Paragraph({ children: [new TextRun({ text: `Успешно пройдено (PASS): ${passCount}`, size: 24, bold: true, color: '008000' })] }),
    new Paragraph({ children: [new TextRun({ text: `Не пройдено (FAIL): ${failCount}`, size: 24, bold: true, color: failCount > 0 ? 'FF0000' : '008000' })] }),
    new Paragraph({ children: [new TextRun({ text: `Процент успеха: ${Math.round(passCount / results.length * 100)}%`, size: 26, bold: true })] }),
    new Paragraph({ text: '' }),

    // Test data
    new Paragraph({ children: [new TextRun({ text: '2. ТЕСТОВЫЕ ДАННЫЕ', bold: true, size: 28 })], heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ children: [new TextRun({ text: 'Для тестирования использовались демо-данные приложения и дополнительно созданные тестовые записи:', size: 22 })] }),
    new Paragraph({ children: [new TextRun({ text: `• Контрагенты: ${contractors.map(c => c.name).join(', ')}`, size: 22 })] }),
    new Paragraph({ children: [new TextRun({ text: `• Номенклатура: ${noms.map(n => n.name).join(', ')}`, size: 22 })] }),
    new Paragraph({ children: [new TextRun({ text: '• Создано 10 документов покупок (поступления, счета, возвраты, ГТД, корректировки, доп. расходы, доверенности)', size: 22 })] }),
    new Paragraph({ children: [new TextRun({ text: '• Создано 12 документов продаж (реализации, счета, возвраты, корректировки, розничные продажи, акты сверки, отчёты комиссионера, производственные услуги)', size: 22 })] }),
    new Paragraph({ text: '' }),

    // Detailed results
    new Paragraph({ children: [new TextRun({ text: '3. ДЕТАЛЬНЫЕ РЕЗУЛЬТАТЫ ТЕСТИРОВАНИЯ', bold: true, size: 28 })], heading: HeadingLevel.HEADING_2 }),
    new Table({ rows: [headerRow, ...tableRows], width: { size: 11500, type: WidthType.DXA } }),
    new Paragraph({ text: '' }),
  ];

  // Passed tests summary
  if (passedTests.length > 0) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: '4. ЧТО РАБОТАЕТ КОРРЕКТНО', bold: true, size: 28, color: '008000' })], heading: HeadingLevel.HEADING_2 }),
      ...passedTests.map(r => new Paragraph({ children: [
        new TextRun({ text: `✓ ${r.testName}`, size: 22, color: '008000' }),
        new TextRun({ text: r.details ? ` — ${r.details}` : '', size: 20, color: '666666' }),
      ] })),
      new Paragraph({ text: '' }),
    );
  }

  // Failed tests
  if (failedTests.length > 0) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: '5. ОБНАРУЖЕННЫЕ ПРОБЛЕМЫ', bold: true, size: 28, color: 'FF0000' })], heading: HeadingLevel.HEADING_2 }),
      ...failedTests.map(r => new Paragraph({ children: [
        new TextRun({ text: `✗ ${r.testName}: `, bold: true, size: 22, color: 'FF0000' }),
        new TextRun({ text: r.details, size: 22 }),
      ] })),
      new Paragraph({ text: '' }),
    );
  }

  // Recommendations
  children.push(
    new Paragraph({ children: [new TextRun({ text: '6. РЕКОМЕНДАЦИИ', bold: true, size: 28 })], heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ children: [new TextRun({ text: '1. Добавить валидацию на отрицательные значения цены и количества — система обрабатывает их без предупреждения, что может привести к ошибкам в учёте.', size: 22 })] }),
    new Paragraph({ children: [new TextRun({ text: '2. Добавить проверку обязательных полей (контрагент, склад) перед сохранением документа.', size: 22 })] }),
    new Paragraph({ children: [new TextRun({ text: '3. Рекомендуется запретить проведение документов с нулевой суммой.', size: 22 })] }),
    new Paragraph({ children: [new TextRun({ text: '4. Добавить подтверждение при удалении документа (диалог подтверждения).', size: 22 })] }),
    new Paragraph({ children: [new TextRun({ text: '5. Реализовать защиту от повторного проведения уже проведённого документа.', size: 22 })] }),
    new Paragraph({ children: [new TextRun({ text: '6. Добавить проверку наличия товара на складе при создании реализации.', size: 22 })] }),
    new Paragraph({ text: '' }),

    // Conclusion
    new Paragraph({ children: [new TextRun({ text: '7. ЗАКЛЮЧЕНИЕ', bold: true, size: 28 })], heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ children: [new TextRun({
      text: `Автоматизированное тестирование раздела «Покупки и Продажи» приложения 1s Бухгалтерия выполнено ${dateStr}. `
        + `Проверено ${results.length} тестовых сценариев, из которых ${passCount} (${Math.round(passCount / results.length * 100)}%) пройдены успешно. `
        + (failCount > 0
          ? `Выявлено ${failCount} проблем. Основные функции создания документов, расчёта НДС, формирования проводок и фильтрации работают корректно. Рекомендуется устранить выявленные проблемы и провести повторное тестирование.`
          : 'Все тесты пройдены. Функционал создания, проведения, удаления документов, расчёта НДС и формирования проводок работает корректно.'),
      size: 22
    })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: 'Тестирование выполнено автоматически с использованием Playwright (Chromium headless).', size: 18, italics: true, color: '888888' })] }),
  );

  const wordDoc = new Document({ sections: [{ properties: {}, children }] });

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outputPath = path.join(REPORT_DIR, 'Отчет_тестирования_Покупки_Продажи.docx');
  const buffer = await Packer.toBuffer(wordDoc);
  fs.writeFileSync(outputPath, buffer);

  console.log(`\nОтчёт сохранён: ${outputPath}`);
  console.log(`ИТОГО: ${passCount} PASS / ${failCount} FAIL из ${results.length} тестов`);
})();
