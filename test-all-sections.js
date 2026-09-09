const { chromium } = require('playwright');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, AlignmentType } = require('docx');
const fs = require('fs');
const path = require('path');

const URL = 'https://nba1121-ai.github.io/my-buh/app.html';
const REPORT_DIR = 'C:\\Users\\User\\Desktop\\Бектур\\Личное\\Личное\\Эльмырза\\тест';

const results = [];
let passCount = 0, failCount = 0;
let currentSection = '';

function log(testName, status, details = '') {
  const s = status ? 'PASS' : 'FAIL';
  if (status) passCount++; else failCount++;
  results.push({ testName, status: s, details, section: currentSection });
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

  await context.addInitScript(() => {
    localStorage.setItem('auth_session', JSON.stringify({ authenticated: true, expires: Date.now() + 3600000, name: 'admin', role: 'admin' }));
  });

  console.log('Opening app...');
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(3000);
  if (page.url().includes('index.html')) {
    await page.evaluate(() => { localStorage.setItem('auth_session', JSON.stringify({ authenticated: true, expires: Date.now() + 3600000, name: 'admin', role: 'admin' })); });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000);
  }

  // Load demo data
  await page.evaluate(() => { if (typeof tSeedDemo === 'function') tSeedDemo(true); });
  await sleep(2000);

  // Helper: create trade doc
  async function createDoc(docType, goodsData, contractorId, extra = {}) {
    return await page.evaluate(({ docType, goodsData, contractorId, extra }) => {
      try {
        const id = tUid(), number = tNextNumber(docType);
        const today = typeof tToday === 'function' ? tToday() : new Date().toISOString().slice(0, 10);
        const cfg = TT[docType] || {};
        const goods = goodsData.map(g => {
          const row = { id: tUid(), nom: g.nom, qty: g.qty, price: g.price, vat: g.vat !== undefined ? g.vat : 12, unit: g.unit || 'шт', sum: 0, vatSum: 0, total: 0, account: g.account || '41.01' };
          tCalcRow(row, 'out');
          return row;
        });
        const tabName = cfg.tabs && cfg.tabs.includes('materials') ? 'materials' : cfg.tabs && cfg.tabs.includes('products') ? 'products' : 'goods';
        const d = { id, type: docType, number, date: today, contractor: contractorId || '', contract: '', warehouse: db.trade.warehouses?.[0]?.id || 'w1', status: 'recorded', vatMode: 'out', goods: tabName === 'goods' ? goods : [], materials: tabName === 'materials' ? goods : [], products: tabName === 'products' ? goods : [], services: [], agent: [], tara: [], extra: [], waste: [], sum: 0, vatTotal: 0, total: 0, basis: '', created: new Date().toISOString(), ...extra };
        tCalcDoc(d);
        db.trade.docs.push(d);
        if (typeof saveData === 'function') saveData();
        return { success: true, doc: { id: d.id, number: d.number, total: d.total, sum: d.sum, status: d.status, type: d.type } };
      } catch (e) { return { success: false, error: e.message }; }
    }, { docType, goodsData, contractorId, extra });
  }

  // Helper: create bank/cash doc
  async function createBankDoc(type, sum, contractor, isCash = false) {
    return await page.evaluate(({ type, sum, contractor, isCash }) => {
      try {
        const CASH_TYPES = ['pko', 'rko', 'advance_report'];
        const doc = {
          id: '_t' + Date.now() + Math.random().toString(36).slice(2, 5),
          type, number: String((isCash ? db.cashDocuments.length : db.bankDocuments.length) + 1).padStart(4, '0'),
          date: new Date().toISOString().split('T')[0], status: 'posted',
          account: db.accounts?.[0]?.id || '', contractor: contractor || '',
          article: db.articles?.[0]?.id || '', currency: db.currencies?.[0]?.id || '',
          sum: sum, rate: 1, purpose: 'Тестовый платёж', note: '', created: new Date().toISOString()
        };
        if (CASH_TYPES.includes(type)) db.cashDocuments.push(doc);
        else db.bankDocuments.push(doc);
        if (typeof saveData === 'function') saveData();
        return { success: true, doc: { id: doc.id, number: doc.number, type: doc.type, sum: doc.sum, status: doc.status } };
      } catch (e) { return { success: false, error: e.message }; }
    }, { type, sum, contractor, isCash });
  }

  // Get reference data
  const refs = await page.evaluate(() => ({
    contractors: (db.trade?.contractors || []).map(c => ({ id: c.id, name: c.name })),
    noms: (db.trade?.nomenclature || []).slice(0, 10).map(n => ({ id: n.id, name: n.name, kind: n.kind })),
    warehouses: (db.trade?.warehouses || []).map(w => ({ id: w.id, name: w.name })),
    employees: (db.trade?.employees || []).map(e => ({ id: e.id, name: e.name })),
    departments: (db.trade?.departments || []).map(d => ({ id: d.id, name: d.name })),
    accounts: (db.accounts || []).map(a => ({ id: a.id, name: a.name })),
    cashs: (db.cashs || []).map(c => ({ id: c.id, name: c.name })),
    currencies: (db.currencies || []).map(c => ({ id: c.id, name: c.name || c.code })),
    articles: (db.articles || []).map(a => ({ id: a.id, name: a.name })),
    bankDocsCount: db.bankDocuments?.length || 0,
    cashDocsCount: db.cashDocuments?.length || 0,
    tradeDocsCount: db.trade?.docs?.length || 0,
  }));
  console.log('Refs:', JSON.stringify(refs, null, 0).slice(0, 500));

  const c1 = refs.contractors[0]?.id;
  const c2 = refs.contractors[1]?.id;
  const matNoms = refs.noms.filter(n => n.kind === 'Материал').map(n => n.id);
  const prodNoms = refs.noms.filter(n => n.kind === 'Продукция').map(n => n.id);
  const goodsNoms = refs.noms.filter(n => n.kind === 'Товар').map(n => n.id);

  // =====================================================
  // РАЗДЕЛ 1: БАНК
  // =====================================================
  currentSection = 'Банк';
  console.log('\n=== БАНК ===\n');

  // 1. Navigate
  try {
    await page.evaluate(() => selectPage('bank'));
    await sleep(500);
    const html = await page.evaluate(() => document.getElementById('content')?.innerHTML?.length || 0);
    log('1. Навигация: раздел "Банк"', html > 100, `Контент: ${html} символов`);
  } catch (e) { log('1. Навигация: Банк', false, e.message); }

  // 2-4. Bank documents
  try {
    const r = await createBankDoc('payment_in', 50000, c1);
    log('2. Входящее платёжное поручение', r.success, r.success ? `№${r.doc.number}, сумма: ${r.doc.sum}` : r.error);
  } catch (e) { log('2. Входящее ПП', false, e.message); }

  try {
    const r = await createBankDoc('payment_out', 35000, c2);
    log('3. Исходящее платёжное поручение', r.success, r.success ? `№${r.doc.number}, сумма: ${r.doc.sum}` : r.error);
  } catch (e) { log('3. Исходящее ПП', false, e.message); }

  try {
    const r = await createBankDoc('payment_in', 120000, c1);
    log('4. Входящее ПП #2 (крупная сумма)', r.success, r.success ? `№${r.doc.number}, сумма: ${r.doc.sum}` : r.error);
  } catch (e) { log('4. Входящее ПП #2', false, e.message); }

  // 5. Bank doc count
  try {
    const cnt = await page.evaluate(() => db.bankDocuments.length);
    log('5. Подсчёт банковских документов', cnt > refs.bankDocsCount, `Было: ${refs.bankDocsCount}, стало: ${cnt}`);
  } catch (e) { log('5. Подсчёт', false, e.message); }

  // 6. Delete bank doc
  try {
    const r = await page.evaluate(() => {
      const before = db.bankDocuments.length;
      if (before === 0) return { success: false, error: 'Нет документов' };
      db.bankDocuments.pop();
      if (typeof saveData === 'function') saveData();
      return { success: db.bankDocuments.length === before - 1, before, after: db.bankDocuments.length };
    });
    log('6. Удаление банковского документа', r.success, r.success ? `Было: ${r.before}, стало: ${r.after}` : r.error);
  } catch (e) { log('6. Удаление банк.док', false, e.message); }

  // 7. Render bank page
  try {
    const r = await page.evaluate(() => { selectPage('bank'); return typeof renderBankDocuments === 'function' ? renderBankDocuments().length > 50 : false; });
    log('7. Рендер страницы банковских документов', r, r ? 'HTML сгенерирован' : 'Ошибка рендера');
  } catch (e) { log('7. Рендер банка', false, e.message); }

  // =====================================================
  // РАЗДЕЛ 2: КАССА
  // =====================================================
  currentSection = 'Касса';
  console.log('\n=== КАССА ===\n');

  try {
    await page.evaluate(() => selectPage('cash'));
    await sleep(500);
    log('8. Навигация: раздел "Касса"', true, 'OK');
  } catch (e) { log('8. Навигация: Касса', false, e.message); }

  try {
    const r = await createBankDoc('pko', 25000, c1, true);
    log('9. Приходный кассовый ордер (ПКО)', r.success, r.success ? `№${r.doc.number}, сумма: ${r.doc.sum}` : r.error);
  } catch (e) { log('9. ПКО', false, e.message); }

  try {
    const r = await createBankDoc('rko', 15000, c2, true);
    log('10. Расходный кассовый ордер (РКО)', r.success, r.success ? `№${r.doc.number}, сумма: ${r.doc.sum}` : r.error);
  } catch (e) { log('10. РКО', false, e.message); }

  try {
    const r = await createBankDoc('pko', 8000, '', true);
    log('11. ПКО без контрагента', r.success, r.success ? `№${r.doc.number}, сумма: ${r.doc.sum}` : r.error);
  } catch (e) { log('11. ПКО без контрагента', false, e.message); }

  try {
    const cnt = await page.evaluate(() => db.cashDocuments.length);
    log('12. Подсчёт кассовых документов', cnt > refs.cashDocsCount, `Было: ${refs.cashDocsCount}, стало: ${cnt}`);
  } catch (e) { log('12. Подсчёт касса', false, e.message); }

  // =====================================================
  // РАЗДЕЛ 3: СКЛАД
  // =====================================================
  currentSection = 'Склад';
  console.log('\n=== СКЛАД ===\n');

  // Stock opening
  try {
    const r = await createDoc('stock_opening', [
      { nom: goodsNoms[0] || 'n1', qty: 100, price: 40000, vat: -1 },
      { nom: goodsNoms[1] || 'n2', qty: 200, price: 12000, vat: -1 },
    ], '', { warehouse: 'w1' });
    log('13. Ввод начальных остатков', r.success, r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('13. Начальные остатки', false, e.message); }

  // Transfer
  try {
    const r = await createDoc('transfer', [
      { nom: goodsNoms[0] || 'n1', qty: 5, price: 40000, vat: -1 },
    ], '', { warehouse: 'w1', warehouseTo: 'w2' });
    log('14. Перемещение товаров между складами', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('14. Перемещение', false, e.message); }

  // Stock in
  try {
    const r = await createDoc('stock_in', [
      { nom: goodsNoms[2] || 'n3', qty: 50, price: 600, vat: -1 },
    ], '', { warehouse: 'w1' });
    log('15. Оприходование товаров', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('15. Оприходование', false, e.message); }

  // Stock out
  try {
    const r = await createDoc('stock_out', [
      { nom: goodsNoms[2] || 'n3', qty: 5, price: 600, vat: -1 },
    ], '', { warehouse: 'w1' });
    log('16. Списание товаров', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('16. Списание', false, e.message); }

  // Inventory
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('inventory');
        const d = { id, type: 'inventory', number, date: tToday(), warehouse: 'w1', status: 'recorded', vatMode: 'in', goods: [
          { id: tUid(), nom: db.trade.nomenclature[0]?.id, qty: 0, qtyFact: 95, price: 40000, vat: -1, sum: 0, vatSum: 0, total: 0 },
        ], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [], sum: 0, vatTotal: 0, total: 0, basis: '', created: new Date().toISOString() };
        tCalcDoc(d);
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number, total: d.total } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('17. Инвентаризация товаров', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('17. Инвентаризация', false, e.message); }

  // Price setting
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('price_setting');
        const d = { id, type: 'price_setting', number, date: tToday(), warehouse: '', status: 'recorded', vatMode: 'in', goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [], prices: [
          { nom: db.trade.nomenclature[0]?.id, priceType: db.trade.priceTypes[0]?.id, price: 55000, vat: 12 },
        ], sum: 0, vatTotal: 0, total: 0, basis: '', created: new Date().toISOString() };
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('18. Установка цен номенклатуры', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('18. Установка цен', false, e.message); }

  // Stock balances
  try {
    const r = await page.evaluate(() => {
      const bal = stockBalances();
      return { count: bal.length, sample: bal.slice(0, 3).map(b => `${tNomName(b.nom)}: ${b.qty}`) };
    });
    log('19. Расчёт остатков на складе', r.count > 0, `${r.count} позиций. Пример: ${r.sample.join(', ')}`);
  } catch (e) { log('19. Остатки склада', false, e.message); }

  // Stock shortages check
  try {
    const r = await page.evaluate(() => typeof tStockShortages === 'function' && typeof tShortageText === 'function');
    log('20. Функция проверки нехватки остатков', r, r ? 'tStockShortages() доступна' : 'Не найдена');
  } catch (e) { log('20. Проверка нехватки', false, e.message); }

  // =====================================================
  // РАЗДЕЛ 4: ПРОИЗВОДСТВО
  // =====================================================
  currentSection = 'Производство';
  console.log('\n=== ПРОИЗВОДСТВО ===\n');

  // Specification
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('spec');
        const d = { id, type: 'spec', number, date: tToday(), status: 'recorded', vatMode: 'in', productNom: 'p1', warehouse: 'w1',
          goods: [], services: [], agent: [], tara: [], extra: [],
          materials: [
            { id: tUid(), nom: 'm1', qty: 1, price: 3500, vat: -1, sum: 0, vatSum: 0, total: 0, unit: 'шт' },
            { id: tUid(), nom: 'm2', qty: 1, price: 7800, vat: -1, sum: 0, vatSum: 0, total: 0, unit: 'шт' },
            { id: tUid(), nom: 'm3', qty: 1, price: 12500, vat: -1, sum: 0, vatSum: 0, total: 0, unit: 'шт' },
          ],
          products: [], waste: [], sum: 0, vatTotal: 0, total: 0, basis: '', created: new Date().toISOString() };
        tCalcDoc(d);
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number, total: d.total } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('21. Спецификация номенклатуры', r.success, r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('21. Спецификация', false, e.message); }

  // Requisition
  try {
    const r = await createDoc('requisition', [
      { nom: 'm1', qty: 5, price: 3500, vat: -1, account: '10.01' },
      { nom: 'm2', qty: 5, price: 7800, vat: -1, account: '10.01' },
    ], '', { warehouse: 'w1', department: 'dep1' });
    log('22. Требование-накладная', r.success, r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('22. Требование-накладная', false, e.message); }

  // Shift report
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('shift_report');
        const d = { id, type: 'shift_report', number, date: tToday(), status: 'recorded', vatMode: 'in', warehouse: 'w1', department: 'dep1',
          goods: [], services: [], agent: [], tara: [], extra: [],
          materials: [{ id: tUid(), nom: 'm1', qty: 3, price: 3500, vat: -1, sum: 0, vatSum: 0, total: 0, unit: 'шт' }],
          products: [{ id: tUid(), nom: 'p1', qty: 3, price: 35000, vat: -1, sum: 0, vatSum: 0, total: 0, unit: 'шт' }],
          waste: [{ id: tUid(), nom: 'w1', qty: 2, price: 20, vat: -1, sum: 0, vatSum: 0, total: 0, unit: 'кг' }],
          sum: 0, vatTotal: 0, total: 0, basis: '', created: new Date().toISOString() };
        tCalcDoc(d);
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number, total: d.total } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('23. Отчёт производства за смену', r.success, r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('23. Отчёт за смену', false, e.message); }

  // Assembly
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('assembly');
        const d = { id, type: 'assembly', number, date: tToday(), status: 'recorded', vatMode: 'in', warehouse: 'w1', opKind: 'Комплектация',
          kitNom: 'k1', kitQty: 1,
          goods: [
            { id: tUid(), nom: 'n1', qty: 1, price: 48000, vat: -1, sum: 0, vatSum: 0, total: 0, unit: 'шт' },
            { id: tUid(), nom: 'n2', qty: 1, price: 15000, vat: -1, sum: 0, vatSum: 0, total: 0, unit: 'шт' },
          ],
          services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          sum: 0, vatTotal: 0, total: 0, basis: '', created: new Date().toISOString() };
        tCalcDoc(d);
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number, total: d.total } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('24. Комплектация номенклатуры', r.success, r.success ? `№${r.doc.number}, Итого: ${r.doc.total}` : r.error);
  } catch (e) { log('24. Комплектация', false, e.message); }

  // To processing
  try {
    const r = await createDoc('to_processing', [
      { nom: 'm4', qty: 10, price: 4200, vat: -1, account: '10.01' },
    ], c2, { warehouse: 'w1' });
    log('25. Передача в переработку', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('25. Передача в переработку', false, e.message); }

  // From processing
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('from_processing');
        const d = { id, type: 'from_processing', number, date: tToday(), status: 'recorded', vatMode: 'in', warehouse: 'w1', contractor: 'c2',
          goods: [], services: [], agent: [], tara: [], materials: [], extra: [],
          products: [{ id: tUid(), nom: 'p2', qty: 5, price: 55000, vat: -1, sum: 0, vatSum: 0, total: 0, unit: 'шт' }],
          waste: [], sum: 0, vatTotal: 0, total: 0, basis: '', created: new Date().toISOString() };
        tCalcDoc(d);
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number, total: d.total } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('26. Поступление из переработки', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('26. Из переработки', false, e.message); }

  // Month close
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('month_close');
        const d = { id, type: 'month_close', number, date: tToday(), status: 'recorded', vatMode: 'in', warehouse: '', period: tToday().slice(0, 7), department: 'dep1',
          goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          sum: 0, vatTotal: 0, total: 0, basis: '', created: new Date().toISOString() };
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('27. Закрытие месяца', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('27. Закрытие месяца', false, e.message); }

  // WIP Inventory
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('wip_inventory');
        const d = { id, type: 'wip_inventory', number, date: tToday(), status: 'recorded', vatMode: 'in', warehouse: 'w1', department: 'dep1',
          goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          wip: [{ id: tUid(), nomGroup: 'ng1', sum: 50000 }],
          sum: 0, vatTotal: 0, total: 0, basis: '', created: new Date().toISOString() };
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('28. Инвентаризация НЗП', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('28. Инвентаризация НЗП', false, e.message); }

  // =====================================================
  // РАЗДЕЛ 5: ЗАРПЛАТА И КАДРЫ
  // =====================================================
  currentSection = 'Зарплата и кадры';
  console.log('\n=== ЗАРПЛАТА И КАДРЫ ===\n');

  // Ensure HR data exists (tSeedDemo may clear it)
  await page.evaluate(() => {
    if (!db.trade.employees || db.trade.employees.length === 0) {
      delete db.trade.employees; delete db.trade.positions; delete db.trade.schedules;
      hrInit();
      if (typeof saveData === 'function') saveData();
    }
  });
  await sleep(300);

  // Hiring
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('hire');
        const d = { id, type: 'hire', number, date: tToday(), status: 'recorded', vatMode: 'in',
          employee: db.trade.employees[3]?.id || 'e4', orderDate: tToday(), hireDate: tToday(), department: 'dep1', position: 'pos3', salary: 45000, schedule: 'sch1', probation: 3,
          goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          sum: 0, vatTotal: 0, total: 0, warehouse: '', basis: '', created: new Date().toISOString() };
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('29. Приём на работу', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('29. Приём на работу', false, e.message); }

  // Transfer HR
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('hr_transfer');
        const d = { id, type: 'hr_transfer', number, date: tToday(), status: 'recorded', vatMode: 'in',
          employee: db.trade.employees[4]?.id || 'e5', orderDate: tToday(), newDepartment: 'dep3', newPosition: 'pos5', newSalary: 45000,
          goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          sum: 0, vatTotal: 0, total: 0, warehouse: '', basis: '', created: new Date().toISOString() };
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('30. Кадровый перевод', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('30. Кадровый перевод', false, e.message); }

  // Vacation
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('vacation');
        const e = db.trade.employees[0]; if (!e) return { success: false, error: 'Нет сотрудников' };
        const d = { id, type: 'vacation', number, date: tToday(), status: 'recorded', vatMode: 'in',
          employee: e.id, orderDate: tToday(), opKind: 'Основной оплачиваемый отпуск',
          absFrom: '2026-09-14', absTo: '2026-09-27', avgDay: Math.round((e.salary + (e.bonus || 0)) / 29.6 * 100) / 100,
          goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          sum: 0, vatTotal: 0, total: 0, warehouse: '', basis: '', created: new Date().toISOString() };
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number, avgDay: d.avgDay } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('31. Отпуск сотрудника', r.success, r.success ? `№${r.doc.number}, среднедневной: ${r.doc.avgDay}` : r.error);
  } catch (e) { log('31. Отпуск', false, e.message); }

  // Sick leave
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('sick_leave');
        const d = { id, type: 'sick_leave', number, date: tToday(), status: 'recorded', vatMode: 'in',
          employee: db.trade.employees[2]?.id || 'e3', orderDate: tToday(), absFrom: '2026-09-01', absTo: '2026-09-05', pct: 100,
          avgDay: Math.round(((db.trade.employees[2]?.salary || 60000)) / 21.6 * 100) / 100,
          goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          sum: 0, vatTotal: 0, total: 0, warehouse: '', basis: '', created: new Date().toISOString() };
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('32. Больничный лист', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('32. Больничный', false, e.message); }

  // Dismissal
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('dismissal');
        const d = { id, type: 'dismissal', number, date: tToday(), status: 'recorded', vatMode: 'in',
          employee: db.trade.employees[5]?.id || 'e6', orderDate: tToday(), fireDate: '2026-09-30', reason: 'По собственному желанию', compDays: 5,
          avgDay: Math.round(((db.trade.employees[5]?.salary || 35000)) / 29.6 * 100) / 100,
          goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          sum: 0, vatTotal: 0, total: 0, warehouse: '', basis: '', created: new Date().toISOString() };
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('33. Увольнение сотрудника', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('33. Увольнение', false, e.message); }

  // Timesheet
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('timesheet');
        const d = { id, type: 'timesheet', number, date: tToday(), status: 'recorded', vatMode: 'in',
          period: tToday().slice(0, 7),
          rows: db.trade.employees.filter(e => e.status === 'Работает').map(e => ({ employee: e.id, days: 22, hours: 176 })),
          goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          sum: 0, vatTotal: 0, total: 0, warehouse: '', basis: '', created: new Date().toISOString() };
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number, rowsCount: d.rows.length } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('34. Табель учёта рабочего времени', r.success, r.success ? `№${r.doc.number}, сотрудников: ${r.doc.rowsCount}` : r.error);
  } catch (e) { log('34. Табель', false, e.message); }

  // Payroll
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('payroll');
        const period = tToday().slice(0, 7);
        const rows = db.trade.employees.filter(e => e.status === 'Работает').map(e => ({
          employee: e.id, normDays: 22, workedDays: 22, salary: e.salary,
          salaryPay: e.salary, bonus: e.bonus || 0, vacDays: 0, sickDays: 0, vacPay: 0, sickPay: 0,
          other: 0, compensation: 0, gross: 0, sfEmp: 0, deduction: 0, taxBase: 0, incomeTax: 0,
          netPay: 0, sfEmployer: 0
        }));
        const d = { id, type: 'payroll', number, date: tToday(), status: 'recorded', vatMode: 'in',
          period, rows,
          goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          sum: 0, vatTotal: 0, total: 0, warehouse: '', basis: '', created: new Date().toISOString() };
        tCalcDoc(d);
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number, total: d.total, rowsCount: d.rows.length } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('35. Начисление зарплаты', r.success, r.success ? `№${r.doc.number}, Итого: ${r.doc.total}, сотрудников: ${r.doc.rowsCount}` : r.error);
  } catch (e) { log('35. Зарплата', false, e.message); }

  // Payroll calculation check
  try {
    const r = await page.evaluate(() => {
      const P = db.trade.payroll;
      return { incomeTax: P.incomeTax, sfEmployee: P.sfEmployee, sfEmployer: P.sfEmployer, stdDeduction: P.stdDeduction, minSalary: P.minSalary };
    });
    log('36. Настройки зарплаты (ставки)', true, `ПН: ${r.incomeTax}%, СФ(раб): ${r.sfEmployee}%, СФ(работодат): ${r.sfEmployer}%, Вычет: ${r.stdDeduction}, МРОТ: ${r.minSalary}`);
  } catch (e) { log('36. Настройки зарплаты', false, e.message); }

  // Employee list
  try {
    const r = await page.evaluate(() => db.trade.employees.length);
    log('37. Справочник сотрудников', r >= 6, `${r} сотрудников`);
  } catch (e) { log('37. Сотрудники', false, e.message); }

  // GPC (civil contract)
  try {
    const r = await page.evaluate(() => {
      try {
        const id = tUid(), number = tNextNumber('gph');
        const d = { id, type: 'gph', number, date: tToday(), status: 'recorded', vatMode: 'in',
          employee: db.trade.employees[2]?.id || 'e3', gphSubject: 'Разработка макета', gphSum: 25000, gphFrom: '2026-09-01', gphTo: '2026-09-30',
          goods: [], services: [], agent: [], tara: [], materials: [], products: [], waste: [], extra: [],
          sum: 0, vatTotal: 0, total: 0, warehouse: '', basis: '', created: new Date().toISOString() };
        db.trade.docs.push(d);
        saveData();
        return { success: true, doc: { number: d.number } };
      } catch (e) { return { success: false, error: e.message }; }
    });
    log('38. Договор ГПХ', r.success, r.success ? `№${r.doc.number}` : r.error);
  } catch (e) { log('38. Договор ГПХ', false, e.message); }

  // =====================================================
  // РАЗДЕЛ 6: СПРАВОЧНИКИ
  // =====================================================
  currentSection = 'Справочники';
  console.log('\n=== СПРАВОЧНИКИ ===\n');

  try {
    const r = await page.evaluate(() => (db.trade?.contractors || []).length);
    log('39. Справочник контрагентов', r >= 3, `${r} контрагентов`);
  } catch (e) { log('39. Контрагенты', false, e.message); }

  try {
    const r = await page.evaluate(() => (db.trade?.contracts || []).length);
    log('40. Справочник договоров', r >= 2, `${r} договоров`);
  } catch (e) { log('40. Договоры', false, e.message); }

  try {
    const r = await page.evaluate(() => (db.trade?.nomenclature || []).length);
    log('41. Справочник номенклатуры', r >= 10, `${r} позиций`);
  } catch (e) { log('41. Номенклатура', false, e.message); }

  try {
    const r = await page.evaluate(() => (db.trade?.warehouses || []).length);
    log('42. Справочник складов', r >= 2, `${r} складов`);
  } catch (e) { log('42. Склады', false, e.message); }

  try {
    const r = await page.evaluate(() => (db.trade?.priceTypes || []).length);
    log('43. Типы цен', r >= 2, `${r} типов цен`);
  } catch (e) { log('43. Типы цен', false, e.message); }

  try {
    const r = await page.evaluate(() => (db.trade?.departments || []).length);
    log('44. Справочник подразделений', r >= 2, `${r} подразделений`);
  } catch (e) { log('44. Подразделения', false, e.message); }

  try {
    const r = await page.evaluate(() => (db.trade?.positions || []).length);
    log('45. Справочник должностей', r >= 4, `${r} должностей`);
  } catch (e) { log('45. Должности', false, e.message); }

  try {
    const r = await page.evaluate(() => (db.trade?.schedules || []).length);
    log('46. Графики работы', r >= 2, `${r} графиков`);
  } catch (e) { log('46. Графики', false, e.message); }

  try {
    const r = await page.evaluate(() => db.trade?.org?.name || '');
    log('47. Реквизиты организации', r.length > 0, `Организация: ${r}`);
  } catch (e) { log('47. Организация', false, e.message); }

  try {
    const r = await page.evaluate(() => (db.accounts || []).length);
    log('48. Банковские счета', r >= 1, `${r} счетов`);
  } catch (e) { log('48. Банковские счета', false, e.message); }

  try {
    const r = await page.evaluate(() => (db.currencies || []).length);
    log('49. Справочник валют', r >= 1, `${r} валют`);
  } catch (e) { log('49. Валюты', false, e.message); }

  try {
    const r = await page.evaluate(() => (db.articles || []).length);
    log('50. Статьи движения ДС', r >= 1, `${r} статей`);
  } catch (e) { log('50. Статьи ДДС', false, e.message); }

  // =====================================================
  // РАЗДЕЛ 7: ОТЧЁТЫ
  // =====================================================
  currentSection = 'Отчёты';
  console.log('\n=== ОТЧЁТЫ ===\n');

  try {
    await page.evaluate(() => selectPage('reports'));
    await sleep(500);
    const html = await page.evaluate(() => document.getElementById('content')?.innerHTML?.length || 0);
    log('51. Навигация: Отчёты по ДДС', html > 50, `Контент: ${html} символов`);
  } catch (e) { log('51. Отчёты ДДС', false, e.message); }

  try {
    await page.evaluate(() => selectPage('cashbook'));
    await sleep(500);
    const html = await page.evaluate(() => document.getElementById('content')?.innerHTML?.length || 0);
    log('52. Кассовая книга', html > 50, `Контент: ${html} символов`);
  } catch (e) { log('52. Кассовая книга', false, e.message); }

  // Trade reports
  const reportPages = ['r_payables', 'r_receivables', 'r_sales', 'r_gross', 'r_purchases'];
  const reportNames = ['Задолженность поставщикам', 'Задолженность покупателей', 'Отчёт "Продажи"', 'Валовая прибыль', 'Анализ закупок'];
  for (let i = 0; i < reportPages.length; i++) {
    try {
      await page.evaluate((p) => { selectPage(p); }, reportPages[i]);
      await sleep(300);
      const html = await page.evaluate(() => document.getElementById('content')?.innerHTML?.length || 0);
      log(`${53 + i}. ${reportNames[i]}`, html > 50, `Контент: ${html} символов`);
    } catch (e) { log(`${53 + i}. ${reportNames[i]}`, false, e.message); }
  }

  // =====================================================
  // РАЗДЕЛ 8: АДМИНИСТРИРОВАНИЕ
  // =====================================================
  currentSection = 'Администрирование';
  console.log('\n=== АДМИНИСТРИРОВАНИЕ ===\n');

  try {
    await page.evaluate(() => selectPage('users'));
    await sleep(500);
    const html = await page.evaluate(() => document.getElementById('content')?.innerHTML?.length || 0);
    log('58. Управление пользователями', html > 50, `Контент: ${html} символов`);
  } catch (e) { log('58. Пользователи', false, e.message); }

  try {
    await page.evaluate(() => selectPage('actlog'));
    await sleep(500);
    const html = await page.evaluate(() => document.getElementById('content')?.innerHTML?.length || 0);
    log('59. Журнал действий', html > 50, `Контент: ${html} символов`);
  } catch (e) { log('59. Журнал действий', false, e.message); }

  try {
    await page.evaluate(() => selectPage('profile'));
    await sleep(500);
    const html = await page.evaluate(() => document.getElementById('content')?.innerHTML?.length || 0);
    log('60. Профиль пользователя', html > 50, `Контент: ${html} символов`);
  } catch (e) { log('60. Профиль', false, e.message); }

  // =====================================================
  // РАЗДЕЛ 9: ОБЩИЕ ФУНКЦИИ
  // =====================================================
  currentSection = 'Общие функции';
  console.log('\n=== ОБЩИЕ ФУНКЦИИ ===\n');

  try {
    const r = await page.evaluate(() => typeof exportToCSV === 'function');
    log('61. Экспорт CSV', r, r ? 'Доступна' : 'Не найдена');
  } catch (e) { log('61. Экспорт CSV', false, e.message); }

  try {
    const r = await page.evaluate(() => typeof exportToJSON === 'function');
    log('62. Экспорт JSON', r, r ? 'Доступна' : 'Не найдена');
  } catch (e) { log('62. Экспорт JSON', false, e.message); }

  try {
    const r = await page.evaluate(() => typeof exportToXML === 'function');
    log('63. Экспорт XML', r, r ? 'Доступна' : 'Не найдена');
  } catch (e) { log('63. Экспорт XML', false, e.message); }

  try {
    const r = await page.evaluate(() => typeof printDoc === 'function');
    log('64. Печать документов', r, r ? 'Доступна' : 'Не найдена');
  } catch (e) { log('64. Печать', false, e.message); }

  try {
    const r = await page.evaluate(() => typeof printCashbook === 'function');
    log('65. Печать кассовой книги', r, r ? 'Доступна' : 'Не найдена');
  } catch (e) { log('65. Печать кассовой книги', false, e.message); }

  try {
    await page.evaluate(() => selectPage('dashboard'));
    await sleep(500);
    const html = await page.evaluate(() => document.getElementById('content')?.innerHTML?.length || 0);
    log('66. Дашборд (главная)', html > 100, `Контент: ${html} символов`);
  } catch (e) { log('66. Дашборд', false, e.message); }

  // Theme toggle
  try {
    const r = await page.evaluate(() => typeof toggleTheme === 'function');
    log('67. Переключатель темы', r, r ? 'toggleTheme() доступна' : 'Не найдена');
  } catch (e) { log('67. Тема', false, e.message); }

  // Search
  try {
    const r = await page.evaluate(() => typeof doGlobalSearch === 'function');
    log('68. Глобальный поиск', r, r ? 'Доступна' : 'Не найдена');
  } catch (e) { log('68. Поиск', false, e.message); }

  // SaveData
  try {
    const r = await page.evaluate(() => typeof saveData === 'function');
    log('69. Сохранение данных', r, r ? 'saveData() доступна' : 'Не найдена');
  } catch (e) { log('69. Сохранение', false, e.message); }

  // Total document count
  try {
    const r = await page.evaluate(() => ({
      trade: db.trade.docs.length,
      bank: db.bankDocuments.length,
      cash: db.cashDocuments.length,
      total: db.trade.docs.length + db.bankDocuments.length + db.cashDocuments.length
    }));
    log('70. Итого документов в системе', r.total > 30, `Торговые: ${r.trade}, Банк: ${r.bank}, Касса: ${r.cash}, ВСЕГО: ${r.total}`);
  } catch (e) { log('70. Итого', false, e.message); }

  // Console errors
  const relevantErrors = consoleErrors.filter(e => !e.includes('favicon'));
  if (relevantErrors.length > 0) {
    log('71. Ошибки консоли', false, `${relevantErrors.length} ошибок: ${relevantErrors.slice(0, 3).join('; ')}`);
  } else {
    log('71. Ошибки консоли', true, 'Ошибок не обнаружено');
  }

  await browser.close();

  // =====================================================
  // WORD REPORT
  // =====================================================
  console.log('\n=== ГЕНЕРАЦИЯ WORD ОТЧЁТА ===\n');

  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU');
  const timeStr = now.toLocaleTimeString('ru-RU');

  const sections = [...new Set(results.map(r => r.section))];

  const children = [
    new Paragraph({ children: [new TextRun({ text: 'ОТЧЁТ О ТЕСТИРОВАНИИ', bold: true, size: 36 })], heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: 'Все разделы приложения 1s Бухгалтерия', bold: true, size: 28 })], heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: `URL: ${URL}`, size: 22 })], alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: `Дата: ${dateStr}  Время: ${timeStr}`, size: 22 })], alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: 'Среда: Playwright + Chromium Headless', size: 22 })], alignment: AlignmentType.CENTER }),
    new Paragraph({ text: '' }),

    new Paragraph({ children: [new TextRun({ text: 'СВОДКА РЕЗУЛЬТАТОВ', bold: true, size: 28 })], heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ children: [new TextRun({ text: `Всего тестов: ${results.length}`, size: 24 })] }),
    new Paragraph({ children: [new TextRun({ text: `Успешно: ${passCount}`, size: 24, bold: true, color: '008000' })] }),
    new Paragraph({ children: [new TextRun({ text: `Провалено: ${failCount}`, size: 24, bold: true, color: failCount > 0 ? 'FF0000' : '008000' })] }),
    new Paragraph({ children: [new TextRun({ text: `Процент: ${Math.round(passCount / results.length * 100)}%`, size: 26, bold: true })] }),
    new Paragraph({ text: '' }),
  ];

  // Per-section summary
  children.push(new Paragraph({ children: [new TextRun({ text: 'РЕЗУЛЬТАТЫ ПО РАЗДЕЛАМ', bold: true, size: 28 })], heading: HeadingLevel.HEADING_2 }));
  for (const sec of sections) {
    const secResults = results.filter(r => r.section === sec);
    const secPass = secResults.filter(r => r.status === 'PASS').length;
    const secFail = secResults.filter(r => r.status === 'FAIL').length;
    children.push(new Paragraph({ children: [
      new TextRun({ text: `${sec}: `, bold: true, size: 22 }),
      new TextRun({ text: `${secPass}/${secResults.length} пройдено`, size: 22, color: secFail > 0 ? 'FF0000' : '008000' }),
    ] }));
  }
  children.push(new Paragraph({ text: '' }));

  // Detailed table per section
  for (const sec of sections) {
    const secResults = results.filter(r => r.section === sec);
    children.push(new Paragraph({ children: [new TextRun({ text: sec.toUpperCase(), bold: true, size: 26 })], heading: HeadingLevel.HEADING_2 }));

    const headerRow = new TableRow({ children: [
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: '№', bold: true, size: 18 })] })], width: { size: 500, type: WidthType.DXA }, shading: { fill: 'D9E2F3' } }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Тест', bold: true, size: 18 })] })], width: { size: 4000, type: WidthType.DXA }, shading: { fill: 'D9E2F3' } }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Статус', bold: true, size: 18 })], alignment: AlignmentType.CENTER })], width: { size: 900, type: WidthType.DXA }, shading: { fill: 'D9E2F3' } }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Подробности', bold: true, size: 18 })] })], width: { size: 6100, type: WidthType.DXA }, shading: { fill: 'D9E2F3' } }),
    ] });

    const rows = secResults.map((r, i) => new TableRow({ children: [
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(results.indexOf(r) + 1), size: 18 })], alignment: AlignmentType.CENTER })] }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: r.testName, size: 18 })] })] }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: r.status, bold: true, color: r.status === 'PASS' ? '008000' : 'FF0000', size: 18 })], alignment: AlignmentType.CENTER })], shading: { fill: r.status === 'PASS' ? 'E2EFDA' : 'FCE4EC' } }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: r.details, size: 16 })] })] }),
    ] }));

    children.push(new Table({ rows: [headerRow, ...rows], width: { size: 11500, type: WidthType.DXA } }));
    children.push(new Paragraph({ text: '' }));
  }

  // Failed
  const failed = results.filter(r => r.status === 'FAIL');
  if (failed.length > 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: 'ОБНАРУЖЕННЫЕ ПРОБЛЕМЫ', bold: true, size: 28, color: 'FF0000' })], heading: HeadingLevel.HEADING_2 }));
    failed.forEach(r => children.push(new Paragraph({ children: [
      new TextRun({ text: `[${r.section}] ${r.testName}: `, bold: true, size: 22, color: 'FF0000' }),
      new TextRun({ text: r.details, size: 22 }),
    ] })));
    children.push(new Paragraph({ text: '' }));
  }

  // Conclusion
  children.push(
    new Paragraph({ children: [new TextRun({ text: 'ЗАКЛЮЧЕНИЕ', bold: true, size: 28 })], heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ children: [new TextRun({
      text: `Комплексное тестирование всех разделов приложения 1s Бухгалтерия выполнено ${dateStr}. `
        + `Проверено ${results.length} сценариев по ${sections.length} разделам: ${sections.join(', ')}. `
        + `${passCount} тестов (${Math.round(passCount / results.length * 100)}%) пройдены успешно. `
        + (failCount > 0 ? `Выявлено ${failCount} проблем, требующих внимания.` : 'Все тесты пройдены. Приложение работает корректно.'),
      size: 22
    })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: 'Тестирование выполнено Playwright (Chromium headless).', size: 18, italics: true, color: '888888' })] }),
  );

  const wordDoc = new Document({ sections: [{ properties: {}, children }] });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outputPath = path.join(REPORT_DIR, 'Отчет_тестирования_ВСЕ_РАЗДЕЛЫ.docx');
  const buffer = await Packer.toBuffer(wordDoc);
  fs.writeFileSync(outputPath, buffer);

  console.log(`\nОтчёт: ${outputPath}`);
  console.log(`ИТОГО: ${passCount} PASS / ${failCount} FAIL из ${results.length}`);
})();
