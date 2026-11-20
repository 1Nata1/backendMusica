(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORAGE = {
    name: 'dj-sync-name',
    client: 'dj-sync-client-id',
    volume: 'dj-sync-volume',
    api: 'dj-sync-api',
  };

  // Backend pode estar em outro domínio (ex.: site na Vercel, API na Render).
  // Ordem: ?api=... na URL > localStorage > public/config.js > mesmo domínio.
  const queryApi = new URLSearchParams(location.search).get('api');
  if (queryApi) localStorage.setItem(STORAGE.api, queryApi);
  const configuredApi = queryApi || localStorage.getItem(STORAGE.api) || window.DJ_SYNC_API || '';
  const API_BASE = configuredApi.trim().replace(/\/+$/, '');
  const apiUrl = (path) => `${API_BASE}${path}`;
  const WS_BASE = API_BASE
    ? API_BASE.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

  let displayName = localStorage.getItem(STORAGE.name) || '';
  let clientId = localStorage.getItem(STORAGE.client);
  if (!clientId) {
    clientId = crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random()}`;
    localStorage.setItem(STORAGE.client, clientId);
  }

  let roomCode = null;
  let socket = null;
  let player = null;
  let playerReady = false;
  let unlocked = false;
  let manualLeave = false;
  let fatalError = false;
  let reconnectTimer = null;
  let lastState = null;
  let loadedVideoId = null;
  let draggingSeek = false;

  const urlRoom = location.pathname.match(/^\/r\/([A-Za-z0-9]{3,10})\/?$/)?.[1];
  if (urlRoom) $('join-code').value = urlRoom.toUpperCase();
  $('landing-name').value = displayName;

  // ------------------------------------------------------------- utilidades

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function fmtTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
  }

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function send(action, extra = {}) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action, ...extra }));
    }
  }

  function expectedPosition(state) {
    if (!state) return 0;
    return Math.max(0, state.position + (state.playing ? (Date.now() - state.serverTime) / 1000 : 0));
  }

  // --------------------------------------------------- YouTube IFrame API

  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return initPlayer();
    window.onYouTubeIframeAPIReady = initPlayer;
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(script);
    }
  }

  function initPlayer() {
    if (player || !window.YT) return;
    player = new YT.Player('player', {
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        origin: location.origin,
      },
      events: {
        onReady: () => {
          playerReady = true;
          const saved = Number(localStorage.getItem(STORAGE.volume));
          const volume = Number.isFinite(saved) ? saved : 80;
          player.setVolume(volume);
          player.unMute();
          if (lastState) applyState(true);
        },
        onStateChange: () => {
          updatePlayButton();
        },
      },
    });
  }

  function showGate(show) {
    $('player-gate').classList.toggle('hidden', !show);
    $('audio-btn').classList.toggle('hidden', !show);
  }

  function unlockAudio() {
    unlocked = true;
    showGate(false);
    if (playerReady) {
      player.unMute();
      player.setVolume(Number(localStorage.getItem(STORAGE.volume) ?? 80));
      applyState(true);
    }
    toast('Áudio ativado! O player vai acompanhar o DJ.');
  }

  function applyState(force = false) {
    if (!playerReady || !lastState) return;
    const state = lastState;

    if (!state.current) {
      if (loadedVideoId) {
        player.stopVideo();
        loadedVideoId = null;
      }
      updateSyncPill('—', '');
      return;
    }

    const videoId = state.current.videoId;
    const position = expectedPosition(state);

    if (loadedVideoId !== videoId) {
      loadedVideoId = videoId;
      if (unlocked && state.playing) {
        player.loadVideoById({ videoId, startSeconds: Math.max(0, position) });
      } else {
        player.cueVideoById({ videoId, startSeconds: Math.max(0, position) });
        if (!unlocked) showGate(true);
      }
      return;
    }

    if (!unlocked) {
      showGate(true);
      return;
    }

    const current = player.getCurrentTime?.() || 0;
    const drift = position - current;

    if (force || Math.abs(drift) > 1.4) {
      if (state.playing && Math.abs(drift) > 0.35) player.seekTo(Math.max(0, position), true);
      else if (!state.playing && Math.abs(drift) > 0.6) player.seekTo(Math.max(0, position), true);
    }

    const nativeState = player.getPlayerState?.();
    if (state.playing) {
      if (nativeState !== 1) player.playVideo();
    } else if (nativeState === 1) {
      player.pauseVideo();
    }

    updateSyncPill(state.playing ? Math.abs(drift) : 0, state.playing ? drift : 0);
  }

  function updateSyncPill(drift, raw) {
    const el = $('sync-pill');
    if (drift === '—') {
      el.textContent = '—';
      el.className = 'sync-pill';
      return;
    }
    if (Math.abs(raw) > 3) {
      el.textContent = `Ajustando (${Math.abs(raw).toFixed(1)}s)`;
      el.className = 'sync-pill bad';
    } else {
      el.textContent = `● Sincronizado${Math.abs(raw) > 0.6 ? ` · ${Math.abs(raw).toFixed(1)}s` : ''}`;
      el.className = 'sync-pill ok';
    }
  }

  function updatePlayButton() {
    const playing = lastState?.playing;
    $('play-btn').textContent = playing ? '▶' : '▶';
    $('play-btn').style.opacity = playing ? '.55' : '1';
    $('pause-btn').style.opacity = playing ? '1' : '.55';
  }

  // ---------------------------------------------------------------- render

  function renderQueue(state) {
    const queue = state.queue || [];
    $('queue-count').textContent = String(queue.length);
    if (!queue.length) {
      $('queue').innerHTML = '<div class="empty">A fila está vazia. Adicione um link do YouTube acima.</div>';
      return;
    }
    $('queue').innerHTML = queue.map((track, index) => `
      <div class="queue-item">
        <img class="queue-thumb" src="https://i.ytimg.com/vi/${esc(track.videoId)}/mqdefault.jpg" alt="" />
        <div class="queue-body">
          <div class="queue-title">${index + 1}. ${esc(track.title)}</div>
          <div class="queue-by">pedido por ${esc(track.requestedBy)}</div>
        </div>
        ${state.isHost ? `<button class="queue-remove" data-track="${esc(track.trackId)}" title="Remover">×</button>` : ''}
      </div>
    `).join('');

    $('queue').querySelectorAll('.queue-remove').forEach((btn) => {
      btn.addEventListener('click', () => send('remove', { trackId: btn.dataset.track }));
    });
  }

  function renderMessages(state) {
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 70;
    box.innerHTML = (state.messages || []).map((msg) => {
      if (msg.kind === 'system') {
        return `<div class="msg system">${esc(msg.text)}</div>`;
      }
      const mine = msg.name === displayName ? ' me' : '';
      return `<div class="msg${mine}"><strong>${esc(msg.name)}:</strong> ${esc(msg.text)}</div>`;
    }).join('');
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function renderNowPlaying(state) {
    const track = state.current;
    if (!track) {
      $('np-title').textContent = 'Nada tocando ainda';
      $('np-meta').textContent = 'Adicione uma música à fila para começar';
      $('np-thumb').removeAttribute('src');
      return;
    }
    $('np-title').textContent = track.title;
    $('np-meta').textContent = `${track.author ? `${track.author} · ` : ''}pedido por ${track.requestedBy}`;
    $('np-thumb').src = `https://i.ytimg.com/vi/${encodeURIComponent(track.videoId)}/mqdefault.jpg`;
  }

  function render(state) {
    lastState = state;
    $('room-code').textContent = state.code;
    $('listener-count').textContent = `👤 ${state.listeners}`;
    $('host-pill').classList.toggle('hidden', !state.isHost);
    $('dj-controls').classList.toggle('hidden', !state.isHost);
    $('host-settings').classList.toggle('hidden', !state.isHost);
    $('listener-note').classList.toggle('hidden', state.isHost);
    $('allow-requests').checked = state.settings.allowRequests;

    renderNowPlaying(state);
    renderQueue(state);
    renderMessages(state);
    updatePlayButton();

    if (!draggingSeek) {
      const pos = expectedPosition(state);
      $('seek').value = String(Math.min(pos, Number($('seek').max) || 100));
      $('time-label').textContent = fmtTime(pos);
    }
    if (playerReady) {
      const duration = player.getDuration?.();
      if (Number.isFinite(duration) && duration > 0) $('seek').max = String(Math.floor(duration));
    }

    applyState();
  }

  // ------------------------------------------------------------ conexão

  function enterRoom(code) {
    if (!code) return toast('Digite o código da sala.');
    roomCode = String(code).trim().toUpperCase();
    history.replaceState({}, '', `/r/${roomCode}`);
    $('room-code').textContent = roomCode;
    $('landing').classList.add('hidden');
    $('app').classList.remove('hidden');
    manualLeave = false;
    fatalError = false;
    connect();
    loadYouTubeApi();
  }

  function connect() {
    clearTimeout(reconnectTimer);
    const query = new URLSearchParams({ room: roomCode, name: displayName, clientId });
    socket = new WebSocket(`${WS_BASE}/ws?${query}`);

    socket.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'state') return render(msg);
      if (msg.type === 'toast') return toast(msg.text);
      if (msg.type === 'error') {
        fatalError = true;
        toast(msg.text);
        setTimeout(leave, 1200);
      }
    });

    socket.addEventListener('close', () => {
      if (manualLeave || fatalError) return;
      toast('Conexão perdida. Tentando reconectar...');
      reconnectTimer = setTimeout(connect, 2000);
    });
  }

  function leave() {
    manualLeave = true;
    clearTimeout(reconnectTimer);
    socket?.close();
    history.replaceState({}, '', location.origin + '/');
    location.reload();
  }

  // ------------------------------------------------------------- eventos

  $('create-btn').addEventListener('click', async () => {
    displayName = $('landing-name').value.trim() || 'Convidado';
    localStorage.setItem(STORAGE.name, displayName);
    $('create-btn').disabled = true;
    try {
      const response = await fetch(apiUrl('/api/room'), { method: 'POST' });
      if (!response.ok) throw new Error('falhou');
      const data = await response.json();
      enterRoom(data.code);
      toast('Sala criada! Compartilhe o link com seus amigos.');
    } catch {
      toast('Não foi possível criar a sala. Tente de novo.');
    } finally {
      $('create-btn').disabled = false;
    }
  });

  $('join-btn').addEventListener('click', () => {
    displayName = $('landing-name').value.trim() || 'Convidado';
    localStorage.setItem(STORAGE.name, displayName);
    enterRoom($('join-code').value);
  });

  $('landing-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join-code').value ? $('join-btn').click() : $('create-btn').click();
  });
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-btn').click(); });

  async function copyLink() {
    if (!roomCode) return;
    const link = `${location.origin}/r/${roomCode}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const input = document.createElement('textarea');
      input.value = link;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    toast('Link copiado: ' + link);
  }
  $('copy-btn').addEventListener('click', copyLink);
  $('room-badge').addEventListener('click', copyLink);

  $('leave-btn').addEventListener('click', leave);
  $('gate-btn').addEventListener('click', unlockAudio);
  $('audio-btn').addEventListener('click', () => showGate(true));

  $('play-btn').addEventListener('click', () => send('play'));
  $('pause-btn').addEventListener('click', () => send('pause'));
  $('next-btn').addEventListener('click', () => send('next'));
  $('prev-btn').addEventListener('click', () => send('previous'));
  $('clear-btn').addEventListener('click', () => send('clearQueue'));
  $('allow-requests').addEventListener('change', (e) => send('setAllowRequests', { value: e.target.checked }));
  $('resync-btn').addEventListener('click', () => {
    send('syncRequest');
    applyState(true);
    toast('Sincronizando com o servidor...');
  });

  $('seek').addEventListener('input', () => {
    draggingSeek = true;
    $('time-label').textContent = fmtTime(Number($('seek').value));
  });
  $('seek').addEventListener('change', () => {
    draggingSeek = false;
    send('seek', { position: Number($('seek').value) });
  });

  const savedVolume = Number(localStorage.getItem(STORAGE.volume));
  const initialVolume = Number.isFinite(savedVolume) ? savedVolume : 80;
  $('volume').value = String(initialVolume);
  $('volume-value').textContent = `${initialVolume}%`;
  $('volume').addEventListener('input', (e) => {
    const value = Number(e.target.value);
    localStorage.setItem(STORAGE.volume, String(value));
    $('volume-value').textContent = `${value}%`;
    player?.setVolume?.(value);
    if (value > 0) player?.unMute?.();
  });

  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('add-url');
    const url = input.value.trim();
    if (!url) return;
    send('add', { url });
    input.value = '';
  });

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    send('chat', { text });
    input.value = '';
  });

  // Se o link já veio com código e o nome está salvo, entra direto
  if (urlRoom && displayName) enterRoom(urlRoom);
})();
