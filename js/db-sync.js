// ============================================
// GitHub API Database Synchronization Module
// Stores data as JSON in a 'data' branch
// Every save = git commit = automatic backup
// ============================================

const DbSync = (function() {
    const REPO_OWNER = 'NBA1121-ai';
    const REPO_NAME = 'my-buh';
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

    function init() {
        _token = localStorage.getItem('gh_token');
    }

    function getToken() { return _token; }

    function setToken(token) {
        _token = token;
        localStorage.setItem('gh_token', token);
    }

    function clearToken() {
        _token = null;
        localStorage.removeItem('gh_token');
    }

    async function validateToken(token) {
        try {
            const res = await fetch(API_BASE + '/user', {
                headers: { 'Authorization': 'token ' + token }
            });
            if (!res.ok) return null;
            return await res.json();
        } catch(e) {
            return null;
        }
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

        try {
            // Step 1: Get file metadata (sha, size)
            const metaUrl = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`;
            const metaRes = await fetch(metaUrl, {
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
                const rawRes = await fetch(rawUrl, {
                    headers: { 'Authorization': 'token ' + _token },
                    cache: 'no-store'
                });
                if (!rawRes.ok) throw new Error('Raw download error: ' + rawRes.status);
                parsed = await rawRes.json();
            }

            _lastHash = hashData(parsed);
            _dataLoaded = true;

            // Cache locally with SHA for offline fallback
            try {
                localStorage.setItem('db_cache', JSON.stringify(parsed));
                localStorage.setItem('db_cache_sha', _fileSha);
            } catch(e) {}

            return parsed;
        } catch(err) {
            console.error('Load error:', err);
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

        retryCount = retryCount || 0;

        const currentHash = hashData(dbObject);
        if (currentHash === _lastHash) return;

        _saving = true;
        showSyncStatus('saving');

        try {
            if (!navigator.onLine) {
                showSyncStatus('offline');
                _saving = false;
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
            const res = await fetch(url, {
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
                    // Small delay before retry
                    await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
                    return await saveData(dbObject, retryCount + 1);
                }
                throw new Error('Save failed: ' + res.status + ' ' + (errData.message || ''));
            }

            const result = await res.json();
            _fileSha = result.content.sha;
            _lastHash = currentHash;
            // Update cache SHA so next load won't re-download
            try { localStorage.setItem('db_cache_sha', _fileSha); } catch(e) {}
            showSyncStatus('saved');
        } catch(err) {
            console.error('Save error:', err);
            showSyncStatus('error');
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
            const res = await fetch(url, {
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
            console.error('reloadSha error:', e);
        }
    }

    // Poll for changes from other devices (every 30 seconds)
    function startPolling(callback) {
        if (_pollTimer) clearInterval(_pollTimer);
        _pollTimer = setInterval(async () => {
            if (_saving || !_token || !navigator.onLine) return;
            try {
                const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`;
                const res = await fetch(url, {
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
                        const rawRes = await fetch(rawUrl, {
                            headers: { 'Authorization': 'token ' + _token },
                            cache: 'no-store'
                        });
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
            const res = await fetch(url, {
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
            const res = await fetch(url, {
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
        window.location.href = 'index.html';
    }

    // ---- User management (users.json in data branch) ----
    const USERS_FILE = 'users.json';
    let _usersSha = null;

    async function loadUsers() {
        if (!_token) return [];
        try {
            const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${USERS_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`;
            const res = await fetch(url, {
                headers: { 'Authorization': 'token ' + _token, 'Accept': 'application/vnd.github+json' },
                cache: 'no-store'
            });
            if (!res.ok) return [];
            const fileData = await res.json();
            _usersSha = fileData.sha;
            const decoded = b64DecodeUTF8(fileData.content);
            return JSON.parse(decoded);
        } catch(e) {
            console.error('loadUsers error:', e);
            return [];
        }
    }

    async function saveUsers(users) {
        if (!_token) return false;
        try {
            // Reload SHA to avoid conflicts
            if (!_usersSha) {
                const chk = await fetch(`${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${USERS_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`, {
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
            const res = await fetch(`${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${USERS_FILE}`, {
                method: 'PUT',
                headers: { 'Authorization': 'token ' + _token, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error('Save users failed: ' + res.status);
            const result = await res.json();
            _usersSha = result.content.sha;
            return true;
        } catch(e) {
            console.error('saveUsers error:', e);
            return false;
        }
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

    function showSyncStatus(status) {
        const el = document.getElementById('syncStatus');
        if (!el) return;
        const states = {
            saving: { text: 'Сохранение...', color: '#ff9800' },
            saved: { text: 'Сохранено в GitHub', color: '#4caf50' },
            synced: { text: 'Синхронизировано', color: '#2196f3' },
            error: { text: 'Ошибка сохранения!', color: '#f44336' },
            offline: { text: 'Нет сети', color: '#999' }
        };
        const s = states[status] || states.saved;
        el.textContent = s.text;
        el.style.color = s.color;
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
        init, getToken, setToken, clearToken, validateToken,
        loadData, scheduleSave, forceSave, isDataLoaded,
        startPolling, stopPolling,
        getHistory, restoreFromCommit,
        logout, showSyncStatus,
        loadUsers, saveUsers
    };
})();
