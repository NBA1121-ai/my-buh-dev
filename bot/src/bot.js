// Логика Telegram-бота EsepOnline
import * as L from './logic.js';
import { renderPdf, FORM_NAMES } from './pdf.js';
import { DataStore } from './github.js';

const MENU = {
    newdoc: '📄 Новый документ', docs: '🗂 Документы',
    stock: '📦 Остатки', debts: '💰 Долги',
    contractors: '👥 Контрагенты', more: '⚙️ Ещё',
};
const MAIN_KB = { keyboard: [[MENU.newdoc, MENU.docs], [MENU.stock, MENU.debts], [MENU.contractors, MENU.more]], resize_keyboard: true, is_persistent: true };
const PAGE = 10;

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const btn = (text, data) => ({ text, callback_data: data });
const rows2 = (btns) => { const out = []; for (let i = 0; i < btns.length; i += 2) out.push(btns.slice(i, i + 2)); return out; };
const short = (s, n = 30) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const vatLabel = (v, mode) => !(Number(v) >= 0) ? 'Без НДС' : `НДС ${v}% ${mode === 'in' ? 'в т.ч.' : 'сверху'}`;
const parseNum = (t) => { const v = Number(String(t).replace(/\s/g, '').replace(',', '.')); return isFinite(v) ? v : NaN; };

export class Bot {
    constructor(env, fonts) {
        this.env = env; this.fonts = fonts; this.store = new DataStore(env);
        this.admins = String(env.ADMIN_IDS || '').split(/[,\s]+/).filter(Boolean);
    }

    // ---------- Telegram API ----------
    async tg(method, payload) {
        const res = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const j = await res.json().catch(() => ({}));
        if (!j.ok && !/message is not modified/.test(j.description || '')) console.log('TG error', method, j.description);
        return j;
    }
    async send(chat, text, kb) { return this.tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb }); }
    // В ответ на кнопку — редактируем сообщение с кнопками, иначе отправляем новое
    async reply(ctx, text, inline) {
        const kb = inline ? { inline_keyboard: inline } : undefined;
        if (ctx.cbMsg) {
            const r = await this.tg('editMessageText', { chat_id: ctx.chat, message_id: ctx.cbMsg, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb });
            if (r.ok || /not modified/.test(r.description || '')) return r;
        }
        return this.send(ctx.chat, text, kb);
    }
    async sendPdf(chat, bytes, filename, caption, inline) {
        const fd = new FormData();
        fd.append('chat_id', String(chat));
        fd.append('document', new Blob([bytes], { type: 'application/pdf' }), filename);
        fd.append('caption', caption); fd.append('parse_mode', 'HTML');
        if (inline) fd.append('reply_markup', JSON.stringify({ inline_keyboard: inline }));
        const res = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
        return res.json().catch(() => ({}));
    }

    // ---------- Хранилище: сессии и сотрудники (Cloudflare D1) ----------
    async initDb() {
        if (Bot._dbReady) return;
        await this.env.DB.batch([
            this.env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (uid TEXT PRIMARY KEY, data TEXT, updated INTEGER)'),
            this.env.DB.prepare('CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, name TEXT, role TEXT, added INTEGER)'),
        ]);
        Bot._dbReady = true;
    }
    async getSession(uid) {
        const r = await this.env.DB.prepare('SELECT data FROM sessions WHERE uid = ?').bind(uid).first();
        return r ? JSON.parse(r.data) : {};
    }
    async setSession(uid, s) { await this.env.DB.prepare('INSERT OR REPLACE INTO sessions (uid, data, updated) VALUES (?, ?, ?)').bind(uid, JSON.stringify(s), Date.now()).run(); }
    async getUser(uid) { return await this.env.DB.prepare('SELECT * FROM users WHERE uid = ?').bind(uid).first(); }
    async setUser(uid, name, role) { await this.env.DB.prepare('INSERT OR REPLACE INTO users (uid, name, role, added) VALUES (?, ?, ?, ?)').bind(uid, name, role, Date.now()).run(); }
    async listUsers() { const r = await this.env.DB.prepare("SELECT * FROM users WHERE role != 'pending' ORDER BY added").all(); return r.results || []; }

    // ---------- Вход ----------
    async handle(update) {
        await this.initDb();
        const msg = update.message, cb = update.callback_query;
        const from = (msg || cb || {}).from; if (!from) return;
        const chat = msg ? msg.chat.id : cb.message.chat.id;
        if (msg && msg.chat.type !== 'private') return; // только личные сообщения
        const uid = String(from.id);
        const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || uid;
        const ctx = { uid, chat, name, cbMsg: cb ? cb.message.message_id : null, isAdmin: this.admins.includes(uid) };
        if (cb) this.tg('answerCallbackQuery', { callback_query_id: cb.id });

        // Доступ
        if (!ctx.isAdmin) {
            const u = await this.getUser(uid);
            if (!u || u.role !== 'user') {
                if (cb && /^u[ar]:/.test(cb.data)) return;
                return this.noAccess(ctx, u, from);
            }
        }
        const s = await this.getSession(uid);
        ctx.s = s;
        try {
            if (cb) await this.onCallback(ctx, cb.data);
            else if (msg.text) await this.onText(ctx, msg.text.trim());
        } catch (e) {
            console.log('Error', e && e.stack || e);
            await this.send(chat, '⚠️ Ошибка: ' + esc(e.message || e) + '\nПопробуйте ещё раз.', MAIN_KB);
        }
        await this.setSession(uid, ctx.s);
    }

    async noAccess(ctx, u, from) {
        if (!u) {
            await this.setUser(ctx.uid, ctx.name, 'pending');
            for (const a of this.admins) {
                await this.send(a, `🔔 Запрос доступа к боту\n<b>${esc(ctx.name)}</b>${from.username ? ' (@' + esc(from.username) + ')' : ''}\nID: <code>${ctx.uid}</code>`, { inline_keyboard: [[btn('✅ Разрешить', 'ua:' + ctx.uid), btn('✖ Отклонить', 'ur:' + ctx.uid)]] });
            }
        }
        await this.send(ctx.chat, `Здравствуйте! У вас пока нет доступа к боту EsepOnline.\nЗапрос отправлен администратору. Ваш ID: <code>${ctx.uid}</code>`, { remove_keyboard: true });
    }

    // ---------- Текст ----------
    async onText(ctx, text) {
        const s = ctx.s;
        if (text === '/start' || text === '/menu') { ctx.s = {}; return this.send(ctx.chat, `Здравствуйте, ${esc(ctx.name)}! Выберите действие в меню ниже.\nМожно просто написать название товара или контрагента — покажу остаток и долг.`, MAIN_KB); }
        if (text === '/id') return this.send(ctx.chat, `Ваш ID: <code>${ctx.uid}</code>`, MAIN_KB);
        if (text === '/cancel' || text === 'Отмена') { ctx.s = {}; return this.send(ctx.chat, 'Отменено.', MAIN_KB); }
        switch (text) {
            case MENU.newdoc: ctx.s = {}; return this.newDocMenu(ctx);
            case MENU.docs: return this.docsList(ctx, 0);
            case MENU.stock: return this.stockMenu(ctx);
            case MENU.debts: return this.debtsMenu(ctx);
            case MENU.contractors: ctx.s.await = 'csearch'; return this.send(ctx.chat, '👥 Напишите часть названия контрагента — покажу карточку, долг и последние документы.', MAIN_KB);
            case MENU.more: return this.moreMenu(ctx);
        }
        // Ввод в мастере
        const w = s.wiz;
        switch (s.await) {
            case 'contractor': return this.wizContractorSearch(ctx, text);
            case 'nom': return this.wizNomSearch(ctx, text);
            case 'qty': {
                const v = parseNum(text); if (!(v > 0)) return this.send(ctx.chat, 'Введите количество числом, например: 150 или 12,5');
                w.cur.qty = v; return this.wizAskPrice(ctx);
            }
            case 'price': {
                const v = parseNum(text); if (!(v >= 0)) return this.send(ctx.chat, 'Введите цену числом, например: 240');
                w.cur.price = v; return this.wizAddRow(ctx);
            }
            case 'newnom_name': w.newNom = { name: text }; s.await = null; return this.send(ctx.chat, `Новая позиция: <b>${esc(text)}</b>\nЧто это?`, { inline_keyboard: [[btn('Товар', 'nk:Товар'), btn('Продукция', 'nk:Продукция'), btn('Услуга', 'nk:Услуга')], [btn('✖ Отмена', 'cart')]] });
            case 'newnom_unit': w.newNom.unit = text.slice(0, 10); return this.wizCreateNom(ctx);
            case 'newc_name': w.newC = { name: text }; s.await = 'newc_inn'; return this.send(ctx.chat, `Новый контрагент: <b>${esc(text)}</b>\nНапишите ИНН (14 цифр) или нажмите «Без ИНН».`, { inline_keyboard: [[btn('Без ИНН', 'cninn:skip')]] });
            case 'newc_inn': if (!/^\d{10,14}$/.test(text.replace(/\s/g, ''))) return this.send(ctx.chat, 'ИНН — 10–14 цифр. Напишите ещё раз или нажмите «Без ИНН».', { inline_keyboard: [[btn('Без ИНН', 'cninn:skip')]] });
                w.newC.inn = text.replace(/\s/g, ''); return this.wizCreateContractor(ctx);
            case 'date': {
                const m = text.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/);
                if (!m) return this.send(ctx.chat, 'Дата в формате ДД.ММ.ГГГГ, например 25.11.2026');
                const y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : L.today().slice(0, 4);
                w.date = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; s.await = 'nom'; return this.wizCart(ctx);
            }
            case 'csearch': return this.contractorSearch(ctx, text);
        }
        // Свободный текст — поиск по товарам и контрагентам
        return this.globalSearch(ctx, text);
    }

    // ---------- Кнопки ----------
    async onCallback(ctx, data) {
        const [cmd, a, b] = data.split(':');
        const w = ctx.s.wiz;
        switch (cmd) {
            case 'menu': ctx.s = {}; return this.reply(ctx, 'Главное меню — кнопки внизу экрана.');
            case 'nd': return a ? this.wizStart(ctx, a) : this.newDocMenu(ctx);
            case 'c': return this.wizSetContractor(ctx, a);
            case 'cs': ctx.s.await = 'contractor'; return this.reply(ctx, '🔍 Напишите часть названия контрагента.');
            case 'cn': if (!w) return;
                if (a === 's' && w.lastSearch) { w.newC = { name: w.lastSearch }; ctx.s.await = 'newc_inn'; return this.reply(ctx, `Новый контрагент: <b>${esc(w.lastSearch)}</b>\nНапишите ИНН (14 цифр) или нажмите «Без ИНН».`, [[btn('Без ИНН', 'cninn:skip')]]); }
                ctx.s.await = 'newc_name'; return this.reply(ctx, '➕ Напишите название нового контрагента, например: ОсОО «Строй Сервис».');
            case 'cninn': if (!w || !w.newC) return; return this.wizCreateContractor(ctx);
            case 'n': return this.wizSetNom(ctx, a);
            case 'nn': if (!w) return;
                if (a === 's' && w.lastNomSearch) { w.newNom = { name: w.lastNomSearch }; ctx.s.await = null; return this.reply(ctx, `Новая позиция: <b>${esc(w.lastNomSearch)}</b>\nЧто это?`, [[btn('Товар', 'nk:Товар'), btn('Продукция', 'nk:Продукция'), btn('Услуга', 'nk:Услуга')], [btn('✖ Отмена', 'cart')]]); }
                ctx.s.await = 'newnom_name'; return this.reply(ctx, '➕ Напишите название нового товара или услуги.');
            case 'nk': if (!w || !w.newNom) return; w.newNom.kind = a; return this.reply(ctx, `Единица измерения для «${esc(w.newNom.name)}»?`, [...rows2(['шт', 'кг', 'тонна', 'мешок', 'м', 'м²', 'м³', 'усл'].map(u => btn(u, 'nu:' + u))), [btn('Другая — напишу', 'nu:')]]);
            case 'nu': if (!w || !w.newNom) return; if (!a) { ctx.s.await = 'newnom_unit'; return this.reply(ctx, 'Напишите единицу измерения.'); } w.newNom.unit = a; return this.wizCreateNom(ctx);
            case 'pk': if (!w || !w.cur) return; w.cur.price = Number(a); return this.wizAddRow(ctx);
            case 'cart': if (!w) return this.newDocMenu(ctx); ctx.s.await = 'nom'; return this.wizCart(ctx);
            case 'add': if (!w) return; return this.wizAskNom(ctx);
            case 'dl': if (!w) return; return this.reply(ctx, 'Какую позицию убрать?', [...w.rows.map((r, i) => [btn(`✖ ${i + 1}. ${short(r.name, 28)}`, 'del:' + i)]), [btn('← Назад', 'cart')]]);
            case 'del': if (!w) return; w.rows.splice(Number(a), 1); return this.wizCart(ctx);
            case 'vat': if (!w) return; if (a) { w.vat = Number(a); w.vatMode = b || 'in'; return this.wizCart(ctx); }
                return this.reply(ctx, 'НДС в документе:', [[btn('Без НДС', 'vat:-1:in')], [btn('НДС 12% в т.ч.', 'vat:12:in'), btn('НДС 12% сверху', 'vat:12:out')], [btn('← Назад', 'cart')]]);
            case 'dt': if (!w) return; if (a === 't') { w.date = L.today(); return this.wizCart(ctx); }
                if (a === 'y') { const d = new Date(Date.now() + 6 * 3600e3 - 864e5); w.date = d.toISOString().slice(0, 10); return this.wizCart(ctx); }
                if (a === 'in') { ctx.s.await = 'date'; return this.reply(ctx, 'Напишите дату в формате ДД.ММ.ГГГГ'); }
                return this.reply(ctx, 'Дата документа:', [[btn('Сегодня', 'dt:t'), btn('Вчера', 'dt:y')], [btn('Ввести дату', 'dt:in')], [btn('← Назад', 'cart')]]);
            case 'gen': return this.wizGenerate(ctx, a === 'draft');
            case 'x': ctx.s = {}; return this.reply(ctx, '✖ Документ отменён.');
            case 'pdf': return this.sendDocPdf(ctx, a, b);
            case 'bs': return this.createOnBasis(ctx, a, b);
            case 'sf': return this.issueSF(ctx, a);
            case 'sfc': return this.sfChooseDoc(ctx, a);
            case 'st': return this.stockList(ctx, a, Number(b) || 0);
            case 'stm': return this.stockMenu(ctx);
            case 'dbtm': return this.debtsMenu(ctx);
            case 'dbt': return this.debtsList(ctx, a, Number(b) || 0);
            case 'cc': return this.contractorCard(ctx, a);
            case 'ncd': return this.wizStart(ctx, a, b); // новый документ для контрагента
            case 'docs': return this.docsList(ctx, Number(a) || 0);
            case 'dc': return this.docCard(ctx, a);
            case 'users': return this.usersMenu(ctx);
            case 'ua': case 'ur': return this.approveUser(ctx, a, cmd === 'ua');
            case 'help': return this.reply(ctx, this.helpText());
        }
    }

    // ---------- Новый документ: мастер ----------
    async newDocMenu(ctx) {
        return this.reply(ctx, '📄 Какой документ создать?', [
            [btn('🧾 Счёт на оплату', 'nd:invoice')],
            [btn('🚚 Накладная', 'nd:waybill'), btn('📦 Акт приёма-передачи', 'nd:transfer')],
            [btn('🛠 Акт выполненных работ', 'nd:works')],
            [btn('📑 Счёт-фактура (к накладной/акту)', 'nd:sf')],
        ]);
    }
    async wizStart(ctx, kind, contractorId) {
        const { db } = await this.store.load(15000);
        if (kind === 'sf') {
            ctx.s = { wiz: { kind: 'sf' }, await: 'contractor' };
            if (contractorId) return this.sfChooseDoc(ctx, contractorId);
        } else {
            ctx.s = { wiz: { kind, rows: [], vat: L.defaultVat(db), vatMode: 'in', date: L.today() }, await: 'contractor' };
            if (contractorId) return this.wizSetContractor(ctx, contractorId);
        }
        const k = ctx.s.wiz.kind === 'sf' ? { label: 'Счёт-фактура', icon: '📑' } : L.BOT_DOCS[kind];
        const freq = L.frequentContractors(db, 8);
        return this.reply(ctx, `${k.icon} <b>${k.label}</b>\nВыберите контрагента или <b>напишите часть названия</b>:`, [
            ...rows2(freq.map(c => btn(short(c.name, 26), 'c:' + c.id))),
            [btn('➕ Новый контрагент', 'cn'), btn('✖ Отмена', 'x')],
        ]);
    }
    async wizContractorSearch(ctx, text) {
        const { db } = await this.store.load(15000);
        const found = L.search(db.trade.contractors || [], text).slice(0, 10);
        if (ctx.s.wiz) ctx.s.wiz.lastSearch = text;
        if (!found.length) return this.send(ctx.chat, `Контрагент «${esc(text)}» не найден. Напишите иначе или создайте нового.`, { inline_keyboard: [[btn('➕ Создать «' + short(text, 20) + '»', 'cn:s')], [btn('✖ Отмена', 'x')]] });
        return this.send(ctx.chat, 'Выберите контрагента:', { inline_keyboard: [...found.map(c => [btn(short(c.name, 40), 'c:' + c.id)]), [btn('➕ Новый контрагент', 'cn')]] });
    }
    async wizCreateContractor(ctx) {
        const w = ctx.s.wiz, nc = w.newC; ctx.s.await = null;
        const id = await this.store.update(db => {
            const ex = (db.trade.contractors || []).find(c => L.normName(c.name) === L.normName(nc.name));
            if (ex) return ex.id;
            const c = { id: 'tg' + L.uid().slice(1), name: nc.name, full: nc.name, inn: nc.inn || '', kind: /^(ОсОО|ОАО|ЗАО|ООО|ОДО|ГП|МП)/i.test(nc.name) ? 'Юридическое лицо' : (/^ИП/i.test(nc.name) ? 'Индивидуальный предприниматель' : 'Физическое лицо'), address: '', phone: '', account: '', bank: '' };
            db.trade.contractors.push(c); return c.id;
        }, `Telegram-бот: новый контрагент ${nc.name} (${ctx.name})`);
        delete w.newC;
        await this.send(ctx.chat, `✅ Контрагент «${esc(nc.name)}» добавлен на сайт.`);
        ctx.cbMsg = null;
        return w.kind === 'sf' ? this.sfChooseDoc(ctx, id) : this.wizSetContractor(ctx, id);
    }
    async wizSetContractor(ctx, id) {
        const w = ctx.s.wiz; if (!w) return;
        if (w.kind === 'sf') return this.sfChooseDoc(ctx, id);
        const { db } = await this.store.load(15000);
        const c = L.contractor(db, id); if (!c) return this.reply(ctx, 'Контрагент не найден.');
        w.contractor = id; w.cname = c.name;
        return this.wizAskNom(ctx);
    }
    async wizAskNom(ctx) {
        const w = ctx.s.wiz; ctx.s.await = 'nom';
        const { db } = await this.store.load(15000);
        const k = L.BOT_DOCS[w.kind];
        const freq = L.frequentNoms(db, k.tab, 8);
        return this.reply(ctx, `${k.icon} <b>${k.label}</b> · ${esc(w.cname)}\nВыберите ${k.tab === 'services' ? 'услугу' : 'товар'} или <b>напишите часть названия</b>:`, [
            ...rows2(freq.map(n => btn(short(n.name, 26), 'n:' + n.id))),
            [btn('➕ Новый товар / услуга', 'nn')],
            ...(w.rows.length ? [[btn('← К документу (' + w.rows.length + ' поз.)', 'cart')]] : [[btn('✖ Отмена', 'x')]]),
        ]);
    }
    async wizNomSearch(ctx, text) {
        const { db } = await this.store.load(15000);
        const found = L.search(db.trade.nomenclature || [], text).slice(0, 10);
        if (ctx.s.wiz) ctx.s.wiz.lastNomSearch = text;
        if (!found.length) return this.send(ctx.chat, `«${esc(text)}» не найдено в номенклатуре.`, { inline_keyboard: [[btn('➕ Создать «' + short(text, 22) + '»', 'nn:s')], [btn('← Назад', 'add')]] });
        return this.send(ctx.chat, 'Выберите позицию:', { inline_keyboard: [...found.map(n => [btn(short(n.name, 34) + (n.unit ? ', ' + n.unit : ''), 'n:' + n.id)]), [btn('➕ Новая позиция', 'nn')]] });
    }
    async wizCreateNom(ctx) {
        const w = ctx.s.wiz, nn = w.newNom; ctx.s.await = null;
        const vat = w.vat;
        const id = await this.store.update(db => {
            const ex = (db.trade.nomenclature || []).find(n => L.normName(n.name) === L.normName(nn.name));
            if (ex) return ex.id;
            const n = { id: 'tg' + L.uid().slice(1), name: nn.name, article: '', kind: nn.kind, unit: nn.unit || (nn.kind === 'Услуга' ? 'усл' : 'шт'), vat: Number(vat) >= 0 ? Number(vat) : -1, price: 0, cost: 0, account: nn.kind === 'Услуга' ? '' : (nn.kind === 'Продукция' ? '43' : '41.01'), country: '', nomGroup: '' };
            db.trade.nomenclature.push(n); return n.id;
        }, `Telegram-бот: новая позиция ${nn.name} (${ctx.name})`);
        delete w.newNom;
        await this.send(ctx.chat, `✅ «${esc(nn.name)}» добавлено в номенклатуру сайта.`);
        ctx.cbMsg = null;
        return this.wizSetNom(ctx, id);
    }
    async wizSetNom(ctx, id) {
        const w = ctx.s.wiz; if (!w) return;
        const { db } = await this.store.load(15000);
        const n = L.nom(db, id); if (!n) return this.reply(ctx, 'Позиция не найдена.');
        w.cur = { nom: id, name: n.name.trim(), unit: n.unit || '' };
        ctx.s.await = 'qty';
        const st = n.kind === 'Услуга' ? '' : `\nОстаток на складе: <b>${L.formatQty(L.stockQty(db, id, 'w1'))} ${esc(n.unit || '')}</b>`;
        return this.reply(ctx, `<b>${esc(n.name)}</b>${st}\nНапишите количество${n.unit ? ' (' + esc(n.unit) + ')' : ''}:`, [[btn('← Назад', w.rows.length ? 'cart' : 'add')]]);
    }
    async wizAskPrice(ctx) {
        const w = ctx.s.wiz; ctx.s.await = 'price';
        const { db } = await this.store.load(15000);
        const lp = Math.round(L.lastPrice(db, w.cur.nom, w.contractor) * 100) / 100;
        const kb = lp > 0 ? [[btn(`Цена ${L.formatAmount(lp)}`, 'pk:' + lp)]] : [];
        return this.send(ctx.chat, `${esc(w.cur.name)} — ${L.formatQty(w.cur.qty)} ${esc(w.cur.unit)}\nНапишите цену за единицу${lp > 0 ? ' или нажмите последнюю цену' : ''}:`, kb.length ? { inline_keyboard: kb } : undefined);
    }
    async wizAddRow(ctx) {
        const w = ctx.s.wiz;
        w.rows.push({ nom: w.cur.nom, name: w.cur.name, unit: w.cur.unit, qty: w.cur.qty, price: w.cur.price });
        delete w.cur; ctx.s.await = 'nom'; ctx.cbMsg = null;
        return this.wizCart(ctx);
    }
    async wizCart(ctx) {
        const w = ctx.s.wiz; if (!w) return;
        const k = L.BOT_DOCS[w.kind];
        const d = L.calcDoc({ vatMode: w.vatMode, goods: w.rows.map(r => ({ qty: r.qty, price: r.price, vat: w.vat })) });
        const lines = w.rows.map((r, i) => `${i + 1}. ${esc(r.name)}\n    ${L.formatQty(r.qty)} ${esc(r.unit)} × ${L.formatAmount(r.price)} = <b>${L.formatAmount(r.qty * r.price)}</b>`);
        const txt = `${k.icon} <b>${k.label}</b>\nКонтрагент: <b>${esc(w.cname)}</b>\nДата: ${L.formatDate(w.date)} · ${vatLabel(w.vat, w.vatMode)}\n\n${lines.join('\n') || 'Позиций пока нет.'}\n\n<b>Итого: ${L.formatAmount(d.total)} сом</b>${d.vatTotal ? ' (НДС ' + L.formatAmount(d.vatTotal) + ')' : ''}\n\nМожно сразу написать название следующей позиции.`;
        ctx.s.await = 'nom';
        return this.reply(ctx, txt, [
            [btn('➕ Добавить позицию', 'add'), ...(w.rows.length ? [btn('🗑 Убрать', 'dl')] : [])],
            [btn('⚙️ ' + vatLabel(w.vat, w.vatMode), 'vat'), btn('📅 ' + L.formatDate(w.date), 'dt')],
            ...(w.rows.length ? [[btn('✅ Сформировать PDF', 'gen')]] : []),
            [btn('✖ Отменить документ', 'x')],
        ]);
    }
    async wizGenerate(ctx, asDraft) {
        const w = ctx.s.wiz; if (!w || !w.rows.length) return;
        if (w.saving) return; w.saving = true;
        const k = L.BOT_DOCS[w.kind];
        let short_ = null;
        const doc = await this.store.update(db => {
            const d = L.makeDoc(db, k.type, {
                contractor: w.contractor, date: w.date, vatMode: w.vatMode, vat: w.vat, opKind: k.opKind || '', tab: k.tab, user: ctx.name,
                rows: w.rows.map(r => ({ nom: r.nom, qty: r.qty, price: r.price })), status: 'posted',
                payUntil: '',
            });
            d.form = k.form; // какой печатной формой выдан документ
            if (k.type === 'sale') {
                const sh = L.shortages(db, d);
                if (sh.length && !asDraft) { short_ = sh; return false; }
                if (sh.length) { d.status = 'draft'; d.history[0].action += ' — не проведён: не хватает остатка'; }
            }
            db.trade.docs.push(d);
            return d;
        }, `Telegram-бот: ${k.label} (${ctx.name})`);
        w.saving = false;
        if (doc === false && short_) {
            const { db } = await this.store.load(15000);
            const txt = '⚠️ Не хватает остатка на складе:\n' + short_.map(x => `• ${esc(L.nomName(db, x.nom))}: нужно ${L.formatQty(x.need)}, есть ${L.formatQty(x.have)}`).join('\n') + '\n\nМожно сохранить документ без проведения (на сайте он будет черновиком, склад не изменится) или вернуться и поправить количество.';
            return this.reply(ctx, txt, [[btn('💾 Сохранить без проведения', 'gen:draft')], [btn('← Изменить документ', 'cart')]]);
        }
        ctx.s = {};
        await this.reply(ctx, `✅ ${k.label} ${esc(doc.number)} сохранён на сайте${doc.status === 'draft' ? ' (черновик, не проведён)' : ''}. Формирую PDF…`);
        return this.sendDocPdf(ctx, doc.id, k.form);
    }

    // ---------- PDF и действия с документом ----------
    docForms(d) {
        if (d.type === 'customer_invoice') return ['invoice'];
        const isWorks = (d.opKind || '').startsWith('Услуги') || (!(d.goods || []).length && (d.services || []).length);
        const f = isWorks ? ['works'] : ['waybill', 'transfer'];
        if (d.sf) f.push('sf');
        return f;
    }
    docActions(d) {
        const out = [];
        if (d.type === 'customer_invoice') {
            const hasServices = (d.services || []).length && !(d.goods || []).length;
            out.push(hasServices ? [btn('🛠 Акт выполненных работ по счёту', 'bs:' + d.id + ':works')] : [btn('🚚 Накладная по счёту', 'bs:' + d.id + ':waybill'), btn('📦 Акт приёма-передачи', 'bs:' + d.id + ':transfer')]);
        } else if (d.type === 'sale') {
            const forms = this.docForms(d).filter(f => f !== d.form && f !== 'sf');
            if (forms.length) out.push(forms.map(f => btn('📄 ' + FORM_NAMES[f], 'pdf:' + d.id + ':' + f)));
            out.push([d.sf ? btn('📑 Счёт-фактура № ' + d.sf.number, 'pdf:' + d.id + ':sf') : btn('📑 Выписать счёт-фактуру', 'sf:' + d.id)]);
        }
        return out;
    }
    async sendDocPdf(ctx, docId, form) {
        const { db } = await this.store.load(15000);
        let d = L.docById(db, docId);
        if (!d) { const fresh = await this.store.load(0); d = L.docById(fresh.db, docId); if (!d) return this.send(ctx.chat, 'Документ не найден.'); }
        form = form || d.form || this.docForms(d)[0];
        const bytes = await renderPdf(db, d, form, this.fonts);
        const num = form === 'sf' && d.sf ? d.sf.number : d.number;
        const fname = `${FORM_NAMES[form].replace(/[ -]/g, '_')}_${num}.pdf`;
        const c = L.contractor(db, d.contractor) || {};
        const cap = `${FORM_NAMES[form]} № ${esc(num)} от ${L.formatDate(form === 'sf' && d.sf ? d.sf.date : d.date)}\n${esc(c.name || '')} · <b>${L.formatAmount(d.total)} сом</b>${d.status === 'draft' ? '\n⚠️ Не проведён (черновик)' : ''}\n\nПерешлите этот файл клиенту.`;
        return this.sendPdf(ctx.chat, bytes, fname, cap, this.docActions(d));
    }
    // Накладная / акт на основании счёта
    async createOnBasis(ctx, invId, kind, asDraft) {
        const k = L.BOT_DOCS[kind];
        const pre = await this.store.load(0);
        const inv = L.docById(pre.db, invId); if (!inv) return this.send(ctx.chat, 'Счёт не найден.');
        const exist = (pre.db.trade.docs || []).find(d => d.basis === invId && d.type === 'sale' && d.status !== 'deleted');
        if (exist) { await this.send(ctx.chat, `По этому счёту уже есть ${esc(exist.number)} от ${L.formatDate(exist.date)} — отправляю его.`); return this.sendDocPdf(ctx, exist.id, kind); }
        let short_ = null;
        const doc = await this.store.update(db => {
            const src = L.docById(db, invId);
            const rows = [...(src.goods || []), ...(src.services || [])].map(r => ({ nom: r.nom, qty: r.qty, price: r.price, vat: r.vat }));
            const d = L.makeDoc(db, 'sale', { contractor: src.contractor, date: L.today(), vatMode: src.vatMode, opKind: k.opKind, tab: k.tab, user: ctx.name, rows, basis: src.id, status: 'posted' });
            d.form = k.form;
            const sh = L.shortages(db, d);
            if (sh.length) { d.status = 'draft'; d.history[0].action += ' — не проведён: не хватает остатка'; short_ = sh; }
            db.trade.docs.push(d); return d;
        }, `Telegram-бот: ${k.label} по счёту ${inv.number} (${ctx.name})`);
        if (short_) await this.send(ctx.chat, '⚠️ Не хватает остатка — документ сохранён без проведения:\n' + short_.map(x => `• ${esc(L.nomName(pre.db, x.nom))}: нужно ${L.formatQty(x.need)}, есть ${L.formatQty(x.have)}`).join('\n'));
        return this.sendDocPdf(ctx, doc.id, k.form);
    }
    async sfChooseDoc(ctx, contractorId) {
        const { db } = await this.store.load(15000);
        const c = L.contractor(db, contractorId);
        const docs = (db.trade.docs || []).filter(d => d.type === 'sale' && d.contractor === contractorId && d.status !== 'deleted').slice(-10).reverse();
        ctx.s = {};
        if (!docs.length) return this.reply(ctx, `У «${esc(c ? c.name : '')}» нет накладных и актов. Сначала создайте накладную или акт.`);
        return this.reply(ctx, `📑 Счёт-фактура для <b>${esc(c.name)}</b>\nВыберите накладную или акт:`, docs.map(d => [btn(`${d.sf ? '✔ СФ ' + d.sf.number + ' · ' : ''}${d.number} от ${L.formatDate(d.date)} · ${L.formatAmount(d.total)}`, d.sf ? 'pdf:' + d.id + ':sf' : 'sf:' + d.id)]));
    }
    async issueSF(ctx, docId) {
        const d = await this.store.update(db => {
            const x = L.docById(db, docId); if (!x) return false;
            if (x.sf && x.sf.number) return x;
            db.trade.sfCounter = db.trade.sfCounter || { in: 0, out: 0 };
            db.trade.sfCounter.out = (Number(db.trade.sfCounter.out) || 0) + 1;
            x.sf = { number: String(db.trade.sfCounter.out), date: L.today(), code: '01' };
            x.history = x.history || []; x.history.push({ ts: new Date().toISOString(), user: ctx.name, action: 'Выписан счёт-фактура № ' + x.sf.number + ' (Telegram-бот)' });
            return x;
        }, `Telegram-бот: счёт-фактура (${ctx.name})`);
        if (!d) return this.send(ctx.chat, 'Документ не найден.');
        return this.sendDocPdf(ctx, docId, 'sf');
    }

    // ---------- Справки ----------
    async stockMenu(ctx) {
        return this.reply(ctx, '📦 <b>Остатки на складе</b>\nВыберите группу или напишите название товара:', [
            [btn('🏭 Продукция', 'st:Продукция'), btn('🧱 Материалы', 'st:Материал')],
            [btn('🛒 Товары', 'st:Товар'), btn('📋 Все', 'st:all')],
        ]);
    }
    async stockList(ctx, kind, page) {
        const { db } = await this.store.load(15000);
        const bal = L.stockBalances(db).filter(b => Math.abs(b.qty) > 1e-9);
        const whs = db.trade.warehouses || [];
        const items = bal.map(b => ({ b, n: L.nom(db, b.nom) })).filter(x => x.n && (kind === 'all' || x.n.kind === kind)).sort((x, y) => x.n.name.localeCompare(y.n.name, 'ru'));
        const pages = Math.max(1, Math.ceil(items.length / 25));
        const part = items.slice(page * 25, page * 25 + 25);
        const label = { all: 'Все', 'Продукция': 'Продукция', 'Материал': 'Материалы', 'Товар': 'Товары' }[kind] || kind;
        const txt = `📦 <b>Остатки · ${label}</b> на ${L.formatDate(L.today())}\n\n` + (part.map(x => `• ${esc(x.n.name.trim())}: <b>${L.formatQty(x.b.qty)}</b> ${esc(x.n.unit || '')}${whs.length > 1 && x.b.wh !== 'w1' ? ' <i>(' + esc((whs.find(w => w.id === x.b.wh) || {}).name || x.b.wh) + ')</i>' : ''}${x.b.qty < 0 ? ' ⚠️' : ''}`).join('\n') || 'Остатков нет.') + (pages > 1 ? `\n\nСтр. ${page + 1} из ${pages}` : '');
        const nav = [];
        if (page > 0) nav.push(btn('← Назад', `st:${kind}:${page - 1}`));
        if (page < pages - 1) nav.push(btn('Дальше →', `st:${kind}:${page + 1}`));
        return this.reply(ctx, txt, [...(nav.length ? [nav] : []), [btn('← Группы', 'stm')]]);
    }
    async debtsMenu(ctx) {
        const { db } = await this.store.load(15000);
        const { owe, weOwe } = L.allDebts(db);
        const sum = (l) => l.reduce((s, x) => s + x.sum, 0);
        return this.reply(ctx, `💰 <b>Взаиморасчёты</b> на ${L.formatDate(L.today())}\n\n📈 Нам должны: <b>${L.formatAmount(sum(owe))} сом</b> (${owe.length})\n📉 Мы должны: <b>${L.formatAmount(sum(weOwe))} сом</b> (${weOwe.length})`, [
            [btn('📈 Нам должны', 'dbt:owe'), btn('📉 Мы должны', 'dbt:we')],
        ]);
    }
    async debtsList(ctx, side, page) {
        const { db } = await this.store.load(15000);
        const list = L.allDebts(db)[side === 'owe' ? 'owe' : 'weOwe'];
        const pages = Math.max(1, Math.ceil(list.length / PAGE));
        const part = list.slice(page * PAGE, page * PAGE + PAGE);
        const total = list.reduce((s, x) => s + x.sum, 0);
        const txt = `${side === 'owe' ? '📈 <b>Нам должны</b>' : '📉 <b>Мы должны</b>'} · итого ${L.formatAmount(total)} сом\n\n` + (part.map((x, i) => `${page * PAGE + i + 1}. ${esc(x.c.name.trim())} — <b>${L.formatAmount(x.sum)}</b>`).join('\n') || 'Долгов нет.') + (pages > 1 ? `\n\nСтр. ${page + 1} из ${pages}` : '');
        const nav = [];
        if (page > 0) nav.push(btn('← Назад', `dbt:${side}:${page - 1}`));
        if (page < pages - 1) nav.push(btn('Дальше →', `dbt:${side}:${page + 1}`));
        return this.reply(ctx, txt, [...rows2(part.map((x, i) => btn(`${page * PAGE + i + 1}. ${short(x.c.name, 20)}`, 'cc:' + x.c.id))), ...(nav.length ? [nav] : []), [btn('← Итоги', 'dbtm')]]);
    }
    async contractorSearch(ctx, text) {
        const { db } = await this.store.load(15000);
        const found = L.search(db.trade.contractors || [], text).slice(0, 10);
        if (found.length === 1) { ctx.cbMsg = null; return this.contractorCard(ctx, found[0].id); }
        if (!found.length) return this.send(ctx.chat, `Контрагент «${esc(text)}» не найден.`);
        return this.send(ctx.chat, 'Найдено:', { inline_keyboard: found.map(c => [btn(short(c.name, 40), 'cc:' + c.id)]) });
    }
    async contractorCard(ctx, id) {
        const { db } = await this.store.load(15000);
        const c = L.contractor(db, id); if (!c) return this.reply(ctx, 'Контрагент не найден.');
        const s = L.contractorDebt(db, c, 'sale'), p = L.contractorDebt(db, c, 'purchase');
        const net = Math.round((s.debt - p.debt) * 100) / 100;
        const docs = (db.trade.docs || []).filter(d => d.contractor === id && ['customer_invoice', 'sale', 'purchase'].includes(d.type) && d.status !== 'deleted').slice(-5).reverse();
        const txt = `👤 <b>${esc(c.name.trim())}</b>\n${c.inn ? 'ИНН ' + esc(c.inn) + '\n' : ''}${c.phone ? 'Тел. ' + esc(c.phone) + '\n' : ''}\n` +
            (net > 0.004 ? `📈 Должен нам: <b>${L.formatAmount(net)} сом</b>` : net < -0.004 ? `📉 Мы должны: <b>${L.formatAmount(-net)} сом</b>` : '✅ Долгов нет') +
            (docs.length ? '\n\nПоследние документы:\n' + docs.map(d => `• ${d.type === 'customer_invoice' ? 'Счёт' : d.type === 'sale' ? 'Реализация' : 'Поступление'} ${esc(d.number)} от ${L.formatDate(d.date)} — ${L.formatAmount(d.total)}${d.status === 'draft' ? ' (черновик)' : ''}`).join('\n') : '');
        return this.reply(ctx, txt, [
            [btn('🧾 Счёт', 'ncd:invoice:' + id), btn('🚚 Накладная', 'ncd:waybill:' + id)],
            [btn('📦 Акт приёма-передачи', 'ncd:transfer:' + id), btn('🛠 Акт работ', 'ncd:works:' + id)],
            [btn('📑 Счёт-фактура', 'ncd:sf:' + id)],
            ...docs.filter(d => ['customer_invoice', 'sale'].includes(d.type)).slice(0, 3).map(d => [btn('📄 ' + d.number + ' — PDF', 'dc:' + d.id)]),
        ]);
    }
    async globalSearch(ctx, text) {
        const { db } = await this.store.load(15000);
        const noms = L.search(db.trade.nomenclature || [], text).slice(0, 8);
        const cs = L.search(db.trade.contractors || [], text).slice(0, 6);
        if (!noms.length && !cs.length) return this.send(ctx.chat, `Ничего не найдено по «${esc(text)}». Воспользуйтесь меню внизу.`, MAIN_KB);
        const lines = noms.map(n => `📦 ${esc(n.name.trim())}: <b>${n.kind === 'Услуга' ? 'услуга' : L.formatQty(L.stockQty(db, n.id, 'w1')) + ' ' + esc(n.unit || '')}</b>`);
        return this.send(ctx.chat, (lines.length ? '<b>Остатки:</b>\n' + lines.join('\n') : '') + (cs.length ? (lines.length ? '\n\n' : '') + '<b>Контрагенты:</b>' : ''), cs.length ? { inline_keyboard: cs.map(c => [btn('👤 ' + short(c.name, 38), 'cc:' + c.id)]) } : undefined);
    }
    async docsList(ctx, page) {
        const { db } = await this.store.load(15000);
        const docs = (db.trade.docs || []).filter(d => ['customer_invoice', 'sale'].includes(d.type) && d.status !== 'deleted').slice().sort((a, b) => (b.created || b.date || '').localeCompare(a.created || a.date || '')).slice(0, 40);
        const part = docs.slice(page * PAGE, page * PAGE + PAGE);
        const nav = [];
        if (page > 0) nav.push(btn('← Назад', 'docs:' + (page - 1)));
        if ((page + 1) * PAGE < docs.length) nav.push(btn('Дальше →', 'docs:' + (page + 1)));
        return this.reply(ctx, '🗂 <b>Последние документы</b> (счета, накладные, акты). Нажмите, чтобы получить PDF:', [
            ...part.map(d => [btn(`${d.type === 'customer_invoice' ? '🧾' : (d.opKind || '').startsWith('Услуги') ? '🛠' : '🚚'} ${d.number} · ${short(L.contractorName(db, d.contractor), 16)} · ${L.formatAmount(d.total)}`, 'dc:' + d.id)]),
            ...(nav.length ? [nav] : []),
        ]);
    }
    async docCard(ctx, id) {
        const { db } = await this.store.load(15000);
        const d = L.docById(db, id); if (!d) return this.reply(ctx, 'Документ не найден.');
        const forms = this.docForms(d);
        return this.reply(ctx, `${d.type === 'customer_invoice' ? '🧾 Счёт на оплату' : '🚚 Реализация'} <b>${esc(d.number)}</b> от ${L.formatDate(d.date)}\n${esc(L.contractorName(db, d.contractor))} · <b>${L.formatAmount(d.total)} сом</b>${d.status === 'draft' ? '\n⚠️ Черновик (не проведён)' : ''}\n\nКакую форму прислать?`, [
            ...rows2(forms.map(f => btn('📄 ' + FORM_NAMES[f] + (f === 'sf' ? ' № ' + d.sf.number : ''), 'pdf:' + d.id + ':' + f))),
            ...(d.type === 'sale' && !d.sf ? [[btn('📑 Выписать счёт-фактуру', 'sf:' + d.id)]] : []),
            [btn('← К списку', 'docs:0')],
        ]);
    }

    // ---------- Ещё: сотрудники, помощь ----------
    async moreMenu(ctx) {
        return this.reply(ctx, '⚙️ <b>Ещё</b>', [
            ...(ctx.isAdmin ? [[btn('👥 Сотрудники с доступом', 'users')]] : []),
            [btn('❓ Как пользоваться', 'help')],
        ]);
    }
    helpText() {
        return '❓ <b>Как пользоваться ботом</b>\n\n' +
            '📄 <b>Новый документ</b> — счёт на оплату, накладная, акт приёма-передачи, акт выполненных работ, счёт-фактура. Выберите контрагента, добавьте позиции (кол-во и цену), нажмите «Сформировать PDF». Документ сразу появится на сайте, а PDF придёт сюда — перешлите его клиенту.\n\n' +
            '🧾 Из счёта можно одной кнопкой сделать накладную или акт, из накладной — счёт-фактуру.\n\n' +
            '📦 <b>Остатки</b> и 💰 <b>Долги</b> — то же, что на сайте, с учётом ввода остатков.\n\n' +
            '🔍 Просто напишите название товара или контрагента — покажу остаток и долг.\n\n/start — главное меню, /cancel — отменить текущий документ.';
    }
    async usersMenu(ctx) {
        if (!ctx.isAdmin) return;
        const users = await this.listUsers();
        return this.reply(ctx, '👥 <b>Сотрудники с доступом</b>\n' + (users.length ? users.map(u => `• ${esc(u.name)} (<code>${u.uid}</code>)`).join('\n') : 'Пока только администраторы.') + '\n\nЧтобы добавить сотрудника, попросите его написать боту /start — вам придёт запрос с кнопкой «Разрешить».', users.map(u => [btn('✖ Убрать ' + short(u.name, 25), 'ur:' + u.uid)]));
    }
    async approveUser(ctx, uid, ok) {
        if (!ctx.isAdmin) return;
        const u = await this.getUser(uid);
        const name = u ? u.name : uid;
        if (ok) { await this.setUser(uid, name, 'user'); await this.send(uid, '✅ Доступ к боту EsepOnline открыт. Нажмите /start.', MAIN_KB); return this.reply(ctx, `✅ ${esc(name)} получил доступ.`); }
        await this.setUser(uid, name, 'blocked');
        return this.reply(ctx, `✖ ${esc(name)} — доступ закрыт.`);
    }
}
