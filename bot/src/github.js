// Чтение и запись базы сайта (db.json в репозитории данных на GitHub).
// Сайт и бот пишут в один файл: при конфликте версий бот перечитывает файл и повторяет своё изменение.

const API = 'https://api.github.com';

function b64ToText(b64) {
    const bin = atob(b64.replace(/\n/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}
function textToB64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

let cache = null; // { at, db, sha, key }

export class DataStore {
    constructor(env) {
        this.token = env.GITHUB_TOKEN;
        this.owner = env.DATA_OWNER || 'NBA1121-ai';
        this.repo = env.DATA_REPO || 'my-buh-dev-data';
        this.branch = env.DATA_BRANCH || 'data';
        this.file = env.DATA_FILE || 'db.json';
        this.key = `${this.owner}/${this.repo}/${this.branch}/${this.file}`;
    }
    headers(accept) {
        return { 'Authorization': 'Bearer ' + this.token, 'Accept': accept || 'application/vnd.github+json', 'User-Agent': 'esep-telegram-bot', 'X-GitHub-Api-Version': '2022-11-28' };
    }
    url() { return `${API}/repos/${this.owner}/${this.repo}/contents/${this.file}`; }

    // Свежая версия базы. maxAgeMs > 0 — можно взять из кэша (для справок), 0 — всегда с GitHub (перед записью)
    async load(maxAgeMs = 0) {
        if (maxAgeMs && cache && cache.key === this.key && Date.now() - cache.at < maxAgeMs) return { db: cache.db, sha: cache.sha, pretty: cache.pretty };
        const u = this.url() + '?ref=' + encodeURIComponent(this.branch) + '&_t=' + Date.now();
        const res = await fetch(u, { headers: this.headers() });
        if (!res.ok) throw new Error('GitHub: не удалось прочитать базу (' + res.status + ')');
        const meta = await res.json();
        let text;
        if (meta.content && meta.encoding === 'base64') text = b64ToText(meta.content);
        else {
            // Файл больше 1 МБ — читаем «сырым»
            const raw = await fetch(u, { headers: this.headers('application/vnd.github.raw+json') });
            if (!raw.ok) throw new Error('GitHub: не удалось прочитать базу (' + raw.status + ')');
            text = await raw.text();
        }
        const db = JSON.parse(text);
        const pretty = /^\{\s*\n\s+"/.test(text); // сохраняем тот же формат, что у сайта
        cache = { at: Date.now(), db, sha: meta.sha, pretty, key: this.key };
        return { db, sha: meta.sha, pretty };
    }

    // Изменить базу: mutate(db) меняет объект и возвращает результат; при конфликте — повтор на свежей версии
    async update(mutate, message) {
        for (let attempt = 0; attempt < 5; attempt++) {
            const { db, sha, pretty } = await this.load(0);
            const result = await mutate(db);
            if (result === false) return false;
            const body = JSON.stringify({ message: message || 'Telegram-бот', content: textToB64(pretty ? JSON.stringify(db, null, 2) : JSON.stringify(db)), sha, branch: this.branch });
            const res = await fetch(this.url(), { method: 'PUT', headers: Object.assign(this.headers(), { 'Content-Type': 'application/json' }), body });
            if (res.ok) {
                const j = await res.json();
                cache = { at: Date.now(), db, sha: j.content && j.content.sha, pretty, key: this.key };
                return result;
            }
            if (res.status === 409 || res.status === 422) { cache = null; await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
            throw new Error('GitHub: не удалось сохранить (' + res.status + ')');
        }
        throw new Error('GitHub: база постоянно меняется, попробуйте ещё раз');
    }
}
