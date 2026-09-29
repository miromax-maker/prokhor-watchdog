// Сторож бота «Прохор» (Pro Город). Запускается GitHub Actions раз в 10 минут — со стороны, не с сервера бота:
// если сервер или n8n упали, сам бот о себе сообщить уже не может.
// Проверка: GET HEALTH_URL → 200 и {"ok":true} (n8n жив, вебхуки на месте, база бота отвечает). Две попытки через 30 с.
// Сообщения в VK от сообщества тревог одному человеку (VK_PEER):
//   упал  → «🔴 Бот не отвечает с 14:20 (МСК)»;  лежит дальше → напоминание раз в час;  поднялся → «🟢 Бот снова работает».
// Состояние — в state.json (коммитится воркфлоу); раз в 30 дней отметка keepalive, чтобы GitHub не выключил
// расписание (он выключает его после 60 дней без изменений в репозитории).
// Переменные: HEALTH_URL, VK_TOKEN, VK_PEER — секреты репозитория; VK_API_URL и STATE_FILE — только для тестов.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { HEALTH_URL, VK_TOKEN, VK_PEER } = process.env;
const VK_API = process.env.VK_API_URL || 'https://api.vk.com/method';
const STATE_FILE = process.env.STATE_FILE || new URL('./state.json', import.meta.url);
const RETRY_MS = Number(process.env.RETRY_MS || 30000);
const now = Date.now();
if (!HEALTH_URL || !VK_TOKEN || !VK_PEER) { console.error('нет секретов HEALTH_URL / VK_TOKEN / VK_PEER'); process.exit(1); }

const load = () => { try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {}; } catch { return {}; } };
const state = load();
const before = JSON.stringify(state);
const msk = t => new Date(t).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const mins = ms => Math.max(1, Math.round(ms / 60000));
const dur = ms => { const m = mins(ms); return m < 60 ? m + ' мин' : Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин'; };

async function alive() {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' } });
      const t = await r.text();
      if (r.status === 200 && /"ok"\s*:\s*true/.test(t)) return { ok: true };
      if (i === 1) return { ok: false, why: 'HTTP ' + r.status + (r.status === 503 ? ' — база бота не отвечает' : '') };
    } catch (e) {
      if (i === 1) return { ok: false, why: e.name === 'TimeoutError' ? 'нет ответа 20 с' : 'сервер недоступен' };
    }
    await new Promise(res => setTimeout(res, RETRY_MS));
  }
}

async function vk(message) {
  const q = new URLSearchParams({ peer_id: VK_PEER, message, random_id: String(Math.floor(Math.random() * 2147483647)), access_token: VK_TOKEN, v: '5.199' });
  const r = await fetch(`${VK_API}/messages.send?${q}`, { method: 'POST', signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!j.response) { console.error('VK не принял сообщение:', JSON.stringify(j.error || j).slice(0, 200)); process.exitCode = 1; }
  else console.log('отправлено в VK');
}

const res = await alive();
console.log(res.ok ? 'бот жив' : 'бот не отвечает: ' + res.why);
if (res.ok) {
  if (state.down_since) {
    await vk('🟢 Бот снова работает (не отвечал ' + dur(now - state.down_since) + ').');
    state.down_since = null; state.last_notice = null;
  }
} else if (!state.down_since) {
  state.down_since = now; state.last_notice = now;
  await vk('🔴 Бот не отвечает с ' + msk(now) + ' (МСК): ' + res.why + '.\nПроверьте сервер и n8n. Следующее сообщение — когда оживёт или через час.');
} else if (now - (state.last_notice || 0) >= 60 * 60000) {
  state.last_notice = now;
  await vk('🔴 Бот всё ещё не отвечает — уже ' + dur(now - state.down_since) + ' (с ' + msk(state.down_since) + ' МСК): ' + res.why + '.');
}
if (!state.keepalive || now - state.keepalive >= 30 * 86400000) state.keepalive = now;
if (JSON.stringify(state) !== before) { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n'); console.log('состояние изменено'); }
