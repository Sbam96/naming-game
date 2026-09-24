"""Browser tests for the Naming Game. Needs the server running with NG_TEST_HOOKS=1.
Usage: python3 test/e2e.py http://localhost:3456  -> writes test/e2e-results.json
"""
import asyncio, json, os, re, subprocess, sys, time, traceback
from playwright.async_api import async_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3456'
HERE = os.path.dirname(os.path.abspath(__file__))
AXE = os.path.join(HERE, '..', 'node_modules', 'axe-core', 'axe.min.js')
SHOTS = os.environ.get('SHOTS', '/home/claude/shots')
results = {}
expect.set_options(timeout=8000)


def record(req, ok, detail=''):
    prev = results.get(req)
    if prev and not prev['pass']:
        return  # keep the first failure
    results[req] = {'pass': ok, 'detail': detail}


async def player(browser, width=1280, height=900, share_mock=False):
    ctx = await browser.new_context(viewport={'width': width, 'height': height}, permissions=['clipboard-read', 'clipboard-write'])
    if share_mock:
        await ctx.add_init_script("window.__shared=null; navigator.share = async (d) => { window.__shared = d; };")
    page = await ctx.new_page()
    page.errors = []
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    return page


async def create_room(page, name='Ste'):
    await page.goto(BASE + '/')
    await page.fill('#nameInput', name)
    await page.click('text=Create room')
    await expect(page.locator('.code-big')).to_be_visible()
    return (await page.locator('.code-big').inner_text()).strip()


async def join_link(page, code, name):
    await page.goto(f'{BASE}/r/{code}')
    await page.fill('#nameInput', name)
    await page.click('button:has-text("Join room")')
    await expect(page.locator('.code-big')).to_be_visible()


async def hook(page, action, **kw):
    return await page.evaluate("""([action, kw]) => new Promise(r => window.__ngSocket.emit('test:hook', {action, ...kw}, r))""", [action, kw])


async def phase(page):
    return await page.evaluate('window.__ng.view && window.__ng.view.room.phase')


async def wait_phase(page, want, timeout=10):
    wants = want if isinstance(want, (tuple, list)) else (want,)
    end = time.time() + timeout
    while time.time() < end:
        if await phase(page) in wants:
            await page.wait_for_timeout(80)
            return
        await page.wait_for_timeout(50)
    raise AssertionError(f'expected phase {want}, got {await phase(page)}')


async def picker_of(pages):
    for p in pages:
        if await p.evaluate('window.__ng.view.room.pickerId === window.__ng.view.you.id'):
            return p
    raise AssertionError('no picker')


async def fill_answers(page, answers):
    for cat, text in answers.items():
        await page.fill(f'#ans-{cat}', '')
        await page.type(f'#ans-{cat}', text, delay=5)


async def vote_all(page, reject=()):
    """Thumbs up everything except answers whose text is in `reject`, then submit."""
    rows = page.locator('.review-row .thumbs')
    for i in range(await rows.count()):
        row = page.locator('.review-row').filter(has=page.locator('.thumbs')).nth(i)
        ans = (await row.locator('.ans').inner_text()).strip()
        await row.locator('.thumb.down' if ans in reject else '.thumb.up').click()
    await page.click('button:has-text("Submit votes")')


async def play_round(pages, letter, answers, reject=(), skip_to='picking'):
    for p in pages:
        await wait_phase(p, 'picking')
    pk = await picker_of(pages)
    await pk.click(f'.alphabet button[data-letter="{letter}"]')
    for p in pages:
        await wait_phase(p, 'answering')
    for i, p in enumerate(pages):
        await fill_answers(p, answers[i])
        await p.click('button:has-text("I\'m done")')
    for p in pages:
        await wait_phase(p, 'voting')
    for p in pages:
        await vote_all(p, reject)
    await wait_phase(pages[0], ('challenge', 'results'))
    if skip_to == 'challenge':
        return
    if await phase(pages[0]) == 'challenge':
        await hook(pages[0], 'deadlineIn', ms=0)
    await wait_phase(pages[0], 'results')
    if skip_to == 'results':
        return
    await hook(pages[0], 'deadlineIn', ms=0)


def answers_for(letter, extra=''):
    return {'name': f'{letter}ivian{extra}', 'food': f'{letter}anilla', 'animal': f'{letter}ulture', 'place': f'{letter}enice', 'thing': f'{letter}an'}


async def no_hscroll(page, width=375):
    sw = await page.evaluate('document.documentElement.scrollWidth')
    return sw <= width, sw


async def axe(page):
    await page.add_script_tag(path=AXE)
    res = await page.evaluate("axe.run(document, {resultTypes: ['violations']})")
    return [f"{v['id']} ({v['impact']}): {len(v['nodes'])}" for v in res['violations'] if v['impact'] in ('serious', 'critical')]


async def run(name, fn, *args):
    try:
        await fn(*args)
    except Exception as e:  # noqa
        print(f'!! {name} crashed: {e}')
        traceback.print_exc()
        results.setdefault(f'CRASH:{name}', {'pass': False, 'detail': str(e)[:300]})


# ---------------- scenarios ----------------
async def lobby_and_sharing(browser):
    host = await player(browser, share_mock=True)
    code = await create_room(host, 'Ste')
    record('GR-01', await host.locator('h1').inner_text() != '' and len(code) == 5, f'room {code}')
    link = f'{BASE}/r/{code}'

    guest = await player(browser)
    await guest.goto(link)
    prompt = await guest.locator('h1').inner_text()
    await guest.fill('#nameInput', 'Ade')
    await guest.click('button:has-text("Join room")')
    await expect(guest.locator('.code-big')).to_be_visible()
    await expect(host.locator('.players')).to_contain_text('Ade')
    record('SL-02', prompt.startswith('Join'), f'prompt "{prompt}", guest in lobby')

    # GR-02 host-only controls in the lobby
    host_start = await host.locator('#startBtn').count()
    host_kick = await host.locator('button:has-text("Remove")').count()
    guest_start = await guest.locator('#startBtn').count()
    guest_kick = await guest.locator('button:has-text("Remove")').count()
    record('GR-02', host_start == 1 and host_kick == 1 and guest_start == 0 and guest_kick == 0,
           f'host start/kick {host_start}/{host_kick}, guest {guest_start}/{guest_kick}')

    # SL-03 copy + share
    await host.click('button:has-text("Copy link")')
    clip = await host.evaluate('navigator.clipboard.readText()')
    await host.click('button:has-text("Share")')
    shared = await host.evaluate('window.__shared && window.__shared.url')
    record('SL-03', clip == link and shared == link, f'clipboard={clip} share={shared}')

    # SL-04 QR code decodes to the room link
    await host.click('button:has-text("Show QR code")')
    img = host.locator('#qrImg')
    await expect(img).to_be_visible()
    await host.wait_for_function("document.querySelector('#qrImg').naturalWidth > 0")
    png = await (await host.request.get(f'{BASE}/qr/{code}.png')).body()
    path = '/tmp/qr.png'
    open(path, 'wb').write(png)
    decoded = subprocess.run(['node', os.path.join(HERE, 'decode-qr.js'), path], capture_output=True, text=True).stdout
    record('SL-04', decoded == link, f'decoded {decoded}')
    await host.keyboard.press('Escape')

    # GR-03 visibility setting controls public listing
    await host.check('input[name=visibility][value=public]')
    await host.click('button:has-text("Save settings")')
    await host.wait_for_timeout(200)
    listed_public = any(r['code'] == code for r in await (await host.request.get(BASE + '/api/rooms')).json())
    await host.check('input[name=visibility][value=private]')
    await host.click('button:has-text("Save settings")')
    await host.wait_for_timeout(200)
    listed_private = any(r['code'] == code for r in await (await host.request.get(BASE + '/api/rooms')).json())
    record('GR-03', listed_public and not listed_private, f'public listed={listed_public}, private listed={listed_private}')

    # GR-04 UI: out-of-range answer time is rejected with a message
    await host.fill('#set-answerTime', '75')
    await host.click('button:has-text("Save settings")')
    await expect(host.locator('#toast')).to_contain_text('between 20 and 60')
    defaults = [await host.input_value(f'#set-{k}') for k in ('pickTime', 'reviewFallback', 'challengeTime')]
    record('GR-04', defaults == ['20', '30', '30'], f'defaults pick/review/challenge {defaults}; 75s rejected')

    # GR-06 one-click start with defaults, GR-05 locked in game, GR-02 end game control
    await host.fill('#set-answerTime', '50')
    await host.click('#startBtn')
    await wait_phase(host, 'picking')
    record('GR-06', True, 'started with defaults in one click')
    await host.click('summary:has-text("Game settings")')
    disabled = await host.locator('#settingsForm input').evaluate_all('els => els.every(e => e.disabled)')
    record('GR-05', disabled, 'all in-game settings inputs disabled for host')
    host_end = await host.locator('button:has-text("End game")').count()
    guest_end = await guest.locator('button:has-text("End game")').count()
    record('GR-02', host_end == 1 and guest_end == 0, f'end game host={host_end} guest={guest_end}')

    # SL-06 in-progress link
    late = await player(browser)
    await late.goto(link)
    await expect(late.locator('h1')).to_have_text('This game has already started')
    in_prog_ok = await late.locator('button:has-text("Create room")').count() == 1

    # SL-06 closed link
    solo = await player(browser)
    c2 = await create_room(solo, 'Solo')
    await solo.click('text=Leave room')
    await late.goto(f'{BASE}/r/{c2}')
    await expect(late.locator('h1')).to_have_text('This room has closed')
    closed_ok = await late.locator('button:has-text("Create room")').count() == 1
    record('SL-06', in_prog_ok and closed_ok, 'in-progress and closed links explain why, with Create room')
    record('SL-05', closed_ok, 'old link stops working after the room closes')

    # JG-06 rejoin by reloading (token kept in the browser)
    await guest.reload()
    await wait_phase(guest, 'picking')
    record('JG-06', await guest.evaluate("window.__ng.view.you.name") == 'Ade', 'reload rejoined the same seat')
    for p in (host, guest, late, solo):
        await p.context.close()


async def full_game(browser):
    host = await player(browser)
    guest = await player(browser)
    code = await create_room(host, 'Ste')
    await join_link(guest, code, 'Ade')
    await host.click('#startBtn')
    pages = [host, guest]
    await wait_phase(host, 'picking')
    pk = await picker_of(pages)
    await pk.click('.alphabet button[data-letter="V"]')
    for p in pages:
        await wait_phase(p, 'answering')
    tiles = [await p.locator('.tile.big').inner_text() for p in pages]
    record('GP-05', tiles == ['V', 'V'], f'both see {tiles}')

    # PR-05 4th word blocked with hint; PR-06 wrong-letter warning
    await host.type('#ans-food', 'Very Vanilla Ice Cream', delay=10)
    val = await host.input_value('#ans-food')
    hint = await host.locator('#hint-food').inner_text()
    record('PR-05', val.strip() == 'Very Vanilla Ice' and '3 words' in hint, f'value "{val}", hint "{hint}"')
    await host.fill('#ans-food', '')
    await host.type('#ans-food', 'Banana', delay=5)
    hint = await host.locator('#hint-food').inner_text()
    record('PR-06', 'start with V' in hint, f'hint "{hint}"')

    await fill_answers(host, {'name': 'Vivian', 'food': 'Snake', 'animal': 'Vulture', 'place': 'Venice', 'thing': 'Van'})
    await fill_answers(guest, answers_for('V'))
    await host.click("button:has-text(\"I'm done\")")
    await guest.click("button:has-text(\"I'm done\")")
    for p in pages:
        await wait_phase(p, 'voting')
    await vote_all(host)
    await vote_all(guest, reject=('Snake',))
    await wait_phase(host, 'challenge')

    # RV-08 only own rejected answers show Challenge
    host_btns = await host.locator('button:has-text("Challenge")').count()
    guest_btns = await guest.locator('button:has-text("Challenge")').count()
    record('RV-08', host_btns == 1 and guest_btns == 0, f'host sees {host_btns}, guest sees {guest_btns}')
    await host.click('button:has-text("Challenge")')
    await expect(guest.locator('.chal')).to_contain_text('Snake')
    await guest.click('button:has-text("It counts")')
    await expect(host.locator('.chal')).to_contain_text('Upheld')
    record('RV-10', True, 'challenge upheld by group vote in the UI')

    # GP-08 leaderboard anytime
    await guest.click('#boardBtn')
    board = await guest.locator('#boardDialog').inner_text()
    record('GP-08', 'Ste' in board and 'Ade' in board, 'leaderboard dialog lists both players')
    await guest.keyboard.press('Escape')

    await hook(host, 'deadlineIn', ms=0)
    await wait_phase(host, 'results')
    lb = await host.locator('.leader').nth(1).inner_text()
    record('GP-07', 'Ste' in lb and 'Ade' in lb, 'leaderboard shown before next pick')
    await hook(host, 'deadlineIn', ms=0)
    for p in pages:
        await wait_phase(p, 'picking')
    dis = [await p.locator('.alphabet button[data-letter="V"]').is_disabled() for p in pages]
    record('GP-03', all(dis), f'V greyed out for both: {dis}')
    pk2 = await picker_of(pages)
    record('GP-02', pk2 is guest, 'second pick goes to the second player')

    # GP-11 restart message after the whole alphabet
    await hook(host, 'useLetters', letters=[c for c in 'ABCDEFGHIJKLMNOPQRSTUWXY'])
    await play_round(pages, 'Z', [answers_for('Z'), answers_for('Z', '2')], skip_to='results')
    await hook(host, 'deadlineIn', ms=0)
    await wait_phase(host, 'final')
    heading = await host.locator('#winnerHeading').inner_text()
    record('WN-01', 'wins' in heading or 'Joint' in heading, heading)
    await host.click('button:has-text("Restart game")')
    dialog = host.locator('#restartDialog')
    await expect(dialog).to_be_visible()
    msg = await dialog.inner_text()
    await host.click('button:has-text("Restart game") >> nth=-1')
    await wait_phase(host, 'picking')
    scores = await host.evaluate('window.__ng.view.players.map(p => p.score)')
    free = await host.evaluate('window.__ng.view.room.usedLetters.length')
    record('GP-11', "won't be as competitive" in msg and scores == [0, 0] and free == 0, f'message shown; scores {scores}; used letters {free}')
    for p in pages:
        await p.context.close()


async def mobile_and_a11y(browser):
    host = await player(browser, 375, 780)
    guest = await player(browser, 375, 780)
    widths = {}
    violations = {}

    async def check(label, page):
        ok, sw = await no_hscroll(page)
        widths[label] = sw
        await page.screenshot(path=f'{SHOTS}/m-{label}.png', full_page=True)
        v = await axe(page)
        if v:
            violations[label] = v

    await host.goto(BASE + '/')
    await check('home', host)
    # keyboard-only create: Tab to name, type, Enter
    for _ in range(8):
        await host.keyboard.press('Tab')
        if await host.evaluate("document.activeElement && document.activeElement.id") == 'nameInput':
            break
    await host.keyboard.type('Ste')
    await host.keyboard.press('Enter')
    await expect(host.locator('.code-big')).to_be_visible()
    keyboard_create = True
    code = (await host.locator('.code-big').inner_text()).strip()
    await join_link(guest, code, 'Ade')
    await check('lobby', host)
    await host.click('#startBtn')
    await wait_phase(host, 'picking')
    pages = [host, guest]
    pk = await picker_of(pages)
    await check('picking', pk)
    # keyboard letter pick
    await pk.locator('.alphabet button[data-letter="M"]').focus()
    await pk.keyboard.press('Enter')
    for p in pages:
        await wait_phase(p, 'answering')
    await check('answering', host)

    # MS-05: host has sound on, guest mutes; both hear the last-seconds countdown
    await guest.click('#muteBtn')
    await host.evaluate('window.__soundLog.length = 0')
    await guest.evaluate('window.__soundLog.length = 0')
    await hook(host, 'deadlineIn', ms=5500)
    await host.wait_for_timeout(3500)
    host_beeps = await host.evaluate('window.__soundLog.length')
    guest_beeps = await guest.evaluate('window.__soundLog.length')
    record('MS-05', host_beeps >= 2 and guest_beeps == 0, f'alerts: sound on {host_beeps}, muted {guest_beeps}')
    await hook(host, 'deadlineIn', ms=60000)

    await fill_answers(host, answers_for('M'))
    await fill_answers(guest, answers_for('M', 'x'))
    for p in pages:
        await p.click("button:has-text(\"I'm done\")")
    for p in pages:
        await wait_phase(p, 'voting')
    await check('voting', host)
    # keyboard voting: focus each thumbs-up and press Space
    ups = host.locator('.thumb.up')
    for i in range(await ups.count()):
        await ups.nth(i).focus()
        await host.keyboard.press('Space')
    await host.locator('button:has-text("Submit votes")').focus()
    await host.keyboard.press('Enter')
    await vote_all(guest, reject=('Mivian',))
    await wait_phase(host, 'challenge')
    await check('results', host)
    await hook(host, 'deadlineIn', ms=0)
    await wait_phase(host, 'results')
    await check('round-scores', host)
    host.once('dialog', lambda d: asyncio.ensure_future(d.accept()))
    await host.click('button:has-text("End game")')
    await wait_phase(host, 'final')
    await check('final', host)

    wide = {k: v for k, v in widths.items() if v > 375}
    record('MS-02', not wide, f'scrollWidth per screen: {widths}')
    record('MS-06', not violations and keyboard_create, 'axe: no serious/critical issues; keyboard create, pick and vote worked' if not violations else json.dumps(violations))
    for p in pages:
        await p.context.close()


async def blank_player_round(browser):
    ste = await player(browser)
    ade = await player(browser)
    code = await create_room(ste, 'Ste')
    await join_link(ade, code, 'Ade')
    await ste.click('#startBtn')
    await wait_phase(ste, 'picking')
    pk = await picker_of([ste, ade])
    await pk.click('.alphabet button[data-letter="B"]')
    for p in (ste, ade):
        await wait_phase(p, 'answering')
    await fill_answers(ade, {'name': 'Bob', 'food': 'Bread', 'animal': 'Bear', 'place': 'Berlin', 'thing': 'Ball'})
    await ste.click("button:has-text(\"I'm done\")")
    await ade.click("button:has-text(\"I'm done\")")
    await wait_phase(ste, 'voting')
    ste_has_votes = await ste.locator('.thumb.up').count()
    ade_text = await ade.locator('main').inner_text()
    explains = "didn't write any answers" in ade_text and 'Waiting for the other players' in ade_text
    await vote_all(ste)
    await wait_phase(ade, 'results')
    record('GP-06', True, 'nothing to challenge, so the round went straight to scores')
    record('RV-05', ste_has_votes == 5 and explains,
           f'blank player reviews {ste_has_votes} answers; other player told why they have nothing to review: {explains}')
    for p in (ste, ade):
        await p.context.close()


async def dropped_player_round(browser):
    a = await player(browser)
    b = await player(browser)
    code = await create_room(a, 'A')
    await join_link(b, code, 'B')
    await a.click('#startBtn')
    await wait_phase(a, 'picking')
    await a.click('.alphabet button[data-letter="B"]')
    for p in (a, b):
        await wait_phase(p, 'answering')
    await fill_answers(a, {'name': 'Bob', 'food': 'Bread', 'animal': 'Bear', 'place': 'Berlin', 'thing': 'Ball'})
    await b.evaluate('window.__ngSocket.disconnect()')  # B's phone locks
    await hook(a, 'deadlineIn', ms=300)
    await wait_phase(a, 'voting')
    await expect(a.locator('main')).to_contain_text('lost connection')
    await b.evaluate('window.__ngSocket.connect()')     # B unlocks it
    await wait_phase(b, 'voting')
    await expect(b.locator('.thumb.up')).to_have_count(5)
    await vote_all(b)
    await wait_phase(a, ('challenge', 'results'))
    score = await a.evaluate('window.__ng.view.you.score')
    record('GP-12', score == 5, f'B dropped and came back: B reviewed A, A scored {score}')
    for p in (a, b):
        await p.context.close()


async def main():
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        await run('lobby_and_sharing', lobby_and_sharing, browser)
        await run('full_game', full_game, browser)
        await run('mobile_and_a11y', mobile_and_a11y, browser)
        await run('blank_player_round', blank_player_round, browser)
        await run('dropped_player_round', dropped_player_round, browser)
        await browser.close()
    out = os.path.join(HERE, 'e2e-results.json')
    json.dump(results, open(out, 'w'), indent=2)
    for k, v in sorted(results.items()):
        print(('PASS ' if v['pass'] else 'FAIL ') + k + '  ' + v['detail'])


if __name__ == '__main__':
    asyncio.run(main())
