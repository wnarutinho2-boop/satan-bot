const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { figCreate } = require('./fig.js');

// token vem do .env ao lado — nao precisa de variavel de ambiente nem de chave na mao
if (!process.env.DISCORD_TOKEN) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const m = env.match(/DISCORD_TOKEN=(.+)/);
    if (m) process.env.DISCORD_TOKEN = m[1].trim();
  } catch {}
}
const TOKEN = process.env.DISCORD_TOKEN;
const ROOT = __dirname;
const OWNER_ID = '1521612392105250836';          // só o dono usa comandos
// servers onde o bot fica / boas-vindas ativas (teste + oficial)
const INFERNO_GUILDS = new Set(['1525806672839442633', '1484007517091528914']);
const OUT = path.join(ROOT, 'out');
const INBOX = path.join(ROOT, 'inbox.jsonl');
const SENT = path.join(ROOT, 'sent.jsonl');
const ERRORS = path.join(ROOT, 'errors.log');

fs.mkdirSync(OUT, { recursive: true });

// anti-flood (ajustavel via antispam_config.json)
const ANTIFLOOD_CFG = path.join(ROOT, 'antispam_config.json');
const RE_INV = /[\s\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2800\u3164\ufeff\ufe00-\ufe0f\ufff0-\ufff8\ufffe\uffff\u{e0000}-\u{e007f}]/gu;
const ANTIFLOOD_DEFAULT = { chars: 500, windowMs: 6000, max: 5, penaltyMs: 10000, repeatWindowMs: 30000 };
const floodBuf = new Map();
const repBuf = new Map();
const penaltyUntil = new Map();

// castigo (timeout) progressivo: repetiu 10+ vezes -> 1h, e +1h a cada reincidencia
const MUTE_STATE = path.join(ROOT, 'mute_state.json');
const MUTE_BASE_MS = 60 * 60 * 1000;
const REP_MUTE_QTD = 10;
const repStreak = new Map(); // userId -> { sig, count }
const emoStreak = new Map();
const shortBuf = new Map(); // userId -> msgs curtas (spam W/Ww) // userId -> qtd seguida de msgs so de emoji
const linkBuf = new Map();   // userId -> [timestamps de links]
const RE_LINK = /(https?:\/\/|discord\.gg\/|discord\.com\/invite|discordapp\.com\/)/i;

// assinatura da mensagem: vale pra TUDO (texto, emoji, figurinha, imagem, gif, embed)
function msgSig(m) {
  const txt = (m.content || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const em = m.content ? (m.content.match(/<(a?):\w+:(\d+)>/g) || []).join(',') : '';
  const st = m.stickers && m.stickers.size ? [...m.stickers.values()].map((s) => s.id || s.name).join(',') : '';
  const at = m.attachments.size ? [...m.attachments.values()].map((a) => a.width || a.height ? `img:${a.width}x${a.height}` : `f:${a.name}`).join(',') : '';
  const eb = m.embeds.length ? m.embeds.map((e) => (e.image && e.image.url) || (e.thumbnail && e.thumbnail.url) || e.title || 'eb').join('|') : '';
  return [txt, em, st, at, eb].filter(Boolean).join('#') || 'vazia';
}
function msgKind(m) {
  if (m.stickers && m.stickers.size) return 'figurinha';
  if (m.attachments.size) return 'arquivo';
  if (m.embeds.length) return 'embed';
  const semEmoji = (m.content || '').replace(/<(a?):\w+:(\d+)>/g, '').trim();
  if (m.content && !semEmoji) return 'emoji';
  return 'texto';
}

// nuke (owner): recria o canal a cada 12h
const NUKE_STATE = path.join(ROOT, 'nuke_state.json');
const NUKE_EVERY_MS = 20 * 60 * 1000; // 20min

// bump reminder (estilo fibo): 2h apos o bump do disboard, repete a cada 2h
const DISBOARD_ID = '302050872383242240';
const BUMP_STATE = path.join(ROOT, 'bump_state.json');
const BUMP_EVERY_MS = 2 * 60 * 60 * 1000;



// boas-vindas (DM pro membro novo)
const WELCOME_MSG = {
  flags: 1 << 15,
  components: [
    {
      type: 17,
      accent_color: 8912896,
      components: [
        { type: 10, content: '# Bem-vindo ao Inferno' },
        { type: 14, spacing: 1, divider: true },
        { type: 10, content: 'Aqui não existe **nenhuma regra**. Pode falar sobre qualquer assunto, sem censura e sem limite — ninguém vai te julgar, punir ou banir pelo que você disser.' },
        { type: 14, spacing: 1, divider: false },
        { type: 10, content: 'Sinta-se em casa. Faça o que quiser.' },
      ],
    },
  ],
};

// menu de comandos (components V2)
function menuMsg() {
  return {
    flags: 1 << 15,
    components: [
      {
        type: 17,
        accent_color: 8912896,
        components: [
          { type: 10, content: '# Comandos do Satan' },
          { type: 14, spacing: 1, divider: true },
          { type: 10, content: '**.menu** — este menu\n**.nuke on / .nuke off** — a cada 20min limpa o chat das calls e recria o ・confessionario do zero; **.nuke agora** faz na hora; o painel de contagem fica no canal do comando (nunca no confessionario) / desliga\n**.cl [qtd]** — apaga o proprio comando + qtd mensagens de cima (sem valor = 10)\n**.fig** — fabrica de figurinhas (foto/video/gif viram sticker quadrado)\n**.bump** — painel de quem o lembrete de 2h marca\n**.att [arquivo]** — atualiza o bot e religa com o codigo novo\n**.4l** — caça nick de 4 letras disponivel no discord\n**.check on / .check off** — liga/desliga a caca 4l dos workers (avisa no canal + pv)' },
        ],
      },
    ],
  };
}

// lembrete de bump (components V2), marca o alvo configurado (.bump)
function mentionsOf(t) {
  const us = (t && t.users) || [];
  const rs = (t && t.roles) || [];
  if (!us.length && !rs.length) return `<@${OWNER_ID}>`;
  return [...us.map((id) => `<@${id}>`), ...rs.map((id) => `<@&${id}>`)].join(' ');
}
function bumpMsg() {
  return {
    flags: 1 << 15,
    components: [
      {
        type: 17,
        accent_color: 8912896,
        components: [
          { type: 10, content: '# ESCREVA /bump E ENVIE NESSE CANAL' },
          { type: 10, content: 'o disboard tá liberado de novo.' },
        ],
      },
    ],
  };
}
function bumpAvisoMsg() {
  return {
    flags: 1 << 15,
    components: [
      {
        type: 17,
        accent_color: 8912896,
        components: [
          { type: 10, content: 'vou marcar vocês pra dar bump daqui a duas horas :)' },
        ],
      },
    ],
  };
}

// ---------- painel do bump: multi-selecao de quem o lembrete marca ----------

function bumpPanel(st) {
  const body = [
    '**Painel do bump**',
    '',
    `Quem eu marco no lembrete de 2h: ${mentionsOf(st.target)}`,
    '',
    'Escolhe nas listas ai embaixo — sem digitar nada.',
  ].join('\n');
  return {
    flags: 1 << 15,
    components: [{
      type: 17, accent_color: 8912896,
      components: [
        { type: 10, content: body },
        { type: 1, components: [{ type: 5, custom_id: 'bump_sel_user', min_values: 1, max_values: 25, placeholder: '+ escolher pessoa(s)' }] },
        { type: 1, components: [{ type: 6, custom_id: 'bump_sel_role', min_values: 1, max_values: 25, placeholder: '+ escolher cargo(s)' }] },
        { type: 1, components: [
          { type: 2, style: 3, label: 'Salvar', custom_id: 'bump_sel_done' },
          { type: 2, style: 2, label: 'Me inclui', custom_id: 'bump_self' },
          { type: 2, style: 4, label: 'Zerar (so eu)', custom_id: 'bump_reset' },
        ]},
      ],
    }],
  };
}

function bumpAddMentions(st, m) {
  st.target = st.target || { users: [], roles: [] };
  st.target.users = st.target.users || [];
  st.target.roles = st.target.roles || [];
  let n = 0;
  for (const u of m.mentions.users.values()) if (!st.target.users.includes(u.id)) { st.target.users.push(u.id); n++; }
  for (const r of m.mentions.roles.values()) if (!st.target.roles.includes(r.id)) { st.target.roles.push(r.id); n++; }
  return n;
}

let seq = 0;
const log = (tag, obj) => {
  seq++;
  const line = `#${String(seq).padStart(4,'0')} [${tag}] ${typeof obj === 'string' ? obj : JSON.stringify(obj)}`;
  console.log(line);
};

function append(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function err(e) {
  const s = `${new Date().toISOString()} ${e && e.stack ? e.stack : e}\n`;
  fs.appendFileSync(ERRORS, s);
  console.error('ERR', s.trim());
}

// ---------- webhook: TUDO que o bot fala nos canais sai como webhook "Satan" ----------
let AVATAR_B64 = null;
async function carregarAvatarWebhook() {
  const url = client.user.displayAvatarURL({ forceStatic: true, extension: 'png', size: 256 });
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  const buf = Buffer.from(await r.arrayBuffer());
  AVATAR_B64 = 'data:image/png;base64,' + buf.toString('base64');
}
const whCache = new Map(); // channelId -> webhook
async function getWebhook(ch) {
  if (whCache.has(ch.id)) return whCache.get(ch.id);
  let wh = null;
  const hooks = await ch.fetchWebhooks().catch(() => null);
  if (hooks) wh = hooks.find((h) => h.name === 'Satan') || null;
  if (!wh) {
    if (!AVATAR_B64) await carregarAvatarWebhook();
    wh = await ch.createWebhook({ name: 'Satan', avatar: AVATAR_B64 });
  }
  whCache.set(ch.id, wh);
  return wh;
}
async function whSend(ch, payload) {
  const wh = await getWebhook(ch);
  return wh.send(payload);
}
async function whEdit(ch, messageId, payload) {
  const wh = await getWebhook(ch);
  return wh.editMessage(messageId, payload);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('ready', async () => {
  log('READY', { user: client.user.tag, id: client.user.id, guilds: client.guilds.cache.size });
  client.user.setActivity('o sofrimento dos condenados', { type: 3 });
  if (typeof varrerLinks === 'function') varrerLinks().catch(err); else err(new Error('varrerLinks ausente no ready'));
  if (typeof varrerFlood === 'function') varrerFlood().catch(err); else err(new Error('varrerFlood ausente no ready'));
  (async () => {
    const stN = readJsonSafe(NUKE_STATE, {});
    if (stN && stN.on === true && stN.nextAt) {
      const maxAt = Date.now() + NUKE_EVERY_MS;
      if (stN.nextAt > maxAt) { // ciclo mudou: ajusta o nuke que ja estava armado
        stN.nextAt = maxAt;
        fs.writeFileSync(NUKE_STATE, JSON.stringify(stN, null, 2));
        ghStateSyncTick();
      }
      await garantirPainelNuke(stN);
      await editarPainelNuke(stN);
    }
  })().catch(err);
  // slash commands removidos a pedido do dono (nao registrar mais)
});

// server novo: so entra se o dono adicionou; ai vira casa oficial (welcome + varredura)
client.on('guildCreate', async (g) => {
  const dono = await g.fetchOwner().catch(() => null);
  if (dono && dono.user && dono.user.id === OWNER_ID) {
    INFERNO_GUILDS.add(g.id);
    log('GUILD_NOVA_DO_DONO', { guild: g.id, name: g.name });
  } else {
    log('GUILD_LEAVE', { guild: g.id, name: g.name });
    try { await g.leave(); } catch (e) { err(e); }
  }
});

// membro novo no inferno -> manda as boas-vindas na DM
client.on('guildMemberAdd', async (member) => {
  if (!INFERNO_GUILDS.has(member.guild.id)) return;
  try {
    await member.send(WELCOME_MSG);
    log('WELCOME', { user: member.id, tag: member.user.tag });
  } catch (e) {
    log('WELCOME_FAIL', { user: member.id, err: e && e.message });
  }
});

// ---------- .fig: fabrica de figurinhas (quadradas 320x320, <=512KB) ----------
// ---------- estado persistente no repo GitHub (sobrevive a religadas/updates) ----------
const GH_STATE_FILES = ['nuke_state.json', 'bump_state.json', 'mute_state.json', 'hunt4l.json', 'nick_watch.json', 'check_state.json', 'nuke_log.json'];
async function ghStateLoad() {
  const tok = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  if (!tok || !repo) return;
  for (const f of GH_STATE_FILES) {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/${f}`, { headers: { Authorization: `token ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'satan-state' } });
      if (!r.ok) continue;
      const j = await r.json();
      fs.writeFileSync(path.join(ROOT, f), Buffer.from(j.content, 'base64').toString('utf8'));
      log('STATE_LOAD', { f });
    } catch (e) { err(e); }
  }
}
const ghLastMtime = {};
async function ghStateSyncTick() {
  const tok = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  if (!tok || !repo) return;
  for (const f of GH_STATE_FILES) {
    const p = path.join(ROOT, f);
    let stt; try { stt = fs.statSync(p); } catch { continue; }
    if (ghLastMtime[f] === stt.mtimeMs) continue;
    ghLastMtime[f] = stt.mtimeMs;
    try {
      const H = { Authorization: `token ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'satan-state', 'Content-Type': 'application/json' };
      const cur = await fetch(`https://api.github.com/repos/${repo}/contents/${f}`, { headers: H });
      let sha; if (cur.ok) sha = (await cur.json()).sha;
      const put = await fetch(`https://api.github.com/repos/${repo}/contents/${f}`, {
        method: 'PUT', headers: H,
        body: JSON.stringify({ message: `state ${f}`, content: fs.readFileSync(p).toString('base64'), ...(sha ? { sha } : {}) }),
      });
      if (!put.ok) throw new Error('put ' + put.status);
      log('STATE_SYNC', { f });
    } catch (e) { err(e); delete ghLastMtime[f]; }
  }
}
ghStateLoad();
setInterval(ghStateSyncTick, 60 * 1000);

const figState = new Map(); // guildId -> { msgId, lines: [] }

function figPanel(st, fim) {
  const body = [
    '**Fabrica de figurinhas**' + (fim ? ` — ${fim}` : ' — coleta ATIVA'),
    '',
    'Manda foto, video ou gif como ARQUIVO ANEXADO (um ou varios na mesma mensagem).',
    'Cada item vira na hora uma figurinha QUADRADA 320x320 deste server.',
    'Quando acabar, aperta CONCLUIR.',
  ];
  if (st && st.lines.length) body.push('', ...st.lines.slice(-12));
  const comps = [{ type: 10, content: body.join('\n') }];
  if (!fim) comps.push({
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Concluir', custom_id: 'fig_done' },
      { type: 2, style: 4, label: 'Cancelar', custom_id: 'fig_cancel' },
    ],
  });
  return { flags: 1 << 15, components: [{ type: 17, accent_color: 8912896, components: comps }] };
}

client.on('messageCreate', async (m) => {
  // bump reminder: detecta a confirmacao de bump do disboard e agenda lembrete a cada 2h
  if (m.author.id === DISBOARD_ID && m.guild) {
    if (isBumpDone(m)) {
      const bumper = (m.interaction && m.interaction.user && m.interaction.user.id) || OWNER_ID;
      const st = readJsonSafe(BUMP_STATE, {});
      const target = st.target || null;
      st[m.channelId] = { nextAt: Date.now() + BUMP_EVERY_MS, lastBumper: bumper };
      fs.writeFileSync(BUMP_STATE, JSON.stringify(st, null, 2));
      await whSend(m.channel, bumpAvisoMsg()).catch((e) => err(e));
      log('BUMP_DETECTADO', { channel: m.channelId, bumper, target });
    }
    return;
  }
  if (m.author.bot) return;
  const rec = {
    ts: new Date().toISOString(),
    id: m.id,
    author: m.author.tag,
    authorId: m.author.id,
    where: m.guild ? `guild:${m.guild.id}:${m.channel.name}` : 'dm',
    channelId: m.channelId,
    content: m.content,
    attachments: m.attachments.map((a) => ({ name: a.name, url: a.url })),
  };
  append(INBOX, rec);
  if (m.author.id === OWNER_ID) {
    // fala do dono: tag propria pra achar rapido no log
    log('DONO', { channel: m.channelId, where: rec.where, content: m.content });
  } else {
    log('MSG', rec);
  }

  // ---------- comandos do dono (.nuke / .menu / .cl) — qualquer outro usuário é ignorado ----------
  if (m.guild && m.author.id === OWNER_ID) {
    const c = m.content.trim().toLowerCase();
    if (c === '.nuke' || c === '.nuke on' || c === '.nuke off') {
      if (c === '.nuke' || c === '.nuke on') {
        const stJa = readJsonSafe(NUKE_STATE, {});
        if (stJa && stJa.on === true) {
          await m.delete().catch(() => {});
          await whSend(m.channel, { flags: 1 << 15, components: [{ type: 17, accent_color: 8912896, components: [
            { type: 10, content: 'o nuke **ja ta armado**.' },
          ]}] }).catch(() => {});
          return;
        }
        const stPrev0 = readJsonSafe(NUKE_STATE, {});
        const baseN = stPrev0 && stPrev0.lastNuke ? stPrev0.lastNuke + NUKE_EVERY_MS : 0;
        const st2 = { on: true, nextAt: baseN > Date.now() ? baseN : Date.now() + NUKE_EVERY_MS, cmdChannel: m.channel.id, lastNuke: (stPrev0 && stPrev0.lastNuke) || 0 };
        await m.delete().catch(() => {});
        const stPrev = readJsonSafe(NUKE_STATE, {});
        if (stPrev && stPrev.painel && stPrev.painel.channelId) {
          const och = await client.channels.fetch(stPrev.painel.channelId).catch(() => null);
          if (och) await och.messages.fetch(stPrev.painel.messageId).then((mm) => mm.delete().catch(() => {})).catch(() => {});
        }
        const alvo = canalDoPainel(m.guild, m.channel.id);
        const pm = await whSend(alvo, nukePainelMsg(st2.nextAt)).catch(() => null);
        if (pm) st2.painel = { channelId: alvo.id, messageId: pm.id };
        fs.writeFileSync(NUKE_STATE, JSON.stringify(st2, null, 2));
        ghStateSyncTick();
        log('NUKE_ON_GLOBAL', { guild: m.guild.id, nextAt: st2.nextAt, cmdChannel: m.channel.id, painel: painelId });
      } else {
        const stPrev = readJsonSafe(NUKE_STATE, {});
        if (!stPrev || stPrev.on !== true) {
          await m.delete().catch(() => {});
          await whSend(m.channel, { flags: 1 << 15, components: [{ type: 17, accent_color: 8912896, components: [
            { type: 10, content: 'o nuke **ja ta desarmado**.' },
          ]}] }).catch(() => {});
          return;
        }
        if (stPrev && stPrev.painel && stPrev.painel.channelId) {
          const chp = await client.channels.fetch(stPrev.painel.channelId).catch(() => null);
          if (chp) await chp.messages.fetch(stPrev.painel.messageId).then((mm) => mm.delete().catch(() => {})).catch(() => {});
        }
        await m.delete().catch(() => {});
        fs.writeFileSync(NUKE_STATE, JSON.stringify({ on: false }, null, 2));
        const choff = canalDoPainel(m.guild, m.channel.id);
        await whSend(choff, nukeOffMsg()).catch(() => {});
        ghStateSyncTick();
        log('NUKE_OFF_GLOBAL', { guild: m.guild.id });
      }
      return;
    }
    if (c === '.nuke agora' || c === '.nuke now') {
      await m.delete().catch(() => {});
      const stA = readJsonSafe(NUKE_STATE, {});
      const r = await limparServer(m.guild);
      stA.lastNuke = Date.now();
      if (stA.on === true) stA.nextAt = Date.now() + NUKE_EVERY_MS;
      fs.writeFileSync(NUKE_STATE, JSON.stringify(stA, null, 2));
      ghStateSyncTick();
      if (stA.on === true) await editarPainelNuke(stA);
      const chf = canalDoPainel(m.guild, m.channel.id);
      const tmp = await whSend(chf, nukeManualMsg()).catch(() => null);
      if (tmp) setTimeout(() => tmp.delete().catch(() => {}), 15000);
      log('NUKE_MANUAL', { guild: m.guild.id, msgs: r.msgs });
      return;
    }
    if (c === '.check on' || c === '.check off') {
      const on = c.endsWith('on');
      const stC = readJsonSafe(path.join(ROOT, 'check_state.json'), {});
      await m.delete().catch(() => {});
      if (stC && stC.on === on) {
        await whSend(m.channel, { flags: 1 << 15, components: [{ type: 17, accent_color: 8912896, components: [
          { type: 10, content: on ? 'o checker **ja ta ligado**.' : 'o checker **ja ta desligado**.' },
        ]}] }).catch(() => {});
        return;
      }
      fs.writeFileSync(path.join(ROOT, 'check_state.json'), JSON.stringify({ on }, null, 2));
      ghStateSyncTick();
      await whSend(m.channel, { flags: 1 << 15, components: [{ type: 17, accent_color: 8912896, components: [
        { type: 10, content: on ? 'checker 4l **ligado** — os 18 workers vao cacar e te avisar aqui + no pv quando acharem livre.' : 'checker 4l **desligado** — os workers param de avisar.' },
      ]}] }).catch(() => {});
      log('CHECK_TOGGLE', { on });
      return;
    }
    if (c === '.4l' || c.startsWith('.4l ')) {
      await m.delete().catch(() => {});
      const args = c.slice(4).trim().split(/[\s,]+/).filter((w) => w).slice(0, 10);
      const tmp = await whSend(m.channel, { flags: 1 << 15, components: [{ type: 17, accent_color: 8912896, components: [
        { type: 10, content: args.length ? 'consultando o discord sobre esses nicks...' : 'cacando 4l disponivel (ate 60 tentativas)...' },
      ]}] }).catch(() => null);
      const rd = (x) => x[Math.floor(Math.random() * x.length)];
      const conso = 'vkzxqjwrlmntchdbsgy', vog = 'aeiouy';
      const fila = args.length ? args : Array.from({ length: 60 }, () => rd(conso) + rd(vog) + rd(conso) + rd(vog));
      const livres = []; const tomadas = [];
      for (const wRaw of fila) {
        const w = wRaw.toLowerCase();
        if (!/^[a-z0-9._]{2,32}$/.test(w)) continue;
        try {
          const res = await fetch('https://discord.com/api/v9/unique-username/username-attempt-unauthed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            body: JSON.stringify({ username: w }),
          });
          if (res.status === 429) { tomadas.push(w + '(limite)'); await new Promise((r2) => setTimeout(r2, 2000)); continue; }
          const j = await res.json().catch(() => null);
          if (j && j.taken === false) livres.push(w); else tomadas.push(w);
        } catch (e) { /* rede */ }
        await new Promise((r2) => setTimeout(r2, 350));
      }
      let corpo;
      if (args.length) {
        corpo = livres.length ? 'livre(s): **' + livres.join('** · **') + '**' : 'todos esses ja tao tomados: ' + tomadas.join(', ');
      } else {
        corpo = livres.length ? '4l livres pra pegar:\n**' + livres.join('** · **') + '**' : 'nenhum 4l livre nessas 60 tentativas — 4l puro ta praticamente esgotado no discord. usa .4l nome1 nome2 pra eu consultar nomes que vc escolher.';
      }
      if (tmp) await whEdit(m.channel, tmp.id, { flags: 1 << 15, components: [{ type: 17, accent_color: 8912896, components: [
        { type: 10, content: '# consulta 4l' },
        { type: 10, content: corpo },
      ]}] }).catch(() => {});
      log('CONSULTA_4L', { livres: livres.length, tentadas: fila.length });
      return;
    }
    if (c === '.menu') {
      await whSend(m.channel, menuMsg()).catch((e) => err(e));
      log('MENU', { channel: m.channelId });
      return;
    }
    // .cl [qtd] — apaga mensagens de uma vez (dono). sem valor = 10.
    if (c === '.cl' || c.startsWith('.cl ')) {
      const n = parseInt(c.split(/\s+/)[1], 10);
      const total = isNaN(n) ? 10 : Math.min(Math.max(n, 1), 500);
      try {
        await m.delete().catch(() => {}); // o comando some e nao entra na conta
        let left = total, deleted = 0;
        while (left > 0) {
          const batch = Math.min(100, left);
          const col = await m.channel.bulkDelete(batch, true).catch(() => null);
          if (!col || col.size === 0) break;
          deleted += col.size;
          left -= col.size;
          if (col.size < batch) break;
        }
        log('CL', { channel: m.channelId, pedido: total, apagadas: deleted });
      } catch (e) { err(e); }
      return;
    }
    // .att [arquivo] — sobe o arquivo pro repo do GitHub e religa com o codigo novo (só no bot hospedado)
    if (c === '.att' || c.startsWith('.att ')) {
      const att = m.attachments.first();
      const ghTok = process.env.GITHUB_TOKEN;
      const repo = process.env.GITHUB_REPOSITORY;
      if (!ghTok || !repo) {
        await whSend(m.channel, 'o .att só funciona no bot hospedado no GitHub.').catch(() => {});
        return;
      }
      if (!att) {
        await whSend(m.channel, 'manda o arquivo junto com o .att (ex: bot.js)').catch(() => {});
        return;
      }
      try {
        const name = path.basename(att.name).replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!name || name === '.' || name === '..') throw new Error('nome de arquivo invalido');
        const res = await fetch(att.url);
        if (!res.ok) throw new Error('download falhou ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        const GH = { Authorization: `token ${ghTok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'satan-att' };
        const meta = await fetch(`https://api.github.com/repos/${repo}/contents/${name}`, { headers: GH });
        let sha;
        if (meta.ok) sha = (await meta.json()).sha;
        const put = await fetch(`https://api.github.com/repos/${repo}/contents/${name}`, {
          method: 'PUT',
          headers: { ...GH, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `.att ${name}`, content: buf.toString('base64'), ...(sha ? { sha } : {}) }),
        });
        if (!put.ok) throw new Error('commit falhou ' + put.status + ' ' + (await put.text()).slice(0, 150));
        fs.writeFileSync(path.join(ROOT, name), buf); // troca o arquivo local pra religar ja com o novo
        await whSend(m.channel, `**${name}** atualizado no repositório. religando com o código novo em 3s...`).catch(() => {});
        log('ATT', { name, size: buf.length });
        setTimeout(() => process.exit(0), 3000); // o loop do workflow liga de novo com o codigo novo
      } catch (e) {
        await whSend(m.channel, '.att falhou: ' + e.message).catch(() => {});
        err(e);
      }
      return;
    }
    // .bump — painel de quem o lembrete marca (dono); .bump @x @y adiciona direto
    if (c === '.bump' || c.startsWith('.bump ')) {
      const st = readJsonSafe(BUMP_STATE, {});
      if (m.mentions.users.size || m.mentions.roles.size) {
        bumpAddMentions(st, m);
        fs.writeFileSync(BUMP_STATE, JSON.stringify(st, null, 2));
        await whSend(m.channel, `adicionado. agora eu marco: ${mentionsOf(st.target)}`).catch(() => {});
        log('BUMP_ALVO', { target: st.target });
        return;
      }
      await whSend(m.channel, bumpPanel(st)).catch((e) => err(e));
      return;
    }
    // .fig — abre o painel da fabrica de figurinhas (dono)
    if (c === '.fig') {
      if (figState.has(m.guild.id)) {
        await whSend(m.channel, 'ja tem coleta ativa aqui. termina no botao CONCLUIR.').catch(() => {});
        return;
      }
      const msg = await whSend(m.channel, figPanel(null)).catch((e) => { err(e); return null; });
      if (msg) {
        figState.set(m.guild.id, { msgId: msg.id, lines: [] });
        log('FIG_ON', { guild: m.guild.id, channel: m.channelId });
      }
      return;
    }
  }

  // ---------- coleta do .fig: anexos e links do dono viram figurinha ----------
  if (m.guild && m.author.id === OWNER_ID && figState.has(m.guild.id)) {
    const st = figState.get(m.guild.id);
    const srcs = [];
    for (const a of m.attachments.values()) srcs.push({ url: a.url, name: a.name, ctype: a.contentType });
    if (srcs.length) {
      for (const s of srcs) {
        try {
          const nm = await figCreate(m.guild, s.url, s.name, s.ctype);
          st.lines.push('ok: ' + nm);
          log('FIG_OK', { guild: m.guild.id, name: nm });
        } catch (e) {
          st.lines.push('erro (' + (s.name || s.url).slice(0, 30) + '): ' + String(e.message).slice(0, 90));
          err(e);
        }
        await whEdit(m.channel, st.msgId, figPanel(st)).catch(() => {});
      }
      return;
    }
  }

async function aplicarCastigo(m, motivo) {
  const st = readJsonSafe(MUTE_STATE, {});
  const rec = st[m.author.id] || { level: 0, until: 0 };
  if (Date.now() < rec.until) return; // ja esta de castigo agora
  rec.level += 1;
  const horas = rec.level;
  rec.until = Date.now() + horas * MUTE_BASE_MS;
  st[m.author.id] = rec;
  fs.writeFileSync(MUTE_STATE, JSON.stringify(st, null, 2));
  repStreak.delete(m.author.id);
  linkBuf.delete(m.author.id);
  const aviso = `Você tomou castigo de ${horas} hora${horas > 1 ? 's' : ''}. Caso continue floodando, o tempo aumentará pra ${horas + 1} horas e assim consecutivamente.`;
  try {
    await m.member.timeout(horas * MUTE_BASE_MS, 'flood: ' + motivo);
    log('CASTIGO', { author: m.author.id, horas, motivo });
  } catch (e) { err(e); }
  // aviso so pra pessoa: o Discord nao deixa mensagem invisivel solta, entao vai por DM (privada)
  await m.author.send(aviso).catch(async () => {
    const tmp = await whSend(m.channel, `${m.author} ${aviso}`).catch(() => null);
    if (tmp) setTimeout(() => tmp.delete().catch(() => {}), 15000);
  });
}

// varre os canais ao ligar: apaga sobra de flood/repetida/invisivel que passou durante o gap do restart
async function varrerFlood() {
  for (const gid of INFERNO_GUILDS) {
    const g = client.guilds.cache.get(gid);
    if (!g) continue;
    for (const ch of [...g.channels.cache.values()]) {
      if (!ch.isTextBased()) continue;
      try {
        const msgs = (await ch.messages.fetch({ limit: 100 })).filter((x) => !x.author.bot && x.author.id !== OWNER_ID && x.deletable);
        const por = {};
        for (const x of [...msgs.values()]) (por[x.author.id] = por[x.author.id] || []).push(x);
        const alvos = new Set();
        for (const arr of Object.values(por)) {
          arr.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
          for (let i = 1; i < arr.length; i++) {
            if (msgSig(arr[i]) === msgSig(arr[i - 1]) && arr[i].createdTimestamp - arr[i - 1].createdTimestamp < 30000) alvos.add(arr[i]);
          }
          const curtas = arr.filter((x) => { const v = (x.content || '').trim(); return v.length > 0 && v.length <= 3; });
          for (let i = 5; i < curtas.length; i++) {
            if (curtas[i].createdTimestamp - curtas[i - 5].createdTimestamp < 60000) curtas.slice(i - 5, i + 1).forEach((x) => alvos.add(x));
          }
          for (const x of arr) { const v = x.content || ''; if (v && !v.replace(RE_INV, '')) alvos.add(x); }
          for (const x of arr) { if ((x.content || '').includes('*')) alvos.add(x); }
        }
        for (const x of alvos) await x.delete().catch(() => {});
        if (alvos.size) log('VARREDURA_FLOOD', { canal: ch.id, apagadas: alvos.size });
      } catch (e) { /* sem permissao, segue */ }
    }
  }
}

// varre os canais ao ligar: apaga link que passou enquanto o bot reiniciava
async function varrerLinks() {
  for (const gid of INFERNO_GUILDS) {
    const g = client.guilds.cache.get(gid);
    if (!g) continue;
    for (const ch of [...g.channels.cache.values()]) {
      if (!ch.isTextBased()) continue;
      try {
        const msgs = await ch.messages.fetch({ limit: 100 });
        const alvos = msgs.filter((x) => !x.author.bot && x.author.id !== OWNER_ID && RE_LINK.test(x.content || '') && x.deletable);
        if (!alvos.size) continue;
        await ch.bulkDelete(alvos, true).catch(async () => {
          for (const x of [...alvos.values()]) await x.delete().catch(() => {});
        });
        log('VARREDURA', { canal: ch.id, apagadas: alvos.size });
      } catch (e) { /* sem permissao no canal, segue */ }
    }
  }
}

  // ---------- anti-flood: apaga na hora, sem esperar o flood terminar ----------
  // TODA mensagem conta pro flood, independente de qual regra ja pegou ela
  try {
    if (!m.guild) return;
    if (m.author.id === OWNER_ID) return; // o dono e imune: nada e apagado nele
    const cfg = readJsonSafe(ANTIFLOOD_CFG, ANTIFLOOD_DEFAULT);
    const reasons = [];
    const now = Date.now();

    // 1) limite de caracteres por mensagem (nao poluir tela de celular)
    if (m.content.length > cfg.chars) reasons.push(`chars>${cfg.chars}`);

    // 1.5) qualquer link / convite de server morre na hora
    if (RE_LINK.test(m.content)) reasons.push('link');

    // 1.6) asterisco (markdown quebrado tipo **teste*): apaga na hora, sem castigo
    if ((m.content || '').includes('*')) reasons.push('asterisco');

    // 1.7) mensagem invisivel (so espacos/zero-width/tags unicode): apaga na hora; grande = castigo
    {
      const bruto = m.content || '';
      const visivel = bruto.replace(RE_INV, '');
      if (bruto.length > 0 && visivel.length === 0) {
        reasons.push('invisivel');
      }
    }

    // 2) mensagem repetida: compara com as 3 últimas do mesmo autor (pega
    //    "emoji, emoji" e tambem "emoji1, emoji2, emoji1" alternado)
    //    assinatura cobre texto, emoji, figurinha, imagem/gif, arquivo e embed
    {
      const sig = msgSig(m);
      const hist = repBuf.get(m.author.id) || [];
      if (hist.some((h) => h.sig === sig && now - h.ts < cfg.repeatWindowMs)) reasons.push('repetida');
      hist.push({ sig, ts: now });
      while (hist.length > 3) hist.shift();
      repBuf.set(m.author.id, hist);
    }

    // 3) penalidade ativa: quem floodou tem tudo apagado durante o cooldown
    if (now < (penaltyUntil.get(m.author.id) || 0)) reasons.push('penalidade');

    // 4) flood: mais de max msgs na janela -> apaga TUDO (inclusive retroativo) + penalidade
    {
      const arr = (floodBuf.get(m.author.id) || []).filter((e) => now - e.t < cfg.windowMs);
      arr.push({ t: now, id: m.id });
      floodBuf.set(m.author.id, arr);
      if (arr.length > cfg.max) {
        reasons.push(`flood>${cfg.max}em${cfg.windowMs / 1000}s`);
        penaltyUntil.set(m.author.id, now + cfg.penaltyMs);
        // retroativo: apaga pelo id todas as msgs da janela que passaram antes
        let n = 0;
        for (const e of arr) {
          if (e.id === m.id) continue;
          await m.channel.messages.delete(e.id).catch(() => {});
          n++;
        }
        if (n) log('ANTIFLOOD_RETRO', { author: m.author.id, apagadas: n });
      }
    }

    // 5) repetiu a MESMA mensagem mais de 10 vezes -> castigo progressivo
    {
      const sig = msgSig(m);
      const s = repStreak.get(m.author.id);
      const streak = s && s.sig === sig ? { sig, count: s.count + 1 } : { sig, count: 1 };
      repStreak.set(m.author.id, streak);
      if (streak.count > REP_MUTE_QTD) await aplicarCastigo(m, 'repetir a mesma mensagem 10+ vezes');
    }

    // 5b) 5+ mensagens seguidas so de emoji -> castigo progressivo
    {
      const txt = (m.content || '').trim();
      const soEmoji = txt.length > 0 && /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\s]+$/u.test(txt);
      if (soEmoji) {
        const q = (emoStreak.get(m.author.id) || 0) + 1;
        emoStreak.set(m.author.id, q);
        if (q >= 5) await aplicarCastigo(m, 'chuva de emojis');
      } else {
        emoStreak.delete(m.author.id);
      }
    }


    // 7) spam de msg curta (W, Ww, kkk alternado curto): 6+ msgs de ate 3 caracteres em 60s -> apaga tudo + penalidade
    {
      const vis = (m.content || '').trim();
      if (vis.length > 0 && vis.length <= 3) {
        const arr = (shortBuf.get(m.author.id) || []).filter((e) => now - e.t < 60000);
        arr.push({ t: now, id: m.id });
        shortBuf.set(m.author.id, arr);
        if (arr.length >= 6) {
          reasons.push('spam-curto');
          penaltyUntil.set(m.author.id, now + cfg.penaltyMs);
          for (const e of arr) {
            if (e.id === m.id) continue;
            await m.channel.messages.delete(e.id).catch(() => {});
          }
        }
      }
    }

    // 6) chuva de link: 10+ links em 10 minutos -> castigo progressivo
    if (RE_LINK.test(m.content || '')) {
      const arr = (linkBuf.get(m.author.id) || []).filter((t) => now - t < 10 * 60 * 1000);
      arr.push(now);
      linkBuf.set(m.author.id, arr);
      if (arr.length > REP_MUTE_QTD) await aplicarCastigo(m, 'mandar link 10+ vezes');
    }

    if (reasons.length && m.deletable) {
      await m.delete().catch(() => {});
      log('ANTIFLOOD', { reason: reasons.join('+'), kind: msgKind(m), author: m.author.id, channel: m.channelId, len: m.content.length });
    }
  } catch (e) {
    err(e);
  }
});

client.on('interactionCreate', async (i) => {
  // botoes do painel .fig (so o dono)
  if (i.isButton() && (i.customId === 'fig_done' || i.customId === 'fig_cancel')) {
    await i.deferUpdate().catch(() => {});
    if (i.user.id !== OWNER_ID || !i.guild) return;
    const st = figState.get(i.guild.id);
    figState.delete(i.guild.id);
    const fim = i.customId === 'fig_done' ? 'concluido' : 'cancelado';
    if (st) await whEdit(i.channel, st.msgId, figPanel(st, fim)).catch(() => {});
    log('FIG_FIM', { guild: i.guild.id, fim, itens: st ? st.lines.length : 0 });
    return;
  }
  // painel do bump: selects e botoes (so o dono)
  if ((i.isUserSelectMenu && i.isUserSelectMenu() && i.customId === 'bump_sel_user') ||
      (i.isRoleSelectMenu && i.isRoleSelectMenu() && i.customId === 'bump_sel_role')) {
    await i.deferUpdate().catch(() => {});
    if (i.user.id !== OWNER_ID || !i.guild) return;
    const st = readJsonSafe(BUMP_STATE, {});
    st.target = st.target || { users: [], roles: [] };
    st.target.users = st.target.users || [];
    st.target.roles = st.target.roles || [];
    const ids = i.values || [];
    if (i.customId === 'bump_sel_user') for (const id of ids) if (!st.target.users.includes(id)) st.target.users.push(id);
    else for (const id of ids) if (!st.target.roles.includes(id)) st.target.roles.push(id);
    fs.writeFileSync(BUMP_STATE, JSON.stringify(st, null, 2));
    await whEdit(i.channel, i.message.id, bumpPanel(st)).catch(() => {});
    log('BUMP_PAINEL', { custom: i.customId, ids, target: st.target });
    return;
  }
  if (i.isButton() && i.customId === 'bump_sel_done') {
    if (i.user.id !== OWNER_ID) { await i.reply({ flags: 64, components: [{ type: 17, accent_color: 8912896, components: [{ type: 10, content: 'só o dono usa isso.' }] }] }); return; }
    await i.deferUpdate().catch(() => {});
    await i.message.delete().catch(() => {});
    return;
  }
  if (i.isButton() && ['bump_self', 'bump_reset'].includes(i.customId)) {
    await i.deferUpdate().catch(() => {});
    if (i.user.id !== OWNER_ID || !i.guild) return;
    const st = readJsonSafe(BUMP_STATE, {});
    st.target = st.target || { users: [], roles: [] };
    st.target.users = st.target.users || [];
    if (i.customId === 'bump_self') { if (!st.target.users.includes(OWNER_ID)) st.target.users.push(OWNER_ID); }
    else st.target = { users: [], roles: [] };
    fs.writeFileSync(BUMP_STATE, JSON.stringify(st, null, 2));
    await whEdit(i.channel, i.message.id, bumpPanel(st)).catch(() => {});
    log('BUMP_PAINEL', { custom: i.customId, target: st.target });
    return;
  }
});

client.on('error', err);
process.on('unhandledRejection', err);

// confirmacao de bump do disboard — nao depende do idioma da resposta.
// 1) o comando que gerou a mensagem eh /bump  2) embed com a cor do disboard
// 3) texto de sucesso em pt/en/es (bump done, concluido, exito, logrado...)
const DISBOARD_EMBED_COLOR = 5786862; // 0x5865F2
const BUMP_OK_RE = /(bump\w*\s*(done|feito|complete[d]?|success)|done\s*bump|sucess|conclu[ií]d|[eé]xito|logrado|gracias|obrigad|thank|confira no disboard|disboard\.org\/server)/i;
function isBumpDone(m) {
  const cmd = m.interaction && m.interaction.commandName;
  if (cmd && cmd.toLowerCase() === 'bump') return true;
  if (!m.embeds || !m.embeds.length) return BUMP_OK_RE.test(m.content || ''); // formato novo: texto puro, sem embed
  if (m.embeds.some((e) => e.color === DISBOARD_EMBED_COLOR)) return true;
  const hay = (m.content || '') + ' ' + JSON.stringify(m.embeds.map((e) => ({ t: e.title, d: e.description, f: e.fields })));
  return BUMP_OK_RE.test(hay);
}

// ---------- outbox: eu escrevo JSON aqui, o bot envia ----------

async function handleJob(job) {
  switch (job.action) {
    case 'send': {
      const ch = await client.channels.fetch(job.channelId);
      if (!ch) throw new Error('canal nao encontrado');
      const msg = await whSend(ch, job.payload);
      return { messageId: msg.id, channelId: msg.channelId };
    }
    case 'edit': {
      const ch = await client.channels.fetch(job.channelId);
      const msg = await ch.messages.fetch(job.messageId);
      await msg.edit(job.payload);
      return { edited: msg.id };
    }
    case 'react': {
      const ch = await client.channels.fetch(job.channelId);
      const msg = await ch.messages.fetch(job.messageId);
      await msg.react(job.emoji);
      return { reacted: job.emoji };
    }
    case 'delete': {
      const ch = await client.channels.fetch(job.channelId);
      const msg = await ch.messages.fetch(job.messageId);
      await msg.delete();
      return { deleted: job.messageId };
    }
    case 'reply': {
      const ch = await client.channels.fetch(job.channelId);
      const msg = await ch.messages.fetch(job.messageId);
      const r = await msg.reply(job.payload);
      return { messageId: r.id, channelId: r.channelId };
    }
    case 'presence': {
      if (!client.user) await new Promise((res) => client.once('clientReady', res));
      client.user.setPresence({ status: job.status || 'online', activities: job.activities || [] });
      return { presence: client.user.presence.status };
    }
    case 'channels': {
      return client.guilds.cache.map((g) => ({
        guild: g.name,
        guildId: g.id,
        channels: [...g.channels.cache.values()]
          .filter((c) => c.isTextBased())
          .map((c) => ({ name: c.name, id: c.id, type: c.type })),
      }));
    }
    default:
      throw new Error('action desconhecida: ' + job.action);
  }
}

function readJsonSafe(p, d) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; }
}

// recria um canal (clone mantém nome/permissões/categoria/posição), apaga o original
// e manda o embed Components V2 no canal novo

// ---------- painel do nuke: countdown Components V2, atualizado a cada minuto ----------
function fmtResto(nextAt) {
  const ms = Math.max(0, nextAt - Date.now());
  const h = Math.floor(ms / 3600000);
  const mn = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return h + 'h ' + String(mn).padStart(2, '0') + 'm ' + String(s).padStart(2, '0') + 's';
  return String(mn).padStart(2, '0') + 'm ' + String(s).padStart(2, '0') + 's';
}
function barraResto(nextAt) {
  const frac = Math.max(0, Math.min(1, (nextAt - Date.now()) / NUKE_EVERY_MS));
  const cheio = Math.round(frac * 10);
  return '[' + '█'.repeat(cheio) + '░'.repeat(10 - cheio) + ']';
}
function periodoDoDia(h) {
  if (h < 6) return 'da madrugada';
  if (h < 12) return 'da manha';
  if (h < 18) return 'da tarde';
  return 'da noite';
}
function horaBrasilia(nextAt) {
  const iso = new Date(nextAt - 3 * 3600000).toISOString();
  const h = parseInt(iso.slice(11, 13), 10);
  return iso.slice(11, 16) + ' ' + periodoDoDia(h);
}
function nukePainelMsg(nextAt) {
  return {
    flags: 1 << 15,
    components: [{
      type: 17, accent_color: 8912896,
      components: [
        { type: 10, content: '# NUKE ARMADO' },
        { type: 10, content: '**' + fmtResto(nextAt) + '**' },
        { type: 10, content: barraResto(nextAt) },
        { type: 10, content: 'próxima limpeza às ' + horaBrasilia(nextAt) },
      ],
    }],
  };
}
// canal do painel: o do comando, mas NUNCA o confessionario (cai no bump)
function canalDoPainel(guild, preferId) {
  let ch = null;
  if (preferId) ch = guild.channels.cache.get(preferId) || null;
  if (!ch || /confessionar/i.test(ch.name || '')) {
    ch = guild.channels.cache.find((cc) => cc.type === 0 && /^bump$/i.test(cc.name || '')) || ch;
  }
  return ch;
}
function nukeAnuncioMsg() {
  return {
    embeds: [{ description: 'As portas do inferno foram abertas', color: 8912896 }],
  };
}
async function anunciarNuke(guild) {
  const all = await guild.channels.fetch().catch(() => guild.channels.cache);
  const ch = [...all.values()].find((c) => (c.type === 0 || c.type === 5) && /confessionar/i.test(c.name || ''));
  if (!ch) return;
  const msg = await whSend(ch, nukeAnuncioMsg()).catch((e) => { err(e); return null; });
  if (msg) setTimeout(() => msg.delete().catch(() => {}), 5000);
}
function nukeManualMsg() {
  return {
    flags: 1 << 15,
    components: [{ type: 17, accent_color: 8912896, components: [
      { type: 10, content: '**nuke manual feito** — calls limpas, ・confessionario recriado. contador do automatico zerado.' },
    ]}],
  };
}
function nukeOffMsg() {
  return {
    flags: 1 << 15,
    components: [{ type: 17, accent_color: 8912896, components: [
      { type: 10, content: 'nuke desarmado. painel removido, nada será limpo.' },
    ]}],
  };
}
// limpa: chat das calls (bulk) + ・confessionario RECRRIA o canal identico (posicao/perms/topic)
const NUKE_LOG = path.join(ROOT, 'nuke_log.json');
async function limparServer(guild) {
  let msgs = 0;
  const nlog = { quando: new Date().toISOString(), confAchado: null, confDelete: null, confCreate: null, anuncio: null, calls: [], erros: [] };
  // 1) PRIMEIRO o confessionario: recria e anuncia na hora (sem esperar as calls)
  const todos = await guild.channels.fetch().catch((e) => { nlog.erros.push('fetch canais: ' + (e && e.message)); return guild.channels.cache; });
  const chans = [...todos.values()];
  const conf = chans.find((c) => (c.type === 0 || c.type === 5) && /confessionar/i.test(c.name || ''));
  nlog.confAchado = conf ? conf.id : null;
  if (!conf) log('NUKE_CONF_NAO_ACHADO', { guild: guild.id });
  if (conf) {
    try {
      const f = await conf.fetch().catch(() => conf);
      const eraSistema = guild.systemChannelId === f.id;
      const over = f.permissionOverwrites.cache.map((o) => ({
        id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString(),
      }));
      const spec = {
        name: f.name,
        type: f.type,
        parent: f.parentId || undefined,
        topic: f.topic || undefined,
        nsfw: f.nsfw,
        rateLimitPerUser: f.rateLimitPerUser || undefined,
        position: f.position,
        permissionOverwrites: over,
        reason: 'nuke: renascimento do confessionario',
      };
      await f.delete('nuke: confessionario renasce').then(() => { nlog.confDelete = 'ok'; }).catch((e) => { nlog.confDelete = 'erro: ' + (e && e.message); err(e); });
      const novo = await guild.channels.create(spec).catch((e) => { nlog.erros.push('create: ' + (e && e.message)); err(e); return null; });
      nlog.confCreate = novo ? novo.id : null;
      if (novo) {
        log('NUKE_CONF_RECRIADO', { novo: novo.id, pos: novo.position, sistema: eraSistema });
        if (eraSistema) await guild.setSystemChannel(novo).catch((e) => err(e));
        await anunciarNuke(guild); // mensagem entra no canal novo na hora
        nlog.anuncio = 'ok';
      }
    } catch (e) { nlog.erros.push('conf: ' + (e && e.message)); err(e); }
  }
  try { fs.writeFileSync(NUKE_LOG, JSON.stringify(nlog, null, 2)); ghStateSyncTick(); } catch (e) { err(e); }
  // 2) depois as calls (mais rapido: pausa menor entre lotes)
  for (const ch of chans) {
    if (ch.type !== 2) continue;
    let q = 0;
    try {
      while (true) {
        const del = await ch.bulkDelete(100, true).catch((e) => { nlog.erros.push(`call ${ch.name}: ` + (e && e.message)); return null; });
        if (!del || del.size === 0) break;
        q += del.size;
        if (del.size < 100) break;
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (e) { nlog.erros.push(`call ${ch.name}: ` + (e && e.message)); err(e); }
    nlog.calls.push({ canal: ch.name, apagadas: q });
    msgs += q;
  }
  nlog.totalMsgs = msgs;
  try { fs.writeFileSync(NUKE_LOG, JSON.stringify(nlog, null, 2)); ghStateSyncTick(); } catch (e) { err(e); }
  return { msgs };
}

// confere a cada minuto se chegou a hora do nuke global (12h)
async function nukeTick() {
  try {
    const st = readJsonSafe(NUKE_STATE, {});
    if (!st || st.on !== true || !st.nextAt) return;
    const maxAt = Date.now() + NUKE_EVERY_MS;
    if (st.nextAt > maxAt) { // ciclo menor que o armado (ex.: mudou de 12h pra 6h)
      st.nextAt = maxAt;
      fs.writeFileSync(NUKE_STATE, JSON.stringify(st, null, 2));
      ghStateSyncTick();
    }
    await garantirPainelNuke(st);
    if (Date.now() >= st.nextAt) {
      const guild = client.guilds.cache.find((g) => g.ownerId === OWNER_ID) || client.guilds.cache.first();
      if (!guild) return;
      const r = await limparServer(guild);
      st.nextAt = Date.now() + NUKE_EVERY_MS;
      st.lastNuke = Date.now();
      fs.writeFileSync(NUKE_STATE, JSON.stringify(st, null, 2));
      ghStateSyncTick();
      await editarPainelNuke(st);
      log('NUKE_AUTO_GLOBAL', { guild: guild.id, msgs: r.msgs, nextAt: st.nextAt });
    }
  } catch (e) { err(e); }
}

// recria o painel so se ele tiver sumido (restart/apagaram); nao edita por minuto (zero rate limit)
async function garantirPainelNuke(st) {
  try {
    if (!st || st.on !== true || !st.nextAt) return;
    const guild = client.guilds.cache.find((g) => g.ownerId === OWNER_ID) || client.guilds.cache.first();
    if (!guild) return;
    if (!st.painel || !st.painel.channelId) {
      const ch = canalDoPainel(guild, st.cmdChannel);
      if (!ch) return;
      const pm = await whSend(ch, nukePainelMsg(st.nextAt)).catch(() => null);
      if (pm) { st.painel = { channelId: ch.id, messageId: pm.id }; fs.writeFileSync(NUKE_STATE, JSON.stringify(st, null, 2)); }
      return;
    }
    const ch = await client.channels.fetch(st.painel.channelId).catch(() => null);
    if (!ch) return;
    const msg = await ch.messages.fetch(st.painel.messageId).catch(() => null);
    if (msg) {
      const ok = await whEdit(ch, st.painel.messageId, nukePainelMsg(st.nextAt)).then(() => true).catch(() => false);
      if (ok) return;
      await ch.messages.delete(st.painel.messageId).catch(() => {});
    }
    {
      const pm = await whSend(ch, nukePainelMsg(st.nextAt)).catch(() => null);
      if (pm) { st.painel.messageId = pm.id; fs.writeFileSync(NUKE_STATE, JSON.stringify(st, null, 2)); }
    }
  } catch (e) { err(e); }
}
// edita o painel (usado no .nuke on e apos cada limpeza de 12h)
async function editarPainelNuke(st) {
  try {
    if (!st || !st.painel || !st.painel.channelId) return;
    const ch = await client.channels.fetch(st.painel.channelId).catch(() => null);
    if (!ch) return;
    await whEdit(ch, st.painel.messageId, nukePainelMsg(st.nextAt)).catch(() => {});
  } catch (e) { err(e); }
}
// lembrete de bump: a cada 2h desde o ultimo bump, repete ate bumpar de novo
async function bumpTick() {
  try {
    const st = readJsonSafe(BUMP_STATE, {});
    const now = Date.now();
    for (const [cid, info] of Object.entries(st)) {
      if (info && now >= info.nextAt) {
        const ch = await client.channels.fetch(cid).catch(() => null);
        if (!ch) { delete st[cid]; fs.writeFileSync(BUMP_STATE, JSON.stringify(st, null, 2)); continue; }
        await whSend(ch, {
          content: mentionsOf(st.target), // @ pingando (unica parte que notifica)
          embeds: [{ title: 'ESCREVA /bump E ENVIE NESSE CANAL', description: 'o disboard tá liberado de novo.', color: 8912896 }],
        }).catch((e) => err(e));
        delete st[cid]; // lembrete uma vez por bump; so avisa de novo com bump novo
        fs.writeFileSync(BUMP_STATE, JSON.stringify(st, null, 2));
        log('BUMP_LEMBRETE', { channel: cid });
      }
    }
  } catch (e) { err(e); }
}

// overflow (call cheia -> cria outra) removido a pedido do dono

// ---------- caca 4l/3l/4n/semi: roda uma vez por religada, salva no repo ----------
const HUNT4L = path.join(ROOT, 'hunt4l.json');
async function caca4lPadroes() {
  const st = readJsonSafe(HUNT4L, {});
  if (st && st.done) return; // ja cacou nessa versao do estado
  const L = 'abcdefghijklmnopqrstuvwxyz', D = '0123456789', S = '._';
  const r = (x) => x[Math.floor(Math.random() * x.length)];
  const temDig = (w) => /\d/.test(w);
  const pats = {
    '3l': () => r(L) + r(L) + r(L),
    '3c': () => { let w; do { w = r(L + D) + r(L + D) + r(L + D); } while (!temDig(w)); return w; },
    '4l': () => r(L) + r(L) + r(L) + r(L),
    '4c': () => { let w; do { w = r(L + D) + r(L + D) + r(L + D) + r(L + D); } while (!temDig(w)); return w; },
    '4n': () => r(D) + r(D) + r(D) + r(D),
    'semi3l': () => { const a = r(L) + r(L) + r(L); const p = 1 + Math.floor(Math.random() * 2); return a.slice(0, p) + r(S) + a.slice(p); },
    'semi3c': () => { const a = r(L) + r(D) + r(L); const p = 1 + Math.floor(Math.random() * 2); return a.slice(0, p) + r(S) + a.slice(p); },
    'semi4n': () => { const a = r(D) + r(D) + r(D) + r(D); const p = 1 + Math.floor(Math.random() * 3); return a.slice(0, p) + r(S) + a.slice(p); },
  };
  const out = { done: false, achados: {}, tentadas: 0, erros: 0, inicio: Date.now() };
  fs.writeFileSync(HUNT4L, JSON.stringify(out));
  for (const [nome, gen] of Object.entries(pats)) {
    const ach = []; let tries = 0; const vistas = new Set();
    while (tries < 100 && ach.length < 3) {
      const w = gen();
      if (vistas.has(w)) continue;
      vistas.add(w); tries++; out.tentadas++;
      try {
        const res = await fetch('https://discord.com/api/v9/unique-username/username-attempt-unauthed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          body: JSON.stringify({ username: w }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 429) {
          const j = await res.json().catch(() => null);
          const ra = ((j && j.retry_after) || 30) * 1000;
          if (ra > 45000) break; // limite longo: pula o resto desse padrao
          await new Promise((r2) => setTimeout(r2, ra));
          tries--; continue;
        }
        const j = await res.json().catch(() => null);
        if (j && j.taken === false) ach.push(w);
      } catch (e) { out.erros++; }
      await new Promise((r2) => setTimeout(r2, 300));
    }
    out.achados[nome] = ach;
    fs.writeFileSync(HUNT4L, JSON.stringify(out));
  }
  out.done = true; out.fim = Date.now();
  fs.writeFileSync(HUNT4L, JSON.stringify(out));
  log('CACA_4L_PADROES', { tentadas: out.tentadas, achados: Object.values(out.achados).flat().length });
}
// vigia de nicks: consulta a lista aos poucos (limite do site e curto)
setInterval(vigiaNicks, 15 * 60 * 1000);
vigiaNicks().catch(err);

// ---------- vigia 4l permanente: lotes aleatorios so de 4 caracteres, avisa quando achar livre ----------
const NICK_WATCH = path.join(ROOT, 'nick_watch.json');
const AVISO_4L_CANAL = '1548910505500868709'; // adm
async function vigiaNicks() {
  const st = readJsonSafe(NICK_WATCH, { tick: 0, livres: [], avisados: [] });
  const L = 'abcdefghijklmnopqrstuvwxyz', D = '0123456789', S = '._';
  const r = (x) => x[Math.floor(Math.random() * x.length)];
  const gens = [
    () => r(L) + r(L) + r(L) + r(L),                                   // 4l
    () => r(L) + r(D) + r(L) + r(D),                                   // 4c alternado
    () => r(D) + r(L) + r(L) + r(D),                                   // 4c capsula
    () => r(D) + r(D) + r(D) + r(D),                                   // 4n
    () => r(L) + r(S) + r(L) + r(L),                                   // semi l.ll
    () => r(L) + r(L) + r(S) + r(L),                                   // semi ll.l
  ];
  const gen = gens[st.tick % gens.length];
  const achadosAgora = [];
  for (let i = 0; i < 15; i++) {
    const w = gen();
    try {
      const res = await fetch('https://discord.com/api/v9/unique-username/username-attempt-unauthed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        body: JSON.stringify({ username: w }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429) break;
      const j = await res.json().catch(() => null);
      if (j && j.taken === false) {
        if (!st.livres.includes(w)) st.livres.push(w);
        achadosAgora.push(w);
      }
    } catch (e) { /* rede */ }
    await new Promise((r2) => setTimeout(r2, 400));
  }
  st.tick++;
  while (st.livres.length > 30) st.livres.shift();
  fs.writeFileSync(NICK_WATCH, JSON.stringify(st));
  for (const w of achadosAgora) {
    const ch = await client.channels.fetch(AVISO_4L_CANAL).catch(() => null);
    if (ch) await whSend(ch, { flags: 1 << 15, components: [{ type: 17, accent_color: 8912896, components: [
      { type: 10, content: '# 4L LIVRE ACABOU DE APARECER' },
      { type: 10, content: '**' + w + '** — corre la e pega antes que outro bot snipe.' },
    ]}] }).catch((e) => err(e));
  }
  log('VIGIA_4L', { tick: st.tick, livres: st.livres.length, novos: achadosAgora.length });
}

setInterval(nukeTick, 60 * 1000);
setInterval(() => { editarPainelNuke(readJsonSafe(NUKE_STATE, {})).catch(() => {}); }, 5 * 1000); // relogio vivo do painel (5s)
setInterval(bumpTick, 60 * 1000);

client.login(TOKEN).catch((e) => {
  err(e);
  process.exit(1);
});
