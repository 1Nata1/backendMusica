'use strict';

// Medição de loudness (LUFS) de um vídeo do YouTube.
// O player do IFrame não expõe áudio, então não dá para medir no navegador.
// A página /watch costuma devolver 429 em IPs de datacenter (Render), então usamos
// a API interna do player — a mesma que a busca por nome já usa — e lemos
// playerConfig.audioConfig.trackAbsoluteLoudnessLkfs (loudness integrada do YouTube).

const ENABLED = process.env.DJ_SYNC_LOUDNESS !== 'false';
// Com o medidor local, o Render não precisa tentar o YouTube (IP bloqueado).
const SERVER_MEASURE = process.env.DJ_SYNC_LOUDNESS_SERVER_MEASURE !== 'false';
const TARGET_LUFS = Number(process.env.DJ_SYNC_TARGET_LUFS || -16);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const cache = new Map();   // videoId → { lufs, gain }
const failed = new Map();  // videoId → timestamp (evita repetir falhas)
const pending = new Map(); // videoId → Promise
const queue = [];
let active = 0;
const MAX_ACTIVE = 2;

let innertube = { key: null, version: null, sts: 0, visitor: null, cookie: null, fetchedAt: 0 };

// API externa (KeyAPI): sai de outro IP e devolve o playerResponse bruto do YouTube.
// 100 créditos grátis no cadastro; um crédito por vídeo novo (o cache evita repetir).
const API_KEY = String(process.env.DJ_SYNC_LOUDNESS_API_KEY || '').trim();
const API_URL = process.env.DJ_SYNC_LOUDNESS_API_URL || 'https://api.keyapi.ai/v1/youtube/get_video_info';
if (API_KEY) console.log(`Loudness: usando API externa (${API_URL.split('/')[2]})`);
if (ENABLED && !SERVER_MEASURE) console.log('Loudness: medição no servidor desativada (aguardando medidor local)');

// Função na Vercel: sai com outro IP, útil quando o Render é bloqueado pelo YouTube.
const PROXY_URL = process.env.DJ_SYNC_LOUDNESS_PROXY || 'https://teste-de-musica.vercel.app/api/loudness';

// O cliente WEB costuma levar LOGIN_REQUIRED em IPs de datacenter. ANDROID e iOS
// respondem sem login e também expõem a loudness.
const PLAYER_CLIENTS = [
  { name: 'ANDROID', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip', headerName: '3', client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'pt', gl: 'BR' } },
  { name: 'IOS', ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)', headerName: '5', client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'pt', gl: 'BR' } },
];

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

async function fromPlayerApi(videoId, host, spec) {
  const { key, version, sts, visitor, cookie } = await getInnertube();
  const isWeb = spec.name === 'WEB';
  const response = await fetch(`${host}/youtubei/v1/player?key=${key}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': isWeb ? USER_AGENT : spec.ua,
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'X-Youtube-Client-Name': isWeb ? '1' : spec.headerName,
      'X-Youtube-Client-Version': isWeb ? version : spec.client.clientVersion,
      ...(isWeb && visitor ? { 'X-Goog-Visitor-Id': visitor } : {}),
      ...(isWeb && cookie ? { Cookie: cookie } : {}),
      Origin: host,
    },
    body: JSON.stringify({
      context: {
        client: isWeb
          ? { clientName: 'WEB', clientVersion: version, hl: 'pt', gl: 'BR', ...(visitor ? { visitorData: visitor } : {}) }
          : spec.client,
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: { contentPlaybackContext: { signatureTimestamp: sts } },
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`${host} respondeu ${response.status}`);
  const data = await response.json().catch(() => ({}));
  try {
    return loudnessOf(data);
  } catch (error) {
    const status = data.playabilityStatus?.status || 'sem status';
    const reason = String(data.playabilityStatus?.reason || '').slice(0, 80);
    throw new Error(`${host}/${spec.name}: ${error.message} (${status}${reason ? ' — ' + reason : ''})`);
  }
}

// A resposta da KeyAPI embrulha o playerResponse do YouTube. Em vez de depender
// do formato do envelope, procuramos o campo diretamente no JSON inteiro.
function findLoudnessInJson(value) {
  if (!value || typeof value !== 'object') return null;
  const audio = value.playerConfig?.audioConfig;
  if (audio) {
    const lufs = Number(audio.trackAbsoluteLoudnessLkfs ?? audio.perceptualLoudnessDb);
    if (Number.isFinite(lufs)) return lufs;
  }
  for (const child of Object.values(value)) {
    const found = findLoudnessInJson(child);
    if (found !== null) return found;
  }
  return null;
}

async function fromExternalApi(videoId) {
  if (!API_KEY) throw new Error('sem chave de API');
  const separator = API_URL.includes('?') ? '&' : '?';
  const response = await fetch(`${API_URL}${separator}video_id=${encodeURIComponent(videoId)}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`API externa respondeu ${response.status}: ${text.slice(0, 100)}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error('API externa devolveu JSON inválido'); }
  const lufs = findLoudnessInJson(data);
  if (lufs === null) {
    const playability = data?.data?.playabilityStatus?.status || data?.playabilityStatus?.status || 'desconhecido';
    throw new Error(`API externa sem loudness (${playability})`);
  }
  return lufs;
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
  // Ordem: API externa (IP próprio), proxy da Vercel, hosts diretos, página /watch.
  if (API_KEY) {
    try {
      return await fromExternalApi(videoId);
    } catch (error) {
      console.error(`Loudness: API externa falhou para ${videoId} — ${error.message}`);
    }
  }

  try {
    return await fromVercelProxy(videoId);
  } catch (error) {
    console.error(`Loudness: proxy indisponível para ${videoId} — ${error.message}`);
  }

  const attempts = [];
  for (const spec of PLAYER_CLIENTS) attempts.push({ host: PLAYER_HOSTS[0], spec });
  attempts.push({ host: PLAYER_HOSTS[0], spec: { name: 'WEB' } });
  for (const host of PLAYER_HOSTS.slice(1)) {
    for (const spec of PLAYER_CLIENTS) attempts.push({ host, spec });
  }

  let lastError;
  for (const { host, spec } of attempts) {
    try {
      return await fromPlayerApi(videoId, host, spec);
    } catch (error) {
      lastError = error;
    }
  }

  // 429 é temporário: uma segunda rodada rápida depois de alguns segundos.
  if (/429/.test(lastError?.message || '')) {
    await wait(4000);
    for (const spec of PLAYER_CLIENTS) {
      try {
        return await fromPlayerApi(videoId, PLAYER_HOSTS[0], spec);
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
  if (!ENABLED || !SERVER_MEASURE) return Promise.resolve(null);
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

// Recebe uma medição feita pelo medidor local (IP residencial) e guarda no mesmo
// cache usado pela medição do servidor, sem gastar crédito de API externa.
function rememberLoudness(videoId, lufs) {
  if (!ENABLED) return null;
  const id = String(videoId || '');
  const value = Number(lufs);
  if (!/^[A-Za-z0-9_-]{11}$/.test(id) || !Number.isFinite(value) || value < -80 || value > 10) return null;

  const gain = clampGain(10 ** ((TARGET_LUFS - value) / 20));
  const result = { lufs: value, gain };
  cache.set(id, result);
  failed.delete(id);
  console.log(`Loudness local: ${id} = ${value.toFixed(2)} LUFS → ganho ${Math.round(gain * 100)}%`);
  return result;
}

module.exports = {
  measureVideoLoudness,
  rememberLoudness,
  loudnessEnabled: ENABLED,
  serverMeasureEnabled: SERVER_MEASURE,
  TARGET_LUFS,
};
