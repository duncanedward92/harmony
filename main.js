// ---------- config ----------

// Keep in sync with --cols / --rows in style.css
const COLS = 6;
const ROWS = 12;

// Every cell is a step on a pentatonic scale, so any combination harmonizes.
const SCALE = [0, 2, 4, 7, 9]; // semitones: major pentatonic
const BASE_FREQ = 130.81; // C3, bottom-left cell

// Public test broker: fine for prototyping, anyone can read/write it.
const BROKER_URL = 'wss://broker.emqx.io:8084/mqtt';
const ROOM = 'harmony-kabk-7f3a/v1';

const HEARTBEAT_MS = 2000; // resend held notes this often
const PEER_TIMEOUT_MS = 5000; // drop a peer's notes after this much silence
const MAX_NOTES_PER_PEER = 10;

// ---------- grid ----------

const grid = document.getElementById('grid');
const cells = [];
for (let i = 0; i < COLS * ROWS; i++) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.dataset.index = i;
  grid.appendChild(cell);
  cells.push(cell);
}

// Pitch rises left to right and bottom to top.
function cellFreq(index) {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  const step = col + (ROWS - 1 - row);
  const semitones = 12 * Math.floor(step / SCALE.length) + SCALE[step % SCALE.length];
  return BASE_FREQ * 2 ** (semitones / 12);
}

// ---------- audio ----------

let ctx = null;
let master = null;
const voices = new Map(); // "owner:cell" -> voice

function unlockAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const compressor = ctx.createDynamicsCompressor();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(compressor).connect(ctx.destination);
  }
  if (ctx.state !== 'running') ctx.resume().then(render);
}

function startVoice(index) {
  const freq = cellFreq(index);
  const now = ctx.currentTime;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.16, now + 0.03);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(freq * 4, 8000);

  const oscs = [
    ['triangle', freq, 1],
    ['sine', freq * 2, 0.25],
  ].map(([type, f, level]) => {
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = f;
    oscGain.gain.value = level;
    osc.connect(oscGain).connect(filter);
    osc.start(now);
    return osc;
  });

  filter.connect(gain).connect(master);
  return { gain, oscs };
}

function stopVoice(voice) {
  const now = ctx.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setTargetAtTime(0, now, 0.08);
  voice.oscs.forEach((osc) => osc.stop(now + 0.6));
}

// ---------- state ----------

const clientId = Math.random().toString(36).slice(2, 10);
const pointers = new Map(); // pointerId -> cell index (this device)
const peers = new Map(); // peer id -> { cells: Set<number>, lastSeen: number }

function localCells() {
  return new Set(pointers.values());
}

// Bring the squares and the sounding voices in line with current state.
function render() {
  const wanted = new Set();
  const lit = new Set();
  for (const index of localCells()) {
    wanted.add(`${clientId}:${index}`);
    lit.add(index);
  }
  for (const [id, peer] of peers) {
    for (const index of peer.cells) {
      wanted.add(`${id}:${index}`);
      lit.add(index);
    }
  }

  cells.forEach((cell, i) => cell.classList.toggle('on', lit.has(i)));

  if (!ctx || ctx.state !== 'running') return;
  for (const [key, voice] of voices) {
    if (!wanted.has(key)) {
      stopVoice(voice);
      voices.delete(key);
    }
  }
  for (const key of wanted) {
    if (!voices.has(key)) voices.set(key, startVoice(Number(key.split(':')[1])));
  }
}

// ---------- input ----------

function cellAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.classList.contains('cell') ? Number(el.dataset.index) : null;
}

function setPointer(e) {
  const index = cellAt(e.clientX, e.clientY);
  if (pointers.get(e.pointerId) === (index ?? undefined)) return;
  if (index === null) pointers.delete(e.pointerId);
  else pointers.set(e.pointerId, index);
  render();
  publish();
}

function clearPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  render();
  publish();
}

window.addEventListener('pointerdown', (e) => {
  unlockAudio();
  setPointer(e);
});
window.addEventListener('pointermove', (e) => {
  // sliding a held finger glides to the square under it
  if (pointers.has(e.pointerId)) setPointer(e);
});
window.addEventListener('pointerup', clearPointer);
window.addEventListener('pointercancel', clearPointer);
window.addEventListener('blur', () => {
  if (!pointers.size) return;
  pointers.clear();
  render();
  publish();
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- network ----------

const topic = `${ROOM}/${clientId}`;
let client = null;

function publish() {
  if (client && client.connected) client.publish(topic, JSON.stringify([...localCells()]));
}

function onPeerMessage(id, payload) {
  let list;
  try {
    list = JSON.parse(payload);
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  const valid = list
    .filter((n) => Number.isInteger(n) && n >= 0 && n < cells.length)
    .slice(0, MAX_NOTES_PER_PEER);
  if (valid.length) peers.set(id, { cells: new Set(valid), lastSeen: Date.now() });
  else peers.delete(id);
  render();
}

if (window.mqtt) {
  client = mqtt.connect(BROKER_URL, {
    clientId: `harmony-${clientId}`,
    reconnectPeriod: 2000,
    // broker announces our release if we vanish mid-note
    will: { topic, payload: '[]', qos: 0, retain: false },
  });
  client.on('connect', () => {
    client.subscribe(`${ROOM}/+`);
    publish();
  });
  client.on('message', (t, payload) => {
    const id = t.slice(ROOM.length + 1);
    if (id !== clientId) onPeerMessage(id, payload.toString());
  });
  client.on('error', (err) => console.warn('harmony: broker error', err.message));
} else {
  console.warn('harmony: mqtt library failed to load, running solo');
}

setInterval(() => {
  if (pointers.size) publish();
  const cutoff = Date.now() - PEER_TIMEOUT_MS;
  let dropped = false;
  for (const [id, peer] of peers) {
    if (peer.lastSeen < cutoff) dropped = peers.delete(id) || dropped;
  }
  if (dropped) render();
}, HEARTBEAT_MS);
