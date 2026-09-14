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
const ANTIFLOOD_DEFAULT = { chars: 500, windowMs: 6000, max: 5, penaltyMs: 10000, repeatWindowMs: 30000 };
const floodBuf = new Map();
const repBuf = new Map();
const penaltyUntil = new Map();

// castigo (timeout) progressivo: repetiu 10+ vezes -> 1h, e +1h a cada reincidencia
const MUTE_STATE = path.join(ROOT, 'mute_state.json');
const MUTE_BASE_MS = 60 * 60 * 1000;
const REP_MUTE_QTD = 10;
const repStreak = new Map(); // userId -> { sig, count }
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
const NUKE_EVERY_MS = 12 * 60 * 60 * 1000;

// bump reminder (estilo fibo): 2h apos o bump do disboard, repete a cada 2h
const DISBOARD_ID = '302050872383242240';
const BUMP_STATE = path.join(ROOT, 'bump_state.json');
const BUMP_EVERY_MS = 2 * 60 * 60 * 1000;

const NUKE_MSG = {
  flags: 1 << 15,
  components: [
    {
      type: 17,
      accent_color: 8912896,
      components: [
        { type: 10, content: 'As portas do inferno foram abertas.' },
      ],
    },
  ],
};

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
          { type: 10, content: '**.menu** — este menu\n**.nuke on / .nuke off** — limpa o ・confessionario e o chat das calls na hora e a cada 12h (inferno e bump ficam em paz) / desliga\n**.cl [qtd]** — apaga mensagens de uma vez (sem valor = 10)\n**.fig** — fabrica de figurinhas (foto/video/gif viram sticker quadrado)\n**.bump** — painel de quem o lembrete de 2h marca\n**.att [arquivo]** — atualiza o bot e religa com o codigo novo' },
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
function bumpMsg(target) {
  return {
    flags: 1 << 15,
    components: [
      {
        type: 17,
        accent_color: 8912896,
        components: [
          { type: 10, content: `${mentionsOf(target)} hora do bump — o disboard tá liberado de novo.` },
        ],
      },
    ],
  };
}
function bumpAvisoMsg(target) {
  return {
    flags: 1 << 15,
    components: [
      {
        type: 17,
        accent_color: 8912896,
        components: [
          { type: 10, content: `Bump registrado. ${mentionsOf(target)} — vou marcar aqui daqui a 2 horas pra bumpar de novo.` },
        ],
      },
    ],
  };
}

// ---------- painel do bump: multi-selecao de quem o lembrete marca ----------
const bumpPanelMsg = new Map(); // guildId -> id da mensagem do painel

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
  varrerLinks().catch(err); // apaga link que entrou durante o reinicio
  // slash commands removidos a pedido do dono (nao registrar mais)
  // varre arquivos de saida que ja existam
  scanOutbox();
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
const GH_STATE_FILES = ['nuke_state.json', 'bump_state.json', 'mute_state.json'];
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
      await m.channel.send(bumpAvisoMsg(target)).catch((e) => err(e));
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
        const st2 = { on: true, nextAt: Date.now() + NUKE_EVERY_MS };
        fs.writeFileSync(NUKE_STATE, JSON.stringify(st2, null, 2));
        const r = await limparServer(m.guild).catch((e) => { err(e); return { msgs: 0 }; });
        await m.channel.send({ content: 'nuke ligado: limpei ' + r.msgs + ' mensagens (・confessionario + chat das calls; inferno e bump nao mexo). repete a cada 12h. .nuke on de novo reinicia a contagem.' }).catch(() => {});
        log('NUKE_ON_GLOBAL', { guild: m.guild.id, msgs: r.msgs, nextAt: st2.nextAt });
      } else {
        fs.writeFileSync(NUKE_STATE, JSON.stringify({ on: false }, null, 2));
        await m.channel.send({ content: 'nuke desligado.' }).catch(() => {});
        log('NUKE_OFF_GLOBAL', { guild: m.guild.id });
      }
      return;
    }
    if (c === '.menu') {
      await m.channel.send(menuMsg()).catch((e) => err(e));
      log('MENU', { channel: m.channelId });
      return;
    }
    if (c === '.menu') {
      await m.channel.send(menuMsg()).catch((e) => err(e));
      log('MENU', { channel: m.channelId });
      return;
    }
    // .cl [qtd] — apaga mensagens de uma vez (dono). sem valor = 10.
    if (c === '.cl' || c.startsWith('.cl ')) {
      const n = parseInt(c.split(/\s+/)[1], 10);
      const total = isNaN(n) ? 10 : Math.min(Math.max(n, 1), 500);
      try {
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
        await m.channel.send('o .att só funciona no bot hospedado no GitHub.').catch(() => {});
        return;
      }
      if (!att) {
        await m.channel.send('manda o arquivo junto com o .att (ex: bot.js)').catch(() => {});
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
        await m.channel.send(`**${name}** atualizado no repositório. religando com o código novo em 3s...`).catch(() => {});
        log('ATT', { name, size: buf.length });
        setTimeout(() => process.exit(0), 3000); // o loop do workflow liga de novo com o codigo novo
      } catch (e) {
        await m.channel.send('.att falhou: ' + e.message).catch(() => {});
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
        await m.channel.send(`adicionado. agora eu marco: ${mentionsOf(st.target)}`).catch(() => {});
        log('BUMP_ALVO', { target: st.target });
        return;
      }
      const msg = await m.channel.send(bumpPanel(st)).catch((e) => { err(e); return null; });
      if (msg) bumpPanelMsg.set(m.guild.id, msg.id);
      return;
    }
    // .fig — abre o painel da fabrica de figurinhas (dono)
    if (c === '.fig') {
      if (figState.has(m.guild.id)) {
        await m.channel.send('ja tem coleta ativa aqui. termina no botao CONCLUIR.').catch(() => {});
        return;
      }
      const msg = await m.channel.send(figPanel(null)).catch((e) => { err(e); return null; });
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
        await m.channel.messages.fetch(st.msgId).then((p) => p.edit(figPanel(st))).catch(() => {});
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
    const tmp = await m.channel.send(`${m.author} ${aviso}`).catch(() => null);
    if (tmp) setTimeout(() => tmp.delete().catch(() => {}), 15000);
  });
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
    if (st) await i.channel.messages.fetch(st.msgId).then((p) => p.edit(figPanel(st, fim))).catch(() => {});
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
    await i.message.edit(bumpPanel(st)).catch(() => {});
    log('BUMP_PAINEL', { custom: i.customId, ids, target: st.target });
    return;
  }
  if (i.isButton() && i.customId === 'bump_sel_done') {
    if (i.user.id !== OWNER_ID) { await i.reply({ content: 'só o dono usa isso.', flags: 64 }); return; }
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
    await i.message.edit(bumpPanel(st)).catch(() => {});
    log('BUMP_PAINEL', { custom: i.customId, target: st.target });
    return;
  }
  if (i.isChatInputCommand()) log('SLASH_IGNORADO', { user: i.user.id, cmd: i.commandName });
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
function scanOutbox() {
  let files = [];
  try {
    files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    return err(e);
  }
  for (const f of files) {
    const p = path.join(OUT, f);
    // claim atomico: renomeia antes de processar pra ninguem pegar de novo
    const proc = p + '.processing';
    try {
      fs.renameSync(p, proc);
    } catch {
      continue;
    }
    let job;
    try {
      job = JSON.parse(fs.readFileSync(proc, 'utf8'));
    } catch (e) {
      fs.renameSync(proc, p + '.bad');
      err(new Error(`outbox parse ${f}: ${e.message}`));
      continue;
    }
    handleJob(job)
      .then((res) => {
        append(SENT, { file: f, ok: true, res });
        log('SENT', { file: f, res });
        fs.rmSync(proc, { force: true });
      })
      .catch((e) => {
        append(SENT, { file: f, ok: false, error: String(e) });
        log('SEND_FAIL', { file: f, error: String(e) });
        fs.renameSync(proc, p + '.failed');
      });
  }
}

async function handleJob(job) {
  switch (job.action) {
    case 'send': {
      const ch = await client.channels.fetch(job.channelId);
      if (!ch) throw new Error('canal nao encontrado');
      const msg = await ch.send(job.payload);
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
async function doNuke(ch) {
  const clone = await ch.clone({ reason: 'nuke' });
  await ch.delete('nuke').catch(() => {});
  const msg = await clone.send(NUKE_MSG).catch((e) => { err(e); return null; });
  if (msg) setTimeout(() => msg.delete().catch(() => {}), 5000);
  return clone;
}

// limpa so o ・confessionario e o chat das calls (inferno e bump ficam em paz)
async function limparServer(guild) {
  let msgs = 0;
  for (const ch of guild.channels.cache.values()) {
    try {
      // 2 = canal de voz (chat da call); texto so se for o confessionario
      const ehConf = (ch.type === 0 || ch.type === 5) && /confessionar/i.test(ch.name || '');
      if (ch.type === 2 || ehConf) {
        while (true) {
          const del = await ch.bulkDelete(100, true).catch(() => null);
          if (!del || del.size === 0) break;
          msgs += del.size;
          if (del.size < 100) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    } catch (e) { err(e); }
  }
  return { msgs };
}

// confere a cada minuto se chegou a hora do nuke global (12h)
async function nukeTick() {
  try {
    const st = readJsonSafe(NUKE_STATE, {});
    if (!st || st.on !== true || !st.nextAt) return;
    if (Date.now() >= st.nextAt) {
      const guild = client.guilds.cache.find((g) => g.ownerId === OWNER_ID) || client.guilds.cache.first();
      if (!guild) return;
      const r = await limparServer(guild);
      st.nextAt = Date.now() + NUKE_EVERY_MS;
      fs.writeFileSync(NUKE_STATE, JSON.stringify(st, null, 2));
      log('NUKE_AUTO_GLOBAL', { guild: guild.id, msgs: r.msgs, nextAt: st.nextAt });
    }
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
        await ch.send(bumpMsg(st.target)).catch((e) => err(e));
        st[cid] = { ...info, nextAt: now + BUMP_EVERY_MS };
        fs.writeFileSync(BUMP_STATE, JSON.stringify(st, null, 2));
        log('BUMP_LEMBRETE', { channel: cid, nextAt: st[cid].nextAt });
      }
    }
  } catch (e) { err(e); }
}

// overflow (call cheia -> cria outra) removido a pedido do dono

setInterval(scanOutbox, 1000);
setInterval(nukeTick, 60 * 1000);
setInterval(bumpTick, 60 * 1000);

client.login(TOKEN).catch((e) => {
  err(e);
  process.exit(1);
});
