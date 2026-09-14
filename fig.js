// fabrica de figurinhas: conversao pra quadrado 320x320, <=512KB (regras do Discord)
// formatos: foto -> PNG | gif/video -> GIF (palette de 128 cores)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MAX_BYTES = 512 * 1024;

function ffmpegBin() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require('ffmpeg-static'); } catch {}
  return 'ffmpeg';
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

// tira de uma pagina HTML o link da midia direta (og:video > og:image > url solta)
function extractMediaUrl(html) {
  const grab = (re) => {
    const m = html.match(re);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  };
  return (
    grab(/<meta[^>]+property="og:video(?::secure_url|:url)?"[^>]+content="([^"]+)"/i) ||
    grab(/<meta[^>]+content="([^"]+)"[^>]+property="og:video(?::secure_url|:url)?"/i) ||
    grab(/<meta[^>]+name="twitter:player:stream"[^>]+content="([^"]+)"/i) ||
    grab(/<meta[^>]+property="og:image(?::secure_url)?"[^>]+content="([^"]+)"/i) ||
    grab(/<meta[^>]+content="([^"]+)"[^>]+property="og:image(?::secure_url)?"/i) ||
    grab(/(https?:\/\/[^"'<>\s]+?\.(?:gif|mp4|webm)(?:\?[^"'<>\s]*)?)/i)
  );
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// baixa uma midia (url) e devolve { buf, ext, kind } pronto pra virar sticker
async function buildSticker(url, name, ctype, hop) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) throw new Error('o site bloqueou o download (' + res.status + ') - manda o arquivo ou um link direto de midia');
    throw new Error('download ' + res.status);
  }
  const raw = Buffer.from(await res.arrayBuffer());
  const ct = (ctype || res.headers.get('content-type') || '').toLowerCase();
  // pagina HTML: tenta resolver a midia direta dentro dela (1 pulo so)
  if (ct.includes('text/html') || raw.slice(0, 15).toString('utf8').toLowerCase().startsWith('<!doctype html') || raw.slice(0, 5).toString('utf8').toLowerCase() === '<html') {
    if (hop) throw new Error('pagina sem midia direta');
    const media = extractMediaUrl(raw.toString('utf8'));
    if (!media) throw new Error('pagina protegida ou sem midia - manda o arquivo ou link direto');
    return buildSticker(media, media.split('/').pop().split('?')[0], null, true);
  }
  const kind = sniffKind(raw, name, ct);
  const tmp = path.join(os.tmpdir(), `fig_in_${process.pid}_${Date.now()}`);
  fs.writeFileSync(tmp, raw);
  try {
    const { buf, ext } = await makeSquareSticker(tmp, kind);
    return { buf, ext, kind };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// nome fixo de toda figurinha (pedido do dono); discord aceita nomes repetidos
const NOME_FIG = 'discord.gg/inferninho';

// cria a figurinha no server (guild = objeto discord.js): baixa, quadrado, upload
async function figCreate(guild, url, name, ctype) {
  const { buf, ext } = await buildSticker(url, name, ctype);
  const stick = await guild.stickers.create({ name: NOME_FIG, tags: NOME_FIG, file: { attachment: buf, name: `${NOME_FIG}.${ext}` } });
  return stick.name;
}

module.exports = { sniffKind, makeSquareSticker, buildSticker, figCreate, NOME_FIG, MAX_BYTES };
