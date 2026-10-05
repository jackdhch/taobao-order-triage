#!/usr/bin/env python3
"""
离线端到端测试：发票功能里「只读」的部分（同步全部发票、扫描旺旺回复、下载、挂上 PDF）。
全程不连淘宝、不联网，订单、店铺、发票全部虚构（抬头「某大学」，税号是校验位正确的虚构号）。

    env -u TMPDIR python3 tools/e2e-invoice.py

需要 python3 和 playwright（含它自带的 Chromium）。TMPDIR 太长时 Chromium 会报 Socket path too long，所以去掉它。
做法：带扩展启动无界面 Chromium，用 ctx.route 把淘宝「全部发票」页、旺旺页的真实网址回应成 tools/ 下的模拟页
（扩展的内容脚本按真实网址注入，不用改 manifest），其他一切外部请求直接拦掉。
流程：扩展主页导入虚构订单表 → 设置抬头税号 → 发票栏「同步」→「扫描旺旺」→「下载全部」→ 给一单「挂上 PDF」，
每一步核对主页上每单的发票状态。同步、扫描都故意放慢（每页停 1~2 秒），整个测试大约两分钟。
"""
import csv
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]          # 项目根目录本身就是扩展
TOOLS = ROOT / 'tools'
INV_URL = 'https://i.taobao.com/my_itaobao/invoice'
# 网址前缀 → 回应成哪个模拟页
MOCKS = [(INV_URL, 'mock-invoice.html'),
         ('https://market.m.taobao.com/app/im/chat/index.html', 'mock-chat.html'),
         ('https://market.m.taobao.com/app/im/chat-core/', 'mock-chat-core.html'),
         ('https://trade.taobao.com/trade/detail/', 'mock-detail.html'),               # 订单详情页：旺旺图标上有卖家旺旺名
         ('https://dppt.zhejiang.chinatax.gov.cn:8443/', 'mock-qr.html'),                # 税务局电子发票页（卖家发的二维码）
         ('https://ai.alimebot.taobao.com/', 'mock-alime.html')]                         # 淘宝官方客服（找 88VIP 人工客服督促）
TITLE, TAX = '某大学', '121000009999999996'

# 虚构订单：key → (订单号, 日期, 状态, 店铺, 实付, [(商品, 规格, 数量, 单价)])
O = {
    'A': ('5190000000000000101', '2026-08-02', '交易成功', '某某虚构 五金工具', '23.50',
          [('304不锈钢螺丝 M3', 'M3*8 100只', 1, '15.50'), ('M3 铜柱 六角隔离柱', 'M3*10', 1, '8.00')]),
    'B': ('5190000000000000102', '2026-08-03', '交易成功', '某某虚构电池配件', '12.80', [('XT60 公母插头 航模电池接头', '一对', 1, '12.80')]),
    'C': ('5190000000000000103', '2026-08-20', '交易成功', '某某虚构接插件', '6.50', [('杜邦线 公对母 40P', '20cm', 1, '6.50')]),
    'D': ('5190000000000000104', '2026-08-25', '交易成功', '某某虚构线材', '19.00', [('硅胶线 16AWG 1米', '红色', 1, '19.00')]),
    'E': ('5190000000000000105', '2026-08-05', '交易成功', '某某虚构电子元器件专营店', '9.90', [('CH340 串口模块', 'USB转TTL', 1, '9.90')]),
    'F': ('5190000000000000106', '2026-08-14', '交易成功', '某某虚构传感器店', '21.00', [('MPU6050 六轴传感器模块', '', 1, '21.00')]),
    'G': ('5190000000000000107', '2026-08-18', '交易成功', '某某虚构碳纤维加工', '88.00', [('碳纤维板 CNC 切割', '2mm', 1, '88.00')]),
    'H': ('5190000000000000108', '2026-09-01', '交易成功', '某某虚构轴承', '15.00', [('深沟球轴承 608', '608ZZ', 10, '1.50')]),
    'I': ('5190000000000000109', '2026-09-10', '交易成功', '某某虚构焊接耗材', '32.00', [('焊锡丝 0.8mm', '100g', 1, '32.00')]),
    'P': ('5190000000000000110', '2026-08-08', '交易成功', '某某虚构日用百货', '29.90', [('牙膏 家庭装', '3支', 1, '29.90')]),       # 个人
    'R': ('5190000000000000111', '2026-07-28', '交易关闭', '某某虚构模型配件', '18.00', [('碳纤维桨 5寸', '2对', 1, '18.00')]),      # 实验室但关闭了
}
NO = {k: v[0] for k, v in O.items()}
LAB = [k for k in O if k not in ('P', 'R')]         # 该出现在发票栏的
# 各阶段每单的发票状态（主页发票栏「发票」列的文字）
AFTER_SYNC = {'A': '已开票·待下载', 'B': '已开票，但抬头不对', 'C': '平台申请中', 'D': '可平台申请', 'E': '需找卖家',
              'F': '需找卖家', 'G': '需找卖家', 'H': '需找卖家', 'I': '需找卖家'}
AFTER_SCAN = dict(AFTER_SYNC, E='卖家发来了文件', F='卖家发来了图片（可能是二维码）', G='卖家提到邮箱', I='已要过发票，等回复')
# 该被点开的会话：发票栏里有订单的店（A 的店没聊过发票也算）；个人、已关闭、无关的店不该点
# 旺旺只看还需要卖家回复的单（需找卖家 / 已要过 / 卖家回了还没下）：A 已开票、B 抬头不对、C 申请中、D 能平台申请的店都不打开，
# 免得一大批店看到「已读」
CONV_OPEN = {'某某虚构电子元器件专营店', '某某虚构传感器店', '某某虚构碳纤维加工', '某某虚构焊工小王'}   # 焊接耗材的会话名是卖家旺旺名
# 「全部发票」页上允许点的按钮：标签、翻页、下载。点了「申请开票 / 撤销申请 / 换开」就是动了账号
PAGE_OK = re.compile(r'^(已开具发票|申请中发票|未申请|下一页|上一页|\d+|下载到本地)$')

F_HINT = 'F 不对多半和上面「二维码图片」那条是同一个原因'
fails = []


def check(ok, msg, detail=''):
    print(('  通过  ' if ok else '  失败  ') + msg + ('' if ok or not detail else '\n          ' + str(detail)))
    if not ok:
        fails.append(msg)


def js_num(s):
    """和 String(Number) 一样的写法：23.50 → 23.5，15.00 → 15"""
    return f'{float(s):.2f}'.rstrip('0').rstrip('.')


def save_name(k):
    no, d, _, shop, pay, _ = O[k]
    return f'{d}_{js_num(pay)}_{re.sub(r"[\\/:*?\"<>|\s]+", "", shop)}_{no}.pdf'


def write_csv(path):
    # 淘宝导出表的样子：一单多件时，后续行订单号（和整单字段）留空
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['订单号', '订单提交时间', '订单状态', '店铺名称', '商品名称', '型号款式', '商品数量', '商品金额', '实付金额', '运费'])
        for no, d, st, shop, pay, items in O.values():
            for i, (t, sku, q, p) in enumerate(items):
                head = [no, d + ' 10:00:00', st, shop] if i == 0 else ['', '', '', '']
                w.writerow(head + [t, sku, q, p] + ([pay, '0.00'] if i == 0 else ['', '']))


def wait_until(page, fn, timeout):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        page.wait_for_timeout(300)
    return None


def fake_oss(tmp):
    # 假的「阿里云发票文件」服务器：扩展自己发起的下载不走 ctx.route，只能让浏览器把这个域名解析到本机。
    # 用自签证书起 https（浏览器加 --ignore-certificate-errors），回应的 PDF 里写着是哪一单，照样不联网
    import http.server, ssl, subprocess, threading
    key, crt = tmp / 'oss.key', tmp / 'oss.crt'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=einvoice-file.oss-cn-beijing.aliyuncs.com',
                    '-keyout', str(key), '-out', str(crt)], check=True, capture_output=True)

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            m = re.match(r'/mock/OSTB_(\d+)\.pdf', self.path)
            if not m:
                self.send_error(404); return
            inv = m.group(1)
            no = next((v[0] for v in O.values() if v[0][-3:] == inv[-3:]), '?')
            body = f'%PDF-1.4\n%虚构测试发票 订单 {no} 发票号 {inv}\n%%EOF\n'.encode()
            self.send_response(200); self.send_header('Content-Type', 'application/pdf'); self.send_header('Content-Length', str(len(body))); self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(str(crt), str(key))
    srv.socket = c.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def run(p, tmp):
    oss = fake_oss(tmp)
    # 下载只能落在临时目录：配置里指定下载文件夹，HOME 也指过去（万一配置没生效，默认的 ~/Downloads 也在临时目录里）
    dl_dir = tmp / '下载'
    (tmp / 'profile' / 'Default').mkdir(parents=True)
    (tmp / 'profile' / 'Default' / 'Preferences').write_text(json.dumps(
        {'download': {'default_directory': str(dl_dir), 'prompt_for_download': False, 'directory_upgrade': True}}), encoding='utf-8')
    ctx = p.chromium.launch_persistent_context(str(tmp / 'profile'), channel='chromium', headless=True, accept_downloads=True,
                                               env=dict(os.environ, HOME=str(tmp / 'home')), args=[
        '--disable-extensions-except=' + str(ROOT), '--load-extension=' + str(ROOT),
        # 双保险不联网：不走系统代理；域名一律解析失败（模拟页由下面的 route 直接回应，不需要解析）
        '--no-proxy-server', '--ignore-certificate-errors',
        f'--host-resolver-rules=MAP einvoice-file.oss-cn-beijing.aliyuncs.com 127.0.0.1:{oss.server_address[1]}, MAP * ~NOTFOUND'])
    blocked, errors, dialogs, pages = [], [], [], []
    pages_html = {f: (TOOLS / f).read_text(encoding='utf-8') for _, f in MOCKS}

    def handle(route):
        url = route.request.url
        m = re.match(r'https://einvoice-file\.oss-cn-beijing\.aliyuncs\.com/mock/OSTB_(\d+)\.pdf', url)
        if m:                                           # 模拟阿里云上的发票文件：内容里写着是哪一单的
            inv = m.group(1)
            no = next((v[0] for v in O.values() if v[0][-3:] == inv[-3:]), '?')
            return route.fulfill(status=200, content_type='application/pdf', body=f'%PDF-1.4\n%虚构测试发票 订单 {no} 发票号 {inv}\n%%EOF\n'.encode())
        if url.startswith('https://consumerservice.taobao.com/online-help'):      # 官方客服入口：真实页面会跳到 alimebot
            return route.fulfill(status=200, content_type='text/html; charset=utf-8',
                                 body='<meta charset="utf-8"><script>location.replace("https://ai.alimebot.taobao.com/intl/index.htm?from=mock")</script>')
        if url == 'https://img.alicdn.com/mock/qr-dppt-106.png':     # 能解码的二维码：税务局电子发票地址
            return route.fulfill(status=200, content_type='image/png', body=(TOOLS / 'fixtures' / 'qr-dppt-106.png').read_bytes())
        for prefix, f in MOCKS:
            if url.startswith(prefix):
                return route.fulfill(status=200, content_type='text/html; charset=utf-8', body=pages_html[f])
        blocked.append(url)
        route.abort()
    ctx.route(lambda u: urlsplit(u).scheme in ('http', 'https', 'ws', 'wss'), handle)

    def watch(page, tag):
        page.on('pageerror', lambda e: errors.append(f'{tag}: {e}'))
        page.on('dialog', lambda d: (dialogs.append(f'{tag}: {d.message}'), d.dismiss()))
        return page
    ctx.on('page', lambda pg: pages.append(watch(pg, '新开页')))

    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
    eid = urlsplit(sw.url).hostname
    print('扩展已加载，ID', eid)
    csv_path = tmp / '虚构订单表.csv'
    write_csv(csv_path)

    print('\n[1] 扩展主页导入虚构订单表，设置抬头税号')
    app = ctx.new_page()
    # accept_downloads 让 Playwright 接管下载：文件存成随机名，Chrome 不再问扩展起什么名（onDeterminingFilename 不触发），
    # 和真实使用不一样。这里换回 Chrome 自己的下载流程
    ctx.new_cdp_session(app).send('Browser.setDownloadBehavior', {'behavior': 'default'})
    app.goto(f'chrome-extension://{eid}/index.html')
    app.set_input_files('#file', str(csv_path))
    app.wait_for_selector('#main:not([hidden])')
    # 补图时订单页上记下的卖家旺旺名：I 单的卖家旺旺名和店名不一样，扫描要靠它找到会话
    # G 单：会话很久以前、不在左侧列表里，扫描要按卖家旺旺名用地址打开
    app.evaluate('s => chrome.storage.local.set({ scraped: s })', {NO['I']: {'no': NO['I'], 'nick': '某某虚构焊工小王', 'lines': [{'title': '焊锡丝 0.8mm'}]},
                                                              NO['G']: {'no': NO['G'], 'nick': '某某虚构碳纤维加工', 'lines': [{'title': '碳纤维板 CNC 切割'}]}})
    app.wait_for_timeout(600)
    store = lambda k: app.evaluate('k => chrome.storage.local.get(k).then(r => r[k])', k)
    app.click('#btn-settings')
    app.fill('#inv-title', TITLE)
    app.fill('#inv-tax', TAX[:-1] + '7')                # 最后一位打错
    app.click('#rules-save')
    check(app.is_visible('#dlg-settings') and '校验不通过' in app.inner_text('#inv-tax-err'), '税号校验位打错：保存被拦下，提示校验不通过',
          app.inner_text('#inv-tax-err'))
    app.fill('#inv-tax', TAX)
    check('校验通过' in app.inner_text('#inv-tax-err'), '税号改对后提示校验通过', app.inner_text('#inv-tax-err'))
    app.click('#rules-save')
    app.wait_for_selector('#dlg-settings', state='hidden')
    want = wait_until(app, lambda: (w := store('invWant')) and w.get('title') == TITLE and w, 5) or store('invWant')
    got_nos = sorted(o['no'] for o in (want or {}).get('orders', []))
    check(got_nos == sorted(NO[k] for k in LAB), '要开票的订单（写给淘宝页的 invWant）= 实验室且没关闭的 9 单，不含个人的牙膏、已关闭的桨',
          got_nos)
    check(want and want.get('since') == '2026-08-02' and want.get('taxId') == TAX, 'invWant 的起始日期是 2026-08-02（最早的实验室订单），带上税号',
          want and {k: want.get(k) for k in ('since', 'title', 'taxId')})

    app.click('#seg-cat button[data-cat="invoice"]')
    app.wait_for_selector('.inv-table')

    def inv_rows():
        # 第 1 列是商品图，第 3 列是店铺和订单号，第 6 列是发票状态
        return app.evaluate('''() => Object.fromEntries([...document.querySelectorAll('.inv-table tbody tr')].map(tr => [
            tr.children[2].querySelector('.detail').textContent.trim(),
            { st: tr.querySelector('.st').textContent.trim(), detail: [...tr.children[5].querySelectorAll('.detail')].map(d => d.textContent).join(' | '),
              btns: [...tr.querySelectorAll('.acts button')].map(b => b.textContent.trim()) }]))''')

    def check_status(want, msg, hint=''):
        rows = inv_rows()
        by = {k: rows.get(NO[k], {}).get('st') for k in LAB}
        bad = {k: f'{by[k]!r}，应为 {want[k]!r}' for k in LAB if by[k] != want[k]}
        extra = set(rows) - {NO[k] for k in LAB}
        check(not bad and not extra, msg, f'不对的：{bad}；不该出现的：{extra}' + ('（' + hint + '）' if bad.keys() == {'F'} and hint else ''))
        return rows

    check_status({k: '需找卖家' for k in LAB}, '发票栏列出 9 单（没有牙膏、没有关闭的单），还没同步时都是「需找卖家」')

    print('\n[2] 同步发票状态（「全部发票」模拟页）')
    with ctx.expect_page() as pi:
        app.evaluate("document.querySelector('details.more').open = true")   # 单项操作收在「更多」里
        app.click('#inv-sync')
    inv = pi.value
    t0 = time.time()
    sync = wait_until(app, lambda: store('invSync'), 120)
    print(f'  同步用时 {time.time() - t0:.0f} 秒；面板：' + inv.inner_text('div[style*="2147483647"]').replace('\n', ' | '))
    check(bool(sync), '点「同步发票状态」打开全部发票页，120 秒内写回 invSync')
    rows = (sync or {}).get('rows', {})
    log = inv.evaluate('window.__mock.log')
    print('  模拟页渲染过的页：', log)
    check(log[:7] == ['issued:1', 'issued:2', 'issued:3', 'applying:1', 'applying:2', 'unapplied:1', 'unapplied:2'],
          '三个标签依次翻完；「已开具」第 3 页整页早于 2026-08-02 就停，不翻第 4 页', log)
    check('5180000000000000206' not in rows and '5180000000000000205' in rows, '第 4 页的发票没读，第 3 页的读了', sorted(rows))
    exp = {NO['A']: dict(tab='issued', shop='某某虚构 五金工具', amount=23.5, title=TITLE, type='电子普通发票', date='2026-08-09', canDownload=True),
           NO['B']: dict(tab='issued', title='某某虚构科技有限公司', date='2026-08-06'),
           NO['C']: dict(tab='applying', shop='某某虚构接插件', amount=6.5, title=TITLE, type='电子普通发票', date='2026-09-02', progress='申请中', canDownload=False),
           NO['D']: dict(tab='unapplied', amount=19, date='2026-08-25', canDownload=False)}
    bad = [f'{no} {k}: 读到 {rows.get(no, {}).get(k)!r}，应为 {v!r}' for no, e in exp.items() for k, v in e.items() if rows.get(no, {}).get(k) != v]
    check(not bad, '逐单核对 invSync：标签、店名、金额、抬头、类型、日期（已开具取开票日期、申请中取分组头的申请时间）、进度、能否下载',
          '\n          '.join(bad))
    app.wait_for_timeout(500)
    check_status(AFTER_SYNC, '同步后主页状态：A 已开票·待下载，B 抬头不对，C 平台申请中，D 可平台申请，其余需找卖家')

    print('\n[3] 扫描旺旺里的发票回复（旺旺模拟页，聊天在 iframe 里）')
    with ctx.expect_page() as pi:
        app.evaluate("document.querySelector('details.more').open = true")
        app.click('#inv-scan')
    chat = pi.value
    t0 = time.time()
    scan = wait_until(app, lambda: store('chatScan'), 180)
    check(bool(scan), '点「扫描」打开旺旺页，180 秒内写回 chatScan')
    core = next((f for f in chat.frames if '/chat-core/' in f.url), None)
    check(core is not None, '旺旺页里有 chat-core 框架')
    cm = core.evaluate('({ opened: window.__mock.opened, sent: window.__mock.sent })') if core else {'opened': [], 'sent': []}
    print(f'  扫描用时 {time.time() - t0:.0f} 秒；点开过的会话：{cm["opened"]}')
    check(set(cm['opened']) == CONV_OPEN and len(cm['opened']) == len(CONV_OPEN),
          '只点开还需要卖家回复的店的会话，每个一次（没点已开票、平台申请中、能平台申请的店，也没点零食铺、日用百货、已关闭订单的模型配件）', cm['opened'])
    check(not cm['sent'], '没碰输入框、没点「发送」', cm['sent'])
    convs = (scan or {}).get('convs', {})
    e = convs.get('某某虚构电子元器件专营店', {})
    check(set(convs) == CONV_OPEN, 'chatScan 按会话顶部的全名存（列表里被截断成「…」的也能对上）', sorted(convs))
    check([f.get('name') for f in e.get('files', [])] == ['dzfp_26442000000000000105_某大学_20260807153012.pdf']
          and [k['time'] for k in e.get('asks', [])] == ['2026-08-06 09:30:00'] and [k['nos'] for k in e.get('asks', [])] == [[NO['E']]] and e.get('first') == '2026-07-20 10:00:00' and e.get('orders') == [NO['E']],
          '长会话往上滚到订单表最早日期之前：认出要发票的消息，只收之后卖家发的发票文件（之前发的驱动说明不算），读到右侧订单号',
          {k: e.get(k) for k in ('first', 'asks', 'files', 'orders')})
    g = convs.get('某某虚构碳纤维加工', {})
    check(not g.get('images') and len(g.get('email', [])) == 1, '卖家推的商品卡片图片不当成二维码；要邮箱的话认出来了',
          {k: g.get(k) for k in ('images', 'email')})
    f = convs.get('某某虚构传感器店', {})
    check(len(f.get('images', [])) == 1, '卖家发的二维码图片认出来了（1 张）',
          f'images={f.get("images")}（如果是 []：chat.js readMsgs 里 img 过滤条件 !i.closest(\'[class*="item-"]\') '
          f'会命中外层 .message-item-line，所有图片都被滤掉）')
    app.wait_for_timeout(500)
    rows = check_status(AFTER_SCAN, '扫描后主页状态：E 卖家发来了文件，F 图片（二维码），G 提到邮箱，I 已要过等回复，H 仍需找卖家', F_HINT)
    check(rows.get(NO['E'], {}).get('btns') == ['下载卖家发的文件（1 个）'] and rows.get(NO['A'], {}).get('btns') == ['下载发票'],
          'A 有「下载发票」按钮，E 有「下载卖家发的文件（1 个）」按钮', {k: rows.get(NO[k], {}).get('btns') for k in 'AE'})

    by_url = [u for pg in ctx.pages if '/app/im/' in pg.url for fr in pg.frames if '/chat-core/' in fr.url for u in (fr.evaluate('window.__mock.byUrl || []'))]
    check('某某虚构碳纤维加工' in by_url or any('碳纤维' in k for k in (store('chatScan') or {}).get('convs', {})),
          '不在会话列表里的碳纤维加工：按卖家旺旺名用地址打开并读到了', by_url)
    g = (store('chatScan') or {}).get('convs', {}).get('某某虚构碳纤维加工', {})
    check(g.get('byNick') == '某某虚构碳纤维加工' and g.get('matched') is True, '按旺旺名打开的会话：右侧「我的订单」里有这一单（matched）', {k: g.get(k) for k in ('byNick', 'matched', 'orders')})

    print('\n[4] 下载全部待下载的发票（先关掉前面的两个页面：新开的页面要自己领到活）')
    inv_clicks = inv.evaluate('window.__mock.clicks')      # 关掉的页面就读不到了，先存下来
    inv.close()
    chat.close()
    n_pages = len(pages)
    app.evaluate("document.querySelector('details.more').open = true")
    app.click('#inv-dl-all')
    app.wait_for_timeout(1500)
    jobs = store('invJobs') or {}
    now = app.evaluate('Date.now()')
    # 淘宝页面在后台标签里不干活，两个页面同时开只有前台的在下：先开全部发票页，平台票下完由后台再开旺旺页
    check(now - jobs.get('download', 0) < 10000 and store('chatAfter'), '平台下载排进了 invJobs，旺旺的活记下等平台票下完（chatAfter）',
          {'invJobs': jobs, 'chatAfter': store('chatAfter')})
    first = pages[n_pages:]
    check(len(first) == 1 and INV_URL in first[0].url, '一次点击先只开全部发票页', [pg.url for pg in first])
    both = lambda: (d := store('dlDone')) and NO['A'] in d and NO['E'] in d and d
    dl = wait_until(app, both, 90) or store('dlDone') or {}
    new = pages[n_pages:]
    check(len(new) == 2 and '/app/im/chat/' in new[1].url and not store('chatAfter'), '平台票下完后，后台自动打开了旺旺页', [pg.url for pg in new])
    miss = [k for k in 'AE' if NO[k] not in dl]
    check(not miss, '新开的两个页面都领到了下载活，A（平台）、E（聊天）都下载了', f'没下载的：{miss}（多半是上面 invJobs 里那份活被盖掉了）')
    if miss:
        # 活丢了的话，用户还能点淘宝页右下角面板上的下载按钮：接着测下载本身
        for k in miss:
            pg = next((pg for pg in new if (INV_URL if k == 'A' else '/app/im/chat/') in pg.url), None)
            fr = pg and (pg if k == 'A' else next((f for f in pg.frames if '/chat-core/' in f.url), None))
            if fr:
                print(f'  {k} 单没自动下载，改点面板上的下载按钮')
                fr.click('div[style*="2147483647"] button[data-otp="dl"]')
        dl = wait_until(app, both, 60) or store('dlDone') or {}
    if NO['A'] not in dl:                               # 排查用：浏览器下载记录和发票页面板
        print('  浏览器下载记录：', app.evaluate("chrome.downloads.search({orderBy: ['-startTime'], limit: 4}).then(a => a.map(d => [d.url.slice(0, 80), d.state, d.error, d.filename.split('/').pop()]))"))
        ip = next((pg for pg in new if INV_URL in pg.url), None)
        if ip: print('  发票页面板：', ip.evaluate("(document.querySelector('[data-otp-status]')||{}).textContent"), '| 页面记下的下载：', ip.evaluate('JSON.stringify(window.__mock.downloads)'))
    for k, frm in (('A', 'platform'), ('E', 'chat')):
        got = dl.get(NO[k], [])
        check(len(got) == 1 and got[0].get('file') == save_name(k) and got[0].get('from') == frm,
              f'{k} 单下载记录：一条，建议文件名 {save_name(k)}', got)
        path = Path(got[0].get('path', '')) if got else None
        body = path.read_text(encoding='utf-8', errors='replace') if path and path.is_file() else ''
        check(NO[k] in body and path.name.startswith(save_name(k)[:-4]) and path.parent == dl_dir / '订单分拣-发票',
              f'{k} 单实际存成「订单分拣-发票/{save_name(k)}」，文件内容就是这单的发票（没张冠李戴）',
              f'path={got[0].get("path") if got else None!r}，内容={body[:60]!r}')
    check(set(dl) == {NO['A'], NO['E']}, '只下载了 A、E 两单（B 抬头不对不下载）', sorted(dl))
    app.wait_for_timeout(500)
    rows = inv_rows()
    check(all(rows.get(NO[k], {}).get('st') == '已下载' for k in 'AE'), 'A、E 变成「已下载」', {k: rows.get(NO[k], {}).get('st') for k in 'AE'})

    print('\n[5] 给 H 单挂上 PDF（卖家发到邮箱的）')
    pdf = tmp / '邮件附件.pdf'
    pdf.write_bytes(b'%PDF-1.4\n% fictional test invoice H\n%%EOF\n')
    app.set_input_files(f'input[data-inv="attach"][data-no="{NO["H"]}"]', str(pdf))
    h = wait_until(app, lambda: (r := inv_rows().get(NO['H'], {})) and r.get('st') == '已下载' and r, 10) or inv_rows().get(NO['H'], {})
    check(h.get('st') == '已下载' and save_name('H') in h.get('detail', ''), f'H 变成「已下载」，文件名 {save_name("H")}', h)
    check(NO['H'] not in (store('dlDone') or {}), '扩展自己发起的「挂上 PDF」下载没被后台当成淘宝页的下载改名')
    rows = inv_rows()
    final = dict(AFTER_SCAN, A='已下载', E='已下载', H='已下载')
    wrong = {k: rows.get(NO[k], {}).get('st') for k in LAB if rows.get(NO[k], {}).get('st') != final[k]}
    check(not wrong, '最后每单状态都对', f'{wrong}' + ('（' + F_HINT + '）' if wrong.keys() == {'F'} else ''))

    print('\n[6] 页面打开后才慢慢出表格（真实页面是异步加载的）')
    for pg in [pg for pg in ctx.pages if pg.url.startswith(INV_URL)]:
        inv_clicks += pg.evaluate('window.__mock.clicks')
        pg.close()
    app.evaluate('() => chrome.storage.local.remove("invSync").then(() => chrome.storage.local.get("invJobs"))'
                 '.then(r => chrome.storage.local.set({ invJobs: Object.assign({}, r.invJobs, { sync: Date.now() }) }))')
    slow = watch(ctx.new_page(), '慢加载的全部发票页')
    slow.goto(INV_URL + '?delay=2000')
    s2 = wait_until(app, lambda: store('invSync'), 90) or {}
    check(set(s2.get('rows', {})) == set(rows_all := (sync or {}).get('rows', {})) and rows_all,
          '全部发票页 2 秒后才出表格：领到的同步活照样读全，不写回空结果',
          f'读到 {len(s2.get("rows", {}))} 单，应为 {len(rows_all)} 单；写回时页面渲染过的页 {slow.evaluate("window.__mock.log")}'
          '（是空的就说明 invoice-list.js 领到活马上就读，没等表格出来：找不到标签就跳过，最后把空结果写回 invSync）')

    print('\n[6b] 检查开票情况：点一次，依次同步 → 看卖家回复 → 下载，不用再点别的')
    for pg in [pg for pg in ctx.pages if pg.url.startswith(INV_URL) or '/app/im/' in pg.url]: pg.close()
    at = lambda k: app.evaluate('k => chrome.storage.local.get(k).then(r => r[k] ? r[k].at : 0)', k)
    s0, c0 = at('invSync'), at('chatScan')
    app.bring_to_front()
    app.click('#inv-auto')
    s1 = wait_until(app, lambda: (v := at('invSync')) != s0 and v, 120)
    check(bool(s1), '① 同步发票状态：写回了新的 invSync')
    c1 = wait_until(app, lambda: (v := at('chatScan')) != c0 and v, 180)
    check(bool(c1) and c1 > (s1 or 0), '② 同步完自动去旺旺看卖家回复：写回了新的 chatScan（在同步之后）')
    app.bring_to_front()
    toast = wait_until(app, lambda: (t := app.inner_text('#toast')) and ('下载' in t) and t, 20) or app.inner_text('#toast')
    check('下载' in toast, '③ 看完回复自动进入下载这一步', toast)

    print('\n[7] 杂项')
    all_clicks = [c for pg in ctx.pages if pg.url.startswith(INV_URL) for c in pg.evaluate('window.__mock.clicks')] + inv_clicks
    check(all(PAGE_OK.match(c) for c in all_clicks), '全部发票页上只点了标签、翻页、下载（没点申请开票 / 撤销申请 / 换开）',
          [c for c in all_clicks if not PAGE_OK.match(c)])
    sent = [s for pg in ctx.pages for fr in pg.frames if '/chat-core/' in fr.url for s in fr.evaluate('window.__mock.sent')]
    check(not sent, '所有旺旺页都没碰输入框和「发送」', sent)
    check(not errors, '页面没有报错', errors)
    check(not dialogs, '没有弹窗', dialogs)
    outside = [u for u in blocked if not u.endswith('/favicon.ico')]
    check(not outside, f'拦下的外部请求 {len(blocked)} 个，只有模拟页的 favicon', outside[:5])

    print('\n[8] 给卖家发消息：插件逐家打开、把消息填进输入框，不替用户点发送；用户发了自动开下一家')
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url]: pg.close()
    app.evaluate('s => chrome.storage.local.get("scraped").then(r => chrome.storage.local.set({ scraped: Object.assign(r.scraped || {}, s) }))',
                 {NO['H']: {'no': NO['H'], 'nick': '某某虚构轴承', 'lines': [{'title': '深沟球轴承 608'}]}})
    # 轴承那单前面已经当成卖家发来的文件下载了：清掉下载记录，让它回到「需找卖家」
    app.evaluate('no => chrome.storage.local.get("dlDone").then(r => { const d = Object.assign({}, r.dlDone); delete d[no]; return chrome.storage.local.set({ dlDone: d }); })', NO['H'])
    app.evaluate('''no => { const S = JSON.parse(localStorage.getItem('orderTriage.app.v1')); delete S.invFiles[no];
                         localStorage.setItem('orderTriage.app.v1', JSON.stringify(S)); }''', NO['H'])   # 前面「挂上 PDF」挂的也清掉
    app.reload(); app.wait_for_timeout(1500)
    app.click('#seg-cat button[data-cat="invoice"]'); app.wait_for_timeout(500)
    label = app.inner_text('#inv-ask')
    check('2 家' in label, '「给卖家发消息」：卖家要邮箱的碳纤维加工 + 需找卖家的轴承，共 2 家', label)
    app.click('#inv-ask'); app.wait_for_selector('#dlg-ask[open]', timeout=60000); app.click('#ask-manual')

    def core_of(name):
        for pg in ctx.pages:
            if '/app/im/' not in pg.url: continue
            for fr in pg.frames:
                try:
                    if '/chat-core/' in fr.url and fr.evaluate('document.querySelector(".ww_header .name") && document.querySelector(".ww_header .name").textContent') == name:
                        return fr
                except Exception:
                    pass
        return None

    def filled(name):
        fr = core_of(name)
        return fr and (t := fr.evaluate('document.querySelector(".editBox pre.edit[contenteditable=true]").innerText')) and (fr, t)

    got = wait_until(app, lambda: filled('某某虚构碳纤维加工'), 20)
    check(bool(got) and NO['G'] in got[1] and '税号' in got[1] and '（26.8.18，¥88）' in got[1], '第 1 家碳纤维加工：输入框里填好了订单号、日期金额、抬头税号', got and got[1])
    fr = got[0] if got else None
    if fr:
        fr.page.wait_for_timeout(1500)
        check('点了发送' not in fr.evaluate('window.__mock.sent'), '插件没有替用户点「发送」', fr.evaluate('window.__mock.sent'))
        check('请核对后自己点「发送」' in fr.inner_text('div[style*="2147483647"]'), '面板提示用户自己核对、点发送', fr.inner_text('div[style*="2147483647"]'))
        fr.click('.send-btn')                                  # 用户点发送
    nxt = wait_until(app, lambda: filled('某某虚构轴承'), 20)
    check(bool(nxt) and NO['H'] in nxt[1], '发完自动打开第 2 家轴承（从没聊过，按旺旺名打开），消息也填好了', nxt and nxt[1])
    if nxt:
        nxt[0].click('div[style*="2147483647"] button[data-otp="skip"]')     # 这家用户不想发
        done = wait_until(app, lambda: '都处理完了' in (t := nxt[0].inner_text('div[style*="2147483647"]')) and t, 10)
        check(bool(done) and '发了 1 家' in done and '跳过 1 家' in done, '跳过第 2 家后结束：发了 1 家、跳过 1 家', done)
    sent = app.evaluate('chrome.storage.local.get("askSent").then(r => r.askSent || {})')
    check(set(sent) == {NO['G']}, '只把真发了的那单记成「已发消息」', sent)
    app.bring_to_front(); app.wait_for_timeout(800)
    rows = app.evaluate("() => Object.fromEntries([...document.querySelectorAll('.inv-table tbody tr')].map(r => [r.innerText.match(/\\d{19}/)?.[0], r.innerText.replace(/\\s+/g, ' ')]))")
    check('已发消息要发票' in (rows.get(NO['G']) or '') and '需找卖家' in (rows.get(NO['H']) or ''),
          '主页：发过的碳纤维加工变成「已发消息要发票，等回复」，跳过的轴承还是「需找卖家」', {k: rows.get(NO[k]) for k in 'GH'})

    print('\n[8b] 消息填好后会话被切到别家：插件马上清掉输入框里的字并停下（2026-10-04 真实页面上消息出现在了别家）')
    skipped_txt = (core_of('某某虚构轴承') or app).evaluate('(document.querySelector(".editBox pre.edit[contenteditable=true]") || {}).innerText || ""')
    check(not skipped_txt.strip(), '[8] 里点了「跳过这家」：填的消息清掉了，没留在输入框里', skipped_txt)
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url]: pg.close()
    app.bring_to_front(); app.reload(); app.wait_for_timeout(1500)
    app.click('#seg-cat button[data-cat="invoice"]'); app.wait_for_timeout(500)
    app.click('#inv-ask'); app.wait_for_selector('#dlg-ask[open]', timeout=60000); app.click('#ask-manual')
    got = wait_until(app, lambda: filled('某某虚构轴承'), 20)
    check(bool(got), '轴承这家的消息填好了', got and got[1])
    if got:
        fr = got[0]
        pnl = fr.inner_text('div[style*="2147483647"]')
        check('深沟球轴承 608' in pnl and '¥15' in pnl and fr.evaluate("document.querySelectorAll('div[style*=\"2147483647\"] img').length") >= 1,
              '卡片上显示这单的商品（标题、金额、商品图）', pnl)
        fr.click('.conversation-item:has-text("某某虚构零食铺") .name')
        ok = wait_until(app, lambda: '为了不发错人' in fr.inner_text('div[style*="2147483647"]'), 10)
        txt = fr.evaluate('document.querySelector(".editBox pre.edit[contenteditable=true]").innerText')
        check(bool(ok) and not txt.strip(), '切到零食铺后：输入框里的字清掉了，面板说停下了', {'输入框': txt, '面板': fr.inner_text('div[style*="2147483647"]')})
        check('点了发送' not in fr.evaluate('window.__mock.sent')[-3:], '没有发出去')
        check(not app.evaluate('chrome.storage.local.get("chatQueue").then(r => r.chatQueue || null)'), '队列清掉了，不会再自己往下走')

    print('\n[8c] 确认清单后自动发送：弹窗列出店铺和要发的话；点「确认，自动发送」后插件自己点发送，不用人点')
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url]: pg.close()
    app.evaluate('no => chrome.storage.local.get("askSent").then(r => { const a = Object.assign({}, r.askSent); delete a[no]; return chrome.storage.local.set({ askSent: a }); })', NO['H'])
    app.bring_to_front(); app.reload(); app.wait_for_timeout(1500)
    app.click('#seg-cat button[data-cat="invoice"]'); app.wait_for_timeout(500)
    app.click('#inv-ask'); app.wait_for_selector('#dlg-ask[open]', timeout=60000)
    lst = app.inner_text('#ask-list')
    check('某某虚构轴承' in lst and NO['H'] in lst and '税号' in lst, '确认窗口列出了店铺、订单号和要发的话', lst[:200])
    app.click('#ask-auto')
    ok = wait_until(app, lambda: (v := app.evaluate('chrome.storage.local.get("askSent").then(r => r.askSent || {})')) and NO['H'] in v and v, 40)
    fr = core_of('某某虚构轴承')
    sent_h = fr.evaluate('window.__mock.posted || []') if fr else []
    check(bool(ok) and any(NO['H'] in p['text'] for p in sent_h), '插件自己点了发送，消息发到了轴承这家', sent_h[-1:] if sent_h else None)

    print('\n[9] 旺旺只留一个聊天页：新开的把旧的关掉；剩下的「连接断开」就自己刷新')
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url]: pg.close()
    a = ctx.new_page(); a.goto('https://market.m.taobao.com/app/im/chat/index.html'); a.wait_for_timeout(2500)
    b2 = ctx.new_page(); b2.goto('https://market.m.taobao.com/app/im/chat/index.html?second=1'); b2.wait_for_timeout(2500)
    check(a.is_closed() and not b2.is_closed(), '开第二个旺旺页时，第一个被关掉（淘宝同时只能连一个）', [pg.url for pg in ctx.pages if '/app/im/' in pg.url])
    core = next(fr for fr in b2.frames if '/chat-core/' in fr.url)
    core.evaluate("window.__beforeReload = 1; const d = document.createElement('div'); d.className = 'next-message-title'; d.textContent = '连接断开'; document.body.appendChild(d)")
    reloaded = wait_until(b2, lambda: (c := next((fr for fr in b2.frames if '/chat-core/' in fr.url), None)) and not c.evaluate('window.__beforeReload || 0'), 20)
    check(bool(reloaded), '剩下的这个出现「连接断开」后自己刷新了')

    print('\n[10] 卖家发的是税务局发票二维码：插件打开那个地址，核对抬头、税号、金额，点「PDF下载」，按订单存好，关掉页面')
    check(any(o.get('nick') == '某某虚构传感器店' for o in app.evaluate("JSON.parse(localStorage.getItem('orderTriage.app.v1')).orders")),
          '检查开票情况前，不知道旺旺名的传感器店：插件开订单详情页，从旺旺图标读到了旺旺名')
    app.evaluate('''() => chrome.storage.local.get('chatScan').then(r => { const c = r.chatScan; const k = Object.keys(c.convs).find(n => n.includes('传感器'));
        c.convs[k].images = [{ time: '2026-08-15 20:05:30', src: 'https://img.alicdn.com/mock/qr-dppt-106.png' }]; c.at = Date.now(); return chrome.storage.local.set({ chatScan: c }); })''')
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url or INV_URL in pg.url]: pg.close()
    app.bring_to_front(); app.reload(); app.wait_for_timeout(1500)
    app.click('#seg-cat button[data-cat="invoice"]'); app.wait_for_timeout(500)
    app.evaluate("document.querySelector('details.more').open = true")
    app.click('#inv-dl-all')
    got = wait_until(app, lambda: (d := store('dlDone')) and d.get(NO['F']), 40) or []
    check(len(got) == 1 and got[0].get('from') == 'qr' and got[0].get('file') == save_name('F'), f'F 单按二维码下载，建议文件名 {save_name("F")}', got)
    path = Path(got[0].get('path', '')) if got else None
    body = path.read_text(encoding='utf-8', errors='replace') if path and path.is_file() else ''
    check(NO['F'] in body and path.parent == dl_dir / '订单分拣-发票' and path.name.startswith(save_name('F')[:-4]),
          'F 单实际存进「订单分拣-发票」，按订单改了名（原名是 dzfp_<发票号>_…），内容就是这张票', f'path={path}，内容={body[:60]!r}')
    closed = wait_until(app, lambda: not [pg for pg in ctx.pages if 'chinatax' in pg.url], 10)
    check(bool(closed), '下完后税务局页面自己关掉了', [pg.url for pg in ctx.pages if 'chinatax' in pg.url])

    print('\n[11] 插件自己提醒还有多少单没拿到发票：主页顶上的进度条 + 工具栏插件图标上的数字')
    app.bring_to_front(); app.reload(); app.wait_for_timeout(1500)
    txt = app.inner_text('#remind')
    pend = app.evaluate("chrome.storage.local.get('invPending').then(r => r.invPending)")
    n = pend and pend.get('n')
    frac = re.search(r'发票（已拿到 / 应开）\s*(\d+)\s*/\s*(\d+)\s*单', txt)
    check(bool(n) and bool(frac) and int(frac.group(2)) - int(frac.group(1)) == n and f'还差 {n} 单' in txt,
          f'进度条：发票「已拿到 / 应开」两数相差 {n}，写着还差 {n} 单', txt[:300])
    check('要你处理' in txt and '等待中' in txt and '待下载' in txt, '进度条按「要你处理 / 等待中 / 待下载」分开计数', txt[:300])
    badge = app.evaluate('chrome.action.getBadgeText({})')
    check(badge == str(n), f'插件图标上显示 {n}', badge)
    app.click('#remind [data-goto="invoice"]'); app.wait_for_timeout(500)
    check(app.locator('#inv-bar:not([hidden])').count() == 1, '点进度条上的发票跳到发票栏')

    print('\n[12] 找淘宝官方人工客服督促：先发「人工」直到转人工，再一单一句督促；转人工之前一句督促的话都不发')
    label = app.inner_text('#inv-vip')
    n_vip = int(re.search(r'（(\d+) 单）', label).group(1)) if re.search(r'（(\d+) 单）', label) else 0
    check(n_vip >= 1, '发票栏有「找客服督促（N 单）」，N 是超过 7 天还没开票的单', label)
    expect = app.evaluate("chrome.storage.local.get('invPending').then(r => r.invPending)")
    app.click('#inv-vip')
    core = lambda: next((pg for pg in ctx.pages if 'alimebot' in pg.url), None)
    done = wait_until(app, lambda: (pg := core()) and len([t for t in pg.evaluate('window.__mock.sent') if '督促' in t]) >= n_vip and pg, 60)
    pg = done or core()
    m = pg.evaluate('window.__mock') if pg else {}
    urge = [t for t in m.get('sent', []) if '督促' in t]
    check(m.get('clicked') == 1 and m.get('sent', [])[:2] == ['人工', '人工'], '先连发「人工」，看到「立即联系」点了一次', m.get('sent', [])[:4])
    check(not m.get('early'), '转人工之前一句督促的话都没发（以前聊天记录里的「人工客服」没被当成这次转人工）', m.get('early'))
    check(len(urge) == n_vip and all(re.fullmatch(r'你好，订单号\d{19}隔了\d+天要求开发票到现在还没开出，发票抬头：某大学，税号：121000009999999996，麻烦官方客服帮我督促开票', t) for t in urge),
          f'转人工后发了 {n_vip} 句，用的是用户的话术', urge[:2])
    sent = wait_until(app, lambda: (v := app.evaluate("chrome.storage.local.get('vipSent').then(r => r.vipSent || {})")) and len(v) == n_vip and v, 10)
    check(bool(sent), '插件记下了哪几单督促过', sent)
    app.bring_to_front(); app.wait_for_timeout(800)
    check('（0 单）' in app.inner_text('#inv-vip'), '督促过的 7 天内不再督促：按钮变成 0 单', app.inner_text('#inv-vip'))
    check('找客服督促过' in app.inner_text('#list'), '发票栏里写着哪天找客服督促过')
    # 发完以后：客服问要不要投诉 → 插件回「OK」；客服发「提交投诉」卡片 → 插件点
    got = wait_until(app, lambda: (pg2 := core()) and pg2.evaluate('window.__mock.complained || 0') and pg2, 30)
    m = (got or core()).evaluate('window.__mock')
    check(m.get('complained') == 1 and m.get('sent', []).count('OK') == 1, '客服问「发起投诉…您看可以吗」，插件回了「OK」；「提交投诉」按钮点了一次', (m.get('complained'), m.get('sent', [])[-3:]))
    pnl = (got or core()).inner_text('div[style*="2147483647"]')
    check('已点「提交投诉」' in pnl and '已回复「OK」' in pnl, '卡片上写明回了 OK、点了提交投诉', pnl)

    print('\n[13] 整理成报销文件：选下载好的发票文件夹 → 预览新文件名 → 生成「订单分拣-报销/…」文件夹、汇总表和压缩包；原文件不动')
    import zipfile
    src = dl_dir / '订单分拣-发票'
    before = sorted(x.name for x in src.iterdir())
    app.bring_to_front(); app.click('#seg-cat button[data-cat="invoice"]'); app.wait_for_timeout(500)
    app.evaluate("document.querySelector('details.more').open = true")
    app.set_input_files('#inv-pack-dir', str(src))
    app.wait_for_selector('#dlg-pack[open]', timeout=10000)
    plan = app.input_value('#pack-list')
    names = [l.split('    ←')[0] for l in plan.split('\n') if '    ← ' in l]
    pat = re.compile(r'\d+(\+\d+)*_\d{6}_\d+\.\d{2}-.+-\d+件\.(pdf|ofd|xml)')
    check(names and all(pat.fullmatch(n) for n in names), f'预览了 {len(names)} 个新文件名，格式是「序号_开票日期_金额-商品摘要-数量件」', names[:3])
    app.fill('#pack-name', '测试批'); app.click('#pack-go')
    out = dl_dir / '订单分拣-报销'
    zp = wait_until(app, lambda: out.is_dir() and (z := [x for x in out.iterdir() if x.suffix == '.zip' and not x.name.endswith('.crdownload')]) and z[0], 30)
    folder = [x for x in out.iterdir() if x.is_dir()] if out.is_dir() else []
    inside = sorted(x.name for x in folder[0].iterdir()) if folder else []
    check(bool(folder) and folder[0].name.startswith('测试批_') and '汇总.csv' in inside and len(inside) == len(names) + 1,
          '下载文件夹里多了「订单分拣-报销/测试批_日期_合计金额/」：改好名的发票 + 汇总.csv', inside)
    ok_zip = False
    if zp:
        app.wait_for_timeout(1000)
        with zipfile.ZipFile(zp) as z:
            ok_zip = z.testzip() is None and len(z.namelist()) == len(names) + 1 and any(n.endswith('汇总.csv') for n in z.namelist())
    check(ok_zip, '同名压缩包能正常打开，里面也是这些文件', zp and zp.name)
    csv_txt = (folder[0] / '汇总.csv').read_text(encoding='utf-8-sig') if folder else ''
    check('合计' in csv_txt and '还没有发票的实验室订单' in csv_txt, '汇总表里有合计，最后列出还没有发票的实验室订单', csv_txt[:120])
    check(sorted(x.name for x in src.iterdir()) == before, '原来的「订单分拣-发票」文件夹一个文件都没变')

    print('\n[14] 每天自动处理：后台到点打开主页（带 #auto），主页自己点「检查开票情况」')
    app.goto(f'chrome-extension://{eid}/index.html#auto')
    app.reload()                                       # 后台也是改地址后再刷新（只改 # 不会重新加载）
    t = wait_until(app, lambda: re.search('每天自动处理|检查开票情况', app.inner_text('#toast')) and app.inner_text('#toast'), 15)
    check(bool(t), '打开 #auto 的主页后自动开始检查开票情况', app.inner_text('#toast'))
    check('#auto' not in app.url, '跑过以后地址里的 #auto 去掉了（刷新不会再跑一次）', app.url)
    ctx.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix='order-triage-inv-'))
    try:
        with sync_playwright() as p:
            run(p, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)        # 连同测试浏览器的配置目录（localStorage、扩展存储、下载的假发票）一起删掉
    print('\n' + ('全部通过' if not fails else f'{len(fails)} 项失败：\n  ' + '\n  '.join(fails)))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
