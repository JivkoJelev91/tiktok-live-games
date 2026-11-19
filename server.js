// Свързва се с TikTok Live (безплатно, по потребителско име) и препраща
// коментари/подаръци/харесвания към играта в браузъра през WebSocket.
//
// Стартиране:  node server.js ТВОЕТО_ИМЕ_В_TIKTOK
// Без име:     node server.js        (само тестов режим, без TikTok)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';

const PORT = Number(process.env.PORT) || 3000;
const ARGS = process.argv.slice(2);
const OPEN_WINDOW = ARGS.includes('--open');   // отваря играта в отделен прозорец (за заснемане в LIVE Studio)
const USERNAME = (ARGS.find(a => !a.startsWith('--')) || process.env.TIKTOK_USER || '').replace(/^@/, '').trim();
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'games', 'dumomania');

// ---------- Статичен уеб сървър за играта ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/bridge.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(BRIDGE_HTML); return; }
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const isText = /^text\//.test(type);
    const range = !isText && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {                                           // нужно за превъртане на песните
      const start = range[1] ? +range[1] : Math.max(0, data.length - +range[2]);
      const end = range[1] && range[2] ? Math.min(+range[2], data.length - 1) : data.length - 1;
      if (start > end || start >= data.length) { res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end(); return; }
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1, 'Cache-Control': 'max-age=3600' });
      res.end(data.subarray(start, end + 1)); return;
    }
    res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Type': isText ? type + '; charset=utf-8' : type, 'Content-Length': data.length, 'Cache-Control': isText ? 'no-store' : 'max-age=3600' });
    res.end(data);
  });
});

// ---------- Мост: прозорче, което препраща коментари от страницата на лайва ----------
const BRIDGE_HTML = `<!doctype html>
<html lang="bg"><head><meta charset="utf-8"><title>Думомания – мост</title>
<style>
  body { margin: 0; padding: 14px; background: #111; color: #eee; font: 15px system-ui, sans-serif; }
  #st { font-weight: bold; font-size: 17px; margin-bottom: 8px; }
  #log div { padding: 2px 0; border-bottom: 1px solid #222; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style></head>
<body>
<div id="st">⏳ Свързване с играта...</div>
<div>Получени коментари: <b id="n">0</b></div>
<small>Не затваряй този прозорец, докато играеш.</small>
<div id="log"></div>
<script>
  let ws, n = 0;
  const st = document.getElementById('st');
  function connect() {
    ws = new WebSocket('ws://' + location.host);
    ws.onopen = () => { st.textContent = '✅ Свързан с играта'; st.style.color = '#4ade80'; };
    ws.onclose = () => { st.textContent = '❌ Няма връзка с играта (пуснат ли е START.bat?)'; st.style.color = '#f87171'; setTimeout(connect, 2000); };
  }
  connect();
  addEventListener('message', e => {
    const host = new URL(e.origin).hostname;
    if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return;
    const m = e.data;
    if (!m || m.type !== 'chat' || ws.readyState !== 1) return;
    ws.send(JSON.stringify(m));
    document.getElementById('n').textContent = ++n;
    const row = document.createElement('div');
    row.textContent = (m.user && m.user.name || '?') + ': ' + m.text;
    const log = document.getElementById('log');
    log.prepend(row);
    while (log.children.length > 8) log.lastChild.remove();
  });
</script>
</body></html>`;

// ---------- Лог на чата във файл (chat-log.txt) за диагностика ----------
const LOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-log.txt');
function logLine(s) { fs.appendFile(LOG_FILE, `${new Date().toLocaleTimeString('bg-BG')}  ${s}\n`, () => {}); }

// ---------- WebSocket към играта ----------
const wss = new WebSocketServer({ server });
let status = { type: 'status', state: USERNAME ? 'connecting' : 'test', username: USERNAME };

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(json);
}
function setStatus(state, extra = {}) {
  status = { type: 'status', state, username: USERNAME, ...extra };
  broadcast(status);
}
wss.on('connection', (ws, req) => {
  ws.send(JSON.stringify(status));
  // Мост от страницата на лайва (bridge.html): приема коментари само от localhost
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin || '')) return;
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'diag') {   // играта казва какво е направила с коментара
        console.log(`   ↳ игра: ${m.result}`);
        logLine(`ИГРА  ${m.name}: ${JSON.stringify(m.text)} → ${m.result} | думи: ${(m.words || []).join(',')}`);
        return;
      }
      if (m.type !== 'chat' || !m.text) return;
      const name = String(m.user?.name || 'Зрител').slice(0, 40);
      const msg = { type: 'chat', user: { id: 'web_' + name, name, avatar: String(m.user?.avatar || '') }, text: String(m.text).slice(0, 200) };
      console.log(`💬 (мост) ${name}: ${msg.text}`);
      broadcast(msg);
    } catch {}
  });
});

// Профилна снимка: взимаме формат, който браузърът може да покаже (без .heic)
function pickPicture(u) {
  if (u.profilePictureUrl) return u.profilePictureUrl;
  const urls = [u.profilePictureMedium, u.profilePicture, u.profilePictureLarge, u.avatarThumb]
    .flatMap(img => img?.url || img?.urlList || []);
  return urls.find(x => !x.includes('.heic')) || urls[0] || '';
}

function userOf(data) {
  const u = data.user || {};
  return {
    id: u.uniqueId || u.displayId || data.uniqueId || String(u.id || 'anon'),
    name: u.nickname || data.nickname || u.uniqueId || 'Зрител',
    avatar: pickPicture(u)
  };
}

// ---------- Връзка с TikTok Live ----------
let connection = null;
let retryTimer = null;

async function connectTikTok() {
  clearTimeout(retryTimer);
  connection = new TikTokLiveConnection(USERNAME, { processInitialData: false });

  connection.on(WebcastEvent.CHAT, data => {
    const text = (data.content || data.comment || '').trim();
    if (text) {
      console.log(`💬 ${userOf(data).name}: ${text}`);
      logLine(`TIKTOK ${userOf(data).name}: ${JSON.stringify(text)}`);
      broadcast({ type: 'chat', user: userOf(data), text });
    }
  });

  connection.on(WebcastEvent.GIFT, data => {
    const g = data.gift || data.giftDetails || {};
    const giftType = g.type ?? g.giftType;
    if (giftType === 1 && !data.repeatEnd) return; // серия в процес – чакаме края ѝ
    const count = data.repeatCount || 1;
    const diamonds = (g.diamondCount || 1) * count;
    const giftName = g.name || g.giftName || data.extendedGiftInfo?.name || 'Подарък';
    console.log(`🎁 ${userOf(data).name}: ${giftName} x${count}`);
    broadcast({ type: 'gift', user: userOf(data), giftName, count, diamonds });
  });

  connection.on(WebcastEvent.LIKE, data => {
    broadcast({ type: 'like', user: userOf(data), count: data.count || data.likeCount || 1, total: Number(data.total || data.totalLikeCount || 0) });
  });

  connection.on(WebcastEvent.FOLLOW, data => broadcast({ type: 'follow', user: userOf(data) }));
  connection.on(WebcastEvent.SHARE, data => broadcast({ type: 'share', user: userOf(data) }));

  // --- Диагностика: какво изобщо идва от TikTok ---
  const seen = {};
  connection.on(ControlEvent.DECODED_DATA, (type) => { seen[type] = (seen[type] || 0) + 1; });
  connection.on(ControlEvent.WEBSOCKET_CONNECTED, () => console.log('🔌 Живата връзка (WebSocket) е отворена'));
  connection.on(ControlEvent.ERROR, err => console.log('⚠️  Грешка:', err?.info || err?.message || err));
  clearInterval(globalThis.diagTimer);
  globalThis.diagTimer = setInterval(() => {
    const list = Object.entries(seen).map(([k, v]) => `${k.replace('Webcast', '')}=${v}`).join(', ');
    console.log(`📊 Получено от TikTok за 30 сек: ${list || 'НИЩО'}`);
    for (const k in seen) delete seen[k];
  }, 30000);

  connection.on(ControlEvent.DISCONNECTED, () => {
    console.log('⚠️  Връзката с TikTok прекъсна. Нов опит след 10 сек...');
    setStatus('disconnected');
    retryTimer = setTimeout(connectTikTok, 10000);
  });

  connection.on(WebcastEvent.STREAM_END, () => {
    console.log('🔴 Лайвът приключи.');
    setStatus('ended');
  });

  try {
    setStatus('connecting');
    const state = await connection.connect();
    console.log(`✅ Свързан с лайва на @${USERNAME} (roomId ${state.roomId})`);
    setStatus('connected', { roomId: String(state.roomId || '') });
  } catch (err) {
    console.log(`❌ Неуспешно свързване с @${USERNAME}: ${err?.message || err}`);
    console.log('   Пусни лайва първо. Нов опит след 15 сек...');
    setStatus('offline', { error: String(err?.message || err) });
    retryTimer = setTimeout(connectTikTok, 15000);
  }
}

// Прозорец без адресна лента, 9:16 – удобен за Window Capture
function openGameWindow() {
  const url = `http://localhost:${PORT}`;
  // Отделен профил = отделен процес на браузъра, иначе флаговете се игнорират, ако той вече е отворен.
  // Флаговете спират „замразяването“ на прозореца, когато е покрит от LIVE Studio/друг прозорец.
  const profile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.game-browser-profile');
  const flags = '--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion';
  // Chrome, ако е инсталиран; иначе Edge
  const chrome = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).map(d => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(f => fs.existsSync(f));
  const browser = chrome ? `"${chrome}"` : 'msedge';
  const cmd = process.platform === 'win32'
    ? `start "" ${browser} --app=${url} --window-size=608,1080 --user-data-dir="${profile}" --no-first-run --no-default-browser-check ${flags}`
    : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  exec(cmd, err => { if (err) exec(process.platform === 'win32' ? `start "" ${url}` : `echo`); });
}

server.listen(PORT, () => {
  if (OPEN_WINDOW) openGameWindow();
  console.log(`\n🎮 Играта работи на:  http://localhost:${PORT}`);
  console.log(`   Тестов панел:       натисни клавиш T в играта\n`);
  if (USERNAME) connectTikTok();
  else console.log('ℹ️  Не е зададено TikTok име – работи само тестовият режим.\n   Стартирай с:  node server.js ТВОЕТО_ИМЕ\n');
});
