#!/usr/bin/env python3
# checker 4 caracteres — varredura SISTEMATICA do espaco completo, dividida em 18 workers,
# progresso salvo no repo (reinicia de onde parou), proxies opcionais via proxies.txt
import base64, json, os, random, subprocess, time, datetime

TOK = os.environ.get('DISCORD_TOKEN', '')
GTOK = os.environ.get('GITHUB_TOKEN', '')
REPO = os.environ.get('GITHUB_REPOSITORY', 'wnarutinho2-boop/satan-bot')
OWNER = '1521612392105250836'
CANAL_AVISO = '1548910505500868709'  # adm
WORKER = int(os.environ.get('WORKER', '1'))
WORKERS = 18
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

A36 = 'abcdefghijklmnopqrstuvwxyz0123456789'           # 36
TOTAL4 = 36 ** 4                                          # 1.679.616 (4l+4c+4n juntos)
L = 'abcdefghijklmnopqrstuvwxyz'
D = '0123456789'
S = '._'
TOTAL_SEMI = (36 ** 3) * 3 * 2                            # 3 chars + sep em 3 posicoes

# ---------- tokens de conta (tokens.txt) e proxies opcionais ----------
TOKENS = []
try:
    out = subprocess.run(['curl', '-sS', '--max-time', 15, '-H', 'Authorization: token ' + GTOK,
                          f'https://api.github.com/repos/{REPO}/contents/tokens.txt'],
                         capture_output=True, text=True).stdout
    j = json.loads(out)
    TOKENS = [l.strip() for l in base64.b64decode(j['content']).decode().splitlines() if l.strip()]
except Exception:
    pass
_tk = [0]
def token_conta():
    if not TOKENS:
        return None
    _tk[0] += 1
    return TOKENS[_tk[0] % len(TOKENS)]

PROXIES = []
try:
    out = subprocess.run(['curl', '-sS', '--max-time', 15, '-H', 'Authorization: token ' + GTOK,
                          f'https://api.github.com/repos/{REPO}/contents/proxies.txt'],
                         capture_output=True, text=True).stdout
    j = json.loads(out)
    PROXIES = [l.strip() for l in base64.b64decode(j['content']).decode().splitlines() if l.strip()]
except Exception:
    pass

def curl(args, data=None, proxy=None):
    cmd = ['curl', '-sS', '--max-time', '45']
    if proxy:
        cmd += ['-x', 'http://' + proxy]
    cmd += args
    if data is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(data)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return r.stdout
    except Exception:
        return ''

_i = [0]
def prox():
    if not PROXIES:
        return None
    _i[0] += 1
    return PROXIES[_i[0] % len(PROXIES)]

# ordem EMBARALHADA (passo coprimo): nomes saem misturados tipo 8j2a/sw29/xh7s,
# ainda cobre 100% do espaco sem repeticao entre workers
M4 = TOTAL4 // WORKERS
S4 = 53113  # impar, nao divisivel por 3 -> coprimo com 93312

def nome_idx(idx):
    c = []
    for _ in range(4):
        c.append(A36[idx % 36])
        idx //= 36
    return ''.join(reversed(c))

def proximo4c(me):
    # espaco 4c completo, embaralhado, sem vies
    for _ in range(300):
        idx = (WORKER - 1) + WORKERS * ((me['k4'] * S4) % M4)
        me['k4'] += 1
        w = nome_idx(idx)
        if any(ch in D for ch in w) and any(ch in L for ch in w):
            return w
    return None

EPS = ['https://discord.com/api/v9/unique-username/username-attempt-unauthed',
       'https://discord.com/api/v10/unique-username/username-attempt-unauthed']
EP = [0]

def checa(w):
    tc = token_conta()
    auth = ['Authorization: ' + tc] if tc else []
    out = curl(['-X', 'POST', '-w', '|%{http_code}', EPS[EP[0]],
                '-H', 'User-Agent: ' + UA] + auth, {'username': w}, proxy=prox())
    code = out.split('|')[-1] if '|' in out else ''
    body = out.rsplit('|', 1)[0] if '|' in out else out
    if code in ('404', '403', '000') and EP[0] == 0:
        EP[0] = 1
        return checa(w)
    try:
        j = json.loads(body)
    except Exception:
        return ('erro', None)
    if 'retry_after' in body:
        return ('rl', j.get('retry_after', 60))
    if j.get('taken') is False:
        return ('livre', None)
    return ('tomado', None)

def repo_get(f):
    out = curl(['-H', 'Authorization: token ' + GTOK, f'https://api.github.com/repos/{REPO}/contents/{f}'])
    try:
        j = json.loads(out)
        return json.loads(base64.b64decode(j['content'])), j.get('sha')
    except Exception:
        return None, None

def repo_put(f, body, sha, msg):
    d = {'message': msg, 'content': base64.b64encode(json.dumps(body).encode()).decode()}
    if sha:
        d['sha'] = sha
    out = curl(['-X', 'PUT', '-H', 'Authorization: token ' + GTOK, f'https://api.github.com/repos/{REPO}/contents/{f}'], d)
    print('[save]', f, out[:100], flush=True)
    return out

def estado_on():
    body, _ = repo_get('check_state.json')
    return (body or {}).get('on', True)

def avisa(w):
    if not TOK:
        return
    # webhook com nome+foto do Satan (igual ao resto do server)
    img = subprocess.run(['curl', '-sS', '--max-time', 15, '-H', 'User-Agent: ' + UA,
                          'https://cdn.discordapp.com/avatars/1539465305326227477/8063a11739c958a65813bb8fbd98111b.png?size=256'],
                         capture_output=True).stdout
    av = 'data:image/png;base64,' + base64.b64encode(img).decode() if img else None
    body = {'name': 'Satan'}
    if av:
        body['avatar'] = av
    out = curl(['-X', 'POST', f'https://discord.com/api/v10/channels/{CANAL_AVISO}/webhooks',
                '-H', 'Authorization: Bot ' + TOK, '-H', 'User-Agent: ' + UA], body)
    try:
        wh = json.loads(out)
        curl(['-X', 'POST', wh['url'], '-H', 'User-Agent: ' + UA],
             {'content': f'<@{OWNER}>', 'embeds': [{'title': '4 LIVRE: ' + w,
               'description': 'corre pra pegar antes de outro sniper.', 'color': 8912896}]})
        curl(['-X', 'DELETE', f"https://discord.com/api/v10/webhooks/{wh['id']}",
              '-H', 'Authorization: Bot ' + TOK, '-H', 'User-Agent: ' + UA])
    except Exception:
        curl(['-X', 'POST', f'https://discord.com/api/v10/channels/{CANAL_AVISO}/messages',
              '-H', 'Authorization: Bot ' + TOK, '-H', 'User-Agent: ' + UA],
             {'content': f'<@{OWNER}>', 'embeds': [{'title': '4 LIVRE: ' + w,
               'description': 'corre pra pegar antes de outro sniper.', 'color': 8912896}]})
    dm = curl(['-X', 'POST', 'https://discord.com/api/v10/users/@me/channels',
               '-H', 'Authorization: Bot ' + TOK, '-H', 'User-Agent: ' + UA], {'recipient_id': OWNER})
    try:
        cid = json.loads(dm)['id']
        curl(['-X', 'POST', f'https://discord.com/api/v10/channels/{cid}/messages',
              '-H', 'Authorization: Bot ' + TOK, '-H', 'User-Agent: ' + UA],
             {'content': f'4 LIVRE: **{w}** — pega agora!'})
    except Exception:
        pass

def salva_hit(w, checks):
    body, sha = repo_get('hits4l.json')
    body = body or {'hits': []}
    body['hits'].append({'nome': w, 'quando': datetime.datetime.utcnow().isoformat() + 'Z', 'worker': WORKER})
    repo_put('hits4l.json', body, sha, 'hit 4: ' + w)

def main():
    print(f'[worker {WORKER}/{WORKERS}] varredura sistematica | proxies: {len(PROXIES)}', flush=True)
    prog, psha = repo_get('sweep_state.json')
    prog = prog or {}
    me = prog.get(str(WORKER), {'k4': 0, 'ksemi': 0, 'st': '', 'rl': 0, 'er': 0})
    inicio = time.time()
    checks = 0
    ultimo_save = time.time() - 300  # primeiro save ja na primeira volta
    ultimo_estado = 0.0
    ligado = True
    n = 0
    delay = 0.7
    limpos = 0
    while time.time() - inicio < 5.7 * 3600:
        try:
            if time.time() - ultimo_estado > 300:
                ligado = estado_on()
                ultimo_estado = time.time()
            if not ligado:
                time.sleep(30)
                continue
            n += 1
            if time.time() - ultimo_save > 240:
                prog[str(WORKER)] = me
                repo_put('sweep_state.json', prog, psha, f'sweep w{WORKER}')
                _, psha = repo_get('sweep_state.json')
                ultimo_save = time.time()
            w = proximo4c(me)
            if w is None:  # fatia acabou: 4c aleatorio eterno
                while True:
                    w = ''.join(random.choice(A36) for _ in range(4))
                    if any(ch in D for ch in w) and any(ch in L for ch in w):
                        break
            st, ra = checa(w)
            checks += 1
            me['st'] = st
            if st == 'rl': me['rl'] = me.get('rl', 0) + 1
            if st == 'erro': me['er'] = me.get('er', 0) + 1
            if st == 'livre':
                print(f'[HIT] {w}', flush=True)
                avisa(w)
                salva_hit(w, checks)
            elif st == 'rl':
                delay = min(delay * 1.5, 30)
                limpos = 0
                print(f'[rl] delay agora {delay:.1f}s', flush=True)
                time.sleep(delay)
                continue
            else:
                limpos += 1
                if limpos >= 25:
                    delay = max(delay * 0.9, 0.35)
                    limpos = 0
            time.sleep(delay)
        except Exception as e:
            print('[err]', type(e).__name__, flush=True)
            time.sleep(2)
    prog[str(WORKER)] = me
    repo_put('sweep_state.json', prog, psha, f'sweep w{WORKER} fim')
    print(f'[worker {WORKER}] fim. checks={checks} k4={me["k4"]}', flush=True)

main()
