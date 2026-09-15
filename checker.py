#!/usr/bin/env python3
# checker 4l/4c/semi — roda em GitHub Actions (1 IP por worker), avisa dono ao achar livre
import json, os, random, subprocess, sys, time, datetime

TOK = os.environ.get('DISCORD_TOKEN', '')
GTOK = os.environ.get('GITHUB_TOKEN', '')
REPO = os.environ.get('GITHUB_REPOSITORY', 'wnarutinho2-boop/satan-bot')
OWNER = '1521612392105250836'
CANAL_AVISO = '1548910505500868709'  # adm
WORKER = int(os.environ.get('WORKER', '1'))
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

L = 'abcdefghijklmnopqrstuvwxyz'
D = '0123456789'
S = '._'
MINHAS_LETRAS = {1: 'abcdefg', 2: 'hijklmn', 3: 'opqrst', 4: 'uvwxyz'}.get(WORKER, L)

def curl(args, data=None):
    cmd = ['curl', '-sS'] + args
    if data is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(data)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return r.stdout

def checa(w):
    out = curl(['-X', 'POST', 'https://discord.com/api/v9/unique-username/username-attempt-unauthed',
                '-H', 'User-Agent: ' + UA], {'username': w})
    try:
        j = json.loads(out)
    except Exception:
        return ('erro', None)
    if 'retry_after' in out:
        return ('rl', j.get('retry_after', 60))
    if j.get('taken') is False:
        return ('livre', None)
    return ('tomado', None)

def gen():
    r = random.random()
    if r < 0.45:  # 4c (o que os checkers tao achando: numero+letra)
        return random.choice([
            random.choice(D) + random.choice(L) + random.choice(D) + random.choice(D),
            random.choice(D) + random.choice(L) + random.choice(D) + random.choice(L),
            random.choice(L) + random.choice(D) + random.choice(D) + random.choice(L),
            random.choice(D) + random.choice(D) + random.choice(L) + random.choice(D),
        ])
    if r < 0.80:  # 4l varrendo o espaco do worker
        return random.choice(MINHAS_LETRAS) + random.choice(L) + random.choice(L) + random.choice(L)
    a = random.choice(L) + random.choice(L) + random.choice(L)
    p = random.randint(1, 2)
    return a[:p] + random.choice(S) + a[p:]  # semi 4

def estado_on():
    out = curl(['-H', 'Authorization: token ' + GTOK,
                f'https://api.github.com/repos/{REPO}/contents/check_state.json'])
    try:
        j = json.loads(out)
        body = json.loads(__import__('base64').b64decode(j['content']))
        return body.get('on', True)
    except Exception:
        return True

def avisa(w):
    if not TOK:
        return
    # canal: @dono + embed numa msg so
    curl(['-X', 'POST', f'https://discord.com/api/v10/channels/{CANAL_AVISO}/messages',
          '-H', 'Authorization: Bot ' + TOK, '-H', 'User-Agent: ' + UA],
         {'content': f'<@{OWNER}>', 'embeds': [{'title': '4L LIVRE: ' + w,
           'description': 'corre pra pegar antes de outro sniper.', 'color': 8912896}]})
    # DM
    dm = curl(['-X', 'POST', 'https://discord.com/api/v10/users/@me/channels',
               '-H', 'Authorization: Bot ' + TOK, '-H', 'User-Agent: ' + UA], {'recipient_id': OWNER})
    try:
        cid = json.loads(dm)['id']
        curl(['-X', 'POST', f'https://discord.com/api/v10/channels/{cid}/messages',
              '-H', 'Authorization: Bot ' + TOK, '-H', 'User-Agent: ' + UA],
             {'content': f'4L LIVRE: **{w}** — pega agora!'})
    except Exception:
        pass

def salva_hit(w, total):
    if not GTOK:
        return
    out = curl(['-H', 'Authorization: token ' + GTOK, f'https://api.github.com/repos/{REPO}/contents/hits4l.json'])
    sha, body = None, {'hits': []}
    try:
        j = json.loads(out)
        sha = j.get('sha')
        body = json.loads(__import__('base64').b64decode(j['content']))
    except Exception:
        pass
    body['hits'].append({'nome': w, 'quando': datetime.datetime.utcnow().isoformat() + 'Z', 'worker': WORKER})
    import base64
    curl(['-X', 'PUT', '-H', 'Authorization: token ' + GTOK, f'https://api.github.com/repos/{REPO}/contents/hits4l.json'],
         {'message': 'hit 4l: ' + w, 'content': base64.b64encode(json.dumps(body, indent=2).encode()).decode(),
          **({'sha': sha} if sha else {})})

def main():
    print(f'[worker {WORKER}] letras 4l: {MINHAS_LETRAS}', flush=True)
    inicio = time.time()
    checks = 0
    visto = set()
    ultimo_estado = 0.0
    ligado = True
    while time.time() - inicio < 5.7 * 3600:  # para antes do limite de 6h do job
        if time.time() - ultimo_estado > 300:
            ligado = estado_on()
            ultimo_estado = time.time()
        if not ligado:
            time.sleep(30)
            continue
        w = gen()
        if w in visto:
            continue
        visto.add(w)
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
        time.sleep(0.7)
    print(f'[worker {WORKER}] fim. checks={checks}', flush=True)

main()
