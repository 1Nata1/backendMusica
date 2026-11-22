'use strict';

// Medição de loudness (LUFS) de um vídeo do YouTube.
// O player do IFrame não expõe áudio, então baixamos uma amostra com yt-dlp e
// usamos o filtro loudnorm do ffmpeg para descobrir o nível médio da faixa.

const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ytdl = require('youtube-dl-exec');

const ENABLED = process.env.DJ_SYNC_LOUDNESS !== 'false';
const TARGET_LUFS = Number(process.env.DJ_SYNC_TARGET_LUFS || -16);
const SAMPLE_SECONDS = Math.max(10, Math.min(120, Number(process.env.DJ_SYNC_LOUDNESS_SAMPLE || 40)));

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

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} expirou`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function extractAudioUrl(videoId) {
  const output = await withTimeout(
    ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
      format: 'bestaudio/best',
      getUrl: true,
      noPlaylist: true,
      quiet: true,
      noWarnings: true,
    }),
    30000,
    'yt-dlp'
  );
  const url = String(output).trim().split(/\r?\n/).find(Boolean);
  if (!url || !/^https?:\/\//.test(url)) throw new Error('URL de áudio inválida');
  return url;
}

function measureLufs(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-nostdin', '-hide_banner', '-v', 'info',
      '-i', url, '-t', String(SAMPLE_SECONDS),
      '-af', `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`,
      '-f', 'null', '-',
    ];
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new Error('ffmpeg expirou'));
    }, 60000);

    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        const json = stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
        const lufs = Number(json ? JSON.parse(json).input_i : NaN);
        if (!Number.isFinite(lufs)) throw new Error('LUFS não encontrado');
        resolve(lufs);
      } catch (error) {
        reject(error);
      }
    });
  });
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
    const url = await extractAudioUrl(id);
    const lufs = await measureLufs(url);
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

module.exports = { measureVideoLoudness, loudnessEnabled: ENABLED, TARGET_LUFS, SAMPLE_SECONDS };
