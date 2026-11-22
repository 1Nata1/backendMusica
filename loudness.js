'use strict';

// Medição de loudness (LUFS) de um vídeo do YouTube.
// O player do IFrame não expõe áudio, então não dá para medir no navegador.
// A página /watch costuma devolver 429 em IPs de datacenter (Render), então usamos
// a API interna do player — a mesma que a busca por nome já usa — e lemos
// playerConfig.audioConfig.trackAbsoluteLoudnessLkfs (loudness integrada do YouTube).

const ENABLED = process.env.DJ_SYNC_LOUDNESS !== 'false';
const TARGET_LUFS = Number(process.env.DJ_SYNC_TARGET_LUFS || -16);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const cache = new Map();   // videoId → { lufs, gain }
const failed = new Map();  // videoId → timestamp (evita repetir falhas)
const pending = new Map(); // videoId → Promise
const queue = [];
let active = 0;
const MAX_ACTIVE = 2;

let innertube = { key: null, version: null, sts: 0, visitor: null, cookie: null, fetchedAt: 0 };

// Função na Vercel: sai com outro IP, útil quando o Render é bloqueado pelo YouTube.
const PROXY_URL = process.env.DJ_SYNC_LOUDNESS_PROXY || 'https://teste-de-musica.vercel.app/api/loudness';

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getInnertube() {
  if (innertube.key && Date.now() - innertube.fetchedAt < 30 * 60 * 1000) return innertube;

  const response = await fetch('https://www.youtube.com/', {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`YouTube respondeu ${response.status}`);

  const html = await response.text();
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const version = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  const sts = Number(html.match(/"STS":(\d+)/)?.[1] || 0);
  const visitor = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || undefined;
  const cookie = response.headers.get('set-cookie') || undefined;
  if (!key || !version || !sts) throw new Error('configuração do player não encontrada');

  innertube = { key, version, sts, visitor, cookie, fetchedAt: Date.now() };
  return innertube;
}

function loudnessOf(data) {
  const audio = data?.playerConfig?.audioConfig || {};
  const lufs = Number(audio.trackAbsoluteLoudnessLkfs ?? audio.perceptualLoudnessDb);
  if (!Number.isFinite(lufs)) throw new Error('loudness não encontrada');
  return lufs;
}

async function fromPlayerApi(videoId, host) {
  const { key, version, sts, visitor, cookie } = await getInnertube();
  const response = await fetch(`${host}/youtubei/v1/player?key=${key}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': version,
      ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: host,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: version,
          hl: 'pt',
          gl: 'BR',
          ...(visitor ? { visitorData: visitor } : {}),
        },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: { contentPlaybackContext: { signatureTimestamp: sts } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${host} respondeu ${response.status}`);
  const data = await response.json().catch(() => ({}));
  try {
    return loudnessOf(data);
  } catch (error) {
    const status = data.playabilityStatus?.status || 'sem status';
    const reason = String(data.playabilityStatus?.reason || '').slice(0, 80);
    throw new Error(`${host}: ${error.message} (${status}${reason ? ' — ' + reason : ''})`);
  }
}

async function fromVercelProxy(videoId) {
  const response = await fetch(`${PROXY_URL}?id=${encodeURIComponent(videoId)}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`proxy respondeu ${response.status}`);
  const data = await response.json();
  const lufs = Number(data.lufs);
  if (!Number.isFinite(lufs)) throw new Error(`proxy sem loudness: ${String(data.error || '').slice(0, 80)}`);
  return lufs;
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

// Segunda opção: a página do vídeo (bloqueada com 429 em alguns IPs).
async function fromWatchPage(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=pt`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`YouTube respondeu ${response.status}`);
  const json = extractJsonObject(await response.text(), 'ytInitialPlayerResponse');
  if (!json) throw new Error('resposta do player não encontrada');
  return loudnessOf(JSON.parse(json));
}

const PLAYER_HOSTS = [
  'https://www.youtube.com',
  'https://www.youtube-nocookie.com',
  'https://music.youtube.com',
];

async function fetchTrackLufs(videoId) {
  // Primeiro tenta a Vercel (outro IP); depois os hosts diretos; por fim o /watch.
  try {
    return await fromVercelProxy(videoId);
  } catch (error) {
    console.error(`Loudness: proxy indisponível para ${videoId} — ${error.message}`);
  }

  let lastError;
  for (const host of PLAYER_HOSTS) {
    try {
      return await fromPlayerApi(videoId, host);
    } catch (error) {
      lastError = error;
    }
  }
  // 429 é temporário: uma segunda rodada depois de alguns segundos.
  if (/429/.test(lastError?.message || '')) {
    await wait(4000);
    for (const host of PLAYER_HOSTS) {
      try {
        return await fromPlayerApi(videoId, host);
      } catch (error) {
        lastError = error;
      }
    }
  }
  try {
    return await fromWatchPage(videoId);
  } catch (error) {
    throw new Error(`${lastError?.message || 'player API falhou'} | watch: ${error.message}`);
  }
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
