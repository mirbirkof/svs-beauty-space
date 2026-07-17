/* lib/ai-video-reel.js — «Reels-магія»: монтаж уровня SMM-специалиста (17.07.2026).
   Механика перенесена из ручного монтажа Jarvis (рил «Маленька принцеса»):
   - кадр ЗАПОЛНЯЕТСЯ (scale increase + crop), никаких чёрных полос
   - мягкие xfade-переходы + белая вспышка (fadewhite) перед финальным клипом
   - лёгкий цветовой буст (насыщенность/контраст)
   - титры per-клип красивым шрифтом (Montserrat), финальный — Playfair
   - озвучка текста украинским голосом «напівшепіт» (msedge-tts Polina, rate -15%,
     пост-обработка: highpass+treble+компрессор+лёгкое эхо)
   - музыка (файл пользователя) с sidechain-дакингом под голос + fade in/out
   Боль: салоны тратятся на SMM/монтаж — админ загружает клипы и получает готовый рил.

   БЕЗОПАСНОСТЬ: как в ai-video-montage — текст только через textfile=, файлы во
   временной папке (uuid), spawn без шелла. Render (512MB): threads=1 везде.
   Все ffmpeg-вызовы с таймаутом; вся папка удаляется в cleanup(). */
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpegPath = require('ffmpeg-static');

const FONT_MAIN = path.join(__dirname, '..', 'assets', 'fonts', 'Montserrat-SemiBold.ttf');
const FONT_FINAL = path.join(__dirname, '..', 'assets', 'fonts', 'PlayfairDisplay.ttf');
const FONT_FALLBACK = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
const DIMS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };

const MAX_CLIPS = 8;
const MIN_TARGET = 8, MAX_TARGET = 60, DEF_TARGET = 18;
const XFADE = 0.25;          // обычный переход
const XFADE_WHITE = 0.35;    // вспышка перед финальным клипом
const CLIP_HEAD_SKIP = 0.3;  // пропускаем смазанный первый кадр съёмки

function font(p) { return fs.existsSync(p) ? p : FONT_FALLBACK; }

/** Перенос строк по словам: drawtext сам НЕ переносит — длинный титр вылезал за кадр. */
function wrap(text, maxChars) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const wd of words) {
    if (cur && (cur + ' ' + wd).length > maxChars) { lines.push(cur); cur = wd; }
    else cur = cur ? cur + ' ' + wd : wd;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).join('\n'); // максимум 3 строки — иначе закрывает кадр
}

function run(bin, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const to = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', (e) => { clearTimeout(to); reject(e); });
    p.on('close', (code) => {
      clearTimeout(to);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} exit ${code}: ${err.split('\n').slice(-4).join(' ').slice(0, 400)}`));
    });
  });
}

async function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => resolve(0));
    p.on('close', () => {
      if (!/Video:/.test(err)) return resolve(0);
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (!m) return resolve(0);
      resolve((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]));
    });
  });
}

/** Озвучка текста украинским «напівшепотом». Возвращает путь к wav или null. */
async function makeVoiceover(text, dir) {
  const clean = String(text || '').trim().slice(0, 600);
  if (!clean) return null;
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata('uk-UA-PolinaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioStream } = await tts.toStream(clean, { rate: '-15%', pitch: '-5Hz' });
  const raw = path.join(dir, 'vo_raw.mp3');
  await new Promise((resolve, reject) => {
    const chunks = [];
    const to = setTimeout(() => reject(new Error('tts timeout')), 60000);
    audioStream.on('data', (c) => chunks.push(c));
    audioStream.on('end', () => { clearTimeout(to); fs.writeFileSync(raw, Buffer.concat(chunks)); resolve(); });
    audioStream.on('error', (e) => { clearTimeout(to); reject(e); });
  });
  const out = path.join(dir, 'vo.wav');
  await run(ffmpegPath, ['-y', '-threads', '1', '-i', raw, '-af',
    'highpass=f=130,treble=g=2.5:f=5500,acompressor=threshold=-22dB:ratio=2.5:attack=12:release=250,aecho=0.5:0.2:35:0.1,volume=1.9',
    '-ar', '44100', out]);
  return out;
}

/** Распределить хронометраж по клипам: поровну, дефицит коротких отдаём остальным. */
function planDurations(realDurs, targetSec) {
  const n = realDurs.length;
  const overlaps = n > 1 ? XFADE * (n - 2 >= 0 ? n - 2 : 0) + (n > 1 ? XFADE_WHITE : 0) : 0;
  const rawTotal = targetSec + overlaps;
  const avail = realDurs.map((d) => Math.max(0.8, d - CLIP_HEAD_SKIP));
  let durs = new Array(n).fill(rawTotal / n);
  for (let pass = 0; pass < 3; pass++) {
    let deficit = 0, flexible = [];
    for (let i = 0; i < n; i++) {
      if (durs[i] > avail[i]) { deficit += durs[i] - avail[i]; durs[i] = avail[i]; }
      else flexible.push(i);
    }
    if (deficit < 0.05 || !flexible.length) break;
    const add = deficit / flexible.length;
    for (const i of flexible) durs[i] += add;
  }
  return durs.map((d) => +d.toFixed(2));
}

/**
 * Рендер рила.
 * @param {Array<{path:string,name?:string}>} clips
 * @param {object} opts { aspect, targetSec, captions:[], finalTitle, brandLine, voiceText, musicPath, onProgress(stage) }
 */
async function renderReel(clips, opts = {}) {
  if (!Array.isArray(clips) || !clips.length) throw new Error('no clips');
  if (clips.length > MAX_CLIPS) throw new Error(`max ${MAX_CLIPS} clips`);
  const aspect = DIMS[opts.aspect] ? opts.aspect : '9:16';
  const [w, h] = DIMS[aspect];
  const targetSec = Math.min(MAX_TARGET, Math.max(MIN_TARGET, parseFloat(opts.targetSec) || DEF_TARGET));
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  const dir = path.join(os.tmpdir(), 'reel-' + crypto.randomUUID());
  await fsp.mkdir(dir, { recursive: true });
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});

  try {
    // 1) длительности
    progress('Аналізую кліпи…');
    const realDurs = [];
    for (const c of clips) {
      const d = await probeDuration(c.path);
      if (!d) throw new Error(`файл «${(c.name || 'clip').slice(0, 40)}» не схоже на відео`);
      realDurs.push(d);
    }
    const durs = planDurations(realDurs, targetSec);
    const n = clips.length;

    // 2) нормализация: fill-кроп, цвет, титры, 30fps, БЕЗ звука (звук соберём отдельно)
    const captions = Array.isArray(opts.captions) ? opts.captions : [];
    const normalized = [];
    for (let i = 0; i < n; i++) {
      progress(`Обробляю кліп ${i + 1} з ${n}…`);
      const vf = [
        `scale=${w}:${h}:force_original_aspect_ratio=increase`,
        `crop=${w}:${h}`,
        'setsar=1', 'fps=30',
        'eq=saturation=1.12:contrast=1.03:brightness=0.015',
      ];
      const title = String(captions[i] || '').trim().slice(0, 120);
      if (title) {
        const isLast = i === n - 1;
        const capFile = path.join(dir, `cap${i}.txt`);
        await fsp.writeFile(capFile, wrap(title, isLast ? 14 : 22), 'utf8');
        const f = isLast && opts.finalTitleStyle !== 'plain' ? font(FONT_FINAL) : font(FONT_MAIN);
        const size = isLast ? 'h/18' : 'h/26';
        vf.push(
          `drawtext=fontfile='${f.replace(/'/g, "\\'")}':textfile='${capFile.replace(/'/g, "\\'")}':` +
          `fontcolor=white:fontsize=${size}:line_spacing=12:shadowcolor=black@0.55:shadowx=2:shadowy=3:` +
          `x=(w-text_w)/2:y=h*0.70`
        );
      }
      // фирменная строка на финальном клипе
      if (i === n - 1 && String(opts.brandLine || '').trim()) {
        const brandFile = path.join(dir, 'brand.txt');
        await fsp.writeFile(brandFile, String(opts.brandLine).trim().slice(0, 60).split('').join(' ').toUpperCase(), 'utf8');
        vf.push(
          `drawtext=fontfile='${font(FONT_MAIN).replace(/'/g, "\\'")}':textfile='${brandFile.replace(/'/g, "\\'")}':` +
          `fontcolor=white@0.85:fontsize=h/58:shadowcolor=black@0.4:shadowx=1:shadowy=2:x=(w-text_w)/2:y=h*0.905`
        );
      }
      const out = path.join(dir, `n${i}.mp4`);
      await run(ffmpegPath, [
        '-y', '-threads', '1', '-filter_threads', '1',
        '-ss', String(CLIP_HEAD_SKIP), '-t', String(durs[i]), '-i', clips[i].path,
        '-vf', vf.join(','), '-an',
        '-c:v', 'libx264', '-threads', '1', '-x264-params', 'threads=1:lookahead-threads=1',
        '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        out,
      ], 240000);
      normalized.push({ file: out, dur: durs[i] });
    }

    // 3) переходы xfade (fadewhite перед финальным)
    progress('Зводжу переходи…');
    let vChain = '', prev = '[0:v]';
    let acc = normalized[0].dur;
    for (let i = 1; i < n; i++) {
      const isFinal = i === n - 1;
      const d = isFinal ? XFADE_WHITE : XFADE;
      const off = +(acc - d).toFixed(2);
      const outLbl = i === n - 1 ? '[vx]' : `[x${i}]`;
      vChain += `${prev}[${i}:v]xfade=transition=${isFinal ? 'fadewhite' : 'fade'}:duration=${d}:offset=${off}${outLbl};\n`;
      prev = outLbl;
      acc = acc + normalized[i].dur - d;
    }
    const finalDur = +acc.toFixed(2);
    if (n === 1) vChain = '[0:v]null[vx];\n';

    // 4) звук: голос + музыка (дакинг) / что-то одно / тишина
    progress('Записую озвучку та музику…');
    const voicePath = await makeVoiceover(opts.voiceText, dir).catch((e) => {
      console.error('[reel] voiceover failed (продолжаем без голоса):', e.message);
      return null;
    });
    let musicPath = null;
    if (opts.musicPath && fs.existsSync(opts.musicPath)) {
      musicPath = path.join(dir, 'music.wav');
      await run(ffmpegPath, ['-y', '-threads', '1', '-i', opts.musicPath, '-t', String(finalDur),
        '-af', `afade=t=in:d=1.0,afade=t=out:st=${Math.max(0, finalDur - 1.5)}:d=1.5,volume=0.9`,
        '-ar', '44100', '-ac', '2', musicPath]).catch((e) => {
        console.error('[reel] music prep failed (без музыки):', e.message);
        musicPath = null;
      });
    }

    const inputs = normalized.map((x) => ['-i', x.file]).flat();
    let aChain = '', mapA = null;
    let aIdx = n;
    if (voicePath && musicPath) {
      inputs.push('-i', musicPath, '-i', voicePath);
      aChain = `[${aIdx + 1}:a]adelay=400|400,apad,asplit=2[vk][vm];\n` +
        `[${aIdx}:a][vk]sidechaincompress=threshold=0.02:ratio=10:attack=25:release=450[md];\n` +
        `[md][vm]amix=inputs=2:duration=first:normalize=0[aout]`;
      mapA = '[aout]';
    } else if (voicePath) {
      inputs.push('-i', voicePath);
      aChain = `[${aIdx}:a]adelay=400|400,apad[aout]`;
      mapA = '[aout]';
    } else if (musicPath) {
      inputs.push('-i', musicPath);
      aChain = `[${aIdx}:a]apad[aout]`;
      mapA = '[aout]';
    } else {
      aChain = `anullsrc=channel_layout=stereo:sample_rate=44100[aout]`;
      mapA = '[aout]';
    }

    const script = path.join(dir, 'fc.txt');
    await fsp.writeFile(script, vChain + aChain, 'utf8');

    // 5) финальный рендер
    progress('Фінальний рендер…');
    const outFile = path.join(dir, 'reel.mp4');
    await run(ffmpegPath, [
      '-y', '-threads', '1', '-filter_threads', '1',
      ...inputs,
      '-filter_complex_script', script,
      '-map', '[vx]', '-map', mapA,
      '-t', String(finalDur),
      '-c:v', 'libx264', '-threads', '1', '-x264-params', 'threads=1:lookahead-threads=1',
      '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
      '-movflags', '+faststart',
      outFile,
    ], 420000);

    if (!fs.existsSync(outFile)) throw new Error('рендер не створив файл');
    return { path: outFile, cleanup, durationSec: Math.round(finalDur), clips: n, aspect };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

module.exports = { renderReel, MAX_CLIPS, DEF_TARGET, MAX_TARGET };
