// ДУМОМАНИЯ – игра с думи за TikTok Live
'use strict';

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

// ---------- Награди ----------
const REWARDS = {
  letter:   'Разкрий буква',
  letters3: 'Разкрий 3 букви',
  word:     'Разкрий дума',
  flash:    'Първи букви',
  time:     '+30 секунди'
};

// ---------- Настройки по подразбиране ----------
// kind: like | gift | follow | share
// gift: имена на подаръка (както идват от TikTok); null = всеки друг подарък (броят се монетите)
const DEFAULTS = {
  roundSeconds: 150,
  boardSize: 10,
  music: true,
  musicVol: 40,
  events: [
    { id: 'rose',    on: true, kind: 'gift',   icon: '🌹', label: 'Роза',      gift: ['rose', 'роза'],       count: 1, reward: 'letter' },
    { id: 'tiktok',  on: true, kind: 'gift',   icon: '🥊', label: 'TikTok',    gift: ['tiktok'],             count: 1, reward: 'time' },
    { id: 'perfume', on: true, kind: 'gift',   icon: '🧴', label: 'Парфюм',    gift: ['perfume', 'парфюм'], count: 1, reward: 'word' },
    { id: 'follow',  on: true, kind: 'follow', icon: '➕', label: 'Последване', count: 1, reward: 'word' }
  ]
};
const MAX_PER_COMBO = 5;
const CROWN_STREAK = 5;      // поредни рунда в топ 5 за коронка
const ATTACK_STEAL = 0.3;    // каква част от точките на лидера отнема атаката

function loadSettings() {
  const saved = store.get('dm-settings-v2', null);
  const s = structuredClone(DEFAULTS);
  if (!saved) return s;
  for (const k of ['roundSeconds', 'boardSize', 'music', 'musicVol']) if (saved[k] != null) s[k] = saved[k];
  for (const ev of s.events) {
    const sv = (saved.events || []).find(e => e.id === ev.id);
    if (sv) for (const k of ['on', 'count', 'reward']) if (sv[k] != null) ev[k] = sv[k];
  }
  return s;
}
let S = loadSettings();
const saveSettings = () => store.set('dm-settings-v2', S);

// ---------- Състояние ----------
let scores = store.get('dm-scores', {});          // за целия лайв: id -> {name, avatar, points}
let round = null;                                 // текущ рунд
let lastWinner = store.get('dm-winner', null);   // победител от предния рунд
const accum = {};                                 // натрупани лайкове/монети по събитие
let deck = [];
let lastLeader = null;

// ---------- Мащабиране на сцената ----------
function fit() {
  // SAFE < 1: съдържанието се смалява към центъра, за да не го реже TikTok отляво/отдясно на високите телефони
  const SAFE = 0.86;
  const s = Math.min(innerWidth / 1080, innerHeight / 1920) * SAFE;
  const top = (innerHeight - 1920 * s) / 2;        // отгоре остава място (там е и лентата на прозореца)
  const st = $('#stage').style;
  st.setProperty('--s', s);
  st.top = top + 'px';
  st.height = (innerHeight - top) / s + 'px';     // отдолу сцената стига до ръба – таблото и бутонът слизат долу
}
addEventListener('resize', fit); fit();

// Нагласява прозореца точно на 9:16 (като телефон) – работи в прозореца, отворен от START.bat. Клавиш R – пак.
function snapToPhone() {
  const h = Math.min(screen.availHeight - (outerHeight - innerHeight) - 10, Math.round(innerWidth * 16 / 9));
  const w = Math.round(h * 9 / 16);
  try { resizeBy(w - innerWidth, h - innerHeight); } catch {}
}
addEventListener('load', () => setTimeout(snapToPhone, 300));

// ---------- Звук (WebAudio, без файлове) ----------
let actx = null;
function tone(freqs, dur = 0.12, type = 'triangle', vol = 0.12) {
  try {
    actx ||= new AudioContext();
    freqs.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + i * dur;
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur * 1.8);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur * 2);
    });
  } catch {}
}
const sfx = {
  found:  () => tone([660, 880, 1320], 0.09),
  reveal: () => tone([520, 780], 0.1, 'sine'),
  banner: () => tone([392, 523, 659, 784], 0.11, 'square', 0.06),
  tick:   () => tone([1000], 0.04, 'sine', 0.05),
  end:    () => tone([784, 659, 523, 392], 0.15, 'sawtooth', 0.05)
};
// ---------- Фонова музика (генерира се в браузъра, без файлове) ----------
const CHORDS = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]];  // До – Сол – Ла минор – Фа
const mtof = m => 440 * 2 ** ((m - 69) / 12);
let musicGain = null, musicTimer = null, nextNoteTime = 0, step = 0;
function note(m, t, dur, type, vol) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.value = mtof(m);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(musicGain); o.start(t); o.stop(t + dur + 0.05);
}
function scheduleMusic() {
  const fast = round?.active && round.timeLeft <= 10;
  const spb = 60 / (fast ? 140 : 100) / 2;                 // осмини; ускорява в последните 10 сек.
  while (nextNoteTime < actx.currentTime + 0.3) {
    const ch = CHORDS[Math.floor(step / 8) % 4], s = step % 8;
    if (s === 0) { ch.forEach(m => note(m - 12, nextNoteTime, spb * 8, 'triangle', 0.05)); note(ch[0] - 24, nextNoteTime, spb * 4, 'sine', 0.14); }
    if (s === 4) note(ch[0] - 24, nextNoteTime, spb * 4, 'sine', 0.11);
    if (s === 2 || s === 6) note(ch[2] + 12, nextNoteTime, spb * 0.6, 'square', 0.012);
    note(ch[[0, 1, 2, 1, 0, 2, 1, 2][s]] + 12, nextNoteTime, spb * 1.6, 'sine', 0.045);
    nextNoteTime += spb; step++;
  }
}
function startMusic() {
  try {
    actx ||= new AudioContext(); actx.resume?.();
    if (!musicGain) { musicGain = actx.createGain(); musicGain.connect(actx.destination); }
    musicGain.gain.value = S.music ? S.musicVol / 100 : 0;
    if (!S.music) { clearInterval(musicTimer); musicTimer = null; return; }
    if (musicTimer) return;
    nextNoteTime = actx.currentTime + 0.1;
    musicTimer = setInterval(scheduleMusic, 100);
  } catch {}
}
// браузърът пуска звук чак след първо кликване/натискане
addEventListener('pointerdown', startMusic, { once: true });
addEventListener('keydown', startMusic, { once: true });

// ---------- Аватари ----------
function avatar(user, cls = '') {
  const letter = esc((user.name || '?').trim().charAt(0).toUpperCase() || '?');
  const hue = [...(user.id || user.name || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  if (user.avatar) return `<img class="av ${cls}" src="${esc(user.avatar)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;av ${cls}&quot; style=&quot;background:hsl(${hue},55%,45%)&quot;>${letter}</div>'">`;
  return `<div class="av ${cls}" style="background:hsl(${hue},55%,45%)">${letter}</div>`;
}

// ---------- Съобщения и банери ----------
const HINTS = ['Напиши ЕДНА дума в чата, за да познаеш!', 'По-дългите думи носят повече точки!', 'Подаръците разкриват букви!', 'Точките се пазят през целия лайв!'];
let hintIdx = 0, msgUntil = 0;
function message(text, ms = 5000) {
  const el = $('#msgBar'); el.textContent = text;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  msgUntil = Date.now() + ms;
}
setInterval(() => { if (Date.now() > msgUntil) message(HINTS[hintIdx++ % HINTS.length], 0); }, 7000);

const bannerQueue = []; let bannerBusy = false;
function banner(title, text) { bannerQueue.push([title, text]); if (!bannerBusy) nextBanner(); }
async function nextBanner() {
  const b = bannerQueue.shift(); if (!b) { bannerBusy = false; return; }
  bannerBusy = true;
  $('#bannerTitle').textContent = b[0]; $('#bannerText').textContent = b[1];
  const el = $('#banner'); el.classList.add('hidden'); void el.offsetWidth; el.classList.remove('hidden');
  sfx.banner();
  await sleep(bannerQueue.length > 2 ? 1300 : 2400);
  el.classList.add('hidden'); await sleep(150);
  nextBanner();
}

// ---------- Рунд ----------
function nextPuzzle() {
  if (!deck.length) deck = shuffle([...window.PUZZLES.keys()]);
  return window.PUZZLES[deck.pop()];
}

function startRound() {
  const p = nextPuzzle();
  const n = Math.max(3, Math.min(10, S.boardSize));
  const words = p.words.slice(0, n)
    .sort((a, b) => a.length - b.length || a.localeCompare(b, 'bg'))
    .map(w => ({ w, found: null, revealed: new Set(), flash: false }));
  // буквите горе: някои са скрити („?“) и се показват постепенно
  const letters = shuffle([...p.letters].map(ch => ({ ch, hidden: false })));
  shuffle([...letters]).slice(0, Math.ceil(letters.length / 2)).forEach(l => l.hidden = true);  // винаги поне половината са скрити
  round = { letters, words, timeLeft: S.roundSeconds, total: S.roundSeconds, hiddenTotal: letters.filter(l => l.hidden).length, elapsed: 0, active: true, roundScores: {} };
  $('#screen').classList.add('hidden');
  renderLetters(); renderBoard();
  message('Нов рунд! Напиши ЕДНА дума в чата!');
}

function renderLetters(anim = false) {
  $('#letters').innerHTML = round.letters.map((l, i) =>
    `<div class="ltile ${l.hidden ? 'mystery' : ''} ${anim ? 'shuffle' : ''} ${l.justShown ? 'unveil' : ''}" style="animation-delay:${i * 50}ms">${l.hidden ? '?' : l.ch}</div>`).join('');
  round.letters.forEach(l => l.justShown = false);
}
function unveilLetter() {
  const l = round.letters.find(x => x.hidden);
  if (!l) return;
  l.hidden = false; l.justShown = true;
  renderLetters(); sfx.reveal();
  message(`Скритата буква е ${l.ch}!`);
}
// Ако буква вече се вижда на таблото (позната дума или разкрита буква), показваме я и горе.
function syncHiddenLetters() {
  if (!round.letters.some(l => l.hidden)) return;
  const need = {};
  for (const w of round.words) {
    const cnt = {};
    [...w.w].forEach((ch, j) => { if (w.found || w.revealed.has(j)) cnt[ch] = (cnt[ch] || 0) + 1; });
    for (const ch in cnt) need[ch] = Math.max(need[ch] || 0, cnt[ch]);
  }
  const shown = [];
  for (const ch in need) {
    let visible = round.letters.filter(l => l.ch === ch && !l.hidden).length;
    for (const l of round.letters) {
      if (visible >= need[ch]) break;
      if (l.ch === ch && l.hidden) { l.hidden = false; l.justShown = true; visible++; shown.push(ch); }
    }
  }
  if (shown.length) { renderLetters(); message(`Скритата буква е ${shown.join(', ')}!`); }
}
// скритите букви се показват равномерно през рунда (напр. при 2 скрити – на 1/3 и 2/3 от времето)
function checkUnveil() {
  const total = round.hiddenTotal;
  if (!total) return;
  const due = Math.min(total, Math.floor(round.elapsed / round.total * (total + 1)));
  const shown = total - round.letters.filter(l => l.hidden).length;
  if (due > shown) unveilLetter();
}

function rowHTML(word, i, opts = {}) {
  const tiles = [...word.w].map((ch, j) => {
    let cls = 'empty', txt = '';
    if (word.found) { cls = 'found'; txt = ch; }
    else if (opts.missed) { cls = 'missed'; txt = ch; }
    else if (word.revealed.has(j)) { cls = 'revealed'; txt = ch; }
    else if (word.flash && j === 0) { cls = 'flash'; txt = ch; }
    const delay = opts.animate ? `style="animation-delay:${j * 70}ms"` : '';
    return `<div class="wt ${cls}" ${delay}>${txt}</div>`;
  }).join('');
  const f = word.found;
  const finder = f ? `<div class="finder">${avatar(f.user)}<div class="fn"><div class="nm">${crownName(f.user.id, f.user.name)}</div><div class="pt">+${f.points}</div></div></div>` : '';
  return `<div class="row ${opts.animate && f ? 'justfound' : ''}" data-i="${i}"><div class="tiles">${tiles}</div>${finder}</div>`;
}

function renderBoard() {
  $('#words').classList.toggle('dense', round.words.length > 7);
  $('#words').innerHTML = round.words.map((w, i) => rowHTML(w, i)).join('');
}
function renderRow(i, opts) {
  const el = $(`#words .row[data-i="${i}"]`);
  if (el) el.outerHTML = rowHTML(round.words[i], i, opts);
}

// Таймер
setInterval(() => {
  if (!round?.active) return;
  round.timeLeft = Math.max(0, round.timeLeft - 1);
  round.elapsed++;
  checkUnveil();
  updateTimer();
  if (round.timeLeft <= 5 && round.timeLeft > 0) sfx.tick();
  if (round.timeLeft === 0) endRound();
}, 1000);
function updateTimer() {
  const t = round ? round.timeLeft : 0;
  $('#timeText').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  $('#timer').classList.toggle('low', !!round?.active && t <= 10);
}

// Разбъркване на буквите на всеки 20 сек.
setInterval(() => { if (round?.active) { shuffle(round.letters); renderLetters(true); } }, 20000);

async function endRound() {
  if (!round?.active) return;
  round.active = false; updateTimer();
  round.letters.forEach(l => { if (l.hidden) { l.hidden = false; l.justShown = true; } });
  renderLetters();
  const allFound = round.words.every(w => w.found);
  sfx.end();
  if (allFound) banner('БРАВО!', 'Всички думи са открити!');
  round.words.forEach((w, i) => { if (!w.found) renderRow(i, { missed: true }); });
  message('Край на рунда!');
  await sleep(4000);
  updateStreaks();
  const top3 = Object.values(round.roundScores).sort((a, b) => b.points - a.points).slice(0, 3);
  if (top3.length) {
    lastWinner = top3[0]; store.set('dm-winner', lastWinner); renderWinner();
    showPodium(top3); await sleep(7000);
  }
  if (Object.keys(scores).length) { showTop10(); await sleep(10000); }
  startRound();
}

// ---------- Познаване ----------
function normalize(text) {
  const tokens = String(text).toUpperCase().replace(/Ѝ/g, 'И').split(/\s+/)
    .map(t => t.replace(/[^А-ЯЁA-Z46]/g, '')).filter(Boolean);
  return tokens.length === 1 ? tokens[0] : null;  // само съобщения с една дума
}

// Латиница / шльокавица → проверка срещу думата на кирилица
const LAT = { А:'A', Б:'B', В:'[VW]', Г:'G', Д:'D', Е:'E', Ж:'(ZH|J|Z)', З:'Z', И:'I', Й:'[YIJ]', К:'[KQ]', Л:'L', М:'M', Н:'N', О:'O', П:'P', Р:'R', С:'S', Т:'T', У:'U', Ф:'F', Х:'[HX]', Ц:'(C|TS|TZ)', Ч:'(CH|4)', Ш:'(SH|6|W)', Щ:'(SHT|6T)', Ъ:'[AUY]', Ь:'[YJ]?', Ю:'(YU|JU|IU|U)', Я:'(YA|JA|IA|Q|A)' };
const latRe = {};
function sameWord(w, guess) {
  if (guess === w) return true;
  if (!/^[A-Z46]+$/.test(guess)) return false;
  latRe[w] ||= new RegExp('^' + [...w].map(c => LAT[c] || c).join('') + '$');
  return latRe[w].test(guess);
}

function onChat(user, text) {
  if (tryAttack(user, text)) return diag(user, text, '👑 атака');
  if (!round?.active) return diag(user, text, '⏸ няма активен рунд');
  const guess = normalize(text);
  if (!guess) return diag(user, text, '✖ не е една дума');
  const i = round.words.findIndex(w => !w.found && sameWord(w.w, guess));
  if (i < 0) {
    const done = round.words.find(w => w.found && sameWord(w.w, guess));
    return diag(user, text, done ? `✖ ${guess} вече е позната` : `✖ ${guess} я няма на таблото`);
  }
  diag(user, text, `✅ ${round.words[i].w}`);
  const word = round.words[i];
  const points = word.w.length;
  word.found = { user, points };
  addPoints(user, points);
  renderRow(i, { animate: true });
  sfx.found();
  message(`${user.name} намери ${word.w} (+${points})`);
  syncHiddenLetters();
  if (round.words.every(w => w.found)) endRound();
}

function addPoints(user, points) {
  const s = scores[user.id] ||= { name: user.name, avatar: user.avatar, points: 0 };
  s.name = user.name; if (user.avatar) s.avatar = user.avatar; s.points += points;
  const r = round.roundScores[user.id] ||= { id: user.id, name: user.name, avatar: user.avatar, points: 0 };
  r.points += points;
  store.set('dm-scores', scores);
  renderLeaderboard();
}

function topPlayers(n) {
  return Object.entries(scores).map(([id, s]) => ({ id, ...s })).sort((a, b) => b.points - a.points).slice(0, n);
}
function renderLeaderboard() {
  const top = topPlayers(3);
  if (top[0] && lastLeader && top[0].id !== lastLeader) message(`${top[0].name} поведе в класацията!`);
  lastLeader = top[0]?.id || null;
  // ред: 2, 1, 3 – първият е в средата
  const slots = [top[1], top[0], top[2]];
  const ranks = [2, 1, 3];
  $('#lbList').innerHTML = slots.map((p, k) => p
    ? `<div class="lb ${ranks[k] === 1 ? 'first' : ''}">${avatar(p)}<div class="rk">${ranks[k]}</div><div class="nm">${crownName(p.id, p.name)}</div><div class="pt">${p.points}</div></div>`
    : `<div class="lb empty"><div class="av" style="background:#ffffff18">?</div><div class="rk">${ranks[k]}</div><div class="nm">—</div><div class="pt">0</div></div>`
  ).join('');
}

// ---------- 👑 Кралска атака ----------
const crowned = id => !!scores[id]?.crown;
const crownName = (id, name) => esc(name) + (crowned(id) ? ' 👑' : '');

function updateStreaks() {
  const top5 = new Set(topPlayers(5).filter(p => p.points > 0).map(p => p.id));
  for (const [id, s] of Object.entries(scores)) {
    if (s.crown) continue;                       // вече има коронка – чака да атакува
    s.streak = top5.has(id) ? (s.streak || 0) + 1 : 0;
    if (s.streak >= CROWN_STREAK) {
      s.crown = true; s.streak = 0;
      banner(`👑 ${s.name} 👑`, 'КРАЛСКА АТАКА! Напиши 1, 2 или 3');
    }
  }
  store.set('dm-scores', scores);
  renderLeaderboard();
}

function tryAttack(user, text) {
  if (!crowned(user.id)) return false;
  const t = String(text).trim();
  if (!/^[^0-9A-Za-zА-Яа-я]*[1-3][^0-9A-Za-zА-Яа-я]*$/.test(t)) return false;   // само число 1–3 (емоджита около него са ОК)
  const n = +t.match(/[1-3]/)[0];
  const target = topPlayers(3)[n - 1];
  if (!target) return true;
  if (target.id === user.id) { message(`${user.name}, не можеш да атакуваш себе си! Избери друг номер.`); return true; }
  const steal = Math.max(1, Math.round(target.points * ATTACK_STEAL));
  scores[target.id].points -= steal;
  const me = scores[user.id];
  me.points += steal; me.crown = false; me.streak = 0;
  store.set('dm-scores', scores);
  renderLeaderboard();
  sfx.end();
  banner(`⚔️ ${user.name} атакува №${n} ${target.name}!`, `-${steal} точки`);
  return true;
}

// ---------- Награди ----------
function hiddenSpots() {
  const spots = [];
  round.words.forEach((w, i) => { if (!w.found) [...w.w].forEach((_, j) => { if (!w.revealed.has(j)) spots.push([i, j]); }); });
  return spots;
}
function revealLetters(n) {
  const spots = shuffle(hiddenSpots()).slice(0, n);
  const rows = new Set();
  for (const [i, j] of spots) { round.words[i].revealed.add(j); rows.add(i); }
  rows.forEach(i => renderRow(i));
  if (spots.length) { sfx.reveal(); syncHiddenLetters(); }
}
function revealWord() {
  const left = round.words.filter(w => !w.found && w.revealed.size < w.w.length);
  if (!left.length) return;
  const w = left[Math.floor(Math.random() * left.length)];
  [...w.w].forEach((_, j) => w.revealed.add(j));   // показва се, но още може да се „вземе“ с писане
  renderRow(round.words.indexOf(w)); sfx.reveal(); syncHiddenLetters();
}
async function letterFlash() {
  round.words.forEach((w, i) => { if (!w.found) { w.flash = true; renderRow(i); } });
  sfx.reveal();
  await sleep(4000);
  if (!round) return;
  round.words.forEach((w, i) => { if (w.flash) { w.flash = false; renderRow(i); } });
}
function applyReward(reward) {
  if (!round?.active) return;
  if (reward === 'letter') revealLetters(1);
  else if (reward === 'letters3') revealLetters(3);
  else if (reward === 'word') revealWord();
  else if (reward === 'flash') letterFlash();
  else if (reward === 'time') { round.timeLeft += 30; updateTimer(); }
}
function renderWinner() {
  const w = lastWinner;
  $('#winner').innerHTML = w
    ? `<div class="crown">👑</div>${avatar(w)}<div class="wn">${crownName(w.id, w.name)}</div><div class="wp">${w.points} т.</div>`
    : `<div class="crown">👑</div><div class="av" style="background:#ffffff18">?</div><div class="wn">Още няма</div><div class="wp">&nbsp;</div>`;
}
function resetScores() {
  scores = {}; lastWinner = null; lastLeader = null;
  store.set('dm-scores', scores); store.set('dm-winner', null);
  renderLeaderboard(); renderWinner();
}

// ---------- TikTok събития ----------
function findEvent(kind, giftName) {
  const on = S.events.filter(e => e.on && e.kind === kind);
  if (kind !== 'gift') return on[0];
  const name = (giftName || '').toLowerCase();
  return on.find(e => e.gift && e.gift.some(g => name === g)) || on.find(e => !e.gift);
}

function trigger(ev, user, amount, giftLabel) {
  if (!ev) return;
  accum[ev.id] = (accum[ev.id] || 0) + amount;
  const times = Math.min(MAX_PER_COMBO, Math.floor(accum[ev.id] / Math.max(1, ev.count)));
  if (!times) return;
  accum[ev.id] = ev.kind === 'like' ? accum[ev.id] - times * ev.count : 0;  // излишъкът от комбо над 5 се губи
  for (let k = 0; k < times; k++) applyReward(ev.reward);
  const what = giftLabel ? `${giftLabel}${times > 1 ? ' ×' + times : ''}` : ev.label;
  banner(`${ev.icon} ${user.name} – ${what}`, REWARDS[ev.reward] + (times > 1 ? ` ×${times}` : ''));
}

function handle(msg) {
  switch (msg.type) {
    case 'chat':   onChat(msg.user, msg.text); break;
    case 'like':   trigger(findEvent('like'), msg.user, msg.count); break;
    case 'follow': trigger(findEvent('follow'), msg.user, 1); message(`${msg.user.name} последва! Благодаря!`); break;
    case 'share':  trigger(findEvent('share'), msg.user, 1); break;
    case 'gift': {
      const ev = findEvent('gift', msg.giftName);
      if (!ev) break;
      const amount = ev.gift ? msg.count : msg.diamonds;   // „друг подарък“ се брои по монети
      trigger(ev, msg.user, amount, ev.gift ? ev.label : msg.giftName);
      break;
    }
    case 'status': showStatus(msg); break;
  }
}

function showStatus(st) {
  const txt = {
    test: '● Тестов режим (без TikTok)', connecting: `● Свързване с @${st.username}...`, connected: `● Свързан с @${st.username}`,
    offline: `● @${st.username} не е на живо – чакам...`, disconnected: '● Връзката прекъсна – нов опит...', ended: '● Лайвът приключи'
  }[st.state] || '';
  // нов лайв (друга стая) → класацията започва от нулата
  if (st.state === 'connected' && st.roomId && store.get('dm-room', null) !== st.roomId) { store.set('dm-room', st.roomId); resetScores(); }
  const el = $('#status'); el.textContent = txt;
  el.style.opacity = st.state === 'connected' ? 1 : 0;   // на екрана (в лайва) се показва само „Свързан“ за 6 сек; останалото – в черния прозорец
  clearTimeout(showStatus.t);
  if (st.state === 'connected') showStatus.t = setTimeout(() => el.style.opacity = 0, 6000);
}

// ---------- Диагностика (клавиш L): какво получава играта и защо го отхвърля ----------
let wsConn = null;
const diagLog = [];
function diag(user, text, result) {
  const codes = [...String(text)].map(c => c.codePointAt(0)).filter(c => c > 0x7e && (c < 0x400 || c > 0x4ff)).map(c => 'U+' + c.toString(16).toUpperCase());
  diagLog.unshift({ name: user.name, text: String(text), result, odd: [...new Set(codes)].slice(0, 6).join(' ') });
  diagLog.length = Math.min(diagLog.length, 15);
  const panel = $('#debugPanel');
  if (panel && !panel.classList.contains('hidden')) renderDiag();
  if (wsConn?.readyState === 1 && !String(user.id).startsWith('test_') && !String(user.id).startsWith('fake_'))
    wsConn.send(JSON.stringify({ type: 'diag', name: user.name, text: String(text), result, words: round ? round.words.map(w => w.w) : [] }));
}
function renderDiag() {
  $('#debugPanel').innerHTML = `<b>Чат → игра (L – скрий)</b><div class="dwords">Думи: ${round ? round.words.map(w => w.found ? `<s>${esc(w.w)}</s>` : esc(w.w)).join(', ') : '—'}</div>` +
    (diagLog.length ? diagLog.map(d => `<div class="drow"><span>${esc(d.name)}: <i>${esc(d.text)}</i>${d.odd ? ` <small>[${d.odd}]</small>` : ''}</span><b>${esc(d.result)}</b></div>`).join('') : '<div>Още няма коментари.</div>');
}

// WebSocket към server.js
function connectWS() {
  const ws = wsConn = new WebSocket(`ws://${location.host || 'localhost:3000'}`);
  ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => { showStatus({ state: 'disconnected' }); setTimeout(connectWS, 3000); };
}
if (location.protocol.startsWith('http')) connectWS(); else showStatus({ state: 'test' });

// ---------- Екрани в края на рунда ----------
function showPodium(top3) {
  const order = [[top3[1], 2], [top3[0], 1], [top3[2], 3]];
  $('#screen').innerHTML = `<div class="sub">ТОЗИ РУНД</div><h1>ТОП 3</h1><div class="podium">${
    order.map(([p, r]) => p ? `<div class="pod p${r}">${avatar(p)}<div class="nm">${esc(p.name)}</div><div class="blk"><div class="n">${r}</div><div class="p">${p.points} т.</div></div></div>`
                            : `<div class="pod p${r}" style="visibility:hidden"><div class="blk"></div></div>`).join('')}</div>`;
  $('#screen').classList.remove('hidden');
}
function showTop10() {
  const top = topPlayers(20);
  $('#screen').innerHTML = `<div class="top10"><div class="panel-title">ТОП 20 ИГРАЧИ</div>${
    top.map((p, i) => `<div class="t10" style="animation-delay:${i * 50}ms"><div class="r">${i + 1}.</div>${avatar(p)}<div class="nm">${crownName(p.id, p.name)}${p.streak && !p.crown ? ` <span class="streak">🔥${p.streak}/${CROWN_STREAK}</span>` : ''}</div><div class="p">${p.points}</div></div>`).join('')
  }</div><div class="foot">Точките ти се пазят през целия лайв, дори да не си в класацията!</div>`;
  $('#screen').classList.remove('hidden');
}

// ---------- Лента със събития ----------
function renderStrip() {
  const cards = S.events.filter(e => e.on).map(e => {
    const head = e.kind === 'follow' ? `<span class="follow">+ Последвай</span>` : `${e.icon}<b>×${e.count}</b>`;
    return `<div class="ecard"><div class="ic">${head}</div><div class="rw">${REWARDS[e.reward]}</div></div>`;
  });
  $('#strip').innerHTML = cards.join('') + `<div class="note">Макс. ${MAX_PER_COMBO} на комбо</div>`;
}

// ---------- Настройки (S) ----------
function renderSettings() {
  const opt = (sel) => Object.entries(REWARDS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  $('#settings').innerHTML = `
    <h2>⚙️ Настройки</h2>
    <div class="line">Време за рунд (сек): <input type="number" id="sRound" min="10" max="600" step="10" value="${S.roundSeconds}">
      Брой думи: <select id="sSize">${[5, 7, 8, 10].map(n => `<option ${n == S.boardSize ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div class="line"><label><input type="checkbox" id="sMusic" ${S.music ? 'checked' : ''}> Фонова музика</label>
      Сила: <input type="range" id="sVol" min="0" max="100" value="${S.musicVol}"></div>
    <h3>TikTok събития</h3>
    <table><tr><th>Вкл.</th><th>Събитие</th><th>Брой*</th><th>Награда</th></tr>
    ${S.events.map((e, i) => `<tr data-i="${i}">
      <td><input type="checkbox" data-k="on" ${e.on ? 'checked' : ''}></td>
      <td>${e.icon} ${e.label}</td>
      <td><input type="number" data-k="count" min="1" value="${e.count}"></td>
      <td><select data-k="reward">${opt(e.reward)}</select></td></tr>`).join('')}
    </table>
    <small>* Брой: колко лайка/подаръка трябват за 1 награда.</small>
    <div class="actions">
      <button id="sNext">⏭ Следващ рунд</button>
      <button id="sReset">🗑 Нулирай класацията</button>
      <button id="sClose">✖ Затвори (S)</button>
    </div>`;
  const panel = $('#settings');
  panel.oninput = panel.onchange = ev => {
    const t = ev.target;
    if (t.id === 'sRound') S.roundSeconds = Math.max(10, Math.min(600, +t.value || 150));
    else if (t.id === 'sSize') S.boardSize = +t.value;
    else if (t.id === 'sMusic') { S.music = t.checked; startMusic(); }
    else if (t.id === 'sVol') { S.musicVol = +t.value; startMusic(); }
    else if (t.dataset.k) {
      const e = S.events[+t.closest('tr').dataset.i];
      e[t.dataset.k] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Math.max(0, +t.value || 0) : t.value;
    }
    saveSettings(); renderStrip();
  };
  $('#sNext').onclick = () => { if (round?.active) { round.active = false; startRound(); } };
  $('#sReset').onclick = () => { if (confirm('Да изтрия ли всички точки?')) resetScores(); };
  $('#sClose').onclick = () => panel.classList.add('hidden');
}

// ---------- Тестов панел (T) ----------
function testUser() { const name = $('#tUser').value.trim() || 'Тест'; return { id: 'test_' + name, name, avatar: '' }; }
$('#tText').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim()) { handle({ type: 'chat', user: testUser(), text: e.target.value }); e.target.value = ''; }
});
$('#testPanel .btns').addEventListener('click', e => {
  const t = e.target.dataset.t; if (!t) return;
  const user = testUser();
  if (t === 'like') handle({ type: 'like', user, count: 5 });
  else if (t === 'follow' || t === 'share') handle({ type: t, user });
  else if (t === 'big') handle({ type: 'gift', user, giftName: 'Galaxy', count: 1, diamonds: 99 });
  else handle({ type: 'gift', user, giftName: t, count: 1, diamonds: t === 'Perfume' ? 20 : 1 });
});
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 't' || e.key === 'T' || e.key === 'т' || e.key === 'Т') $('#testPanel').classList.toggle('hidden');
  if (e.key === 's' || e.key === 'S' || e.key === 'с' || e.key === 'С') { renderSettings(); $('#settings').classList.toggle('hidden'); }
  if (e.key === 'd' || e.key === 'D' || e.key === 'д' || e.key === 'Д') toggleDemo();
  if (e.key === 'r' || e.key === 'R' || e.key === 'р' || e.key === 'Р') snapToPhone();
  if (e.key === 'l' || e.key === 'L' || e.key === 'л' || e.key === 'Л') { const p = $('#debugPanel'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) renderDiag(); }
});

// ---------- Демо с фейк зрители (само за тест) ----------
const FAKE = ['Мария', 'Иван_88', 'гого', 'Пешо Петров', 'ани.в', 'Ники', 'Дидо', 'Цвети', 'Bobi', 'Емо', 'Сиси', 'Калин', 'Деси 🌸', 'Тошко', 'Радо', 'Вики', 'Mitko_bg', 'Стефи', 'Жоро', 'Лили']
  .map((name, i) => ({ id: 'fake_' + i, name, avatar: '' }));
const CHATTER = ['здравейте', 'ехааа', '😂😂', 'браво', 'коя е думата', 'хаха', '🔥🔥🔥', 'трудно е', 'обичам тази игра'];
const pick = a => a[Math.floor(Math.random() * a.length)];
let demoOn = false, demoT = null;
function demoTick() {
  if (!demoOn) return;
  if (round?.active) {
    const king = FAKE.find(u => crowned(u.id));
    if (king && Math.random() < 0.3) { handle({ type: 'chat', user: king, text: String(1 + Math.floor(Math.random() * 3)) }); demoT = setTimeout(demoTick, 1500); return; }
    const user = pick(FAKE), r = Math.random();
    if (r < 0.6) {
      const left = round.words.filter(w => !w.found);
      let text;
      if (left.length && Math.random() < 0.3) {
        left.sort((a, b) => a.w.length - b.w.length + (Math.random() - 0.5) * 4);  // по-кратките се намират по-лесно
        text = Math.random() < 0.3 ? left[0].w.toLowerCase() + ' ' + pick(['!', '😎', '']) : left[0].w;
      } else text = Math.random() < 0.5 ? pick(CHATTER) : pick(pick(window.PUZZLES).words);
      handle({ type: 'chat', user, text });
    } else if (r < 0.8) handle({ type: 'like', user, count: 3 + Math.floor(Math.random() * 15) });
    else if (r < 0.92) {
      const g = pick(['Rose', 'Rose', 'Rose', 'TikTok', 'Perfume']);
      handle({ type: 'gift', user, giftName: g, count: g === 'Rose' ? 1 + Math.floor(Math.random() * 3) : 1, diamonds: g === 'Perfume' ? 20 : 1 });
    } else handle({ type: Math.random() < 0.6 ? 'follow' : 'share', user });
  }
  demoT = setTimeout(demoTick, 900 + Math.random() * 1800);
}
function toggleDemo() {
  demoOn = !demoOn; clearTimeout(demoT);
  const btn = $('#demoBtn');
  if (btn) btn.textContent = demoOn ? '⏹ Спри фейк зрителите' : '▶ Пусни фейк зрители';
  message(demoOn ? 'Фейк зрителите влизат в играта!' : 'Фейк зрителите излязоха.');
  if (demoOn) demoTick();
}
if ($('#demoBtn')) $('#demoBtn').onclick = toggleDemo;

// ---------- Старт ----------
renderLeaderboard(); renderWinner(); renderStrip(); startRound(); updateTimer();
