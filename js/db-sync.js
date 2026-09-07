// ============================================
// GitHub API Database Synchronization Module
// Stores data as JSON in a 'data' branch
// Every save = git commit = automatic backup
// ============================================

const DbSync = (function() {
    const REPO_OWNER = 'NBA1121-ai';
    const REPO_NAME = '1c-accounting';
    const DATA_BRANCH = 'data';
    const DATA_FILE = 'db.json';
    const API_BASE = 'https://api.github.com';
    const SAVE_DELAY = 2000;

    let _token = null;
    let _saveTimer = null;
    let _saving = false;
    let _fileSha = null;
    let _lastHash = '';
    let _pollTimer = null;

    function init() {
        _token = localStorage.getItem('gh_token');
    }

    function getToken() {
        return _token;
    }

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
            const user = await res.json();
            return user;
        } catch(e) {
            return null;
        }
    }

    async function loadData() {
        if (!_token) return null;

        try {
            const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`;
            const res = await fetch(url, {
                headers: {
                    'Authorization': 'token ' + _token,
                    'Accept': 'application/vnd.github.v3+json'
                },
                cache: 'no-store'
            });

            if (!res.ok) {
                if (res.status === 404) return null; // File doesn't exist yet
                throw new Error('GitHub API error: ' + res.status);
            }

            const fileData = await res.json();
            _fileSha = fileData.sha;

            const content = atob(fileData.content.replace(/\n/g, ''));
            // Decode UTF-8 properly
            const decoded = decodeURIComponent(escape(content));
            const parsed = JSON.parse(decoded);

            _lastHash = hashData(parsed);

            // Cache locally
            try { localStorage.setItem('db_cache', JSON.stringify(parsed)); } catch(e) {}

            return parsed;
        } catch(err) {
            console.error('Load error:', err);
            // Fallback to local cache
            try {
                const cached = localStorage.getItem('db_cache');
                if (cached) return JSON.parse(cached);
            } catch(e) {}
            return null;
        }
    }

    function scheduleSave(dbObject) {
        if (_saveTimer) clearTimeout(_saveTimer);
        // Cache locally immediately
        try { localStorage.setItem('db_cache', JSON.stringify(dbObject)); } catch(e) {}
        _saveTimer = setTimeout(() => saveData(dbObject), SAVE_DELAY);
    }

    async function saveData(dbObject) {
        if (!_token || _saving) return;

        const currentHash = hashData(dbObject);
        if (currentHash === _lastHash) return;

        _saving = true;
        showSyncStatus('saving');

        try {
            // Encode content as base64 (handle UTF-8)
            const jsonStr = JSON.stringify(dbObject, null, 2);
            const utf8 = unescape(encodeURIComponent(jsonStr));
            const base64 = btoa(utf8);

            const body = {
                message: 'Update data ' + new Date().toLocaleString('ru-RU'),
                content: base64,
                branch: DATA_BRANCH
            };

            // Include SHA if we have it (required for updates)
            if (_fileSha) {
                body.sha = _fileSha;
            }

            const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}`;
            const res = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': 'token ' + _token,
                    'Content-Type': 'application/json',
                    'Accept': 'application/vnd.github.v3+json'
                },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                // SHA conflict - reload and retry
                if (res.status === 409 || (res.status === 422 && errData.message && errData.message.includes('sha'))) {
                    console.warn('SHA conflict, reloading...');
                    await reloadSha();
                    _saving = false;
                    return saveData(dbObject);
                }
                throw new Error('Save failed: ' + res.status + ' ' + (errData.message || ''));
            }

            const result = await res.json();
            _fileSha = result.content.sha;
            _lastHash = currentHash;
            showSyncStatus('saved');
        } catch(err) {
            console.error('Save error:', err);
            showSyncStatus('error');
        } finally {
            _saving = false;
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
                    'Accept': 'application/vnd.github.v3+json'
                },
                cache: 'no-store'
            });
            if (res.ok) {
                const data = await res.json();
                _fileSha = data.sha;
            }
        } catch(e) {}
    }

    // Poll for changes from other devices (every 30 seconds)
    function startPolling(callback) {
        if (_pollTimer) clearInterval(_pollTimer);
        _pollTimer = setInterval(async () => {
            if (_saving || !_token) return;
            try {
                const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}?ref=${DATA_BRANCH}&_t=${Date.now()}`;
                const res = await fetch(url, {
                    headers: {
                        'Authorization': 'token ' + _token,
                        'Accept': 'application/vnd.github.v3+json'
                    },
                    cache: 'no-store'
                });
                if (!res.ok) return;
                const fileData = await res.json();

                if (fileData.sha !== _fileSha) {
                    _fileSha = fileData.sha;
                    const content = atob(fileData.content.replace(/\n/g, ''));
                    const decoded = decodeURIComponent(escape(content));
                    const parsed = JSON.parse(decoded);
                    const newHash = hashData(parsed);

                    if (newHash !== _lastHash) {
                        _lastHash = newHash;
                        callback(parsed);
                        showSyncStatus('synced');
                    }
                }
            } catch(e) {}
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
                    'Accept': 'application/vnd.github.v3+json'
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
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            if (!res.ok) return null;
            const fileData = await res.json();
            const content = atob(fileData.content.replace(/\n/g, ''));
            const decoded = decodeURIComponent(escape(content));
            return JSON.parse(decoded);
        } catch(e) { return null; }
    }

    function logout() {
        stopPolling();
        clearToken();
        window.location.href = 'index.html';
    }

    function hashData(obj) {
        const str = JSON.stringify(obj);
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return String(hash);
    }

    function showSyncStatus(status) {
        const el = document.getElementById('syncStatus');
        if (!el) return;
        const states = {
            saving: { text: 'Сохранение...', color: '#ff9800' },
            saved: { text: 'Сохранено в GitHub', color: '#4caf50' },
            synced: { text: 'Синхронизировано', color: '#2196f3' },
            error: { text: 'Ошибка сохранения!', color: '#f44336' }
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
        init,
        getToken,
        setToken,
        clearToken,
        validateToken,
        loadData,
        scheduleSave,
        forceSave,
        startPolling,
        stopPolling,
        getHistory,
        restoreFromCommit,
        logout,
        showSyncStatus
    };
})();
