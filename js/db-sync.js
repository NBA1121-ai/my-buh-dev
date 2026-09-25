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
    let _awaitingConfirm = false;

    function countRecords(obj) {
        let total = 0;
        for (const key in obj) {
            if (Array.isArray(obj[key])) total += obj[key].length;
        }
        return total;
    }

    function showDataLossConfirm(oldCount, newCount) {
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
                    <p style="margin-bottom:20px;color:#d32f2f;font-size:13px;">Вы уверены, что хотите сохранить эти изменения?</p>
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
        // Force clear cache (one-time reset)
        if (localStorage.getItem('db_reset') !== 'r6') {
            localStorage.removeItem('db_cache');
            localStorage.removeItem('db_cache_sha');
            localStorage.removeItem('offline_pending');
            localStorage.setItem('db_reset', 'r6');
        }
        // When browser comes back online, send queued offline data
        window.addEventListener('online', () => {
            const pending = _offlinePending || _loadOfflinePending();
            if (pending) {
                _offlinePending = null;
                localStorage.removeItem('offline_pending');
                showSyncStatus('saving');
                _lastHash = ''; // force save
                setTimeout(() => saveData(pending), 1000);
            }
        });
        // On startup: if online and have pending offline data, sync immediately
        if (navigator.onLine) {
            const pending = _loadOfflinePending();
            if (pending) {
                localStorage.removeItem('offline_pending');
                _lastHash = '';
                setTimeout(() => saveData(pending), 2000);
            }
        }
    }

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

    async function loadData() {
        if (!_token) return null;

        // Offline — immediately return cached data, no waiting for timeout
        if (!navigator.onLine) {
            try {
                const cached = localStorage.getItem('db_cache');
                if (cached) {
                    const parsed = JSON.parse(cached);
                    _lastHash = hashData(parsed);
                    _lastSavedSize = countRecords(parsed);
                    _dataLoaded = true;
                    showSyncStatus('offline');
                    return parsed;
                }
            } catch(e) {}
            return null;
        }

        try {
            // Step 1: Get file metadata (sha, size)
            const metaUrl = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`;
            const metaRes = await fetchWithTimeout(metaUrl, {
                headers: {
                    'Authorization': 'token ' + _token,
                    'Accept': 'application/vnd.github+json'
                },
                cache: 'no-store'
            });

            if (!metaRes.ok) {
                if (metaRes.status === 404) return null;
                throw new Error('GitHub API error: ' + metaRes.status);
            }

            const fileData = await metaRes.json();
            _fileSha = fileData.sha;

            // Check if cache is current (same SHA = same data, skip download)
            const cachedSha = localStorage.getItem('db_cache_sha');
            if (cachedSha === _fileSha) {
                try {
                    const cached = localStorage.getItem('db_cache');
                    if (cached) {
                        const parsed = JSON.parse(cached);
                        _lastHash = hashData(parsed);
                        _lastSavedSize = countRecords(parsed);
                        _dataLoaded = true;
                        return parsed;
                    }
                } catch(e) {}
            }

            let parsed;

            // Step 2: If file has content (< 1MB), decode directly; otherwise use raw download
            if (fileData.content) {
                const decoded = b64DecodeUTF8(fileData.content);
                parsed = JSON.parse(decoded);
            } else {
                // Large file — download via raw URL
                const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${DATA_BRANCH}/${DATA_FILE}?_t=${Date.now()}`;
                const rawRes = await fetchWithTimeout(rawUrl, { cache: 'no-store' });
                if (!rawRes.ok) throw new Error('Raw download error: ' + rawRes.status);
                parsed = await rawRes.json();
            }

            _lastHash = hashData(parsed);
            _lastSavedSize = countRecords(parsed);
            _dataLoaded = true;

            // Cache locally with SHA for offline fallback
            try {
                localStorage.setItem('db_cache', JSON.stringify(parsed));
                localStorage.setItem('db_cache_sha', _fileSha);
            } catch(e) {}

            return parsed;
        } catch(err) {
            console.error('Load error');
            // Fallback to local cache ONLY if GitHub is unreachable
            try {
                const cached = localStorage.getItem('db_cache');
                if (cached) {
                    showSyncStatus('offline');
                    return JSON.parse(cached);
                }
            } catch(e) {}
            return null;
        }
    }

    function isDataLoaded() { return _dataLoaded; }

    function scheduleSave(dbObject) {
        // Don't save until data is loaded from GitHub (prevents overwriting with stale cache)
        if (!_dataLoaded) return;
        if (_saveTimer) clearTimeout(_saveTimer);
        // Cache locally immediately (protection against browser close)
        try { localStorage.setItem('db_cache', JSON.stringify(dbObject)); } catch(e) {}

        if (_saving) {
            // Queue latest state — will be saved after current save finishes
            _pendingSave = dbObject;
            return;
        }
        _saveTimer = setTimeout(() => saveData(dbObject), SAVE_DELAY);
    }

    async function saveData(dbObject, retryCount) {
        if (!_token || _saving) {
            if (_saving) _pendingSave = dbObject;
            return;
        }

        retryCount = retryCount ?? 0;

        const currentHash = hashData(dbObject);
        if (currentHash === _lastHash) return;

        // Data loss protection: if records decreased by ≥20%, ask for confirmation
        if (_lastSavedSize > 0 && retryCount === 0) {
            const newSize = countRecords(dbObject);
            if (newSize < _lastSavedSize * 0.8) {
                if (_awaitingConfirm) return;
                const confirmed = await showDataLossConfirm(_lastSavedSize, newSize);
                if (!confirmed) {
                    showSyncStatus('error');
                    return;
                }
            }
        }

        _saving = true;
        showSyncStatus('saving');

        try {
            if (!navigator.onLine) {
                showSyncStatus('offline');
                _saving = false;
                _offlinePending = dbObject;
                try { localStorage.setItem('offline_pending', JSON.stringify(dbObject)); } catch(e) {}
                return;
            }

            const jsonStr = JSON.stringify(dbObject, null, 2);
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
                    console.warn('SHA conflict, retry', retryCount + 1);
                    await reloadSha();
                    _saving = false;
                    await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
                    return await saveData(dbObject, retryCount + 1);
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
            // Update cache SHA so next load won't re-download
            try { localStorage.setItem('db_cache_sha', _fileSha); } catch(e) {}
            showSyncStatus('saved');
            if (_onSaveCallback) _onSaveCallback(true);
        } catch(err) {
            console.error('Save error');
            _lastFailedData = dbObject;
            showSyncStatus('error');
            if (_onSaveCallback) _onSaveCallback(false);
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
        if (_saveTimer) clearTimeout(_saveTimer);
        await saveData(dbObject);
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

    // Poll for changes from other devices (every 30 seconds)
    function startPolling(callback) {
        if (_pollTimer) clearInterval(_pollTimer);
        _pollTimer = setInterval(async () => {
            if (_saving || !_token || !navigator.onLine) return;
            try {
                const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`;
                const res = await fetchWithTimeout(url, {
                    headers: {
                        'Authorization': 'token ' + _token,
                        'Accept': 'application/vnd.github+json'
                    },
                    cache: 'no-store'
                });
                if (!res.ok) return;
                const fileData = await res.json();

                if (fileData.sha !== _fileSha) {
                    _fileSha = fileData.sha;
                    let parsed;
                    if (fileData.content) {
                        const decoded = b64DecodeUTF8(fileData.content);
                        parsed = JSON.parse(decoded);
                    } else {
                        const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${DATA_BRANCH}/${DATA_FILE}?_t=${Date.now()}`;
                        const rawRes = await fetchWithTimeout(rawUrl, { cache: 'no-store' });
                        if (!rawRes.ok) return;
                        parsed = await rawRes.json();
                    }
                    const newHash = hashData(parsed);

                    if (newHash !== _lastHash) {
                        _lastHash = newHash;
                        // Update cache with new data
                        try {
                            localStorage.setItem('db_cache', JSON.stringify(parsed));
                            localStorage.setItem('db_cache_sha', _fileSha);
                        } catch(e) {}
                        callback(parsed);
                        showSyncStatus('synced');
                    }
                }
            } catch(e) {
                console.warn('Polling error:', e);
            }
        }, 30000);
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
            const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}?ref=${commitSha}`;
            const res = await fetchWithTimeout(url, {
                headers: {
                    'Authorization': 'token ' + _token,
                    'Accept': 'application/vnd.github+json'
                }
            });
            if (!res.ok) return null;
            const fileData = await res.json();
            const decoded = b64DecodeUTF8(fileData.content);
            return JSON.parse(decoded);
        } catch(e) { return null; }
    }

    function logout() {
        stopPolling();
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

    function showSyncStatus(status) {
        const el = document.getElementById('syncStatus');
        if (!el) return;
        const states = {
            saving: { text: 'Сохранение...', color: '#ff9800' },
            saved: { text: 'Сохранено в GitHub', color: '#4caf50' },
            synced: { text: 'Синхронизировано', color: '#2196f3' },
            error: { text: 'Ошибка сохранения! [повторить]', color: '#f44336' },
            offline: { text: 'Нет сети', color: '#999' }
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
        init, getToken, setToken, clearToken, validateToken,
        loadData, scheduleSave, forceSave, isDataLoaded,
        startPolling, stopPolling,
        getHistory, restoreFromCommit,
        logout, showSyncStatus,
        loadUsers, saveUsers,
        createSession, verifySession
    };
})();
