'use strict';

// Medição de loudness (LUFS) de um vídeo do YouTube.
// O player do IFrame não expõe áudio, então não dá para medir no navegador.
// Em vez de baixar o vídeo (o YouTube bloqueia IPs de datacenter com "not a bot"),
// lemos a loudness integrada que o próprio YouTube publica na página do vídeo:
// playerConfig.audioConfig.trackAbsoluteLoudnessLkfs.

const ENABLED = process.env.DJ_SYNC_LOUDNESS !== 'false';
const TARGET_LUFS = Number(process.env.DJ_SYNC_TARGET_LUFS || -16);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win32; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const cache = new Map();   // videoId → { lufs, gain }
const failed = new Map();  // videoId → timestamp (evita repetir falhas)
const pending = new Map(); // videoId → Promise
const queue = [];
let active = 0;
const MAX_ACTIVE = 2;

function clampGain(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.4, Math.min(1.3, Math.round(n * 100) / 100));
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    active++;
    Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => { active--; pump(); });
  }
}

function enqueue(run) {
  return new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    pump();
  });
}

// Extrai um objeto JSON grande do HTML sem depender de regex "até o primeiro };".
function extractJsonObject(html, marker) {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const open = html.indexOf('{', start + marker.length);
  if (open < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(open, i + 1);
    }
  }
  return null;
}

async function fetchTrackLufs(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=pt`, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`YouTube respondeu ${response.status}`);

  const html = await response.text();
  const json = extractJsonObject(html, 'ytInitialPlayerResponse');
  if (!json) throw new Error('resposta do player não encontrada');

  const data = JSON.parse(json);
  const audio = data.playerConfig?.audioConfig || {};
  const lufs = Number(audio.trackAbsoluteLoudnessLkfs ?? audio.perceptualLoudnessDb);
  if (!Number.isFinite(lufs)) throw new Error('loudness não encontrada');
  return lufs;
}

function measureVideoLoudness(videoId) {
  if (!ENABLED) return Promise.resolve(null);
  const id = String(videoId || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return Promise.resolve(null);
  if (cache.has(id)) return Promise.resolve(cache.get(id));

  const lastFailed = failed.get(id);
  if (lastFailed && Date.now() - lastFailed < 10 * 60 * 1000) return Promise.resolve(null);
  if (pending.has(id)) return pending.get(id);

  const job = enqueue(async () => {
    const lufs = await fetchTrackLufs(id);
    const gain = clampGain(10 ** ((TARGET_LUFS - lufs) / 20));
    const result = { lufs, gain };
    cache.set(id, result);
    console.log(`Loudness: ${id} = ${lufs.toFixed(2)} LUFS → ganho ${Math.round(gain * 100)}%`);
    return result;
  })
    .catch((error) => {
      failed.set(id, Date.now());
      console.error(`Loudness: falhou para ${id} — ${error.message}`);
      return null;
    })
    .finally(() => pending.delete(id));

  pending.set(id, job);
  return job;
}

module.exports = { measureVideoLoudness, loudnessEnabled: ENABLED, TARGET_LUFS };
