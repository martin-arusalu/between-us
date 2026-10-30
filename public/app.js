/* Plain browser JavaScript: no framework or build step. */
const app = document.querySelector('#app');
const homeURL = new URL('./', location.href);
const apiBase = (window.BETWEEN_US_CONFIG?.apiBase || '/api').replace(/\/$/, '');
const apiHeaders = window.BETWEEN_US_CONFIG?.publishableKey ? { apikey: window.BETWEEN_US_CONFIG.publishableKey } : {};
const apiURL = path => `${apiBase}/${path}`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
let session = null;
let room = null;
let joinMode = false;
let soloMode = true;
let aiCount = 2;
let difficulty = 5;
let error = '';
let busy = false;
let peek = false;
let copied = false;
let polling = false;
let form = { name: '', code: '', message: '', answer: '' };
let lastSnapshot = '';

try {
  form.name = localStorage.getItem('between-us-name') || '';
  const saved = JSON.parse(sessionStorage.getItem('between-us-session') || 'null');
  const invite = new URLSearchParams(location.search).get('room')?.toUpperCase();
  if (invite) { form.code = invite; joinMode = true; soloMode = false; }
  if (saved && (!invite || saved.code === invite)) session = saved;
} catch { /* Private browsing may disable storage. The current game still works. */ }

async function request(body, token = session?.token) {
  const response = await fetch(apiURL('game'), {
    method: 'POST',
    headers: { ...apiHeaders, 'Content-Type': 'application/json', ...(token ? { 'x-player-token': token } : {}) },
    body: JSON.stringify({ ...body, code: body.code || session?.code }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not connect.');
  return data;
}

function setRoom(value) {
  const changedRound = room?.round !== value.round;
  if (changedRound) { peek = false; form.answer = ''; form.message = ''; }
  const snapshot = JSON.stringify(value);
  room = value;
  syncAudio();
  if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; render(); }
}

async function enter(action) {
  busy = true; error = ''; render();
  try {
    const data = await request({ action, name: form.name || 'Sina', code: form.code,
      mode: soloMode && action === 'create' ? 'solo' : 'multiplayer', aiCount, difficulty }, null);
    session = { code: data.room.code, id: data.id, token: data.token };
    try {
      sessionStorage.setItem('between-us-session', JSON.stringify(session));
      localStorage.setItem('between-us-name', form.name);
    } catch { /* Keep this session in memory if browser storage is unavailable. */ }
    history.replaceState(null, '', `?room=${data.room.code}`);
    if (soloMode && action === 'create') {
      const started = await request({ action: 'start' }, session.token);
      setRoom(started);
    } else setRoom(data.room);
  } catch (e) { error = e.message; }
  finally { busy = false; render(); }
}

async function act(action, extra = {}) {
  const expectedSession = session;
  if (!expectedSession) return;
  busy = true; error = ''; render();
  try {
    const data = await request({ action, ...extra });
    if (session !== expectedSession) return;
    if (action === 'message') form.message = '';
    setRoom(data);
  } catch (e) { error = e.message; }
  finally { busy = false; render(); }
}

async function poll() {
  if (!session || polling) return;
  polling = true;
  const expectedSession = session;
  try {
    const response = await fetch(apiURL(`game?code=${encodeURIComponent(session.code)}`), {
      headers: { ...apiHeaders, 'x-player-token': session.token }, cache: 'no-store',
    });
    const data = await response.json();
    if (session !== expectedSession) return;
    if (!response.ok) throw new Error(data.error || 'Could not load the room.');
    const hadError = error;
    error = '';
    setRoom(data);
    if (hadError) render();
  } catch (e) {
    if (session !== expectedSession) return;
    const next = e instanceof TypeError ? 'Connection lost. Reconnecting…' : e.message;
    if (error !== next) { error = next; render(); }
  } finally { polling = false; }
}

function leave() {
  if (room?.mode === 'solo') soloMode = true;
  joinMode = false;
  form.code = '';
  if (room?.mode === 'solo' && ['preparing', 'discussion'].includes(room.phase)) request({ action: 'pause' }).catch(() => {});
  stopAudio();
  try { sessionStorage.removeItem('between-us-session'); } catch { /* Nothing to clear. */ }
  session = null; room = null; lastSnapshot = ''; error = ''; form.answer = ''; peek = false;
  history.replaceState(null, '', homeURL.pathname); render();
}

async function copyInvite() {
  const link = `${homeURL.href}?room=${room.code}`;
  try {
    if (!navigator.clipboard?.writeText) throw new Error();
    await navigator.clipboard.writeText(link);
    copied = true; render();
    setTimeout(() => { copied = false; render(); }, 2000);
  } catch {
    error = `Invite: ${link} — room code ${room.code}`; render();
  }
}

function landing() {
  return `<section class="entry">
    <div class="mode-picker"><button data-action="solo-mode" aria-pressed="${soloMode}" class="${soloMode ? 'selected' : ''}">Üksi</button><button data-action="friends-mode" aria-pressed="${!soloMode}" class="${!soloMode ? 'selected' : ''}">Sõpradega</button></div>
    ${soloMode ? `<p class="setup-line">Arva ära AI-de salasõna.</p>
      <button class="primary" data-action="create-solo" ${busy ? 'disabled' : ''}>${busy ? 'Hetk…' : 'Alusta'}</button>
      <details id="setup-settings"><summary>Seaded</summary><label>AI-mängijaid</label><div class="tabs"><button data-action="two-ai" aria-pressed="${aiCount === 2}" class="${aiCount === 2 ? 'selected' : ''}">2</button><button data-action="three-ai" aria-pressed="${aiCount === 3}" class="${aiCount === 3 ? 'selected' : ''}">3</button></div><label for="difficulty">Algraskus <output id="difficulty-value">${difficulty}/10</output></label><input id="difficulty" data-field="difficulty" type="range" min="1" max="10" step="1" value="${difficulty}"><p class="setting-note">Kohandub iga vooru järel.</p></details>` : `
      <div class="tabs"><button data-action="create-tab" class="${!joinMode ? 'selected' : ''}">Loo tuba</button><button data-action="join-tab" class="${joinMode ? 'selected' : ''}">Liitu</button></div>
      <form data-form="enter"><label for="name">Nimi</label><input id="name" data-field="name" autocomplete="nickname" maxlength="24" value="${escape(form.name)}" required>
      ${joinMode ? `<label for="code">Toa kood</label><input id="code" data-field="code" class="code-input" placeholder="ABC123" autocomplete="off" autocapitalize="characters" maxlength="6" value="${escape(form.code)}" required>` : ''}
      <button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Hetk…' : joinMode ? 'Liitu' : 'Loo tuba'}</button></form>`}
    ${session ? '<button data-action="leave" class="text-button reset-session">Tagasi algusesse</button>' : ''}
  </section>`;
}

function players() {
  return `<div class="players">${room.players.map(player => `<span class="player ${player.id === room.cluegiver ? 'clue' : ''}">
    <span class="avatar">${escape(player.name[0].toUpperCase())}</span>
    <span class="player-name">${room.mode === 'solo' && !player.ai ? 'Sina · jälgija' : `${escape(player.name)}${player.ai ? ' · AI' : player.id === session.id ? ' (sina)' : ''}`} </span>
    ${player.id === room.cluegiver ? '✦' : player.locked ? '✓' : ''}
    ${room.mode !== 'solo' && session.id === room.host && player.id !== room.host && ['lobby', 'results'].includes(room.phase) ? `<button data-action="remove" data-player="${escape(player.id)}" aria-label="Remove ${escape(player.name)}">×</button>` : ''}
  </span>`).join('')}</div>`;
}

function lobby() {
  return `<section class="lobby">${players()}
    <button class="secondary" data-action="copy">${copied ? 'Link kopeeritud' : 'Kopeeri kutse'}</button>
    ${room.host === session.id ? `<button class="primary" data-action="start" ${room.players.length < 2 || busy ? 'disabled' : ''}>Alusta</button>` : '<p class="quiet">Ootan alustamist…</p>'}
    ${room.players.length < 2 ? '<p class="quiet">Ootan teist mängijat…</p>' : ''}
  </section>`;
}

function lockPanel() {
  if (room.cluegiver === session.id) return '';
  const me = room.players.find(p => p.id === session.id);
  if (me?.locked) return '<div class="locked-notice" role="status">Vastus lukus ✓</div>';
  return guessForm();
}

function guessForm() {
  return `<form data-form="answer" class="lock-form"><input id="answer" data-field="answer" aria-label="Sinu salajane vastus" placeholder="Sinu vastus" autocomplete="off" maxlength="80" value="${escape(form.answer)}" required><button class="primary" ${busy ? 'disabled' : ''}>Lukusta</button></form>`;
}

function chat() {
  const solo = room.mode === 'solo';
  const open = room.phase === 'discussion' && !solo;
  let status = '';
  if (solo && room.phase === 'discussion' && ['thinking', 'voice'].includes(room.aiStatus)) {
    status = `${room.players.find(p => p.id === room.speaking)?.name || 'AI'} mõtleb…`;
  }
  return `<section class="chat"><div class="messages" id="messages" aria-label="Vestlus">
    ${room.messages.map(message => `<div class="message ${message.player === session.id ? 'mine' : ''}"><span>${escape(room.players.find(p => p.id === message.player)?.name || 'Mängija')}</span><p>${escape(message.text)}</p></div>`).join('')}
    ${!room.messages.length && room.phase === 'discussion' ? '<p class="quiet empty-chat">Ootan esimest vihjet…</p>' : ''}
    </div>${status && room.messages.length ? `<div class="activity" role="status">${escape(status)}</div>` : ''}
    ${open ? `<form class="composer" data-form="message"><input id="message" data-field="message" aria-label="Sõnum" placeholder="Kirjuta…" autocomplete="off" maxlength="500" value="${escape(form.message)}" required><button aria-label="Saada" ${busy ? 'disabled' : ''}>↑</button></form>` : ''}
  </section>`;
}

function reveal() {
  const result = room.history.at(-1);
  return `<section class="result"><p class="result-outcome">${result.win === null ? 'Vastus ebaõnnestus' : result.win ? 'Võitsite' : 'Seekord ei võitnud'}</p>
    <h1 class="result-word">${escape(result.word)}</h1>
    <div class="answers"><div class="answer-row"><span>${result.mode === 'practice' ? 'Harjutusbot' : 'AI'}</span><b>${escape(result.ai || 'Vastamata')}</b>${answerMark(result.aiCorrect)}</div>
    ${result.answers.map(a => `<div class="answer-row"><span>${escape(a.name)}</span><b>${escape(a.word || 'Vastamata')}</b>${answerMark(a.correct)}</div>`).join('')}</div>
    ${room.host === session.id ? `<button class="primary" data-action="start" ${busy || room.round >= 30 ? 'disabled' : ''}>Järgmine voor</button>` : '<p class="quiet">Ootan järgmist vooru…</p>'}
  </section>`;
}

function answerMark(correct) {
  return `<span class="match" aria-label="${correct == null ? 'Hindamata' : correct ? 'Õige' : 'Vale'}">${correct == null ? '?' : correct ? '✓' : '×'}</span>`;
}

function audioToggle() {
  if (!room.voiceAvailable) return '';
  return `<button class="audio-toggle ${room.audioEnabled ? 'enabled' : ''}" data-action="toggle-audio" aria-label="${room.audioEnabled ? 'Lülita heli välja' : 'Lülita heli sisse'}" aria-pressed="${room.audioEnabled}" ${busy ? 'disabled' : ''}>${room.audioEnabled ? 'Heli sees' : 'Heli väljas'}</button>`;
}

function guessProgression(result) {
  if (!result.guessHistory?.length) return '';
  const names = [...new Set(result.guessHistory.map(entry => entry.name))];
  return `<details id="guess-history" class="guess-history"><summary>AI pakkumiste ajalugu</summary>${Number.isInteger(result.difficulty) ? `<p class="setting-note">Raskus ${result.difficulty}/10 → ${result.nextDifficulty}/10</p>` : ''}
    ${names.map(name => {
      const entries = result.guessHistory.filter(e => e.name === name);
      return `<div class="guess-track"><h3>${escape(name)}</h3><ol>${entries.map(e => `<li class="${e.correct ? 'matched' : ''}"><span>${e.final ? 'Lõplik' : `Pärast ${e.afterMessage}. repliiki`}</span><b>${escape(e.guess || 'Pakkumiseta')}</b>${answerMark(e.correct)}</li>`).join('')}</ol></div>`;
    }).join('')}</details>`;
}

function soloReveal() {
  const result = room.history.at(-1);
  return `<section class="result"><p class="result-outcome">${result.win === null ? 'Voor ebaõnnestus' : result.humanCorrect ? 'Võitsid' : result.aiWon ? 'AI-d võitsid' : 'Seekord võitjat pole'}</p>
    <h1 class="result-word">${escape(result.word || '—')}</h1>
    <div class="answers"><div class="answer-row"><span>Sina</span><b>${escape(result.humanWord || 'Vastamata')}</b>${answerMark(result.humanCorrect)}</div>
    ${result.answers.map(a => `<div class="answer-row"><span>${escape(a.name)}</span><b>${escape(a.word || 'Vastamata')}</b>${answerMark(a.correct)}</div>`).join('')}</div>
    <button class="primary" data-action="start" ${busy || room.round >= 30 ? 'disabled' : ''}>Järgmine voor</button>
    ${guessProgression(result)}
    ${room.messages.length ? `<details id="round-chat" class="round-chat"><summary>Vestlus</summary>${chat()}</details>` : ''}
  </section>`;
}

function soloView() {
  const active = ['discussion', 'paused'].includes(room.phase) && room.wordReady;
  if (room.phase === 'results') return soloReveal();
  if (room.phase === 'lobby') return `<div class="center-state">${room.wordError ? `<p class="error" role="alert">${escape(room.wordError)}</p>` : ''}<button class="primary" data-action="start" ${busy ? 'disabled' : ''}>Alusta</button></div>`;
  if (room.phase === 'preparing' || !room.wordReady) return `<div class="center-state" role="status"><span class="loading-dot"></span><p>${room.phase === 'paused' ? 'Pausil' : 'Valin sõna…'}</p></div>`;
  return `<div class="board">${chat()}<div class="guess-dock">
    ${active ? guessForm() : '<p class="quiet" role="status">Kontrollin vastuseid…</p>'}
  </div>${room.voiceError || audioError ? `<p class="inline-error" role="status">${escape(room.voiceError || audioError)}</p>` : ''}</div>`;
}

// A persistent audio element survives UI renders. Only public AI messages are voiced.
const voice = new Audio();
voice.preload = 'auto';
let audioError = '';
let audioQueue = [];
let heard = new Set();
let audioEpoch = 0;
let playingAudio = false;
let currentAudioUrl = '';

function stopAudio() {
  audioEpoch++;
  audioQueue = [];
  voice.pause();
  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  currentAudioUrl = '';
  voice.removeAttribute('src');
  voice.load();
  playingAudio = false;
}

function syncAudio() {
  if (!room || room.mode !== 'solo') return;
  if (!room.audioEnabled || room.phase !== 'discussion') {
    stopAudio();
    for (const m of room.messages) heard.add(m.id);
    return;
  }
  for (const message of room.messages) {
    if (heard.has(message.id)) continue;
    heard.add(message.id);
    if (message.audio) audioQueue.push({ code: room.code, id: message.id });
  }
  playNextAudio();
}

async function playNextAudio() {
  if (playingAudio || !audioQueue.length || !session || !room?.audioEnabled) return;
  playingAudio = true;
  const epoch = audioEpoch;
  const message = audioQueue.shift();
  try {
    const res = await fetch(apiURL(`audio?code=${encodeURIComponent(message.code)}&message=${encodeURIComponent(message.id)}`), {
      headers: { ...apiHeaders, 'x-player-token': session.token },
    });
    if (!res.ok) throw new Error('Helifail ei ole saadaval.');
    const blob = await res.blob();
    if (epoch !== audioEpoch) return;
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = URL.createObjectURL(blob);
    voice.src = currentAudioUrl;
    await voice.play();
  } catch (e) {
    if (epoch !== audioEpoch) return;
    audioError = e.name === 'NotAllowedError' ? 'Heli lubamiseks vajuta uuesti nupule „Heli sisse”.' : 'Heli esitamine ebaõnnestus. Tekstivestlus jätkub.';
    playingAudio = false;
    render();
    playNextAudio();
  }
}
voice.addEventListener('ended', () => { playingAudio = false; playNextAudio(); });
voice.addEventListener('error', () => { if (voice.getAttribute('src')) { playingAudio = false; playNextAudio(); } });

function unlockAudio() {
  // Unlock this same audio element during the user's tap, including on mobile browsers.
  const bytes = new Uint8Array(844);
  const view = new DataView(bytes.buffer);
  const label = (offset, value) => [...value].forEach((c, i) => bytes[offset + i] = c.charCodeAt(0));
  label(0, 'RIFF'); view.setUint32(4, 836, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, 800, true);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  voice.src = url;
  voice.play().then(() => { if (voice.src === url) voice.pause(); URL.revokeObjectURL(url); }).catch(() => URL.revokeObjectURL(url));
}

async function toggleAudio() {
  if (!room || busy) return;
  const enabled = !room.audioEnabled;
  audioError = '';
  if (!enabled) stopAudio();
  else {
    unlockAudio();
    for (const m of room.messages) heard.add(m.id);
  }
  await act('audio', { enabled });
}

function gameView() {
  if (room.mode === 'solo') return soloView();
  if (room.phase === 'lobby') return lobby();
  if (room.phase === 'preparing') return '<div class="center-state" role="status"><span class="loading-dot"></span><p>Valin sõna…</p></div>';
  if (room.phase === 'results') return reveal();
  const cluegiver = room.cluegiver === session.id;
  return `<div class="board">
    ${cluegiver && room.phase === 'discussion' ? `<button class="secret" data-action="peek">${peek ? escape(room.word) : 'Näita sõna'}</button>` : ''}
    ${chat()}<div class="guess-dock">${room.phase === 'discussion' ? lockPanel() : '<p class="quiet" role="status">Kontrollin vastuseid…</p>'}</div>
  </div>`;
}

function headerControls() {
  if (!room) return '';
  if (room.mode === 'solo') return `${['preparing', 'discussion', 'paused'].includes(room.phase) ? audioToggle() : ''}
    ${['preparing', 'discussion'].includes(room.phase) ? '<button class="icon-button" data-action="pause-solo" aria-label="Peata vestlus" title="Paus">Ⅱ</button>' : room.phase === 'paused' ? '<button class="icon-button" data-action="resume-solo" aria-label="Jätka vestlust" title="Jätka">▶</button>' : ''}
    <button class="icon-button leave" data-action="leave" aria-label="Lahku mängust" title="Lahku">×</button>`;
  return `${room.phase === 'lobby' ? `<button class="room-code" data-action="copy" aria-label="Kopeeri kutse">${escape(room.code)}${copied ? ' ✓' : ''}</button>` : ''}
    ${room.phase === 'discussion' ? '<span class="timer" id="countdown"></span>' : ''}
    <button class="icon-button leave" data-action="leave" aria-label="Lahku mängust" title="Lahku">×</button>`;
}

function render() {
  const active = document.activeElement;
  const focusedId = active?.id;
  const start = active?.selectionStart;
  const end = active?.selectionEnd;
  const oldMessages = document.querySelector('#messages');
  const scrollTop = oldMessages?.scrollTop;
  const wasAtBottom = !oldMessages || oldMessages.scrollHeight - oldMessages.clientHeight - oldMessages.scrollTop < 50;
  const expanded = [...app.querySelectorAll('details[open]')].map(d => d.id);
  app.className = room ? 'shell playing' : 'shell';
  app.innerHTML = `<header class="app-header"><a class="brand" href="${escape(homeURL.pathname)}" data-action="home" aria-label="Between Us, algusesse">between us<span class="brand-dot">.</span></a><div class="header-controls">${headerControls()}</div></header>
    <div class="screen ${room?.phase === 'results' ? 'results-screen' : ''}">${room ? gameView() : landing()}</div>
    ${room?.mode !== 'solo' && room?.wordError ? `<p class="error" role="alert">${escape(room.wordError)}</p>` : ''}
    ${error ? `<div role="alert" class="error">${escape(error)}${session ? '<button data-action="leave">Algusesse</button>' : ''}</div>` : ''}`;
  for (const id of expanded) { const detail = document.getElementById(id); if (detail) detail.open = true; }
  if (focusedId) {
    const field = document.getElementById(focusedId);
    if (field) {
      field.focus({ preventScroll: true });
      if (typeof start === 'number') field.setSelectionRange(start, end);
    }
  }
  const messages = document.querySelector('#messages');
  if (messages) messages.scrollTop = wasAtBottom ? messages.scrollHeight : scrollTop;
  updateClock();
}

function updateClock() {
  const clock = document.querySelector('#countdown');
  if (!clock || !room) return;
  const seconds = Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000));
  clock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  clock.classList.toggle('urgent', seconds < 20);
}

app.addEventListener('input', event => {
  const field = event.target.dataset.field;
  if (!field) return;
  if (field === 'difficulty') {
    difficulty = Number(event.target.value);
    document.querySelector('#difficulty-value').textContent = `${difficulty}/10`;
    return;
  }
  form[field] = event.target.value;
  if (field === 'code') { form.code = form.code.toUpperCase().replace(/[^A-Z0-9]/g, ''); event.target.value = form.code; }
});
app.addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  if (event.target.dataset.form === 'enter') enter(joinMode ? 'join' : 'create');
  if (event.target.dataset.form === 'message') act('message', { text: form.message });
  if (event.target.dataset.form === 'answer') { if (room?.mode === 'solo') stopAudio(); act('answer', { word: form.answer }); }
});
app.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  event.preventDefault();
  switch (button.dataset.action) {
    case 'friends-mode': soloMode = false; render(); break;
    case 'solo-mode': soloMode = true; joinMode = false; render(); break;
    case 'two-ai': aiCount = 2; render(); break;
    case 'three-ai': aiCount = 3; render(); break;
    case 'create-solo': if (!busy) { unlockAudio(); enter('create'); } break;
    case 'toggle-audio': toggleAudio(); break;
    case 'pause-solo': stopAudio(); if (!busy) act('pause'); break;
    case 'resume-solo': if (!busy) { if (room?.audioEnabled) unlockAudio(); act('resume'); } break;
    case 'create-tab': joinMode = false; error = ''; render(); break;
    case 'join-tab': joinMode = true; error = ''; render(); break;
    case 'copy': copyInvite(); break;
    case 'peek': peek = !peek; render(); break;
    case 'start': if (!busy) { if (room?.mode === 'solo' && room.audioEnabled) unlockAudio(); act('start'); } break;
    case 'remove': if (!busy) act('remove', { player: button.dataset.player }); break;
    case 'resume': poll(); break;
    case 'home': if (!room) break; // Follow the same leave behavior as the explicit button.
    case 'leave': leave(); break;
  }
});
function fitViewport() {
  document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`);
}
fitViewport();
window.visualViewport?.addEventListener('resize', fitViewport);
window.addEventListener('resize', fitViewport);
render();
poll();
setInterval(poll, 1000);
setInterval(updateClock, 250);
