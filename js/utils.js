// ============================================
// Общие утилиты для EsepOnline
// ============================================

// --- Генерация уникальных ID ---
function uid() { return '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function tUid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// --- HTML-экранирование (XSS-защита) ---
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// --- CSV-инъекция защита ---
function csvSafe(v) {
    let s = String(v == null ? '' : v).replace(/"/g, '""');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s + '"';
}

// --- XML-экранирование ---
function xmlSafe(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// --- Форматирование даты ---
function formatDate(dateStr) {
    if (!dateStr) return '\u2014';
    const d = new Date(dateStr + 'T00:00');
    return isNaN(d) ? '\u2014' : d.toLocaleDateString('ru-RU');
}

// --- Форматирование суммы ---
function formatAmount(num) {
    return Number(num || 0).toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}
function getCurrencyCode(id) {
    const c = (db.currencies || []).find(x => x.id === id);
    return c ? c.code : '';
}
function formatAmountCur(num, currencyId, rate) {
    const amt = formatAmount(num);
    const code = getCurrencyCode(currencyId);
    if (code && code !== 'KGS') {
        const r = Number(rate) || 1;
        const kgs = formatAmount(Number(num || 0) * r);
        return amt + ' ' + code + '<br><span style="font-size:11px;color:#888">' + kgs + ' сом</span>';
    }
    return amt;
}
function calcSumKGS() {
    const sum = parseFloat(document.getElementById('docSum').value) || 0;
    const rate = parseFloat(document.getElementById('docRate').value) || 1;
    const el = document.getElementById('docSumKGS');
    if (el) el.value = rate !== 1 ? formatAmount(sum * rate) + ' сом' : '';
}

// --- Компактный формат чисел (для дашборда) ---
function fmt(n) {
    return Number(n || 0).toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

// --- Сортировка документов (по дате desc, потом по номеру desc) ---
function docCmp(a, b) {
    const dc = (b.date || '').localeCompare(a.date || '');
    if (dc !== 0) return dc;
    const na = parseInt((String(a.number).match(/(\d+)$/) || [0, 0])[1]);
    const nb = parseInt((String(b.number).match(/(\d+)$/) || [0, 0])[1]);
    return nb - na || String(b.number).localeCompare(String(a.number));
}

// --- Toast-уведомление ---
function showToast(message, type) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// --- Скачивание файла ---
function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// --- Экспорт в Excel (обёртка SheetJS) ---
function exportExcel(headers, rows, filename, sheetName) {
    if (typeof XLSX === 'undefined') { showToast('Библиотека Excel не загружена', 'error'); return; }
    const data = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = headers.map((h, i) => {
        let max = h.length;
        rows.forEach(r => { const v = String(r[i] || ''); if (v.length > max) max = v.length; });
        return { wch: Math.min(max + 2, 40) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Данные');
    XLSX.writeFile(wb, filename);
    showToast('Экспортировано в Excel');
}

// --- SHA-256 хеш ---
async function sha256(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
function genSalt() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashWithSalt(text, salt) {
    return await sha256(salt + text);
}

// --- Сумма прописью (русский) ---
function amountInWords(n) {
    n = Math.abs(Number(n || 0));
    const units = ['','один','два','три','четыре','пять','шесть','семь','восемь','девять'];
    const teens = ['десять','одиннадцать','двенадцать','тринадцать','четырнадцать','пятнадцать','шестнадцать','семнадцать','восемнадцать','девятнадцать'];
    const tens = ['','','двадцать','тридцать','сорок','пятьдесят','шестьдесят','семьдесят','восемьдесят','девяносто'];
    const hundreds = ['','сто','двести','триста','четыреста','пятьсот','шестьсот','семьсот','восемьсот','девятьсот'];
    const totalKop = Math.round(n * 100);
    const intPart = Math.floor(totalKop / 100);
    const kopPart = totalKop % 100;
    if (intPart === 0) return 'ноль сом ' + String(kopPart).padStart(2,'0') + ' тыйын';
    function group(num) {
        let r = '';
        r += hundreds[Math.floor(num / 100)];
        const rem = num % 100;
        if (rem >= 10 && rem < 20) { r += (r ? ' ' : '') + teens[rem - 10]; }
        else { if (tens[Math.floor(rem / 10)]) r += (r ? ' ' : '') + tens[Math.floor(rem / 10)]; if (units[rem % 10]) r += (r ? ' ' : '') + units[rem % 10]; }
        return r;
    }
    let result = '';
    const millions = Math.floor(intPart / 1000000);
    const thousands = Math.floor((intPart % 1000000) / 1000);
    const rest = intPart % 1000;
    if (millions) result += group(millions) + ' млн ';
    if (thousands) result += group(thousands) + ' тыс. ';
    if (rest || !result) result += group(rest);
    result = result.trim();
    result = result.charAt(0).toUpperCase() + result.slice(1);
    return result + ' сом ' + String(kopPart).padStart(2,'0') + ' тыйын';
}

// --- Дебаунс ---
function debounce(fn, delay) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

// --- Горячие клавиши ---
function initKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
        // Escape — закрыть модальные окна
        if (e.key === 'Escape') {
            const modals = document.querySelectorAll('.modal.active');
            if (modals.length > 0) {
                // Закрываем самый верхний по z-index
                let top = null, maxZ = 0;
                modals.forEach(m => {
                    const z = parseInt(getComputedStyle(m).zIndex) || 0;
                    if (z >= maxZ) { maxZ = z; top = m; }
                });
                if (top) {
                    if (top.id === 'tModal' && typeof tCloseForm === 'function') tCloseForm();
                    else if (top.id === 'tPickModal' && typeof tClosePick === 'function') tClosePick();
                    else if (top.id === 'documentModal' && typeof closeModal === 'function') closeModal();
                    else top.classList.remove('active');
                }
                e.preventDefault();
                return;
            }
        }

        // Ctrl/Cmd+S — сохранить документ
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            const tModal = document.getElementById('tModal');
            if (tModal && tModal.classList.contains('active') && typeof tFormSave === 'function') {
                tFormSave(false);
            } else {
                const docModal = document.getElementById('documentModal');
                if (docModal && docModal.classList.contains('active') && typeof saveDocument === 'function') {
                    saveDocument();
                }
            }
        }

        // Ctrl/Cmd+Enter — провести и закрыть документ
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            const tModal = document.getElementById('tModal');
            if (tModal && tModal.classList.contains('active') && typeof tFormPost === 'function') {
                e.preventDefault();
                tFormPost(true);
            }
        }

        // Ctrl/Cmd+N — создать новый документ (когда нет открытых модалок)
        if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
            const hasActiveModal = document.querySelector('.modal.active');
            if (!hasActiveModal && typeof openCreateModal === 'function') {
                e.preventDefault();
                openCreateModal();
            }
        }

        // Ctrl/Cmd+F — фокус на поиск
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            const search = document.getElementById('globalSearch');
            if (search && !document.querySelector('.modal.active')) {
                e.preventDefault();
                search.focus();
                search.select();
            }
        }
    });
}

// --- Пагинация ---
const _pages = {};
function pageOf(key) { return _pages[key] || 1; }
function setPage(key, p) { _pages[key] = p; renderPage(); }
function paginate(arr, key, perPage) {
    perPage = perPage || 50;
    const total = arr.length;
    const pages = Math.ceil(total / perPage) || 1;
    let p = Math.min(pageOf(key), pages);
    _pages[key] = p;
    const start = (p - 1) * perPage;
    return { items: arr.slice(start, start + perPage), page: p, pages, total };
}
function paginationHtml(key, pg) {
    if (pg.pages <= 1) return '';
    let h = '<div style="display:flex;align-items:center;gap:6px;margin-top:10px;justify-content:center;flex-wrap:wrap">';
    h += '<span style="font-size:13px;color:var(--text-secondary)">Всего: ' + pg.total + '</span>';
    if (pg.page > 1) h += '<button class="btn" style="padding:4px 10px" onclick="setPage(\'' + key + '\',' + (pg.page - 1) + ')">◀</button>';
    const start = Math.max(1, pg.page - 3), end = Math.min(pg.pages, pg.page + 3);
    for (let i = start; i <= end; i++) {
        h += '<button class="btn' + (i === pg.page ? ' primary' : '') + '" style="padding:4px 10px" onclick="setPage(\'' + key + '\',' + i + ')">' + i + '</button>';
    }
    if (pg.page < pg.pages) h += '<button class="btn" style="padding:4px 10px" onclick="setPage(\'' + key + '\',' + (pg.page + 1) + ')">▶</button>';
    h += '</div>';
    return h;
}

// --- Шаблоны документов ---
function saveAsTemplate(docId) {
    const doc = (db.bankDocuments || []).find(d => d.id === docId) || (db.cashDocuments || []).find(d => d.id === docId);
    if (!doc) return;
    const name = prompt('Название шаблона:', doc.contractor || doc.purpose || 'Шаблон');
    if (!name) return;
    if (!db.templates) db.templates = [];
    const tmpl = { ...doc, id: uid(), templateName: name, isTemplate: true };
    delete tmpl.number; delete tmpl.date; delete tmpl.status; delete tmpl.created;
    db.templates.push(tmpl);
    saveData();
    showToast('Шаблон "' + name + '" сохранён');
}
function createFromTemplate(tmplId) {
    const tmpl = (db.templates || []).find(t => t.id === tmplId);
    if (!tmpl) return;
    const doc = { ...tmpl, id: uid(), date: new Date().toISOString().split('T')[0], status: 'draft', created: new Date().toISOString() };
    delete doc.templateName; delete doc.isTemplate;
    const isCash = ['pko', 'rko', 'advance'].includes(doc.type);
    if (isCash) {
        doc.number = 'К-' + String((db.cashDocuments || []).length + 1).padStart(4, '0');
        db.cashDocuments.push(doc);
    } else {
        doc.number = 'ПП-' + String((db.bankDocuments || []).length + 1).padStart(4, '0');
        db.bankDocuments.push(doc);
    }
    saveData(); renderPage();
    showToast('Документ создан из шаблона');
}
function deleteTemplate(id) {
    if (!confirm('Удалить шаблон?')) return;
    db.templates = (db.templates || []).filter(t => t.id !== id);
    saveData(); renderPage();
}
function renderTemplatesPanel() {
    const templates = db.templates || [];
    if (!templates.length) return '';
    return '<div style="margin-bottom:12px;padding:10px;background:var(--bg-card);border-radius:var(--radius-lg);border:1px dashed var(--border-input)"><b>Шаблоны:</b> ' +
        templates.map(t => '<button class="btn" style="padding:3px 10px;margin:2px" onclick="createFromTemplate(\'' + t.id + '\')" title="Создать из шаблона">' + esc(t.templateName) + '</button><button class="btn" style="padding:3px 6px;margin:2px;color:var(--danger);font-size:10px" onclick="deleteTemplate(\'' + t.id + '\')" title="Удалить шаблон">✕</button>').join(' ') + '</div>';
}

// --- Массовые операции ---
let _selected = new Set();
function toggleSelect(id, el) {
    if (el.checked) _selected.add(id); else _selected.delete(id);
    document.querySelectorAll('.bulk-bar').forEach(b => b.style.display = _selected.size ? 'flex' : 'none');
    const cnt = document.getElementById('bulkCount');
    if (cnt) cnt.textContent = _selected.size;
}
function toggleSelectAll(el, ids) {
    ids.forEach(id => { if (el.checked) _selected.add(id); else _selected.delete(id); });
    document.querySelectorAll('.bulk-chk').forEach(c => c.checked = el.checked);
    document.querySelectorAll('.bulk-bar').forEach(b => b.style.display = _selected.size ? 'flex' : 'none');
    const cnt = document.getElementById('bulkCount');
    if (cnt) cnt.textContent = _selected.size;
}
function bulkAction(action) {
    if (!_selected.size) return;
    const ids = [..._selected];
    if (action === 'post') {
        ids.forEach(id => {
            const d = db.bankDocuments.find(x => x.id === id) || db.cashDocuments.find(x => x.id === id);
            if (d) d.status = 'posted';
        });
        showToast('Проведено: ' + ids.length);
    } else if (action === 'unpost') {
        ids.forEach(id => {
            const d = db.bankDocuments.find(x => x.id === id) || db.cashDocuments.find(x => x.id === id);
            if (d) d.status = 'draft';
        });
        showToast('Отменено проведение: ' + ids.length);
    } else if (action === 'delete') {
        if (!confirm('Удалить ' + ids.length + ' документов?')) return;
        ids.forEach(id => {
            db.bankDocuments = db.bankDocuments.filter(x => x.id !== id);
            db.cashDocuments = db.cashDocuments.filter(x => x.id !== id);
        });
        showToast('Удалено: ' + ids.length);
    }
    _selected.clear();
    saveData(); renderPage();
}
function bulkBarHtml() {
    return '<div class="bulk-bar" style="display:none;gap:8px;align-items:center;margin-bottom:8px;padding:8px 12px;background:var(--bg-card);border-radius:var(--radius-lg);border:1px solid var(--primary)"><span>Выбрано: <b id="bulkCount">0</b></span><button class="btn primary" style="padding:4px 12px" onclick="bulkAction(\'post\')">✔ Провести</button><button class="btn" style="padding:4px 12px" onclick="bulkAction(\'unpost\')">↩ Отменить</button><button class="btn" style="padding:4px 12px;color:var(--danger)" onclick="bulkAction(\'delete\')">🗑 Удалить</button></div>';
}

// --- Поиск в меню ---
function filterMenu(q) {
    q = q.toLowerCase().trim();
    const sidebar = document.getElementById('sidebar');
    const items = sidebar.querySelectorAll('.nav-item');
    const sections = sidebar.querySelectorAll('.section-title');
    if (!q) {
        items.forEach(el => el.style.display = '');
        sections.forEach(el => { el.style.display = ''; if (el.nextElementSibling) el.nextElementSibling.style.maxHeight = ''; });
        return;
    }
    sections.forEach(el => el.style.display = 'none');
    items.forEach(el => {
        const text = el.textContent.toLowerCase();
        el.style.display = text.includes(q) ? '' : 'none';
    });
}

// --- Генерация обобщённых CRUD справочников ---
function renderGenericCRUD(config) {
    const { title, items, formId, columns, formFields, onSave, onDelete, addLabel } = config;

    const tableRows = items.map(item => {
        const cells = columns.map(col =>
            `<td>${col.badge ? `<span class="badge ${col.badgeClass(item)}">${esc(col.render(item))}</span>` : (col.strong ? `<strong>${esc(col.render(item))}</strong>` : esc(col.render(item)))}</td>`
        ).join('');
        return `<tr>${cells}<td>
            <button class="action-btn" onclick="${formId}Edit('${item.id}')" title="Редактировать">&#9998;</button>
            <button class="action-btn" onclick="${formId}Delete('${item.id}')" title="Удалить" style="color:var(--danger)">&#128465;</button>
        </td></tr>`;
    }).join('');

    const colHeaders = columns.map(col => `<th>${esc(col.label)}</th>`).join('');

    return `
        <div style="margin-bottom:12px">
            <button class="btn primary" onclick="${formId}ShowAdd()">${addLabel || '+ Добавить'}</button>
        </div>
        <div id="${formId}FormWrap" style="display:none;background:var(--bg-card);padding:16px;border-radius:var(--radius-lg);margin-bottom:16px;box-shadow:var(--shadow-md)">
            <h4 id="${formId}FormTitle" style="margin-bottom:12px">${title}</h4>
            <input type="hidden" id="${formId}EditId">
            <div style="display:grid;grid-template-columns:${formFields.length > 2 ? 'repeat(' + Math.min(formFields.length, 3) + ', 1fr)' : '1fr 1fr'};gap:10px">
                ${formFields.map(f => `<div class="form-group"><label>${esc(f.label)}</label>${f.type === 'select' ? `<select id="${f.id}">${f.options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>` : `<input id="${f.id}" placeholder="${esc(f.placeholder || '')}">`}</div>`).join('')}
            </div>
            <div style="margin-top:10px;display:flex;gap:8px">
                <button class="btn primary" onclick="${formId}Save()">Сохранить</button>
                <button class="btn" onclick="document.getElementById('${formId}FormWrap').style.display='none'">Отмена</button>
            </div>
        </div>
        <div class="table-container"><table>
            <thead><tr>${colHeaders}<th style="width:100px">Действия</th></tr></thead>
            <tbody>${tableRows || '<tr><td colspan="' + (columns.length + 1) + '" class="empty-state" style="padding:30px">Нет записей</td></tr>'}</tbody>
        </table></div>
    `;
}
