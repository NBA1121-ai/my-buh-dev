// ============================================
// GitHub API Database Synchronization Module
// Stores data as JSON in a 'data' branch
// Every save = git commit = automatic backup
// ============================================

const DbSync = (function() {
    const REPO_OWNER = 'NBA1121-ai';
    const REPO_NAME = 'my-buh-dev-data';
    const DATA_BRANCH = 'data';
    const DATA_FILE = 'db.json';
    const API_BASE = 'https://api.github.com';
    const SAVE_DELAY = 2000;
    const MAX_RETRIES = 3;

    let _token = null;
    let _saveTimer = null;
    let _saving = false;
    let _fileSha = null;
    let _lastHash = '';
    let _pollTimer = null;
    let _pendingSave = null; // queued save while _saving is true
    let _offlinePending = null; // data queued while offline
    let _inited = false;
    let _onSaveCallback = null;
    let _lastSavedSize = 0; // record count at last successful load/save
    let _lastSavedKeys = 0; // data section count at last successful load/save
    let _awaitingConfirm = false;
    let _base = undefined;          // последний снимок, совпадающий с GitHub (база для трёхстороннего слияния)
    let _lastScheduledHash = '';    // хеш последнего локального состояния, переданного в scheduleSave
    let _onRemoteCallback = null;   // app: применить данные с сервера (remote, base)
    let _loadRetryTimer = null;
    let _loadRetryDelay = 30000;
    let _needsSave = false;         // после загрузки локальные изменения ещё не отправлены

    // ---- Трёхстороннее слияние: base (общий предок), local, remote ----
    function _isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
    function _eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function _clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
    function _isIdArray(a) { return a.every(x => _isObj(x) && x.id != null); }
    function _mergeById(base, local, remote, hasBase) {
        const B = new Map((base || []).filter(x => _isObj(x) && x.id != null).map(x => [x.id, x]));
        const R = new Map(remote.map(x => [x.id, x]));
        const L = new Map(local.map(x => [x.id, x]));
        const out = [];
        for (const x of local) {
            if (R.has(x.id)) out.push(merge3(B.get(x.id), x, R.get(x.id)));
            else if (hasBase && B.has(x.id) && _eq(x, B.get(x.id))) continue; // удалено на другом устройстве, здесь не менялось
            else out.push(_clone(x));
        }
        for (const x of remote) {
            if (L.has(x.id)) continue;
            if (hasBase && B.has(x.id) && _eq(x, B.get(x.id))) continue; // удалено здесь, там не менялось
            out.push(_clone(x));
        }
        return out;
    }
    function merge3(base, local, remote) {
        if (_eq(local, remote)) return _clone(local);
        if (base !== undefined && _eq(local, base)) return _clone(remote);
        if (base !== undefined && _eq(remote, base)) return _clone(local);
        if (Array.isArray(local) && Array.isArray(remote)) {
            if ((local.length || remote.length) && _isIdArray(local) && _isIdArray(remote)) {
                return _mergeById(Array.isArray(base) ? base : [], local, remote, Array.isArray(base));
            }
            return _clone(local);
        }
        if (_isObj(local) && _isObj(remote)) {
            const b = _isObj(base) ? base : undefined;
            const out = {};
            const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
            for (const k of keys) {
                const inL = k in local, inR = k in remote, inB = !!b && k in b;
                if (inL && inR) out[k] = merge3(inB ? b[k] : undefined, local[k], remote[k]);
                else if (inL) { if (!(inB && _eq(local[k], b[k]))) out[k] = _clone(local[k]); }
                else { if (!(inB && _eq(remote[k], b[k]))) out[k] = _clone(remote[k]); }
            }
            return out;
        }
        return _clone(local); // конфликт простых значений — побеждает локальное
    }

    function _safeSet(key, val) {
        try { localStorage.setItem(key, val); return true; }
        catch (e) { console.warn('localStorage full:', key); return false; }
    }
    function _setBase(data) {
        _base = _clone(data);
        if (!_safeSet('db_base', JSON.stringify(data))) localStorage.removeItem('db_base');
    }
    function _loadStoredBase() {
        try { const s = localStorage.getItem('db_base'); return s ? JSON.parse(s) : undefined; } catch (e) { return undefined; }
    }
    function _isDirty() { return localStorage.getItem('db_dirty') === '1'; }
    function _setDirty(v) { if (v) _safeSet('db_dirty', '1'); else localStorage.removeItem('db_dirty'); }

    // Чтение db.json (или другого файла) с поддержкой файлов > 1 МБ
    async function _fetchFile(ref, file) {
        const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${file || DATA_FILE}?ref=${ref || DATA_BRANCH}&_t=${Date.now()}`;
        const res = await fetchWithTimeout(url, {
            headers: { 'Authorization': 'token ' + _token, 'Accept': 'application/vnd.github+json' },
            cache: 'no-store'
        });
        if (!res.ok) { const e = new Error('GitHub API error: ' + res.status); e.status = res.status; throw e; }
        const meta = await res.json();
        let data;
        if (meta.content && meta.encoding !== 'none') {
            data = JSON.parse(b64DecodeUTF8(meta.content));
        } else {
            const raw = await fetchWithTimeout(url, {
                headers: { 'Authorization': 'token ' + _token, 'Accept': 'application/vnd.github.raw+json' },
                cache: 'no-store'
            });
            if (!raw.ok) { const e = new Error('GitHub raw error: ' + raw.status); e.status = raw.status; throw e; }
            data = JSON.parse(await raw.text());
        }
        return { sha: meta.sha, data };
    }

    function countRecords(obj) {
        let total = 0;
        for (const key in obj) {
            if (Array.isArray(obj[key])) {
                total += obj[key].length;
            } else if (obj[key] && typeof obj[key] === 'object') {
                // Count all arrays inside nested objects (trade.docs, trade.contractors, trade.nomenclature, etc.)
                for (const subKey in obj[key]) {
                    if (Array.isArray(obj[key][subKey])) {
                        total += obj[key][subKey].length;
                    }
                }
            }
        }
        return total;
    }

    function countDataKeys(obj) {
        // Count keys that hold actual data (arrays or objects with any non-empty arrays)
        let count = 0;
        for (const key in obj) {
            if (key.startsWith('_')) continue;
            const val = obj[key];
            if (Array.isArray(val) && val.length > 0) count++;
            else if (val && typeof val === 'object' && !Array.isArray(val)) {
                let hasData = false;
                for (const subKey in val) {
                    if (Array.isArray(val[subKey]) && val[subKey].length > 0) { hasData = true; break; }
                }
                if (hasData) count++;
            }
        }
        return count;
    }

    function showDataLossConfirm(oldCount, newCount, severe) {
        return new Promise((resolve) => {
            _awaitingConfirm = true;
            const pct = Math.round((1 - newCount / oldCount) * 100);
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = `
                <div style="background:#fff;border-radius:12px;padding:30px;max-width:420px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
                    <div style="font-size:48px;margin-bottom:15px;">&#9888;</div>
                    <h3 style="color:#d32f2f;margin-bottom:10px;">Внимание! Потеря данных</h3>
                    <p style="margin-bottom:15px;color:#333;">Количество записей уменьшилось на <b>${pct}%</b></p>
                    <p style="margin-bottom:20px;color:#666;font-size:14px;">Было: <b>${oldCount}</b> записей &rarr; Стало: <b>${newCount}</b> записей</p>
                    <p style="margin-bottom:20px;color:#d32f2f;font-size:13px;">${severe ? 'Удалено больше половины данных! Сохраняйте, только если удаляли их намеренно (например, очистка демо-данных).' : 'Вы уверены, что хотите сохранить эти изменения?'}</p>
                    <div style="display:flex;gap:10px;justify-content:center;">
                        <button id="_dlc_cancel" style="padding:10px 24px;border:1px solid #ccc;border-radius:8px;background:#f5f5f5;cursor:pointer;font-size:15px;">Отменить</button>
                        <button id="_dlc_confirm" style="padding:10px 24px;border:none;border-radius:8px;background:#d32f2f;color:#fff;cursor:pointer;font-size:15px;">Сохранить</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            overlay.querySelector('#_dlc_cancel').onclick = () => { overlay.remove(); _awaitingConfirm = false; resolve(false); };
            overlay.querySelector('#_dlc_confirm').onclick = () => { overlay.remove(); _awaitingConfirm = false; resolve(true); };
        });
    }

    function _loadOfflinePending() {
        try {
            const s = localStorage.getItem('offline_pending');
            if (s) return JSON.parse(s);
        } catch(e) {}
        return null;
    }

    async function _loadToken() {
        const stored = localStorage.getItem('gh_token');
        if (!stored) return null;
        // v2: AES-GCM encrypted
        if (stored.startsWith('v2:')) {
            const token = await _decryptToken(stored.slice(3));
            return token;
        }
        // Legacy XOR obfuscated — migrate to AES-GCM
        const decoded = _deobfuscateLegacy(stored);
        if (decoded && decoded.startsWith('ghp_')) {
            await setToken(decoded);
            return decoded;
        }
        // Legacy plain text — migrate
        if (stored.startsWith('ghp_')) {
            await setToken(stored);
            return stored;
        }
        return decoded || stored;
    }

    async function init() {
        if (_inited) { _token = await _loadToken(); return; }
        _inited = true;
        _token = await _loadToken();
        // Force clear cache (one-time reset) — only when online
        if (localStorage.getItem('db_reset') !== 'r7') {
            if (navigator.onLine && !_isDirty()) {
                // Preserve offline_pending — sync it first if it has data
                const pendingBeforeReset = _loadOfflinePending();
                localStorage.removeItem('db_cache');
                localStorage.removeItem('db_cache_sha');
                localStorage.setItem('db_reset', 'r7');
                if (pendingBeforeReset && countRecords(pendingBeforeReset) > 0) {
                    // Re-save so it gets synced on startup
                    try { localStorage.setItem('offline_pending', JSON.stringify(pendingBeforeReset)); } catch(e) {}
                } else {
                    localStorage.removeItem('offline_pending');
                }
            }
        }
        // Старая офлайн-очередь (до этой версии) — переносим в кэш с пометкой «не сохранено»
        const legacyPending = _loadOfflinePending();
        if (legacyPending && countRecords(legacyPending) > 0) {
            if (_safeSet('db_cache', JSON.stringify(legacyPending))) { _setDirty(true); localStorage.removeItem('offline_pending'); }
        } else if (legacyPending) {
            localStorage.removeItem('offline_pending');
        }
        // Когда сеть вернулась: загрузить данные с сервера, слить с локальными изменениями и отправить
        window.addEventListener('online', () => {
            if (!_dataLoaded && _token) _retryLoad();
            else if (_isDirty() && _lastFailedData) { const d = _lastFailedData; _lastFailedData = null; saveData(d); }
            else if (_isDirty()) { try { const c = JSON.parse(localStorage.getItem('db_cache')); if (c) saveData(c); } catch (e) {} }
        });
    }

    // Повторная загрузка после ошибки/офлайна: результат отдаётся приложению через onDataLoaded
    async function _retryLoad() {
        if (_loadRetryTimer) { clearTimeout(_loadRetryTimer); _loadRetryTimer = null; }
        if (_dataLoaded || !_token) return;
        const data = await loadData();
        if (_dataLoaded) {
            _loadRetryDelay = 30000;
            if (data && typeof _onDataLoaded === 'function') _onDataLoaded(data);
        }
    }
    function _scheduleLoadRetry() {
        if (_loadRetryTimer || _dataLoaded) return;
        _loadRetryTimer = setTimeout(() => { _loadRetryTimer = null; _retryLoad(); }, _loadRetryDelay);
        _loadRetryDelay = Math.min(_loadRetryDelay * 2, 300000);
    }
    function needsSave() { const v = _needsSave; _needsSave = false; return v; }

    function getToken() { return _token; }

    // --- AES-GCM encryption for token storage ---
    async function _getEncryptionKey() {
        let rawKey = localStorage.getItem('_ek');
        if (!rawKey) {
            const arr = new Uint8Array(32);
            crypto.getRandomValues(arr);
            rawKey = btoa(String.fromCharCode(...arr));
            localStorage.setItem('_ek', rawKey);
        }
        const keyBytes = Uint8Array.from(atob(rawKey), c => c.charCodeAt(0));
        return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }

    async function _encryptToken(token) {
        try {
            const key = await _getEncryptionKey();
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encoded = new TextEncoder().encode(token);
            const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
            const combined = new Uint8Array(iv.length + ciphertext.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(ciphertext), iv.length);
            return btoa(String.fromCharCode(...combined));
        } catch(e) { return null; }
    }

    async function _decryptToken(stored) {
        try {
            const key = await _getEncryptionKey();
            const combined = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
            const iv = combined.slice(0, 12);
            const ciphertext = combined.slice(12);
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
            return new TextDecoder().decode(decrypted);
        } catch(e) { return null; }
    }

    // Legacy XOR deobfuscation for migration
    const _OBF_KEY = 'EsEp0nL1n3_s4Lt_k3y';
    function _deobfuscateLegacy(encoded) {
        try {
            const str = atob(encoded);
            let result = '';
            for (let i = 0; i < str.length; i++) {
                result += String.fromCharCode(str.charCodeAt(i) ^ _OBF_KEY.charCodeAt(i % _OBF_KEY.length));
            }
            return result;
        } catch(e) { return null; }
    }

    async function setToken(token) {
        _token = token;
        const encrypted = await _encryptToken(token);
        if (encrypted) {
            localStorage.setItem('gh_token', 'v2:' + encrypted);
        }
    }

    function clearToken() {
        _token = null;
        localStorage.removeItem('gh_token');
        localStorage.removeItem('_ek');
    }

    async function validateToken(token) {
        try {
            const res = await fetchWithTimeout(API_BASE + '/user', {
                headers: { 'Authorization': 'token ' + token }
            });
            if (!res.ok) return null;
            return await res.json();
        } catch(e) {
            return null;
        }
    }

    // --- Fetch with timeout ---
    function fetchWithTimeout(url, options, timeout = 30000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
    }

    // --- UTF-8 safe base64 decode ---
    function b64DecodeUTF8(base64) {
        const binStr = atob(base64.replace(/[\s\n\r]/g, ''));
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) {
            bytes[i] = binStr.charCodeAt(i);
        }
        return new TextDecoder('utf-8').decode(bytes);
    }

    // --- UTF-8 safe base64 encode ---
    function b64EncodeUTF8(str) {
        const bytes = new TextEncoder().encode(str);
        let binStr = '';
        for (let i = 0; i < bytes.length; i++) {
            binStr += String.fromCharCode(bytes[i]);
        }
        return btoa(binStr);
    }

    let _dataLoaded = false; // true after successful GitHub load
    let _onDataLoaded = null; // callback for when data loads after coming online

    async function loadData() {
        if (!_token) return null;
        let cached = null;
        try { const s = localStorage.getItem('db_cache'); if (s) cached = JSON.parse(s); } catch (e) {}

        // Офлайн — работаем с локальным кэшем; сохранение в GitHub включится, когда появится сеть
        if (!navigator.onLine) {
            if (cached) { _lastHash = hashData(cached); showSyncStatus('offline'); }
            return cached;
        }

        try {
            let file;
            try {
                file = await _fetchFile();
            } catch (e) {
                if (e.status === 404) {
                    // Файла ещё нет — первое сохранение создаст его
                    _fileSha = null; _dataLoaded = true; _base = undefined;
                    if (cached && _isDirty()) { _needsSave = true; return cached; }
                    return null;
                }
                throw e;
            }
            const remote = file.data;
            _fileSha = file.sha;
            _lastHash = hashData(remote);
            _lastSavedSize = countRecords(remote);
            _lastSavedKeys = countDataKeys(remote);
            _dataLoaded = true;
            if (_loadRetryTimer) { clearTimeout(_loadRetryTimer); _loadRetryTimer = null; }

            let result = remote;
            if (cached && _isDirty()) {
                // Есть несохранённые локальные изменения — сливаем их с версией с сервера
                const base = _loadStoredBase();
                result = merge3(base, cached, remote);
                if (!_eq(result, remote)) _needsSave = true;
            }
            _setBase(remote);
            _safeSet('db_cache', JSON.stringify(result));
            _safeSet('db_cache_sha', _fileSha);
            if (!_needsSave) _setDirty(false);
            return result;
        } catch (err) {
            console.error('Load error', err && err.message);
            showSyncStatus('loadError');
            _scheduleLoadRetry();
            // Работаем с локальным кэшем; изменения сохраняются локально и уйдут на сервер после загрузки
            return cached;
        }
    }

    function isDataLoaded() { return _dataLoaded; }

    function scheduleSave(dbObject) {
        if (_saveTimer) clearTimeout(_saveTimer);
        // Локальная копия пишется всегда — даже если GitHub недоступен
        if (!_safeSet('db_cache', JSON.stringify(dbObject))) showSyncStatus('quota');
        const h = hashData(dbObject);
        _lastScheduledHash = h;
        if (h !== _lastHash) _setDirty(true);
        if (!_dataLoaded) {
            // Данные с сервера ещё не загружены: отправим после загрузки (слияние сохранит изменения)
            showSyncStatus(navigator.onLine ? 'loadError' : 'offline');
            if (navigator.onLine) _scheduleLoadRetry();
            return;
        }
        if (_saving || _awaitingConfirm) {
            _pendingSave = dbObject;
            return;
        }
        _saveTimer = setTimeout(() => { _saveTimer = null; saveData(dbObject); }, SAVE_DELAY);
    }

    async function saveData(dbObject, retryCount) {
        if (!_token || _saving || _awaitingConfirm) {
            if (_saving || _awaitingConfirm) _pendingSave = dbObject;
            return;
        }
        if (!_dataLoaded) { _scheduleLoadRetry(); return; }

        retryCount = retryCount ?? 0;

        const currentHash = hashData(dbObject);
        if (currentHash === _lastHash) {
            if (currentHash === _lastScheduledHash && !_pendingSave) _setDirty(false);
            return;
        }

        // Data loss protection
        if (_lastSavedSize > 0 && retryCount === 0) {
            const newSize = countRecords(dbObject);
            const newKeys = countDataKeys(dbObject);
            const oldKeys = _lastSavedKeys || 0;

            const severe = newSize < _lastSavedSize * 0.5 || (oldKeys > 3 && newKeys < oldKeys * 0.5);
            // Заметное уменьшение данных — спрашиваем подтверждение (при >50% — с усиленным предупреждением)
            if (severe || newSize < _lastSavedSize * 0.8) {
                const confirmed = await showDataLossConfirm(_lastSavedSize, newSize, severe);
                if (_pendingSave) { dbObject = _pendingSave; _pendingSave = null; } // берём самое свежее состояние
                if (!confirmed) {
                    _lastFailedData = dbObject;
                    showSyncStatus('error');
                    return;
                }
            }
        }

        _saving = true;
        showSyncStatus('saving');

        try {
            if (!navigator.onLine) {
                // Данные уже в локальном кэше с пометкой «не сохранено» — отправим, когда появится сеть
                showSyncStatus('offline');
                _saving = false;
                return;
            }

            const jsonStr = JSON.stringify(dbObject);
            const base64 = b64EncodeUTF8(jsonStr);

            const body = {
                message: 'Update data ' + new Date().toLocaleString('ru-RU'),
                content: base64,
                branch: DATA_BRANCH
            };

            if (_fileSha) {
                body.sha = _fileSha;
            }

            const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}`;
            const res = await fetchWithTimeout(url, {
                method: 'PUT',
                headers: {
                    'Authorization': 'token ' + _token,
                    'Content-Type': 'application/json',
                    'Accept': 'application/vnd.github+json'
                },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                // SHA conflict - reload and retry (with limit)
                if ((res.status === 409 || (res.status === 422 && errData.message && errData.message.includes('sha'))) && retryCount < MAX_RETRIES) {
                    console.warn('SHA conflict, merging with remote data, retry', retryCount + 1);
                    // Загружаем свежую версию и делаем трёхстороннее слияние
                    const merged = await _mergeWithRemote(dbObject);
                    _saving = false;
                    if (!merged) throw new Error('Merge failed');
                    await new Promise(r => setTimeout(r, 300 * (retryCount + 1)));
                    _mergedFrom = _mergedFrom || dbObject; // локальный снимок, от которого пошло слияние
                    return await saveData(merged, retryCount + 1);
                }
                // Rate limiting - wait and retry
                if (res.status === 429 && retryCount < MAX_RETRIES) {
                    const retryAfter = parseInt(res.headers.get('Retry-After')) || 10;
                    console.warn('Rate limited, waiting', retryAfter, 'sec');
                    showSyncStatus('offline');
                    _saving = false;
                    await new Promise(r => setTimeout(r, retryAfter * 1000));
                    return await saveData(dbObject, retryCount + 1);
                }
                // Server error - retry with backoff
                if (res.status >= 500 && retryCount < MAX_RETRIES) {
                    console.warn('Server error', res.status, ', retry', retryCount + 1);
                    _saving = false;
                    await new Promise(r => setTimeout(r, 2000 * (retryCount + 1)));
                    return await saveData(dbObject, retryCount + 1);
                }
                throw new Error('Save failed: ' + res.status + ' ' + (errData.message || ''));
            }

            const result = await res.json();
            _fileSha = result.content.sha;
            _lastHash = currentHash;
            _lastSavedSize = countRecords(dbObject);
            _lastSavedKeys = countDataKeys(dbObject);
            _setBase(dbObject);
            _safeSet('db_cache_sha', _fileSha);
            if (_mergedFrom) {
                // Сохранена слитая версия: отдаём её приложению (оно доливает свои свежие правки)
                const from = _mergedFrom; _mergedFrom = null;
                if (typeof _onRemoteCallback === 'function') {
                    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
                    _pendingSave = null;
                    _safeSet('db_cache', JSON.stringify(dbObject));
                    _setDirty(false);
                    _saving = false;
                    _onRemoteCallback(_clone(dbObject), from);
                }
            } else if (currentHash === _lastScheduledHash && !_pendingSave) {
                _setDirty(false);
            }
            showSyncStatus('saved');
            if (_onSaveCallback) _onSaveCallback(!_isDirty());
        } catch(err) {
            console.error('Save error', err && err.message);
            _mergedFrom = null;
            _lastFailedData = dbObject;
            showSyncStatus('error');
            if (_onSaveCallback) _onSaveCallback(false);
            // Автоповтор через минуту
            setTimeout(() => { if (_lastFailedData === dbObject && navigator.onLine) { _lastFailedData = null; saveData(dbObject); } }, 60000);
        } finally {
            _saving = false;
            // Process queued save if any
            if (_pendingSave) {
                const queued = _pendingSave;
                _pendingSave = null;
                setTimeout(() => saveData(queued), 500);
            }
        }
    }

    async function forceSave(dbObject) {
        if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
        _safeSet('db_cache', JSON.stringify(dbObject));
        const h = hashData(dbObject);
        _lastScheduledHash = h;
        if (h !== _lastHash) _setDirty(true);
        if (!_dataLoaded) {
            console.warn('forceSave: data not loaded from GitHub yet — saved locally');
            showSyncStatus(navigator.onLine ? 'loadError' : 'offline');
            _scheduleLoadRetry();
            return;
        }
        await saveData(dbObject);
    }

    async function _mergeWithRemote(localData) {
        try {
            const file = await _fetchFile();
            const remote = file.data;
            _fileSha = file.sha;
            let base = _base;
            // Если на сервере пропало больше половины записей — не доверяем удалениям (ничего не удаляем локально)
            if (base !== undefined && countRecords(remote) < countRecords(base) * 0.5) base = undefined;
            return merge3(base, localData, remote);
        } catch (e) {
            console.error('Merge failed', e && e.message);
            return null;
        }
    }

    async function reloadSha() {
        try {
            const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`;
            const res = await fetchWithTimeout(url, {
                headers: {
                    'Authorization': 'token ' + _token,
                    'Accept': 'application/vnd.github+json'
                },
                cache: 'no-store'
            });
            if (res.ok) {
                const data = await res.json();
                _fileSha = data.sha;
            }
        } catch(e) {
            console.error('reloadSha error');
        }
    }

    // Опрос изменений с других устройств (каждые 30 секунд)
    function startPolling(callback) {
        if (callback) _onRemoteCallback = callback;
        if (_pollTimer) clearInterval(_pollTimer);
        _pollTimer = setInterval(pollOnce, 30000);
    }
    async function pollOnce() {
        if (_saving || _awaitingConfirm || !_token || !navigator.onLine || !_dataLoaded) return;
        try {
            const meta = await fetchWithTimeout(`${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`, {
                headers: { 'Authorization': 'token ' + _token, 'Accept': 'application/vnd.github+json' }, cache: 'no-store'
            });
            if (!meta.ok) return;
            const m = await meta.json();
            if (m.sha === _fileSha) return;
            const file = await _fetchFile();
            if (_saving || _awaitingConfirm) return; // за время загрузки началось сохранение — разберётся через конфликт
            const remote = file.data;
            const newHash = hashData(remote);
            if (newHash === _lastHash) { _fileSha = file.sha; _setBase(remote); return; }
            let base = _base;
            if (base !== undefined && _lastSavedSize > 5 && countRecords(remote) < _lastSavedSize * 0.5) {
                console.error('Polling: на сервере пропало больше половины записей — удаления не применяются');
                base = undefined;
            }
            // Отменяем отложенное сохранение старого снимка: приложение сольёт и сохранит заново
            if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
            _pendingSave = null;
            _fileSha = file.sha;
            _lastHash = newHash;
            _lastSavedSize = countRecords(remote);
            _lastSavedKeys = countDataKeys(remote);
            _setBase(remote);
            _safeSet('db_cache', JSON.stringify(remote));
            _safeSet('db_cache_sha', _fileSha);
            _setDirty(false);
            if (typeof _onRemoteCallback === 'function') _onRemoteCallback(remote, base);
            showSyncStatus('synced');
        } catch (e) {
            console.warn('Polling error:', e && e.message);
        }
    }

    function stopPolling() {
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    }

    // Get commit history (backups)
    async function getHistory(limit) {
        if (!_token) return [];
        try {
            const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/commits?sha=${DATA_BRANCH}&path=${DATA_FILE}&per_page=${limit || 20}`;
            const res = await fetchWithTimeout(url, {
                headers: {
                    'Authorization': 'token ' + _token,
                    'Accept': 'application/vnd.github+json'
                }
            });
            if (!res.ok) return [];
            return await res.json();
        } catch(e) { return []; }
    }

    // Restore from a specific commit
    async function restoreFromCommit(commitSha) {
        if (!_token) return null;
        try {
            const parsed = (await _fetchFile(commitSha)).data;
            // Validate restored data has meaningful content
            const restoredCount = countRecords(parsed);
            if (restoredCount < 5) {
                console.warn('Restore BLOCKED: commit contains too few records (' + restoredCount + ')');
                return null;
            }
            return parsed;
        } catch(e) { return null; }
    }

    async function logout() {
        if (_isDirty()) {
            if (_dataLoaded && navigator.onLine) {
                try { const c = JSON.parse(localStorage.getItem('db_cache')); if (c) { _lastHash = ''; await saveData(c); } } catch (e) {}
            }
            if (_isDirty() && !confirm('Есть изменения, которые ещё не сохранены в GitHub. Выйти и потерять их?')) return;
        }
        stopPolling();
        localStorage.removeItem('db_base');
        localStorage.removeItem('db_dirty');
        localStorage.removeItem('auth_session');
        localStorage.removeItem('db_cache');
        localStorage.removeItem('db_cache_sha');
        localStorage.removeItem('gh_token');
        localStorage.removeItem('_ek');
        localStorage.removeItem('_ss');
        _token = null;
        window.location.href = 'index.html';
    }

    // ---- User management (users.json in data branch) ----
    const USERS_FILE = 'users.json';
    let _usersSha = null;

    async function loadUsers() {
        if (!_token) return [];
        try {
            const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${USERS_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`;
            const res = await fetchWithTimeout(url, {
                headers: { 'Authorization': 'token ' + _token, 'Accept': 'application/vnd.github+json' },
                cache: 'no-store'
            });
            if (!res.ok) return [];
            const fileData = await res.json();
            _usersSha = fileData.sha;
            const decoded = b64DecodeUTF8(fileData.content);
            return JSON.parse(decoded);
        } catch(e) {
            console.error('loadUsers error');
            return [];
        }
    }

    async function saveUsers(users) {
        if (!_token) return false;
        try {
            // Reload SHA to avoid conflicts
            if (!_usersSha) {
                const chk = await fetchWithTimeout(`${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${USERS_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`, {
                    headers: { 'Authorization': 'token ' + _token, 'Accept': 'application/vnd.github+json' },
                    cache: 'no-store'
                });
                if (chk.ok) { const d = await chk.json(); _usersSha = d.sha; }
            }
            const body = {
                message: 'Update users ' + new Date().toLocaleString('ru-RU'),
                content: b64EncodeUTF8(JSON.stringify(users, null, 2)),
                branch: DATA_BRANCH
            };
            if (_usersSha) body.sha = _usersSha;
            const res = await fetchWithTimeout(`${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${USERS_FILE}`, {
                method: 'PUT',
                headers: { 'Authorization': 'token ' + _token, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error('Save users failed: ' + res.status);
            const result = await res.json();
            _usersSha = result.content.sha;
            return true;
        } catch(e) {
            console.error('saveUsers error');
            return false;
        }
    }

    // Session signing — per-installation random secret
    function _getSessionSecret() {
        let secret = localStorage.getItem('_ss');
        if (!secret) {
            const arr = new Uint8Array(32);
            crypto.getRandomValues(arr);
            secret = btoa(String.fromCharCode(...arr));
            localStorage.setItem('_ss', secret);
        }
        return secret;
    }
    function signSession(sessionObj) {
        const payload = sessionObj.name + '|' + sessionObj.role + '|' + sessionObj.expires + '|' + _getSessionSecret();
        let h = 0x811c9dc5;
        for (let i = 0; i < payload.length; i++) {
            h = Math.imul(h ^ payload.charCodeAt(i), 0x01000193);
        }
        return (h >>> 0).toString(36);
    }

    function createSession(name, role) {
        const session = {
            authenticated: true,
            name: name,
            role: role || 'user',
            expires: Date.now() + 24 * 60 * 60 * 1000
        };
        session.sig = signSession(session);
        return session;
    }

    function verifySession(session) {
        if (!session || !session.authenticated || !session.expires || !session.sig) return false;
        if (session.expires <= Date.now()) return false;
        return session.sig === signSession(session);
    }

    // FNV-1a 52-bit hash — much lower collision rate than 32-bit
    function hashData(obj) {
        const str = JSON.stringify(obj);
        let h1 = 0x811c9dc5, h2 = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 0x01000193);
            h2 = Math.imul(h2 ^ (ch >>> 0), 0x00000193);
        }
        return h1.toString(36) + '-' + h2.toString(36);
    }

    let _lastFailedData = null;
    let _mergedFrom = null;

    function showSyncStatus(status) {
        const el = document.getElementById('syncStatus');
        if (!el) return;
        const states = {
            saving: { text: 'Сохранение...', color: '#ff9800' },
            saved: { text: 'Сохранено в GitHub', color: '#4caf50' },
            synced: { text: 'Синхронизировано', color: '#2196f3' },
            error: { text: 'Ошибка сохранения! [повторить]', color: '#f44336' },
            offline: { text: 'Нет сети — изменения сохраняются локально', color: '#999' },
            loadError: { text: 'Нет связи с GitHub — изменения сохраняются локально', color: '#f44336' },
            quota: { text: 'Локальное хранилище переполнено!', color: '#f44336' }
        };
        const s = states[status] || states.saved;
        el.textContent = s.text;
        el.style.color = s.color;
        if (status === 'error') {
            el.style.cursor = 'pointer';
            el.onclick = function() {
                if (_lastFailedData) {
                    el.onclick = null;
                    el.style.cursor = '';
                    saveData(_lastFailedData);
                    _lastFailedData = null;
                }
            };
        } else {
            el.style.cursor = '';
            el.onclick = null;
            _lastFailedData = null;
        }
        if (status === 'saved' || status === 'synced') {
            setTimeout(() => {
                if (el.textContent === s.text) {
                    el.textContent = 'GitHub';
                    el.style.color = '#4caf50';
                }
            }, 3000);
        }
    }

    return {
        onSave: function(cb) { _onSaveCallback = cb; },
        onDataLoaded: function(cb) { _onDataLoaded = cb; },
        onRemote: function(cb) { _onRemoteCallback = cb; },
        merge3, needsSave, pollOnce,
        init, getToken, setToken, clearToken, validateToken,
        loadData, scheduleSave, forceSave, isDataLoaded,
        startPolling, stopPolling,
        getHistory, restoreFromCommit,
        logout, showSyncStatus,
        loadUsers, saveUsers,
        createSession, verifySession
    };
})();
