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

# ---------- proxies opcionais ----------
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
    cmd = ['curl', '-sS', '--max-time', 10]
    if proxy:
        cmd += ['-x', 'http://' + proxy]
    cmd += args
    if data is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(data)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return r.stdout
    except Exception:
        return ''

_i = [0]
def prox():
    if not PROXIES:
        return None
    _i[0] += 1
    return PROXIES[_i[0] % len(PROXIES)]

def idx4_nome(k):
    idx = (WORKER - 1) + WORKERS * k
    if idx >= TOTAL4:
        return None
    c = []
    for _ in range(4):
        c.append(A36[idx % 36])
        idx //= 36
    return ''.join(reversed(c))

def idxsemi_nome(k):
    idx = (WORKER - 1) + WORKERS * k
    if idx >= TOTAL_SEMI:
        return None
    base = idx % (36 ** 3)
    resto = idx // (36 ** 3)         # 0..5 = pos(0..2)*2 + sep
    pos, si = resto // 2, resto % 2
    c = [A36[base // 1296], A36[(base // 36) % 36], A36[base % 36]]
    c.insert(pos, S[si])
    return ''.join(c)

def checa(w):
    out = curl(['-X', 'POST', 'https://discord.com/api/v9/unique-username/username-attempt-unauthed',
                '-H', 'User-Agent: ' + UA], {'username': w}, proxy=prox())
    try:
        j = json.loads(out)
    except Exception:
        return ('erro', None)
    if 'retry_after' in out:
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
    curl(['-X', 'PUT', '-H', 'Authorization: token ' + GTOK, f'https://api.github.com/repos/{REPO}/contents/{f}'], d)

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
    me = prog.get(str(WORKER), {'k4': 0, 'ksemi': 0})
    inicio = time.time()
    checks = 0
    ultimo_save = time.time()
    ultimo_estado = 0.0
    ligado = True
    n = 0
    while time.time() - inicio < 5.7 * 3600:
        try:
            if time.time() - ultimo_estado > 300:
                ligado = estado_on()
                ultimo_estado = time.time()
            if not ligado:
                time.sleep(30)
                continue
            n += 1
            if n % 5 == 0 and me['ksemi'] * WORKERS + WORKER <= TOTAL_SEMI:
                w = idxsemi_nome(me['ksemi'])
                if w is not None:
                    me['ksemi'] += 1
            else:
                w = idx4_nome(me['k4'])
                if w is None:  # espaco 4 acabou: vira aleatorio eterno
                    w = ''.join(random.choice(A36) for _ in range(4))
                else:
                    me['k4'] += 1
            st, ra = checa(w)
            checks += 1
            if st == 'livre':
                print(f'[HIT] {w}', flush=True)
                avisa(w)
                salva_hit(w, checks)
            elif st == 'rl':
                espera = min(float(ra or 60), 900)
                print(f'[rl] espera {espera:.0f}s', flush=True)
                time.sleep(espera)
                continue
            if time.time() - ultimo_save > 240:
                prog[str(WORKER)] = me
                repo_put('sweep_state.json', prog, psha, f'sweep w{WORKER}')
                _, psha = repo_get('sweep_state.json')
                ultimo_save = time.time()
            time.sleep(0.7)
        except Exception as e:
            print('[err]', type(e).__name__, flush=True)
            time.sleep(2)
    prog[str(WORKER)] = me
    repo_put('sweep_state.json', prog, psha, f'sweep w{WORKER} fim')
    print(f'[worker {WORKER}] fim. checks={checks} k4={me["k4"]}', flush=True)

main()
