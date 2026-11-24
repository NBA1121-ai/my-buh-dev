// Точка входа Cloudflare Worker: вебхук Telegram и одноразовая настройка
import { Bot } from './bot.js';
import fontRegular from './fonts/DejaVuSans.ttf';
import fontBold from './fonts/DejaVuSans-Bold.ttf';

const fonts = { regular: fontRegular, bold: fontBold };

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        // Telegram присылает обновления сюда
        if (request.method === 'POST' && url.pathname === '/webhook') {
            if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
            const update = await request.json();
            const bot = new Bot(env, fonts);
            // Отвечаем Telegram сразу, работу доделываем в фоне (чтобы Telegram не слал повторы)
            ctx.waitUntil(bot.handle(update).catch(e => console.log('handle error', e && e.stack || e)));
            return new Response('ok');
        }
        // Один раз открыть в браузере: https://<адрес>/setup?key=<WEBHOOK_SECRET>
        if (url.pathname === '/setup') {
            if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('Неверный ключ', { status: 403 });
            const missing = ['BOT_TOKEN', 'GITHUB_TOKEN', 'ADMIN_IDS', 'WEBHOOK_SECRET'].filter(k => !env[k]);
            if (missing.length) return new Response('Не заданы секреты: ' + missing.join(', '), { status: 500 });
            const tg = (m, p) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(r => r.json());
            const hook = await tg('setWebhook', { url: url.origin + '/webhook', secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
            await tg('setMyCommands', { commands: [{ command: 'start', description: 'Главное меню' }, { command: 'cancel', description: 'Отменить текущий документ' }, { command: 'id', description: 'Мой Telegram ID' }] });
            // Проверка доступа к базе
            let dbCheck = 'ok';
            try { const r = await fetch(`https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${env.DATA_FILE || 'db.json'}?ref=${env.DATA_BRANCH || 'data'}`, { method: 'HEAD', headers: { Authorization: 'Bearer ' + env.GITHUB_TOKEN, 'User-Agent': 'esep-telegram-bot' } }); dbCheck = r.ok ? 'ok' : 'ошибка ' + r.status; } catch (e) { dbCheck = 'ошибка ' + e.message; }
            const me = await tg('getMe', {});
            return new Response(`Бот: @${me.result && me.result.username}\nВебхук: ${hook.ok ? 'установлен' : 'ошибка — ' + hook.description}\nДоступ к базе ${env.DATA_REPO}: ${dbCheck}\n\nГотово — напишите боту /start в Telegram.`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        return new Response('EsepOnline Telegram bot', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    },
};
