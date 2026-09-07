// ============================================
// Database Synchronization Module
// Handles Supabase data storage with auto-save,
// conflict resolution, and offline fallback
// ============================================

const DbSync = (function() {
    let _supabase = null;
    let _userId = null;
    let _saveTimer = null;
    let _lastHash = '';
    let _saving = false;
    let _initialized = false;
    let _onDataLoaded = null;
    let _channel = null;

    const SAVE_DELAY = 1500; // ms debounce before saving

    function init(supabaseClient, onDataLoaded) {
        _supabase = supabaseClient;
        _onDataLoaded = onDataLoaded;
    }

    async function checkAuth() {
        const { data: { session } } = await _supabase.auth.getSession();
        if (!session) {
            window.location.href = 'index.html';
            return null;
        }
        _userId = session.user.id;
        return session;
    }

    async function loadData() {
        if (!_userId) return null;

        try {
            const { data, error } = await _supabase
                .from('app_data')
                .select('data, updated_at')
                .eq('user_id', _userId)
                .maybeSingle();

            if (error) throw error;

            if (data && data.data) {
                _lastHash = hashData(data.data);
                _initialized = true;
                return data.data;
            }

            // No data yet - return null to use defaults
            _initialized = true;
            return null;
        } catch (err) {
            console.error('Load error:', err);
            // Try to use localStorage as fallback
            const cached = localStorage.getItem('bankCashData_cache');
            if (cached) {
                try {
                    return JSON.parse(cached);
                } catch(e) {}
            }
            return null;
        }
    }

    function scheduleSave(dbObject) {
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => saveData(dbObject), SAVE_DELAY);

        // Also cache locally for offline resilience
        try {
            localStorage.setItem('bankCashData_cache', JSON.stringify(dbObject));
        } catch(e) {}
    }

    async function saveData(dbObject) {
        if (!_userId || _saving) return;

        const currentHash = hashData(dbObject);
        if (currentHash === _lastHash) return; // No changes

        _saving = true;
        showSyncStatus('saving');

        try {
            const { error } = await _supabase
                .from('app_data')
                .upsert({
                    user_id: _userId,
                    data: dbObject,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });

            if (error) throw error;

            _lastHash = currentHash;
            showSyncStatus('saved');
        } catch (err) {
            console.error('Save error:', err);
            showSyncStatus('error');
        } finally {
            _saving = false;
        }
    }

    // Force immediate save (for critical operations)
    async function forceSave(dbObject) {
        if (_saveTimer) clearTimeout(_saveTimer);
        await saveData(dbObject);
    }

    // Subscribe to real-time changes (for multi-device sync)
    function subscribeToChanges(callback) {
        if (!_supabase || !_userId) return;

        _channel = _supabase
            .channel('app_data_changes')
            .on('postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'app_data',
                    filter: `user_id=eq.${_userId}`
                },
                (payload) => {
                    if (payload.new && payload.new.data) {
                        const newHash = hashData(payload.new.data);
                        if (newHash !== _lastHash && !_saving) {
                            _lastHash = newHash;
                            callback(payload.new.data);
                            showSyncStatus('synced');
                        }
                    }
                }
            )
            .subscribe();
    }

    function unsubscribe() {
        if (_channel) {
            _supabase.removeChannel(_channel);
            _channel = null;
        }
    }

    async function logout() {
        unsubscribe();
        await _supabase.auth.signOut();
        localStorage.removeItem('bankCashData_cache');
        window.location.href = 'index.html';
    }

    // Simple hash for change detection
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

    // Sync status indicator
    function showSyncStatus(status) {
        const el = document.getElementById('syncStatus');
        if (!el) return;

        const states = {
            saving: { text: 'Сохранение...', color: '#ff9800' },
            saved: { text: 'Сохранено', color: '#4caf50' },
            synced: { text: 'Синхронизировано', color: '#2196f3' },
            error: { text: 'Ошибка сохранения', color: '#f44336' },
            offline: { text: 'Офлайн режим', color: '#999' }
        };

        const s = states[status] || states.saved;
        el.textContent = s.text;
        el.style.color = s.color;

        if (status === 'saved' || status === 'synced') {
            setTimeout(() => {
                if (el.textContent === s.text) {
                    el.textContent = 'Облако';
                    el.style.color = '#4caf50';
                }
            }, 3000);
        }
    }

    // Create backup
    async function createBackup(dbObject) {
        if (!_userId) return;
        try {
            await _supabase.from('backups').insert({
                user_id: _userId,
                data: dbObject,
                note: 'Manual backup ' + new Date().toLocaleString('ru-RU')
            });
            return true;
        } catch(e) {
            console.error('Backup error:', e);
            return false;
        }
    }

    // List backups
    async function listBackups() {
        if (!_userId) return [];
        try {
            const { data } = await _supabase
                .from('backups')
                .select('id, created_at, note')
                .eq('user_id', _userId)
                .order('created_at', { ascending: false })
                .limit(20);
            return data || [];
        } catch(e) { return []; }
    }

    // Restore from backup
    async function restoreBackup(backupId) {
        if (!_userId) return null;
        try {
            const { data } = await _supabase
                .from('backups')
                .select('data')
                .eq('id', backupId)
                .eq('user_id', _userId)
                .single();
            return data ? data.data : null;
        } catch(e) { return null; }
    }

    return {
        init,
        checkAuth,
        loadData,
        scheduleSave,
        forceSave,
        subscribeToChanges,
        unsubscribe,
        logout,
        createBackup,
        listBackups,
        restoreBackup,
        showSyncStatus
    };
})();
