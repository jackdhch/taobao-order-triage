#!/usr/bin/env python3
"""离线测试（数据全部虚构，不联网）：选文件夹导入已整理的发票、核对下载的发票有没有重复、读卖家图片里的二维码；插件里没有 AI 功能（用户 2026-10-04 要求删掉）；
备份数据 → 清除 → 从备份恢复（进行中的任务不恢复）。

用法：env -u TMPDIR python3 tools/e2e-extras.py

做法：带扩展启动无界面 Chromium。虚构发票 PDF 用浏览器现场「打印」出来；alicdn 图片用 ctx.route 回应假数据，其余请求一律拦掉。
"""
import csv, json, os, re, shutil, sys, tempfile, time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / 'tools' / 'fixtures'
fails = []


def check(ok, msg, detail=''):
    print(('  通过  ' if ok else '  失败  ') + msg + ('' if ok or not detail else '\n          ' + str(detail)))
    if not ok:
        fails.append(msg)


def wait_until(page, fn, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        page.wait_for_timeout(300)
    return None


INVOICE_HTML = '''<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">
<h2>电子发票（普通发票）</h2><p>发票号码：{no}</p><p>开票日期：{y}年{m}月{d}日</p>
<p>购买方信息 名称：某大学 统一社会信用代码/纳税人识别号：121000009999999996</p><p>销售方信息 名称：某某虚构商店</p>
<p>项目名称 虚构商品 金额 ¥{a1} 税额 ¥{a2}</p><p>价税合计（小写）¥{amt}</p></body>'''

# 订单：一单能对上已整理的发票（按开票日期+金额），两单是「待定」的
ORDERS = [('5195000000000000001', '2026-08-01 10:00:00', '交易成功', '某某虚构五金', 'XT60 公母插头 航模电池接头', '一对', 1, '19.90', '19.90'),
          ('5195000000000000002', '2026-08-02 10:00:00', '交易成功', '某某虚构百货', '虚构 多功能收纳盒', '大号', 1, '12.00', '12.00'),
          ('5195000000000000003', '2026-08-03 10:00:00', '交易成功', '某某虚构百货', '虚构 数据线 1米', '白色', 1, '8.00', '8.00')]


def run(p, tmp):
    # 1. 虚构发票 PDF：已整理 2 张（其中一张是订单 1 的），下载的 2 张（一张和已整理重复、一张新的）
    b = p.chromium.launch()
    pg = b.new_page()
    have, dl = tmp / '已整理' / '第一批', tmp / '下载'
    have.mkdir(parents=True); dl.mkdir()
    def mk(path, no, date, amt):
        y, m, d = date.split('-')
        pg.set_content(INVOICE_HTML.format(no=no, y=y, m=m, d=d, amt=f'{amt:.2f}', a1=f'{amt * 0.9:.2f}', a2=f'{amt * 0.1:.2f}'))
        pg.pdf(path=str(path))
    mk(have / '001_订单1.pdf', '11111111111111111111', '2026-08-05', 19.9)
    mk(have / '002_别的.pdf', '22222222222222222222', '2026-07-01', 50.0)
    mk(dl / '下载_重复的.pdf', '22222222222222222222', '2026-07-01', 50.0)
    mk(dl / '下载_新的.pdf', '33333333333333333333', '2026-08-06', 12.0)
    pg.set_content('<meta charset="utf-8"><h2>报销说明</h2><p>本批次共 2 张，合计 ¥69.90。联系电话 13800000000123456789</p>'); pg.pdf(path=str(have / '说明.pdf'))
    b.close()
    table = tmp / '订单表.csv'
    with open(table, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['订单号', '订单提交时间', '订单状态', '店铺名称', '商品名称', '型号款式', '商品数量', '商品金额', '实付金额'])
        w.writerows(ORDERS)

    # 下载只能落在临时目录（「备份数据」会下载一个 JSON）：配置里指定下载文件夹，HOME 也指过去
    dl_dir = tmp / '浏览器下载'
    (tmp / 'profile' / 'Default').mkdir(parents=True)
    (tmp / 'profile' / 'Default' / 'Preferences').write_text(json.dumps(
        {'download': {'default_directory': str(dl_dir), 'prompt_for_download': False, 'directory_upgrade': True}}), encoding='utf-8')
    ctx = p.chromium.launch_persistent_context(str(tmp / 'profile'), channel='chromium', headless=True, accept_downloads=True,
                                               env=dict(os.environ, HOME=str(tmp / 'home')), args=[
        '--disable-extensions-except=' + str(ROOT), '--load-extension=' + str(ROOT), '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND'])
    sent, blocked, errors = [], [], []

    def handle(route):
        r = route.request; url = r.url
        m = re.match(r'https://img\.alicdn\.com/mock/(qr|photo)\.png', url)
        if m:
            return route.fulfill(status=200, headers={'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*'},
                                 body=(FIX / (m.group(1) + '-mock.png')).read_bytes())
        blocked.append(url); route.abort()
    ctx.route(lambda u: urlsplit(u).scheme in ('http', 'https'), handle)
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
    eid = urlsplit(sw.url).hostname
    app = ctx.new_page()
    app.on('pageerror', lambda e: errors.append(str(e)))
    cons = []; app.on('console', lambda c: cons.append(c.type + ' ' + c.text[:200]))
    # accept_downloads 会让 Playwright 接管下载（存成随机名）；换回 Chrome 自己的下载流程，文件按扩展起的名字落进下载文件夹
    ctx.new_cdp_session(app).send('Browser.setDownloadBehavior', {'behavior': 'default'})
    app.goto(f'chrome-extension://{eid}/index.html')
    app.set_input_files('#file', str(table)); app.wait_for_timeout(800)
    # 把两单「数据线、收纳盒」判成待定：词表里它们本来就是模糊词
    app.click('#btn-settings'); app.fill('#inv-title', '某大学'); app.fill('#inv-tax', '121000009999999996'); app.click('#rules-save'); app.wait_for_timeout(300)

    print('\n[1] 「更多 → 导入已整理的发票文件夹」：插件自己读 PDF')
    app.click('.flow li[data-step="2"]')
    app.set_input_files('#inv-have-dir', str(tmp / '已整理'))
    got = wait_until(app, lambda: (s := app.evaluate("JSON.parse(localStorage.getItem('orderTriage.app.v1')).haveIdx")) and len(s) >= 2 and s, 30) or []
    check(sorted(x['invNo'] for x in got) == ['11111111111111111111', '22222222222222222222'], '读出 2 张发票（说明.pdf 不是发票，没算进去）', got)
    check(any(x['date'] == '2026-08-05' and abs(x['amount'] - 19.9) < 0.01 for x in got), '日期、价税合计读对了（取最大的 ¥ 金额，不是金额或税额）', got)

    print('\n[2] 「核对已下载的发票」已去掉（用户 2026-10-07：「更多」只留四项）；下载的发票由插件自动核对，整理报销文件时标出与已整理重复的')
    check(app.locator('#inv-check-dir, #dlg-dup').count() == 0, '界面上没有「核对已下载的发票」')

    print('\n[3] 卖家图片：先判断是不是二维码，是就读出内容')
    # 假装旺旺扫描过：订单 1 的店发来一张二维码、一张商品照片（先去掉订单 1 的已整理状态，让它显示聊天结果）
    app.evaluate("""() => { const S = JSON.parse(localStorage.getItem('orderTriage.app.v1')); S.haveIdx = S.haveIdx.filter(x => x.date !== '2026-08-05');
        localStorage.setItem('orderTriage.app.v1', JSON.stringify(S)); }""")
    app.evaluate("""() => chrome.storage.local.set({ chatScan: { at: Date.now(), convs: { '某某虚构五金': { orders: ['5195000000000000001'], first: '2026-08-01',
        asks: [{ time: '2026-08-02 09:00:00', text: '需要发票', nos: [] }], files: [], email: [],
        images: [{ time: '2026-08-03 10:00:00', src: 'https://img.alicdn.com/mock/photo.png' }, { time: '2026-08-03 10:01:00', src: 'https://img.alicdn.com/mock/qr.png' }] } } } })""")
    app.reload(); app.wait_for_timeout(800); app.click('.flow li[data-step="2"]')
    outs = wait_until(app, lambda: (o := app.evaluate("[...document.querySelectorAll('[data-qr-out]')].map(e => e.textContent)")) and all(o) and len(o) == 2 and o, 15) or []
    check(any('二维码内容' in o and 'https://example.invalid/fapiao/mock-001' in o for o in outs), '二维码图读出了里面的地址，只显示不打开', outs)
    check(any(o.startswith('不是二维码') for o in outs), '商品照片判成「不是二维码」', outs)
    check(not [x for x in ctx.pages if 'example.invalid' in x.url], '没有自动打开二维码里的地址', [x.url for x in ctx.pages])

    print('\n[4] 没有 AI 功能（用户 2026-10-04 要求删掉）')
    app.click('#btn-settings'); app.wait_for_timeout(300)
    check(app.locator('#ai-on, #dlg-ai, [data-ai], [data-ai-img], #ai-batch').count() == 0 and 'AI' not in app.inner_text('#dlg-settings'),
          '设置里、待定页、发票栏都没有任何 AI 的开关和按钮')
    app.keyboard.press('Escape')

    print('\n[5] 备份数据 → 清除 → 从备份恢复：数据一致，进行中的任务不恢复')
    STORE = 'orderTriage.app.v1'
    # 先判一件，让判断不是空的；再放几条下载记录（要恢复的）和一批「进行中的任务 / 领活记录」（不该恢复的）
    app.click('.flow li[data-step="1"]'); app.wait_for_timeout(300); app.keyboard.press('1'); app.wait_for_timeout(300)
    TRANSIENT = {'applyJob': {'nos': ['5195000000000000002'], 'stage': 'running'}, 'applyResult': {'at': 1, 'stage': 'confirm'},
                 'cardJobs': {'5195000000000000002': {'at': 1, 'exp': 2, 'state': 'queued'}}, 'cardRun': {'id': 'x', 'no': '5195000000000000002', 'at': 1},
                 'chatQueue': {'at': 1, 'kind': 'compose', 'items': []}, 'chatAfter': 1, 'dlJobs': [{'id': 'j1', 'no': '5195000000000000002', 'kind': 'platform'}],
                 'invJobs': {'sync': 1}, 'invClaim_sync': {'at': 1, 'by': 'x'}, 'invClaim_scan': {'at': 1, 'by': 'y'}, 'otReload_sync': 1,
                 'jobTabs': {'https://i.taobao.com/x': 12}, 'nickWant': {'5195000000000000002': 1}, 'vipJob': {'at': 1, 'orders': []},
                 'olderDone': {'from': '2026-01-01', 'at': 1}, 'autoLast': 'Mon Jan 01 2001',
                 'autoLog': [{'t': 1, 'at': '2001-01-01 00:00:00', 'src': 'home', 'run': 'x', 'stage': 'sync', 'ev': 'start', 'msg': ''}]}
    app.evaluate("""t => chrome.storage.local.set(Object.assign({ dlDone: { '5195000000000000003': [{ file: '2026-08-03_8.00_某某虚构百货_5195000000000000003.pdf', path: '', at: 1, from: 'platform', src: '', url: '' }] },
        askSent: { '5195000000000000002': 1759000000000 }, autoDaily: { on: true, hour: 23 } }, t))""", TRANSIENT)
    app.wait_for_timeout(500)
    ls0 = app.evaluate(f"localStorage.getItem('{STORE}')")
    st0 = app.evaluate('chrome.storage.local.get(null)')
    n_orders, n_dec = app.evaluate(f"(() => {{ const d = JSON.parse(localStorage.getItem('{STORE}')); return [d.orders.length, Object.keys(d.decisions).length]; }})()")
    check(n_dec >= 1, '备份前已有判断', n_dec)
    app.evaluate("document.querySelector('details.more').open = true")
    check(app.is_visible('#data-backup') and app.is_visible('[data-pick="backup-file"]')
          and app.evaluate("[...document.querySelectorAll('#more .more-pop button')].every(b => b.title.length > 10)"),
          '「更多」里有「备份数据」「从备份恢复…」，每项都有悬停说明')
    app.click('#data-backup')
    bdir = dl_dir / '订单分拣-备份'
    bf = wait_until(app, lambda: bdir.is_dir() and (z := [x for x in bdir.iterdir() if x.suffix == '.json']) and z[0], 15)
    check(bool(bf) and re.fullmatch(r'订单分拣-备份-\d{8}-\d{4}\.json', bf.name), '备份文件存进下载文件夹的「订单分拣-备份/订单分拣-备份-日期-时分.json」', bf)
    bk = json.loads(bf.read_text(encoding='utf-8')) if bf else {}
    ver = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))['version']
    check(bk.get('app') == 'orderTriage' and bk.get('kind') == 'backup' and bk.get('format') == 1 and bk.get('version') == ver and re.match(r'\d{4}-\d\d-\d\dT', bk.get('at', '')),
          '备份文件头：app / kind / format 1 / 插件版本 / 备份时间', {k: bk.get(k) for k in ('app', 'kind', 'format', 'version', 'at')})
    check((bk.get('localStorage') or {}).get(STORE) == ls0 and all(k.startswith('orderTriage.') for k in bk.get('localStorage') or {}),
          '主页数据（localStorage）原样存成字符串，只带本插件的键')
    check(bk.get('storage', {}).get('dlDone') == st0['dlDone'] and 'dlJobs' in bk.get('storage', {}), '扩展存储整份存下（chrome.storage.local.get(null)）')
    check('autoLog' in st0 and 'autoLog' not in bk.get('storage', {}), '本机调试日志 autoLog 不进备份')

    msgs = []
    def on_dialog(d):
        msgs.append(d.message)
        d.accept() if mode[0] == 'accept' else d.dismiss()
    mode = ['accept']
    app.on('dialog', on_dialog)
    app.click('#btn-settings'); app.wait_for_timeout(200); app.click('#data-clear'); app.wait_for_timeout(800)
    check(msgs and '建议先备份数据' in msgs[-1], '「清除本机数据」的确认框提示先备份', msgs[-1:] )
    left = app.evaluate('chrome.storage.local.get(null).then(r => Object.keys(r))')
    check(app.evaluate(f"localStorage.getItem('{STORE}')") is None and set(left) <= {'invWant'}, '已清空（invWant 是主页随时按当前订单重写的发票范围）', left)
    app.evaluate("document.querySelector('details.more').open = true")
    check(app.is_visible('#more') and app.is_visible('[data-pick="backup-file"]') and not app.is_visible('#data-backup'),
          '没有数据时「更多」仍在，可以「从备份恢复」（「备份数据」等需要数据的项隐藏）')
    app.evaluate("document.querySelector('details.more').open = false")

    # 不认识的格式：拒绝，不改动；版本比当前新：提示，取消就不改
    bad = tmp / '格式2.json'; bad.write_text(json.dumps(dict(bk, format=2)), encoding='utf-8')
    app.set_input_files('#backup-file', str(bad)); app.wait_for_timeout(800)
    check(msgs and '无法识别' in msgs[-1] and app.evaluate(f"localStorage.getItem('{STORE}')") is None, '格式号不认识的备份：拒绝并提示，数据不动', msgs[-1:])
    newer = tmp / '新版本.json'; newer.write_text(json.dumps(dict(bk, version='99.0.0')), encoding='utf-8')
    mode[0] = 'dismiss'
    app.set_input_files('#backup-file', str(newer)); app.wait_for_timeout(800)
    check(msgs and '新于当前版本' in msgs[-1] and app.evaluate(f"localStorage.getItem('{STORE}')") is None, '较新版本的备份：确认框里提示，取消则不恢复', msgs[-1:])
    other = tmp / '别的.json'; other.write_text(json.dumps({'format': 'order-triage-scrape', 'orders': []}), encoding='utf-8')
    app.set_input_files('#backup-file', str(other)); app.wait_for_timeout(800)
    check(msgs and '不是订单分拣的备份文件' in msgs[-1], '别的 JSON：提示不是备份文件', msgs[-1:])

    mode[0] = 'accept'
    with app.expect_navigation(timeout=15000):
        app.set_input_files('#backup-file', str(bf))
    app.wait_for_selector('#main:not([hidden])', timeout=10000); app.wait_for_timeout(800)
    m = msgs[-1] if msgs else ''
    check('将用备份覆盖当前全部数据' in m and f'订单：{n_orders} 单' in m and f'判断：{n_dec} 条' in m and '插件版本：' + ver in m and '备份时间：' in m,
          '确认框写明覆盖全部数据，并列出备份时间、插件版本、订单数、判断数', m)
    check(app.evaluate(f"localStorage.getItem('{STORE}')") == ls0, '恢复后主页数据和备份前完全一致')
    st1 = app.evaluate('chrome.storage.local.get(null)')
    regen = {'want', 'invWant', 'invPending', 'autoLast'}           # 主页打开时自己重写的、恢复时特意改的
    keep = [k for k in st0 if k not in TRANSIENT and k not in regen]
    check(keep and all(st1.get(k) == st0[k] for k in keep), f'扩展存储里的记录恢复一致（{len(keep)} 个键）', [k for k in keep if st1.get(k) != st0[k]])
    check(not [k for k in TRANSIENT if k != 'autoLast' and k in st1], '进行中的任务、领活记录、标签页编号都没有恢复', [k for k in TRANSIENT if k in st1])
    check(st1.get('autoLast') == app.evaluate('new Date().toDateString()'), '每日自动处理记成今天已运行，恢复后不会马上自动开始', st1.get('autoLast'))
    check(app.evaluate("document.querySelectorAll('.flow li').length") == 4 and str(n_orders) + ' 单' in app.inner_text('#summary'), '恢复后主页正常显示')
    app.remove_listener('dialog', on_dialog)

    print('\n[5b] 自动处理发票：某段超时也接着做完；「需处理」只有一单（插件做不了的）时清单照样弹出并列出它；结束后刷新界面')
    # 三单都是实验室的：1 抬头不符（红，插件做不了，只能用户去换开）、2 刚申请淘宝开票（等待中）、3 已下载。淘宝页面全部打不开（离线），
    # 「刷新淘宝开票记录」这段把时限改成 4 秒，必然超时；之后几段照常做完
    app.evaluate('''() => { const S = JSON.parse(localStorage.getItem('orderTriage.app.v1'));
        for (const o of S.orders) for (const l of o.lines) S.decisions[l.key] = 'lab';
        S.haveIdx = []; localStorage.setItem('orderTriage.app.v1', JSON.stringify(S)); }''')
    today = app.evaluate("new Date().toISOString().slice(0, 10)")
    app.evaluate('''t => chrome.storage.local.set({ invSync: { at: Date.now() - 864e5, rows: {
        '5195000000000000001': { no: '5195000000000000001', tab: 'issued', title: '企业-某某虚构公司', type: '电子普通发票', date: '2026-08-05', amount: 19.9, canDownload: true },
        '5195000000000000002': { no: '5195000000000000002', tab: 'applying', title: '企业-某大学', type: '电子普通发票', date: t, progress: '申请中' } } },
        chatScan: null, autoLog: [] })''', today)
    app.reload(); app.wait_for_selector('#main:not([hidden])'); app.wait_for_timeout(800)
    app.click('.flow li[data-step="2"]'); app.wait_for_timeout(300)
    red = app.evaluate("[...document.querySelectorAll('.inv-table .st.tone-bad')].map(s => s.closest('tr').innerText.match(/\\d{19}/)[0])")
    check(red == ['5195000000000000001'], '准备好的数据：发票表里只有一单标红（抬头不符）', red)
    app.evaluate('() => { __otDev.tmo = { sync: 4000 }; }')
    app.click('#summary [data-flow="inv-run"]')
    prog = wait_until(app, lambda: (t := app.inner_text('#summary')) and '第 2 / 9 段：刷新淘宝开票记录' in t and re.search(r'已等 \d+ 秒', t) and t, 15) or ''
    check(bool(prog), '处理中显示「第 2 / 9 段：刷新淘宝开票记录 · 等什么 · 已等几秒」', app.inner_text('#summary')[:200])
    dlg = wait_until(app, lambda: app.locator('#dlg-list[open]').count() and app.inner_text('#dlg-list'), 40) or ''
    check('需手动处理' in dlg and '5195000000000000001' in dlg and '换开发票' in dlg and app.inner_text('#list-ok') == '知道了' and not app.is_visible('#list-cancel'),
          '只有一单需处理、而且插件做不了：清单照样弹出，列出这一单和该点的操作（「知道了」）', dlg[:300])
    if dlg:
        app.click('#list-ok')
    fin = wait_until(app, lambda: (t := app.inner_text('#summary')) and '发票处理完成' in t and t, 30) or app.inner_text('#summary')
    check('发票处理完成' in fin and '② 刷新淘宝开票记录：超时：4 秒内未读到开票记录' in fin and '沿用上次' in fin and '⑨ 申请平台开票' in fin,
          '「刷新淘宝开票记录」超时：写明原因，接着做完后面几段，总结逐段列出结果', fin[:600])
    check('仍需处理 1 单：某某虚构五金（已开票，抬头不符）' in fin, '总结里列出仍需处理的那一单', fin[:300])
    dash = app.inner_text('#remind')
    check(re.search(r'需处理\s*1', dash) and app.locator('.read-bar.busy').count() == 0 and app.locator('#summary .flow-acts button').inner_text() == '自动处理发票',
          '结束后界面刷新：顶上「需处理 1」，按钮恢复成「自动处理发票」', dash[:200])
    rb = app.locator('.inv-table tbody tr:has-text("5195000000000000001") button[data-act]')
    check(rb.count() == 1 and rb.inner_text() == '换开发票', '那一单在发票表里的操作是「换开发票」', rb.count() and rb.inner_text())
    log = app.evaluate('chrome.storage.local.get("autoLog").then(r => r.autoLog || [])')
    evs = [(e.get('stage'), e.get('ev')) for e in log]
    check(('sync', 'timeout') in evs and ('confirm', 'end') in evs and evs[-1] == ('run', 'end') and all(e.get('src') == 'home' for e in log),
          'autoLog 记下了这一段超时，以及之后各段和结束', evs)
    tabs = app.evaluate('chrome.tabs.getCurrent().then(t => t.active)')
    check(tabs, '处理结束后主页切回前台')
    blocked[:] = [u for u in blocked if 'taobao.com' not in u]      # 上面「自动处理发票」去开的淘宝页面（离线，全被拦下）

    print('\n[6] 杂项')
    check(not errors, '页面没有报错', errors)
    check(not [u for u in blocked if 'favicon' not in u] and not sent, '除了假图片，没有别的网络请求', blocked[:5])
    ctx.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix='ot-extras-'))
    try:
        with sync_playwright() as p:
            run(p, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f'\n{len(fails)} 项失败：\n  ' + '\n  '.join(fails) if fails else '\n全部通过')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
