// ============================================
// Общие утилиты для 1s Бухгалтерия
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

// --- Компактный формат чисел (для дашборда) ---
function fmt(n) {
    return Number(n || 0).toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

// --- Сортировка документов (по дате desc, потом по номеру desc) ---
function docCmp(a, b) {
    const dc = b.date.localeCompare(a.date);
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
