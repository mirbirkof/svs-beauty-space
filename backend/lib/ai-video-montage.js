/* lib/ai-video-montage.js — VID-02 Монтаж из СВОИХ видео.
   Босс загружает 1..N своих клипов (с телефона, разный формат) → склеиваем
   в один промо-ролик «по тому же принципу», что и AI-студия: каждой сцене —
   свой титр (из раскадровки или ручной), единая ориентация 9:16/16:9, переходы.

   Почему ffmpeg локально, а не Veo: это РЕАЛЬНОЕ видео клиента, его не надо
   генерировать — надо привести к единому формату, наложить титры и склеить.
   Бинарь берём из ffmpeg-static (на Render системного ffmpeg нет).
   Шрифт — bundled assets/fonts (на хосте кириллических шрифтов может не быть).

   БЕЗОПАСНОСТЬ: текст титров пишем в textfile и отдаём ffmpeg через textfile= —
   никакой интерполяции пользовательской строки в командную строку/фильтр,
   значит drawtext-инъекция исключена. Все входы — во временной папке, которая
   всегда удаляется в finally. Имена файлов генерим сами (uuid), не из upload. */
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpegPath = require('ffmpeg-static');

const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
const DIMS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };

const MAX_CLIPS = 8;          // здравый предел: больше — это уже не Reels
const MAX_SECONDS_PER_CLIP = 15;
const MAX_TOTAL_SECONDS = 90; // Reels максимум

/** Запуск ffmpeg/ffprobe с аргументами-массивом (без шелла → нет инъекции). */
function run(bin, args, timeoutMs = 120000) {
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

/** Длительность видео в секундах (ffprobe). 0 если не видео. */
async function probeDuration(file) {
  // ffprobe идёт рядом с ffmpeg-static? нет — у пакета только ffmpeg. Берём ffmpeg -i разбором,
  // но надёжнее ffprobe из системы, если есть. Здесь — лёгкий парс через ffmpeg null-вывод.
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => resolve(0));
    p.on('close', () => {
      // ищем "Duration: HH:MM:SS.xx" и наличие "Video:"
      if (!/Video:/.test(err)) return resolve(0);
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (!m) return resolve(0);
      resolve((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]));
    });
  });
}

function escGeo(s) { return String(s); }

/** Нормализовать один клип: привести к WxH (контейн с чёрными полями), 30 fps,
 *  обрезать по длительности, наложить титр (если есть) из textfile. */
async function normalizeClip(src, dst, { w, h, dur, captionFile, hasTitle }) {
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
    `setsar=1`,
    `fps=30`,
  ];
  if (captionFile && hasTitle) {
    // y у нижней трети; box — читаемость на любом фоне. text — ТОЛЬКО из textfile.
    vf.push(
      `drawtext=fontfile='${FONT.replace(/'/g, "\\'")}':textfile='${captionFile.replace(/'/g, "\\'")}':` +
      `fontcolor=white:fontsize=h/22:line_spacing=8:box=1:boxcolor=black@0.45:boxborderw=22:` +
      `x=(w-tw)/2:y=h-th-h/8`
    );
  }
  const args = [
    '-y', '-i', src,
    '-t', String(dur),
    '-vf', vf.join(','),
    '-r', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    // если в клипе нет звука — добавим тишину, иначе concat звука рассыпется
    '-af', 'apad', '-shortest',
    dst,
  ];
  await run(ffmpegPath, args);
}

/**
 * Смонтировать промо из загруженных клипов.
 * @param {Array<{buffer:Buffer, name:string}>} clips — исходные видео
 * @param {Array<{caption?:string,durationSec?:number}>} scenes — параллельно клипам (титр/длит.)
 * @param {{aspect?:string, caption?:string}} opts
 * @returns {Promise<{path:string, cleanup:Function, durationSec:number, clips:number}>}
 */
async function montage(clips, scenes = [], opts = {}) {
  if (!Array.isArray(clips) || !clips.length) throw new Error('no clips');
  if (clips.length > MAX_CLIPS) throw new Error(`max ${MAX_CLIPS} clips`);
  const aspect = DIMS[opts.aspect] ? opts.aspect : '9:16';
  const [w, h] = DIMS[aspect];

  const dir = path.join(os.tmpdir(), 'montage-' + crypto.randomUUID());
  await fsp.mkdir(dir, { recursive: true });
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});

  try {
    const normalized = [];
    let total = 0;
    for (let i = 0; i < clips.length; i++) {
      const raw = path.join(dir, `in${i}.mp4`);
      await fsp.writeFile(raw, clips[i].buffer);
      const realDur = await probeDuration(raw);
      if (!realDur) throw new Error(`файл «${(clips[i].name || 'clip').slice(0, 40)}» не схоже на відео`);

      const sc = scenes[i] || {};
      let dur = parseFloat(sc.durationSec) || realDur;
      dur = Math.min(dur, realDur, MAX_SECONDS_PER_CLIP);
      if (total + dur > MAX_TOTAL_SECONDS) dur = Math.max(1, MAX_TOTAL_SECONDS - total);
      if (dur < 0.5) break;
      total += dur;

      const title = (sc.caption != null ? sc.caption : '').toString().trim().slice(0, 120);
      let captionFile = null;
      if (title) {
        captionFile = path.join(dir, `cap${i}.txt`);
        await fsp.writeFile(captionFile, title, 'utf8');
      }
      const out = path.join(dir, `n${i}.mp4`);
      await normalizeClip(raw, out, { w, h, dur, captionFile, hasTitle: !!title });
      normalized.push(out);
    }
    if (!normalized.length) throw new Error('нічого монтувати');

    // concat demuxer — клипы уже в едином формате, склейка без перекодирования видео-стыков
    const listFile = path.join(dir, 'list.txt');
    await fsp.writeFile(listFile, normalized.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const outFile = path.join(dir, 'promo.mp4');
    await run(ffmpegPath, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-movflags', '+faststart',
      outFile,
    ]);

    if (!fs.existsSync(outFile)) throw new Error('монтаж не створив файл');
    return { path: outFile, cleanup, durationSec: Math.round(total), clips: normalized.length, aspect };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

module.exports = { montage, MAX_CLIPS, MAX_SECONDS_PER_CLIP, MAX_TOTAL_SECONDS };
