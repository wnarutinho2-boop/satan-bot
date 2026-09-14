// fabrica de figurinhas: conversao pra quadrado 320x320, <=512KB (regras do Discord)
// formatos: foto -> PNG | gif/video -> GIF (palette de 128 cores)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MAX_BYTES = 512 * 1024;

function ffmpegBin() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

// classifica o binario: video | gif | foto
function sniffKind(buf, name, ctype) {
  const c = (ctype || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (c.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/.test(n) ||
      (buf.length > 12 && buf.slice(4, 8).toString('ascii') === 'ftyp') ||
      (buf.length > 4 && buf.slice(0, 4).toString('hex') === '1a45dfa3')) return 'video';
  if (c === 'image/gif' || /\.gif($|\?)/.test(n) || buf.slice(0, 6).toString('ascii') === 'GIF8') return 'gif';
  return 'foto';
}

const CROP = "crop=w='min(iw,ih)':h='min(iw,ih)':x='(iw-min(iw,ih))/2':y='(ih-min(iw,ih))/2'";

function runFfmpeg(args) {
  return new Promise((res, rej) => {
    execFile(ffmpegBin(), args, { maxBuffer: 64 * 1024 * 1024 }, (e, so, se) => {
      if (e) rej(new Error(String(se || e.message).slice(-300)));
      else res();
    });
  });
}

// recebe caminho do arquivo baixado + tipo; devolve { buf, ext } quadrado e dentro do limite
async function makeSquareSticker(src, kind) {
  const attempts = kind === 'foto' ? [['320'], ['256'], ['160']] : [['320', '15'], ['160', '10'], ['128', '8']];
  let lastSize = 0;
  for (const [sc, fps] of attempts) {
    const ext = kind === 'foto' ? 'png' : 'gif';
    const out = path.join(os.tmpdir(), `fig_${process.pid}_${Date.now()}.${ext}`);
    let vf = (fps ? `fps=${fps},` : '') + CROP + `,scale=${sc}:${sc}:flags=lanczos`;
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', src];
    if (kind === 'foto') {
      args.push('-vf', vf, '-frames:v', '1', out);
    } else {
      vf += ',split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse';
      args.push('-vf', vf, '-loop', '0', out);
    }
    await runFfmpeg(args);
    const buf = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    lastSize = buf.length;
    if (buf.length <= MAX_BYTES) return { buf, ext };
  }
  throw new Error(`nao coube em 512KB (ultimo: ${Math.round(lastSize / 1024)}KB)`);
}

// baixa uma midia (url) e devolve { buf, ext, kind } pronto pra virar sticker
async function buildSticker(url, name, ctype) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('download ' + res.status);
  const raw = Buffer.from(await res.arrayBuffer());
  const kind = sniffKind(raw, name, ctype || res.headers.get('content-type'));
  const tmp = path.join(os.tmpdir(), `fig_in_${process.pid}_${Date.now()}`);
  fs.writeFileSync(tmp, raw);
  try {
    const { buf, ext } = await makeSquareSticker(tmp, kind);
    return { buf, ext, kind };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { sniffKind, makeSquareSticker, buildSticker, MAX_BYTES };
