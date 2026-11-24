// Эмулятор: Telegram + GitHub + D1. Прогоняет сценарии бота без реальных токенов.
// Запуск: node test/run.mjs <путь к db.json> [папка для PDF]
import fs from 'fs';
import crypto from 'crypto';
import { Bot } from '../src/bot.js';

const [dbPath, outDir = '/tmp'] = process.argv.slice(2);
const fonts = { regular: fs.readFileSync(new URL('../src/fonts/DejaVuSans.ttf', import.meta.url)), bold: fs.readFileSync(new URL('../src/fonts/DejaVuSans-Bold.ttf', import.meta.url)) };

// ---- GitHub (db.json в памяти) ----
const gh = { text: fs.readFileSync(dbPath, 'utf8'), puts: 0, conflictOnce: false };
gh.sha = crypto.createHash('sha1').update(gh.text).digest('hex');
// ---- Telegram ----
const sent = []; let msgId = 100;
// ---- D1 ----
const tables = { sessions: new Map(), users: new Map() };
const DB = {
    prepare(sql) {
        const st = { sql, args: [], bind(...a) { st.args = a; return st; },
            async first() { if (/FROM sessions/.test(sql)) { const v = tables.sessions.get(st.args[0]); return v ? { data: v } : null; } if (/FROM users WHERE uid/.test(sql)) return tables.users.get(st.args[0]) || null; return null; },
            async run() { if (/INTO sessions/.test(sql)) tables.sessions.set(st.args[0], st.args[1]); if (/INTO users/.test(sql)) tables.users.set(st.args[0], { uid: st.args[0], name: st.args[1], role: st.args[2], added: st.args[3] }); return {}; },
            async all() { return { results: [...tables.users.values()].filter(u => u.role !== 'pending') }; } };
        return st;
    },
    async batch(list) { return list.map(() => ({})); },
};

globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://api.telegram.org/')) {
        const method = url.split('/').pop();
        let body;
        if (opts.body instanceof FormData) {
            body = Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, v]));
            const blob = body.document; const buf = Buffer.from(await blob.arrayBuffer());
            const fname = blob.name || 'doc.pdf'; fs.writeFileSync(`${outDir}/${fname}`, buf);
            body = { chat_id: body.chat_id, file: fname, size: buf.length, caption: body.caption, reply_markup: body.reply_markup ? JSON.parse(body.reply_markup) : null };
        } else body = JSON.parse(opts.body || '{}');
        sent.push({ method, body });
        return json({ ok: true, result: { message_id: ++msgId, username: 'esep_test_bot' } });
    }
    if (url.startsWith('https://api.github.com/')) {
        if ((opts.method || 'GET') === 'GET') {
            if ((opts.headers.Accept || '').includes('raw')) return new Response(gh.text);
            const big = gh.text.length > 1e6;
            return json({ sha: gh.sha, encoding: big ? 'none' : 'base64', content: big ? '' : Buffer.from(gh.text).toString('base64') });
        }
        if (opts.method === 'PUT') {
            const b = JSON.parse(opts.body);
            if (gh.conflictOnce) { // кто-то (сайт) успел записать раньше — добавим «чужой» документ
                gh.conflictOnce = false;
                const d = JSON.parse(gh.text); d.trade.docs.push({ id: 'SITE_EDIT', type: 'stock_in', number: 'ОП-999', date: '2026-11-24', status: 'draft', goods: [] });
                gh.text = JSON.stringify(d); gh.sha = crypto.createHash('sha1').update(gh.text).digest('hex');
            }
            if (b.sha !== gh.sha) return json({ message: 'conflict' }, 409);
            gh.text = Buffer.from(b.content, 'base64').toString('utf8'); gh.sha = crypto.createHash('sha1').update(gh.text).digest('hex'); gh.puts++;
            return json({ content: { sha: gh.sha } });
        }
    }
    throw new Error('Неожиданный запрос ' + url);
};

const env = { BOT_TOKEN: 'TEST', GITHUB_TOKEN: 'TEST', ADMIN_IDS: '111', WEBHOOK_SECRET: 's', DATA_OWNER: 'o', DATA_REPO: 'r', DATA_BRANCH: 'data', DB };
const ADMIN = { id: 111, first_name: 'Бектур', last_name: 'Н.' }, EMP = { id: 222, first_name: 'Айбек' };
let upd = 1;
const say = async (from, text) => { sent.length = 0; await new Bot(env, fonts).handle({ update_id: upd++, message: { message_id: upd, from, chat: { id: from.id, type: 'private' }, text } }); return [...sent]; };
const tap = async (from, data) => { sent.length = 0; await new Bot(env, fonts).handle({ update_id: upd++, callback_query: { id: 'q' + upd, from, data, message: { message_id: 50, chat: { id: from.id } } } }); return [...sent]; };
const last = (arr) => arr.filter(x => x.method !== 'answerCallbackQuery').pop() || {};
const txt = (arr) => (last(arr).body || {}).text || (last(arr).body || {}).caption || '';
const kb = (arr) => { const b = last(arr).body || {}; const m = b.reply_markup; return (m && m.inline_keyboard || []).flat().map(x => x.text + ' → ' + x.callback_data); };
const db = () => JSON.parse(gh.text);
const results = []; const check = (name, ok, info = '') => { results.push([ok ? 'PASS' : 'FAIL', name, info]); };

// ---- Сценарии ----
let r;
r = await say(EMP, '/start');
check('Сотрудник без доступа получает отказ и ID', /нет доступа/.test(txt(r)));
check('Админу пришёл запрос с кнопкой', r.some(x => x.body.chat_id == 111 && /Запрос доступа/.test(x.body.text || '')));
await tap(ADMIN, 'ua:222');
r = await say(EMP, '/start');
check('После одобрения сотрудник видит меню', /Выберите действие/.test(txt(r)));

// Счёт на оплату
const before = db().trade.docs.length;
r = await say(ADMIN, '📄 Новый документ'); check('Меню новых документов', kb(r).some(x => /nd:invoice/.test(x)));
r = await tap(ADMIN, 'nd:invoice'); check('Выбор контрагента: частые', kb(r).length > 2, kb(r).slice(0, 3).join(' | '));
r = await say(ADMIN, 'премиум'); check('Поиск контрагента по части названия', kb(r).some(x => /Премиум Хоум/.test(x)), kb(r).join(' | '));
const premium = db().trade.contractors.find(c => /Премиум Хоум/.test(c.name)).id;
r = await tap(ADMIN, 'c:' + premium); check('После контрагента — выбор позиции', /Выберите товар/.test(txt(r)));
r = await say(ADMIN, 'газоблок 20'); check('Поиск позиции', kb(r).some(x => /n:n3/.test(x)), kb(r).join(' | '));
r = await tap(ADMIN, 'n:n3'); check('Показан остаток при выборе товара', /Остаток на складе/.test(txt(r)), txt(r).split('\n')[1]);
r = await say(ADMIN, '150'); check('Предложена последняя цена', kb(r).some(x => /pk:/.test(x)), kb(r).join(' | '));
r = await say(ADMIN, '240'); check('Корзина с итогом', /Итого: 36 000,00/.test(txt(r)), txt(r).replace(/\n/g, ' / '));
r = await say(ADMIN, 'клей'); r = await tap(ADMIN, 'n:n4'); r = await say(ADMIN, '25,5'); r = await say(ADMIN, '100');
check('Вторая позиция с дробным количеством', /2\. Клей/.test(txt(r)) && /38 550,00/.test(txt(r)), txt(r).replace(/\n/g, ' / '));
r = await tap(ADMIN, 'gen');
const inv = db().trade.docs.find(d => d.source === 'telegram' && d.type === 'customer_invoice');
check('Счёт сохранён в базу сайта', !!inv && db().trade.docs.length === before + 1, inv && inv.number + ' ' + inv.total);
check('PDF счёта отправлен', r.some(x => x.method === 'sendDocument' && /Счёт_на_оплату/.test(x.body.file)), (r.find(x => x.method === 'sendDocument') || {}).body?.file);
check('Под PDF кнопки «Накладная/Акт по счёту»', kb(r).some(x => /bs:.*:waybill/.test(x)), kb(r).join(' | '));

// Накладная по счёту + счёт-фактура
r = await tap(ADMIN, `bs:${inv.id}:waybill`);
const sale = db().trade.docs.find(d => d.basis === inv.id && d.type === 'sale');
check('Накладная по счёту создана и проведена', sale && sale.status === 'posted', sale && sale.number + ' ' + sale.status);
check('PDF накладной', r.some(x => x.method === 'sendDocument' && /Накладная_/.test(x.body.file)));
r = await tap(ADMIN, `bs:${inv.id}:waybill`);
check('Повторное нажатие не создаёт дубль', db().trade.docs.filter(d => d.basis === inv.id).length === 1 && /уже есть/.test(r.map(x => x.body.text || '').join(' ')));
const sfBefore = db().trade.sfCounter.out;
r = await tap(ADMIN, `sf:${sale.id}`);
const saleSf = db().trade.docs.find(d => d.id === sale.id);
check('Счёт-фактура выписан, номер из счётчика сайта', saleSf.sf && saleSf.sf.number === String(sfBefore + 1), JSON.stringify(saleSf.sf));
check('PDF счёт-фактуры', r.some(x => x.method === 'sendDocument' && /Счёт_фактура_/.test(x.body.file)));
r = await tap(ADMIN, `pdf:${sale.id}:transfer`);
check('Акт приёма-передачи по той же накладной', r.some(x => x.method === 'sendDocument' && /Акт_приёма_передачи/.test(x.body.file)));

// Акт выполненных работ: новый контрагент и новая услуга
r = await say(EMP, '📄 Новый документ'); r = await tap(EMP, 'nd:works');
r = await say(EMP, 'Тестовый Заказчик Плюс'); check('Не найден — предлагает создать', kb(r).some(x => /cn:s/.test(x)));
r = await tap(EMP, 'cn:s'); r = await say(EMP, '12345678901234');
check('Новый контрагент создан на сайте с ИНН', db().trade.contractors.some(c => c.name === 'Тестовый Заказчик Плюс' && c.inn === '12345678901234'));
r = await say(EMP, 'Доставка манипулятором'); r = await tap(EMP, 'nn:s'); r = await tap(EMP, 'nk:Услуга'); r = await tap(EMP, 'nu:усл');
check('Новая услуга в номенклатуре сайта', db().trade.nomenclature.some(n => n.name === 'Доставка манипулятором' && n.kind === 'Услуга'));
r = await say(EMP, '2'); r = await say(EMP, '7500'); r = await tap(EMP, 'gen');
const works = db().trade.docs.filter(d => d.source === 'telegram' && (d.opKind || '').startsWith('Услуги')).pop();
check('Акт работ: строки в «Услугах», сотрудник в истории', works && works.services.length === 1 && works.total === 15000 && /Айбек/.test(works.history[0].user), works && works.number);
check('PDF акта работ', r.some(x => x.method === 'sendDocument' && /Акт_выполненных_работ/.test(x.body.file)));

// Нехватка остатка
r = await say(ADMIN, '📄 Новый документ'); r = await tap(ADMIN, 'nd:waybill'); r = await tap(ADMIN, 'c:' + premium);
r = await tap(ADMIN, 'n:n2'); r = await say(ADMIN, '999999'); r = await say(ADMIN, '100'); r = await tap(ADMIN, 'gen');
check('Нехватка остатка — предупреждение', /Не хватает остатка/.test(txt(r)), txt(r).split('\n').slice(0, 2).join(' / '));
const n1 = db().trade.docs.length;
r = await tap(ADMIN, 'gen:draft');
const draft = db().trade.docs.filter(d => d.source === 'telegram').pop();
check('Сохранено черновиком (склад не тронут)', db().trade.docs.length === n1 + 1 && draft.status === 'draft');

// Конфликт записи с сайтом
gh.conflictOnce = true;
r = await say(ADMIN, '📄 Новый документ'); r = await tap(ADMIN, 'nd:invoice'); r = await tap(ADMIN, 'c:' + premium); r = await tap(ADMIN, 'n:n1'); r = await say(ADMIN, '10'); r = await say(ADMIN, '120'); r = await tap(ADMIN, 'gen');
check('Конфликт с сайтом: правка сайта сохранена и счёт записан', db().trade.docs.some(d => d.id === 'SITE_EDIT') && db().trade.docs.filter(d => d.type === 'customer_invoice' && d.source === 'telegram').length === 2);

// Справки
r = await say(ADMIN, '📦 Остатки'); r = await tap(ADMIN, 'st:Продукция'); check('Остатки продукции', /Газоблок/.test(txt(r)), txt(r).split('\n').slice(2, 5).join(' / '));
r = await say(ADMIN, '💰 Долги'); check('Итоги долгов', /Нам должны: .*сом/.test(txt(r)), txt(r).replace(/\n/g, ' / '));
r = await tap(ADMIN, 'dbt:owe'); check('Список должников', /Премиум Хоум/.test(txt(r)), txt(r).split('\n').slice(2, 4).join(' / '));
r = await tap(ADMIN, 'cc:' + premium); check('Карточка контрагента с долгом и документами', /Должен нам/.test(txt(r)) && /Последние документы/.test(txt(r)), txt(r).split('\n').slice(0, 3).join(' / '));
r = await say(ADMIN, 'цемент'); check('Свободный поиск показывает остатки', /Цемент/.test(txt(r)), txt(r).split('\n').slice(0, 3).join(' / '));
r = await say(ADMIN, '🗂 Документы'); check('Список документов', kb(r).some(x => /dc:/.test(x)));
r = await tap(ADMIN, 'nd:sf'); r = await tap(ADMIN, 'c:' + premium); check('СФ: выбор накладной контрагента', kb(r).some(x => /СФ|sf:/.test(x)), kb(r).slice(0, 2).join(' | '));
r = await tap(EMP, 'users'); check('Сотрудник не видит управление доступом', !r.some(x => /Сотрудники с доступом/.test(x.body.text || '')));

fs.writeFileSync(outDir + '/db_after_bot.json', gh.text);
results.forEach(([s, n, i]) => console.log(s, n, i ? '— ' + i : ''));
console.log(`\n${results.filter(r => r[0] === 'PASS').length}/${results.length} пройдено, записей в GitHub: ${gh.puts}`);
