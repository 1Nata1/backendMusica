'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL_MS = 5000;
const HOST_GRACE_MS = 15000;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;

const TWITCH = {
  channel: (process.env.TWITCH_CHANNEL || '').replace(/^#/, '').trim().toLowerCase(),
  nick: (process.env.TWITCH_BOT_NICK || process.env.TWITCH_CHANNEL || '').replace(/^#/, '').trim().toLowerCase(),
  token: (process.env.TWITCH_OAUTH_TOKEN || '').trim(),
  room: (process.env.TWITCH_ROOM || '').trim().toUpperCase(),
  commands: (process.env.TWITCH_SR_COMMANDS || '$sr,!sr').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean),
  reply: process.env.TWITCH_CHAT_REPLY !== 'false',
  ircUrl: process.env.TWITCH_IRC_URL || 'wss://irc-ws.chat.twitch.tv:443',
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());

// Permite que o frontend hospedado em outro domínio (ex.: Vercel) chame a API
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, object>} */
const rooms = new Map();

// ---------------------------------------------------------------- helpers

function makeCode(length = 5) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(code = makeCode()) {
  return {
    code,
    createdAt: Date.now(),
    emptySince: null,
    current: null,
    playing: false,
    position: 0,
    updatedAt: Date.now(),
    queue: [],
    history: [],
    //Histórico de pedidos por usuário (chave = nome em minúsculas)
    userRequests: {},
    messages: [],
    clients: new Set(),
    hostId: null,
    hostTimer: null,
    settings: { allowRequests: true },
  };
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase()) || null;
}

// Mantém só uma entrada por vídeo na lista de cada pessoa (a mais recente).
// Também limpa duplicatas antigas que ficaram salvas antes dessa correção.
function uniqueRequests(tracks) {
  const byVideo = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!track || !track.videoId) continue;
    const previous = byVideo.get(track.videoId);
    if (!previous || Number(track.addedAt || 0) >= Number(previous.addedAt || 0)) {
      byVideo.set(track.videoId, track);
    }
  }
  return Array.from(byVideo.values())
    .sort((a, b) => Number(a.addedAt || 0) - Number(b.addedAt || 0))
    .slice(-60);
}

function currentPosition(room) {
  if (!room.current) return 0;
  const elapsed = room.playing ? (Date.now() - room.updatedAt) / 1000 : 0;
  return Math.max(0, room.position + elapsed);
}

function stateFor(room, ws) {
  return {
    type: 'state',
    code: room.code,
    current: room.current,
    playing: room.playing,
    position: currentPosition(room),
    serverTime: Date.now(),
    queue: room.queue,
    userRequests: Object.fromEntries(
      Object.entries(room.userRequests || {}).map(([user, tracks]) => [user, uniqueRequests(tracks)])
    ),
    messages: room.messages.slice(-60),
    listeners: room.clients.size,
    hostId: room.hostId,
    isHost: room.hostId === ws.clientId,
    settings: room.settings,
  };
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function sendState(ws, room) {
  send(ws, stateFor(room, ws));
}

function broadcastState(room) {
  for (const ws of room.clients) sendState(ws, room);
}

function pushMessage(room, message) {
  room.messages.push({ id: crypto.randomUUID(), at: Date.now(), ...message });
  if (room.messages.length > 100) room.messages.splice(0, room.messages.length - 100);
}

function systemMessage(room, text) {
  pushMessage(room, { kind: 'system', text });
  broadcastState(room);
}

function toast(ws, text) {
  send(ws, { type: 'toast', text });
}

function parseYouTubeId(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;

  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  let id = null;

  if (host === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] || null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch' || url.pathname === '/watch/') {
      id = url.searchParams.get('v');
    } else {
      const parts = url.pathname.split('/').filter(Boolean);
      const marker = parts.findIndex((p) => ['embed', 'shorts', 'live', 'v'].includes(p));
      if (marker !== -1) id = parts[marker + 1] || null;
    }
  }

  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

async function fetchMeta(videoId) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`
  )}&format=json`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('oEmbed falhou');
    const data = await response.json();
    return {
      title: typeof data.title === 'string' ? data.title.slice(0, 160) : `Vídeo ${videoId}`,
      author: typeof data.author_name === 'string' ? data.author_name.slice(0, 80) : '',
    };
  } catch {
    return { title: `Vídeo ${videoId}`, author: '' };
  }
}

// ------------------------------------------------------------ busca por nome

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const searchCache = new Map();
let innertube = { key: null, version: null, fetchedAt: 0 };

async function getInnertube() {
  if (innertube.key && Date.now() - innertube.fetchedAt < 60 * 60 * 1000) return innertube;

  const response = await fetch('https://www.youtube.com/', {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Não foi possível acessar o YouTube');

  const html = await response.text();
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const version = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  if (!key || !version) throw new Error('Chave de busca do YouTube não encontrada');

  innertube = { key, version, fetchedAt: Date.now() };
  return innertube;
}

async function searchWithInnertube(query) {
  const { key, version } = await getInnertube();
  const response = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${key}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': version,
      Origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: version, hl: 'pt', gl: 'BR' } },
      query,
      searchType: 'SEARCH_TYPE_VIDEO',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Busca falhou (${response.status})`);

  const data = await response.json();
  const videos = [];
  const stack = [data];
  let visited = 0;

  while (stack.length && visited++ < 30000 && videos.length < 20) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const renderer = node.videoRenderer;
    if (renderer?.videoId) {
      videos.push({
        videoId: renderer.videoId,
        title: renderer.title?.runs?.map((r) => r.text).join('') || renderer.title?.simpleText || '',
        author: renderer.ownerText?.runs?.map((r) => r.text).join('') || '',
      });
    }
    // Empilha em ordem reversa para preservar a ordem original dos resultados
    const children = Object.values(node).filter((v) => v && typeof v === 'object');
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return videos;
}

async function searchWithApiKey(query) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10&q=${encodeURIComponent(query)}&key=${process.env.YOUTUBE_API_KEY}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.items || []).map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    author: item.snippet.channelTitle,
  }));
}

function pickBest(candidates, query) {
  const normalizedQuery = query.toLowerCase().trim();
  const terms = normalizedQuery.split(/\s+/).filter((t) => t.length > 2);
  const good = /\b(official|oficial|audio|áudio|clip|videoclipe|original|video)\b/i;
  const bad = /\b(lyrics?|letra|karaoke|cover|react|reaction|reação|tutorial|par[oó]dia|parody|remix|slowed|sped|nightcore|8d|ao vivo|live)\b/i;

  let best = candidates[0];
  let bestScore = -Infinity;

  candidates.slice(0, 10).forEach((candidate, index) => {
    const title = candidate.title.toLowerCase();
    const author = (candidate.author || '').toLowerCase();
    let score = (good.test(title) ? 4 : 0) - (bad.test(title) ? 5 : 0);
    if (title.includes(normalizedQuery)) score += 3;
    for (const term of terms) {
      if (title.includes(term)) score += 1;
      if (author.includes(term)) score += 2;
    }
    score -= index * 0.35;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  });

  return best;
}

async function searchYouTube(query) {
  const cacheKey = query.trim().toLowerCase();
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);

  let candidates = [];
  if (process.env.YOUTUBE_API_KEY) {
    try {
      candidates = await searchWithApiKey(query);
    } catch (error) {
      console.error('Busca com API key falhou, usando fallback:', error.message);
    }
  }
  if (!candidates.length) candidates = await searchWithInnertube(query);
  if (!candidates.length) throw new Error('Nenhum vídeo encontrado');

  const chosen = pickBest(candidates, query);
  const result = {
    videoId: chosen.videoId,
    title: String(chosen.title || `Vídeo ${chosen.videoId}`).slice(0, 160),
    author: String(chosen.author || '').slice(0, 80),
  };

  searchCache.set(cacheKey, result);
  setTimeout(() => searchCache.delete(cacheKey), 10 * 60 * 1000);
  return result;
}

async function addTrack(room, input, requestedBy, ws) {
  if (!room.settings.allowRequests && room.hostId !== ws.clientId) {
    toast(ws, 'O DJ desativou os pedidos da fila.');
    return;
  }

  const raw = String(input || '').trim();
  if (!raw) return;
  if (room.queue.length >= 100) {
    toast(ws, 'A fila está cheia (máximo de 100 músicas).');
    return;
  }

  let track;
  const directId = parseYouTubeId(raw);

  if (directId) {
    const meta = await fetchMeta(directId);
    track = { videoId: directId, title: meta.title, author: meta.author };
  } else {
    toast(ws, `Buscando “${raw.slice(0, 60)}” no YouTube...`);
    try {
      track = await searchYouTube(raw);
    } catch (error) {
      console.error('Erro na busca:', error.message);
      innertube.fetchedAt = 0;
      toast(ws, 'Não encontrei essa música. Tente “artista + nome” ou cole um link.');
      return;
    }
  }

  if (!rooms.has(room.code)) return;
  if (room.queue.some((t) => t.videoId === track.videoId) || room.current?.videoId === track.videoId) {
    toast(ws, 'Essa música já está na fila.');
    return;
  }

  const cleanName = String(requestedBy || 'Convidado').trim().slice(0, 24) || 'Convidado';
  const key = cleanName.toLowerCase();

  room.queue.push({
    trackId: crypto.randomUUID(),
    videoId: track.videoId,
    title: track.title,
    author: track.author,
    requestedBy: cleanName,
    addedAt: Date.now(),
  });

  // Guarda o pedido no gosto musical da pessoa, mesmo depois que a música toca.
  // Se ela pedir a mesma música de novo, atualiza a entrada em vez de duplicar.
  if (!room.userRequests) room.userRequests = {};
  const favorites = uniqueRequests(room.userRequests[key]);
  favorites.push({
    videoId: track.videoId,
    title: track.title,
    author: track.author,
    requestedBy: cleanName,
    addedAt: Date.now(),
  });
  room.userRequests[key] = favorites.slice(-60);
  const userKeys = Object.keys(room.userRequests);
  if (userKeys.length > 200) delete room.userRequests[userKeys[0]];

  systemMessage(room, `${requestedBy} adicionou: ${track.title}`);
  return track;
}

function playNext(room) {
  if (!room.queue.length) return false;
  if (room.current) room.history.push(room.current);
  room.current = room.queue.shift();
  room.position = 0;
  room.playing = true;
  room.updatedAt = Date.now();
  return true;
}

function requireHost(room, ws) {
  if (room.hostId !== ws.clientId) {
    toast(ws, 'Somente o DJ pode controlar o player.');
    return false;
  }
  return true;
}

function handleAction(ws, room, msg) {
  const name = ws.name;

  switch (msg.action) {
    case 'add': {
      const isLink = !!parseYouTubeId(msg.url);
      const minDelay = isLink ? 1200 : 2500;
      if (Date.now() - (ws.lastAdd || 0) < minDelay) return;
      ws.lastAdd = Date.now();
      addTrack(room, msg.url, name, ws).catch((error) => {
        console.error('Erro ao adicionar faixa:', error);
        toast(ws, 'Não foi possível adicionar essa música agora.');
      });
      break;
    }

    case 'chat': {
      if (Date.now() - (ws.lastChat || 0) < 700) return;
      ws.lastChat = Date.now();
      const text = String(msg.text || '').trim().slice(0, 200);
      if (!text) return;

      const request = text.match(/^!sr\s+(.+)$/i);
      if (request) {
        const minDelay = parseYouTubeId(request[1]) ? 1200 : 2500;
        if (Date.now() - (ws.lastAdd || 0) < minDelay) {
          toast(ws, 'Aguarde um instante antes de pedir outra música.');
          return;
        }
        ws.lastAdd = Date.now();
        addTrack(room, request[1], name, ws).catch((error) => {
          console.error('Erro no !sr:', error);
          toast(ws, 'Não foi possível adicionar essa música agora.');
        });
        return;
      }

      pushMessage(room, { kind: 'chat', name, text });
      broadcastState(room);
      break;
    }

    case 'syncRequest':
      sendState(ws, room);
      break;

    case 'play':
      if (!requireHost(room, ws)) return;
      if (!room.current && !playNext(room)) {
        toast(ws, 'A fila está vazia.');
        return;
      }
      room.playing = true;
      room.updatedAt = Date.now();
      broadcastState(room);
      break;

    case 'pause':
      if (!requireHost(room, ws)) return;
      room.position = currentPosition(room);
      room.playing = false;
      room.updatedAt = Date.now();
      broadcastState(room);
      break;

    case 'next':
      if (!requireHost(room, ws)) return;
      if (!playNext(room)) toast(ws, 'Não há próxima música.');
      else broadcastState(room);
      break;

    case 'previous':
      if (!requireHost(room, ws)) return;
      if (!room.history.length) {
        toast(ws, 'Não há música anterior.');
        return;
      }
      if (room.current) room.queue.unshift(room.current);
      room.current = room.history.pop();
      room.position = 0;
      room.playing = true;
      room.updatedAt = Date.now();
      broadcastState(room);
      break;

    case 'seek': {
      if (!requireHost(room, ws)) return;
      const seconds = Number(msg.position);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 12 * 3600) return;
      room.position = seconds;
      room.updatedAt = Date.now();
      broadcastState(room);
      break;
    }

    case 'remove':
      if (!requireHost(room, ws)) return;
      room.queue = room.queue.filter((t) => t.trackId !== msg.trackId);
      broadcastState(room);
      break;

    case 'clearQueue':
      if (!requireHost(room, ws)) return;
      room.queue = [];
      broadcastState(room);
      break;

    case 'setAllowRequests':
      if (!requireHost(room, ws)) return;
      room.settings.allowRequests = Boolean(msg.value);
      broadcastState(room);
      break;

    // O DJ devolve o histórico guardado no navegador após um restart do servidor.
    case 'restoreRequests': {
      if (!requireHost(room, ws)) return;
      const incoming = msg.requests && typeof msg.requests === 'object' ? msg.requests : {};
      if (!room.userRequests) room.userRequests = {};
      let changed = false;

      for (const [user, tracks] of Object.entries(incoming)) {
        if (!Array.isArray(tracks)) continue;
        const key = String(user).toLowerCase().slice(0, 24);
        const merged = uniqueRequests([...(room.userRequests[key] || []), ...tracks]);
        if (JSON.stringify(merged) !== JSON.stringify(room.userRequests[key] || [])) {
          room.userRequests[key] = merged;
          changed = true;
        }
      }
      const keys = Object.keys(room.userRequests);
      if (keys.length > 200) {
        for (const key of keys.slice(0, keys.length - 200)) delete room.userRequests[key];
        changed = true;
      }
      if (changed) broadcastState(room);
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------- HTTP

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: Math.floor(process.uptime()) });
});

app.post('/api/room', (req, res) => {
  const code = makeCode();
  rooms.set(code, createRoom(code));
  res.status(201).json({ code, url: `/r/${code}` });
});

app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  res.json({ code: room.code, listeners: room.clients.size });
});

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------- WebSocket

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
  const code = String(params.get('room') || '').toUpperCase();
  const room = getRoom(code);

  if (!room) {
    send(ws, { type: 'error', text: 'Sala não encontrada. Crie uma nova sala.' });
    ws.close();
    return;
  }

  ws.clientId = String(params.get('clientId') || crypto.randomUUID()).slice(0, 64);
  ws.name = String(params.get('name') || 'Convidado').trim().slice(0, 24) || 'Convidado';
  ws.roomCode = code;

  room.emptySince = null;
  room.clients.add(ws);

  if (room.hostTimer && room.hostId === ws.clientId) {
    clearTimeout(room.hostTimer);
    room.hostTimer = null;
  }
  if (!room.hostId) room.hostId = ws.clientId;

  sendState(ws, room);
  systemMessage(room, `${ws.name} entrou na sala.`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.action !== 'string') return;
    try {
      handleAction(ws, room, msg);
    } catch (error) {
      console.error('Erro ao processar ação:', error);
      toast(ws, 'Não foi possível processar essa ação.');
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    if (!room.clients.size) room.emptySince = Date.now();

    if (room.hostId === ws.clientId && !room.hostTimer) {
      room.hostTimer = setTimeout(() => {
        room.hostTimer = null;
        if (room.hostId !== ws.clientId) return;
        const next = room.clients.values().next().value;
        room.hostId = next ? next.clientId : null;
        broadcastState(room);
      }, HOST_GRACE_MS);
    }
    broadcastState(room);
  });

  ws.on('error', () => {});
});

// ------------------------------------------------------------- Twitch IRC

let twitchWs = null;
let twitchReconnect = null;
let twitchBuffer = '';

// "Cliente" fictício para reaproveitar a mesma lógica de fila usada pelo site
const twitchClient = {
  clientId: 'twitch-bot',
  readyState: WebSocket.OPEN,
  send(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'toast' || msg.text.startsWith('Buscando')) return;
    replyTwitch(msg.text);
  },
};

function replyTwitch(text) {
  if (!TWITCH.reply || !twitchWs || twitchWs.readyState !== WebSocket.OPEN) return;
  const clean = String(text).replace(/[\r\n]+/g, ' ').slice(0, 400);
  twitchWs.send(`PRIVMSG #${TWITCH.channel} :${clean}`);
}

function handleTwitchLine(line) {
  line = line.trim();
  if (!line) return;

  if (line.startsWith('PING')) {
    twitchWs.send('PONG :tmi.twitch.tv');
    return;
  }
  if (line.includes(' NOTICE ')) {
    console.log('Twitch NOTICE:', line.replace(/^:/, ''));
    return;
  }

  const match = line.match(/^:([^!]+)!.*?PRIVMSG #([^ ]+) :(.*)$/);
  if (!match) return;

  const [, username, channel, message] = match;
  if (channel !== TWITCH.channel) return;

  const [command, ...rest] = message.trim().split(/\s+/);
  const cmd = (command || '').toLowerCase();

  // Consulta ao gosto musical da pessoa: $lista @usuario (ou só $lista para o ranking)
  if (cmd === '$lista' || cmd === '!lista' || cmd === '$list' || cmd === '!list') {
    const room = getRoom(TWITCH.room);
    if (!room) {
      replyTwitch('A sala do DJ ainda não está aberta.');
      return;
    }
    const favorites = room.userRequests || {};
    const target = rest.join(' ').trim().replace(/^@/, '').toLowerCase();

    if (target) {
      const tracks = favorites[target];
      if (!tracks?.length) {
        replyTwitch(`@${target} ainda não pediu músicas.`);
        return;
      }
      const latest = tracks.slice(-5).map((t) => t.title).join(' | ');
      replyTwitch(`${target}: ${tracks.length} pedidos. Últimos: ${latest}`);
      return;
    }

    const top = Object.entries(favorites)
      .map(([user, tracks]) => ({ user, n: tracks.length }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 6)
      .map((item) => `${item.user} (${item.n})`);
    replyTwitch(
      top.length
        ? `Pedidos: ${top.join(' · ')}. Use $lista @usuario para ver as músicas.`
        : 'Ninguém pediu músicas ainda.'
    );
    return;
  }

  if (!TWITCH.commands.includes(cmd)) return;

  const query = rest.join(' ').trim();
  if (!query) {
    replyTwitch(`Use ${command} nome da música. Ex.: ${command} bohemian rhapsody queen`);
    return;
  }

  const room = getRoom(TWITCH.room);
  if (!room) {
    replyTwitch('A sala do DJ ainda não está aberta.');
    return;
  }

  addTrack(room, query, username, twitchClient)
    .then((track) => {
      if (track) replyTwitch(`✅ ${track.title} adicionado à fila por @${username}`);
    })
    .catch((error) => {
      console.error('Erro no pedido da Twitch:', error);
      replyTwitch('Não consegui adicionar essa música agora.');
    });
}

function connectTwitch() {
  if (!TWITCH.channel || !TWITCH.token || !TWITCH.room) return;
  clearTimeout(twitchReconnect);

  const token = TWITCH.token.replace(/^oauth:/i, '');
  twitchWs = new WebSocket(TWITCH.ircUrl, 'irc');

  twitchWs.on('open', () => {
    console.log(`Twitch: conectando em #${TWITCH.channel} → sala ${TWITCH.room}`);
    twitchWs.send(`PASS oauth:${token}`);
    twitchWs.send(`NICK ${TWITCH.nick || TWITCH.channel}`);
    twitchWs.send(`JOIN #${TWITCH.channel}`);
  });

  twitchWs.on('message', (raw) => {
    twitchBuffer += raw.toString();
    const lines = twitchBuffer.split(/\r?\n/);
    twitchBuffer = lines.pop() || '';
    for (const line of lines) {
      try {
        handleTwitchLine(line);
      } catch (error) {
        console.error('Erro ao processar linha da Twitch:', error);
      }
    }
  });

  twitchWs.on('error', (error) => console.error('Twitch IRC:', error.message));

  twitchWs.on('close', () => {
    twitchWs = null;
    twitchBuffer = '';
    console.log('Twitch: desconectado. Reconectando em 10s...');
    twitchReconnect = setTimeout(connectTwitch, 10000);
  });
}

// Batimentos cardíacos e limpeza de salas abandonadas
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

function broadcastSyncTicks() {
  for (const room of rooms.values()) broadcastState(room);
}

setInterval(() => {
  for (const [code, room] of rooms) {
    if (!room.clients.size && room.emptySince && Date.now() - room.emptySince > EMPTY_ROOM_TTL_MS) {
      clearTimeout(room.hostTimer);
      rooms.delete(code);
    }
  }
}, 60000);

setInterval(broadcastSyncTicks, SYNC_INTERVAL_MS);

// Evita que o processo fique preso ao encerrar
process.on('SIGTERM', () => {
  clearInterval(heartbeat);
  clearTimeout(twitchReconnect);
  twitchWs?.close();
  server.close(() => process.exit(0));
});

server.listen(PORT, () => {
  // Sala fixa usada pelo bot da Twitch (nunca expira por inatividade)
  if (TWITCH.room && !rooms.has(TWITCH.room)) rooms.set(TWITCH.room, createRoom(TWITCH.room));

  console.log(`DJ Sync rodando em http://localhost:${PORT}`);
  if (TWITCH.room) console.log(`Sala da Twitch: ${TWITCH.room} → http://localhost:${PORT}/r/${TWITCH.room}`);

  if (TWITCH.channel && TWITCH.token && TWITCH.room) {
    connectTwitch();
  } else if (TWITCH.channel || TWITCH.token || TWITCH.room) {
    console.warn('Twitch: configure TWITCH_CHANNEL, TWITCH_OAUTH_TOKEN e TWITCH_ROOM no .env para ativar o bot.');
  }
});
