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
from urllib.parse import quote, unquote, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]          # 项目根目录本身就是扩展
TOOLS = ROOT / 'tools'
INV_URL = 'https://i.taobao.com/my_itaobao/invoice'
# 网址前缀 → 回应成哪个模拟页
MOCKS = [(INV_URL, 'mock-invoice.html'),
         ('https://market.m.taobao.com/app/im/chat/index.html', 'mock-chat.html'),
         ('https://market.m.taobao.com/app/im/chat-core/', 'mock-chat-core.html'),
         ('https://trade.taobao.com/trade/detail/', 'mock-detail.html'),               # 订单详情页：旺旺图标上有卖家旺旺名
         ('https://trade.tmall.com/detail/', 'mock-detail.html'),                      # 天猫店的订单详情（淘宝详情页地址会重定向到这里）
         ('https://trade.taobao.com/trade/confirm_goods', 'mock-detail.html'),         # 确认收货的确认页（地址是假设的，待真实页面核对）
         ('https://dppt.zhejiang.chinatax.gov.cn:8443/', 'mock-qr.html'),                # 税务局电子发票页（卖家发的二维码）
         ('https://ai.alimebot.taobao.com/', 'mock-alime.html')]                         # 淘宝官方客服（找 88VIP 人工客服督促）
TITLE, TAX = '某大学', '121000009999999996'
NAME, SID = '张三', '12345678'                          # 虚构的报销人（整理报销文件的文件夹名「学号_姓名_总金额元」）

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
# [17] 另导入的一批（下载的发票核对与整理）：同店合开、挪到同店另一单、不是发票、少 1 元以上、按用券前价格开、部分退款
X17 = {
    'M1': ('5190000000000000121', '2026-09-02', '交易成功', '某某虚构合开店', '10.00', [('杜邦线 母对母 40P', '20cm', 1, '10.00')]),
    'M2': ('5190000000000000122', '2026-09-03', '交易成功', '某某虚构合开店', '15.00', [('杜邦线 公对公 40P', '30cm', 1, '15.00')]),
    'V1': ('5190000000000000128', '2026-09-04', '交易成功', '某某虚构挪单店', '20.00', [('热缩管 套装', '黑色', 1, '20.00')]),
    'V2': ('5190000000000000129', '2026-09-05', '交易成功', '某某虚构挪单店', '66.00', [('热风枪 858D', '标准款', 1, '66.00')]),
    'N1': ('5190000000000000123', '2026-09-06', '交易成功', '某某虚构说明书店', '30.00', [('USB 示波器 入门款', '标准款', 1, '30.00')]),
    'S1': ('5190000000000000124', '2026-09-07', '交易成功', '某某虚构少票店', '50.00', [('焊台 936 恒温', '标准款', 1, '50.00')]),
    'C1': ('5190000000000000125', '2026-09-08', '交易成功', '某某虚构券店', '10.00', [('XT30 插头 公母', '一对', 1, '10.00')]),
    'P2': ('5190000000000000126', '2026-09-08', '交易成功', '某某虚构券店', '10.50', [('牙膏 家庭装', '3支', 1, '10.50')]),      # 个人
    'R1': ('5190000000000000127', '2026-09-09', '交易成功', '某某虚构价保店', '9.90', [('防静电镊子', 'ESD-15', 1, '9.90')]),   # 详情页：退了 5.00
    # [17c] 读旺旺：按旺旺名打开、标题显示店名；会话打不开；旺旺页改版读不出消息
    'W1': ('5190000000000000131', '2026-09-11', '交易成功', '某某虚构店名会话', '12.00', [('万用表 表笔', '一对', 1, '12.00')]),
    'W2': ('5190000000000000132', '2026-09-11', '交易成功', '某某虚构打不开店', '13.00', [('鳄鱼夹 测试线', '10 根', 1, '13.00')]),
    'W3': ('5190000000000000133', '2026-09-12', '交易成功', '某某虚构改版店', '14.00', [('排针 2.54mm', '40P', 1, '14.00')]),
}
NICK17 = {'W1': 'nick店名会话', 'W2': 'nick打不开', 'W3': 'nick改版'}
# [18] 天猫订单先确认收货、再申请平台开票（用户 2026-10-09）：卖家已发货的实验室订单
#   K1 天猫（订单列表上认出）、已签收 → 确认收货；K2 天猫、运输中 → 不确认；K3 列表上认不出天猫（详情页跳到 trade.tmall.com）、已签收，
#   确认页上有密码框 → 插件停下等用户；K4 不是天猫、已签收 → 不确认
X18 = {
    'K1': ('5190000000000000141', '2026-09-20', '卖家已发货', '某某虚构天猫型材', '36.00', [('虚构 铝型材 2020 黑色', '300mm', 1, '36.00')]),
    'K2': ('5190000000000000142', '2026-09-21', '卖家已发货', '某某虚构天猫五金', '18.00', [('虚构 内六角扳手 套装', '9 支', 1, '18.00')]),
    'K3': ('5190000000000000143', '2026-09-22', '卖家已发货', '某某虚构天猫电子', '25.00', [('虚构 面包板 830 孔', '1 块', 1, '25.00')]),
    'K4': ('5190000000000000144', '2026-09-23', '卖家已发货', '某某虚构淘宝小店', '12.00', [('虚构 热熔胶棒 7mm', '20 根', 1, '12.00')]),
}
N18 = {k: v[0] for k, v in X18.items()}
N17 = {k: v[0] for k, v in X17.items()}
INVOICE_HTML = '''<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">
<h2>电子发票（普通发票）</h2><p>发票号码：{inv}</p><p>开票日期：{y}年{m}月{d}日</p>
<p>购买方信息 名称：某大学 统一社会信用代码/纳税人识别号：121000009999999996</p><p>销售方信息 名称：某某虚构商店</p>
<p>项目名称 虚构商品 金额 ¥{a1} 税额 ¥{a2}</p><p>价税合计（小写）¥{amt}</p></body>'''


def make_pdfs(p):
    """虚构发票 PDF（浏览器现场打印），按发票号给出：O 里每单一张（金额 = 实付；末尾注释写着订单号，测试核对下载的文件用），
    以及 [17] 那一批的几张。返回 {发票号: PDF 字节}"""
    b = p.chromium.launch()
    pg = b.new_page()

    def mk(inv, date, amt, no='', html=None):
        y, m, d = date.split('-')
        pg.set_content(html or INVOICE_HTML.format(inv=inv, y=y, m=m, d=d, amt=f'{amt:.2f}', a1=f'{amt * 0.9:.2f}', a2=f'{amt * 0.1:.2f}'))
        return pg.pdf() + f'\n%虚构测试发票 订单 {no} 发票号 {inv}\n'.encode()
    out = {}
    for k, (no, d, _, _, pay, _) in O.items():
        inv = '2644200000000000' + no[-4:]
        day = '2026-08-09' if k == 'A' else d[:8] + f'{min(28, int(d[8:]) + 3):02d}'
        out[inv] = mk(inv, day, float(pay), no)
    for inv, date, amt in (('26990000000000000121', '2026-09-06', 25.0), ('26990000000000000128', '2026-09-10', 66.0),
                           ('26990000000000000124', '2026-09-10', 45.0), ('26990000000000000125', '2026-09-10', 10.5),
                           ('26990000000000000127', '2026-09-12', 4.9)):
        out[inv] = mk(inv, date, amt)
    out['26990000000000000123'] = mk('', '2026-09-10', 0, html='<meta charset="utf-8"><h2>USB 示波器 产品说明书</h2>'
                                     '<p>型号 X1，额定电压 5V，额定电流 1A。使用前请仔细阅读本说明书，按图连接探头后开机，保修一年。</p>')
    b.close()
    return out


def pdf_of(pdfs, inv):
    """发票号 → PDF：[17] 那几张按全号；O 里的按末 3 位对订单（模拟页上的发票号和这里起的不一样）"""
    if inv in pdfs:
        return pdfs[inv]
    return next((v for k, v in pdfs.items() if k.startswith('2644') and k[-3:] == inv[-3:]), None)
# 各阶段每单的发票状态（主页发票栏「发票」列的文字）
ASK = '需向卖家索要发票'
AFTER_SYNC = {'A': '已开票，待下载', 'B': '已开票，抬头不符', 'C': '已申请淘宝开票，等待商家开具', 'D': '可在淘宝平台申请', 'E': ASK,
              'F': ASK, 'G': ASK, 'H': ASK, 'I': ASK}
AFTER_SCAN = dict(AFTER_SYNC, E='卖家已发送文件', F='卖家已发送图片（可能为二维码）', G='卖家要求提供邮箱', I='已向卖家索要发票，等待回复')
# 该被点开的会话：发票栏里有订单的店（A 的店没聊过发票也算）；个人、已关闭、无关的店不该点
# 旺旺只看还需要卖家回复的单（需找卖家 / 已要过 / 卖家回了还没下）：A 已开票、B 抬头不对、C 申请中、D 能平台申请的店都不打开，
# 免得一大批店看到「已读」
CONV_OPEN = {'某某虚构电子元器件专营店', '某某虚构传感器店', '某某虚构碳纤维加工', '某某虚构焊工小王'}   # 焊接耗材的会话名是卖家旺旺名
# 「全部发票」页上允许点的按钮：标签、翻页、下载。点了「申请开票 / 撤销申请 / 换开」就是动了账号
PAGE_OK = re.compile(r'^(已开具发票|申请中发票|未申请|下一页|上一页|\d+|下载到本地)$')

F_HINT = 'F 不对多半和上面「二维码图片」那条是同一个原因'
# 发票栏图例和小标签有没有被裁字：图例不能被上面 sticky 的工具条盖住（没有负外边距），图例里没有裁切；
# 主页上设了 overflow 的元素，文字高度不能超过它自己的高度
CLIP_JS = '''() => { const out = [], lg = document.getElementById('inv-legend'), bar = document.getElementById('bar');
    window.scrollTo(0, 0);
    const b = bar.getBoundingClientRect(), l = lg.getBoundingClientRect();
    if (l.top < b.bottom - 0.5) out.push('图例顶部 ' + l.top.toFixed(1) + ' 在工具条底部 ' + b.bottom.toFixed(1) + ' 之上');
    if (parseFloat(getComputedStyle(lg).marginTop) < 0) out.push('图例的上外边距是负的');
    for (const s of lg.querySelectorAll('span')) { if (!s.textContent.trim()) continue; const r = s.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 30), r.top + 1);
      if (!hit || !lg.contains(hit)) out.push(s.textContent.trim() + '：上沿被 ' + (hit ? (hit.id || hit.className || hit.tagName) : '空白') + ' 盖住'); }
    for (const el of [lg, ...lg.querySelectorAll('*')]) { const cs = getComputedStyle(el); if (cs.overflowY !== 'visible') out.push(el.tagName + ' 裁切 overflow=' + cs.overflowY); }
    for (const el of document.querySelectorAll('#main *, header *')) { const cs = getComputedStyle(el);
      if (cs.overflowY === 'visible' || !el.textContent.trim() || !el.offsetParent || el.matches('.tbl-wrap, .list, .ask-list')) continue;
      if (el.scrollHeight > el.clientHeight + 1) out.push((el.className || el.tagName) + '：文字高 ' + el.scrollHeight + '，框高 ' + el.clientHeight); }
    return out; }'''
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


def write_csv(path, orders=None):
    # 淘宝导出表的样子：一单多件时，后续行订单号（和整单字段）留空
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['订单号', '订单提交时间', '订单状态', '店铺名称', '商品名称', '型号款式', '商品数量', '商品金额', '实付金额', '运费'])
        for no, d, st, shop, pay, items in (orders or O).values():
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


def fake_oss(tmp, pdfs):
    # 假的「阿里云发票文件」服务器：扩展自己发起的下载不走 ctx.route，只能让浏览器把这个域名解析到本机。
    # 用自签证书起 https（浏览器加 --ignore-certificate-errors），回应虚构发票 PDF（末尾注释写着是哪一单），照样不联网
    import http.server, ssl, subprocess, threading
    key, crt = tmp / 'oss.key', tmp / 'oss.crt'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=einvoice-file.oss-cn-beijing.aliyuncs.com',
                    '-keyout', str(key), '-out', str(crt)], check=True, capture_output=True)

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            m = re.match(r'/mock/OSTB_(\d+)\.pdf', self.path)
            body = m and pdf_of(pdfs, m.group(1))
            if not body:
                self.send_error(404); return
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
    pdfs = make_pdfs(p)
    oss = fake_oss(tmp, pdfs)
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
        if m and pdf_of(pdfs, m.group(1)):              # 模拟阿里云上的发票文件：虚构发票 PDF，末尾注释写着是哪一单
            return route.fulfill(status=200, content_type='application/pdf', body=pdf_of(pdfs, m.group(1)))
        if url.startswith('https://consumerservice.taobao.com/online-help'):      # 官方客服入口：真实页面会跳到 alimebot
            return route.fulfill(status=200, content_type='text/html; charset=utf-8',
                                 body='<meta charset="utf-8"><script>location.replace("https://ai.alimebot.taobao.com/intl/index.htm?from=mock")</script>')
        # 天猫店：淘宝订单详情页的地址会被重定向到 trade.tmall.com/detail/orderDetail.htm（2026-10-05 实测），A 单这样模拟
        for tm in (O['A'][0], N18['K3']):
            if url.startswith('https://trade.taobao.com/trade/detail/') and tm in url:
                return route.fulfill(status=302, headers={'Location': 'https://trade.tmall.com/detail/orderDetail.htm?biz_order_id=' + tm + '&forward_action='})
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
    app.fill('#person-name', NAME); app.fill('#person-sid', SID)
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

    app.click('.flow li[data-step="2"]')            # 第 3 步「处理发票」：下方显示发票表
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

    check_status({k: ASK for k in LAB}, '发票栏列出 9 单（没有牙膏、没有关闭的单），还没同步时都是「需向卖家索要发票」')

    print('\n[2] 同步发票状态（「全部发票」模拟页）')
    with ctx.expect_page() as pi:
        app.evaluate('() => { __otDev.sync(); }')        # 界面上只有「自动处理发票」一个按钮；这里单独测其中的同步这一段
    inv = pi.value
    t0 = time.time()
    sync = wait_until(app, lambda: store('invSync'), 120)
    print(f'  同步用时 {time.time() - t0:.0f} 秒；面板：' + inv.inner_text('div[style*="2147483647"]').replace('\n', ' | '))
    check(bool(sync), '同步这一段：打开全部发票页，120 秒内写回 invSync')
    rows = (sync or {}).get('rows', {})
    log = inv.evaluate('window.__mock.log')
    inv_clicks = inv.evaluate('window.__mock.clicks')      # 插件开的这一页同步完 3 秒就关，先存下来
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
    check_status(AFTER_SYNC, '同步后主页状态：A 已开票待下载，B 抬头不符，C 已申请淘宝开票，D 可在淘宝平台申请，其余需向卖家索要发票')
    closed = wait_until(app, lambda: inv.is_closed(), 10)
    check(bool(closed), '插件开的「全部发票」页同步完自己关掉了')
    jt = app.evaluate("chrome.storage.session.get('jobTabs').then(r => r.jobTabs || {})")
    check(INV_URL in jt and store('jobTabs') is None, '派活开的标签页编号只记在 session 存储里（浏览器重启后不会拿旧编号去关用户的页面）', {'session': jt, 'local': store('jobTabs')})

    print('\n[3] 扫描旺旺里的发票回复（旺旺模拟页，聊天在 iframe 里）')
    with ctx.expect_page() as pi:
        app.evaluate('() => { __otDev.scan(); }')
    chat = pi.value
    t0 = time.time()
    scan = wait_until(app, lambda: store('chatScan'), 180)
    check(bool(scan), '读回复这一段：打开旺旺页，180 秒内写回 chatScan')
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
    check(not e.get('images') and not e.get('cards'), '卖家发票文件后面那张「安全提醒：检测到外部链接」系统卡片：不当成图片、不当成开票卡片，扫描照常读完',
          {k: e.get(k) for k in ('images', 'cards')})
    g = convs.get('某某虚构碳纤维加工', {})
    check(not g.get('images') and len(g.get('email', [])) == 1, '卖家推的商品卡片图片不当成二维码；要邮箱的话认出来了',
          {k: g.get(k) for k in ('images', 'email')})
    f = convs.get('某某虚构传感器店', {})
    check(len(f.get('images', [])) == 1, '卖家发的二维码图片认出来了（1 张）',
          f'images={f.get("images")}（如果是 []：chat.js readMsgs 里 img 过滤条件 !i.closest(\'[class*="item-"]\') '
          f'会命中外层 .message-item-line，所有图片都被滤掉）')
    app.wait_for_timeout(500)
    rows = check_status(AFTER_SCAN, '扫描后主页状态：E 卖家已发送文件，F 图片（二维码），G 要求提供邮箱，I 已向卖家索要等回复，H 仍需向卖家索要', F_HINT)
    # 「操作」列按状态只有一个主要操作（用户 2026-10-08）；I 单 09-11 索要、已过应开票截止日（10 日），所以是「找客服督促」而不是「催卖家」；C 单 09-02 申请、也已过截止日
    want_acts = {'A': '下载', 'B': '换开发票', 'C': '找客服督促', 'D': '申请开票', 'E': '下载', 'F': '下载', 'G': '回复邮箱', 'H': '索要发票', 'I': '找客服督促'}
    acts = {k: rows.get(NO[k], {}).get('btns') for k in LAB}
    check(all(acts[k] == [v] for k, v in want_acts.items()), '「操作」列每行只有一个主要操作：待下载 → 下载，抬头不符 → 换开发票，已申请 / 超期 → 找客服督促，可平台申请 → 申请开票，需索要 → 索要发票',
          {k: (acts[k], want_acts[k]) for k in LAB if acts[k] != [want_acts[k]]})
    add = app.evaluate("[...document.querySelectorAll('.inv-table tbody tr')].map(tr => { const a = tr.querySelector('.acts .add'); return a ? [a.textContent.trim(), a.className, getComputedStyle(a).fontSize] : null; })")
    check(add and all(a and a[0] == '手动添加发票' and 'btn' not in a[1] and float(a[2][:-2]) < 13 for a in add), '「手动添加发票」降为每行的小字链接，不和主要操作抢位置', add[:2])
    pb = app.evaluate("no => { const tr = [...document.querySelectorAll('.inv-table tbody tr')].find(tr => tr.innerText.includes(no)); return tr.querySelector('.st').tagName; }", NO['B'])
    check(pb == 'SPAN', '「抬头不符」的状态标签不再可点：和操作列的「换开发票」打开的是同一个页面，只留一个入口', pb)
    # 三种「等待」状态颜色各不相同，标签可点、悬停说明写着去哪
    pill = lambda k: app.evaluate("no => { const tr = [...document.querySelectorAll('.inv-table tbody tr')].find(tr => tr.innerText.includes(no)); const s = tr && tr.querySelector('.st'); "
                                  "return s ? { cls: s.className, tag: s.tagName, title: s.title, bg: getComputedStyle(s).backgroundColor } : {}; }", NO[k])
    pc, pi = pill('C'), pill('I')
    check('tone-plat' in pc.get('cls', '') and 'tone-wait' in pi.get('cls', '') and pc.get('bg') != pi.get('bg'),
          '「已申请淘宝开票」蓝色、「已向卖家索要发票」黄色，颜色不同', (pc, pi))
    check(pc.get('tag') == 'BUTTON' and '发票详情' in pc.get('title', '') and pi.get('tag') == 'BUTTON' and '旺旺' in pi.get('title', ''),
          '两个状态标签都可点：申请中 → 发票详情页，已索要 → 旺旺聊天（悬停说明写明去处）', (pc.get('title'), pi.get('title')))
    check(app.locator('#inv-legend:not([hidden])').count() == 1 and '已由淘宝客服督促' in app.inner_text('#inv-legend'), '发票栏顶上有颜色图例')
    # 图例文字不被裁：Windows 上微软雅黑的字身靠上，以前图例用负的上外边距贴到 sticky 工具条下面，每个字的上沿被盖掉一截（用户 2026-10-08）
    clip = app.evaluate(CLIP_JS)
    check(not clip, '颜色图例的文字完整显示：没被上面的工具条盖住，没有负外边距、固定高度或裁切；带 overflow 的小标签文字也没被裁', clip)
    # 换成 Windows 的微软雅黑（本机装了才有），再换一种上下留白故意放大的字体，各看一遍
    for name, css in (('微软雅黑', 'body,button,input{font-family:"Microsoft YaHei","Microsoft YaHei UI",sans-serif!important}'),
                      ('上下留白放大的字体', '@font-face{font-family:OtTall;src:local("Microsoft YaHei"),local("DejaVu Sans"),local("Noto Sans");ascent-override:130%;descent-override:45%}'
                                           ' body,button,input{font-family:OtTall,sans-serif!important}')):
        app.add_style_tag(content='/*ot-font*/' + css)
        app.wait_for_timeout(300)
        clip = app.evaluate(CLIP_JS)
        check(not clip, f'换成{name}后，图例和小标签的文字仍完整显示', clip)
        app.evaluate("document.querySelectorAll('style').forEach(s => { if (s.textContent.includes('ot-font')) s.remove(); })")
    note = app.inner_text('#inv-note')
    check(note.startswith('上次刷新 ') and '同步' not in app.inner_text('body'), '措辞：发票栏右侧写「上次刷新 时间」，界面上不再出现「同步」', note)

    by_url = [u for pg in ctx.pages if '/app/im/' in pg.url for fr in pg.frames if '/chat-core/' in fr.url for u in (fr.evaluate('window.__mock.byUrl || []'))]
    check('某某虚构碳纤维加工' in by_url or any('碳纤维' in k for k in (store('chatScan') or {}).get('convs', {})),
          '不在会话列表里的碳纤维加工：按卖家旺旺名用地址打开并读到了', by_url)
    g = (store('chatScan') or {}).get('convs', {}).get('某某虚构碳纤维加工', {})
    check(g.get('byNick') == '某某虚构碳纤维加工' and g.get('matched') is True, '按旺旺名打开的会话：右侧「我的订单」里有这一单（matched）', {k: g.get(k) for k in ('byNick', 'matched', 'orders')})

    print('\n[4] 下载全部待下载的发票（先关掉前面的两个页面：新开的页面要自己领到活）')
    for pg in (inv, chat):
        if not pg.is_closed(): pg.close()
    n_pages = len(pages)
    app.evaluate('() => { __otDev.download(); }')
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
    closed = wait_until(app, lambda: new[0].is_closed(), 20)
    check(bool(closed), '插件开的「全部发票」页下载完自己关掉了')
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
        ip = next((pg for pg in new if INV_URL in pg.url and not pg.is_closed()), None)
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

    print('\n[6c] 「全部发票」页认不出「已开具」标签的「下一页」：这个标签按没读完处理，不整份覆盖；主页红色标签写明只读了几个标签')
    for pg in [pg for pg in ctx.pages if pg.url.startswith(INV_URL)]: pg.close()
    s_prev = store('invSync') or {}
    app.evaluate('() => chrome.storage.local.get("invJobs").then(r => chrome.storage.local.set({ invJobs: Object.assign({}, r.invJobs, { sync: Date.now() }) }))')
    pn = watch(ctx.new_page(), '认不出下一页的全部发票页')
    pn.goto(INV_URL + '?nonext=issued')
    s3 = wait_until(app, lambda: (s := store('invSync')) and s.get('at') != s_prev.get('at') and s, 90) or {}
    kept = set(s_prev.get('rows', {})) - set(s3.get('rows', {}))
    check(s3.get('partial') is True and s3.get('tabs') == 2 and not kept, '「已开具」只读了第 1 页：记为不完整（读完 2 / 3 个标签），上次读到的第 2 页以后的记录没被清掉',
          {'partial': s3.get('partial'), 'tabs': s3.get('tabs'), '丢了': sorted(kept)})
    app.bring_to_front(); app.click('.flow li[data-step="2"]'); app.wait_for_timeout(500)
    note = app.inner_html('#inv-note')
    check('tone-bad' in note and '仅读取 2 / 3 个标签' in note, '发票栏「上次刷新」旁边：红色标签「仅读取 2 / 3 个标签」', note)
    if not pn.is_closed(): pn.close()

    print('\n[6d] 「我的发票」页出现安全验证：页面上写明原因（不弹窗），报给主页，主页这一段立即结束、写明原因')
    def inv_ls(js):
        pr = ctx.new_page(); pr.goto(INV_URL + '?probe=1'); pr.wait_for_timeout(500); pr.evaluate(js); pr.close()
    inv_ls("localStorage.setItem('mockVerify', '1')")
    t_v = time.time()
    rv = app.evaluate('__otDev.refresh()') or {}
    jf = store('jobFail') or {}
    check(rv.get('bad') and '安全验证' in rv.get('text', '') and time.time() - t_v < 90 and jf.get('stage') == 'sync',
          '安全验证：「我的发票」页报回失败，主页不等满 3 分钟就结束这一段，写明原因', {'结果': rv, '用时': round(time.time() - t_v), 'jobFail': jf})
    vp = next((pg for pg in ctx.pages if pg.url.startswith(INV_URL) and not pg.is_closed()), None)
    check(vp is not None and '安全验证' in vp.inner_text('div[style*="2147483647"]'), '「我的发票」页留着给用户处理，面板上写着原因', vp and vp.inner_text('div[style*="2147483647"]'))
    for pg in [pg for pg in ctx.pages if pg.url.startswith(INV_URL)]: pg.close()
    inv_ls("localStorage.removeItem('mockVerify')")

    print('\n[6b] 自动处理发票：点一次，依次同步 → 看卖家回复 → 列一张确认清单（只确认一次）；取消则只下载，不提交、不发送')
    for pg in [pg for pg in ctx.pages if pg.url.startswith(INV_URL) or '/app/im/' in pg.url]: pg.close()
    at = lambda k: app.evaluate('k => chrome.storage.local.get(k).then(r => r[k] ? r[k].at : 0)', k)
    s0, c0 = at('invSync'), at('chatScan')
    app.bring_to_front()
    app.evaluate("() => { window.__dlgN = 0; const o = HTMLDialogElement.prototype.showModal; HTMLDialogElement.prototype.showModal = function () { if (this.id === 'dlg-list') window.__dlgN++; return o.call(this); }; }")
    check(app.locator('#summary .flow-acts button').count() == 1 and app.inner_text('#summary .flow-acts') == '自动处理发票', '「处理发票」这一步只有一个按钮「自动处理发票」', app.inner_text('#summary .flow-acts'))
    t_run = app.evaluate('Date.now()')
    app.click('#summary [data-flow="inv-run"]')
    prog = wait_until(app, lambda: (t := app.inner_text('#summary')) and re.search(r'第 \d+ / 10 段：刷新淘宝开票记录 · .+ · 已等 \d+ 秒', t) and t, 60) or app.inner_text('#summary')
    check(bool(re.search(r'第 \d+ / 10 段：刷新淘宝开票记录 · .+ · 已等 \d+ 秒', prog)), '处理中步骤条下方显示分段进度：第几段、在等什么、已等多久', prog[:300])
    s1 = wait_until(app, lambda: (v := at('invSync')) != s0 and v, 120)
    check(bool(s1), '① 同步发票状态：写回了新的 invSync')
    c1 = wait_until(app, lambda: (v := at('chatScan')) != c0 and v, 180)
    check(bool(c1) and c1 > (s1 or 0), '② 同步完自动去旺旺看卖家回复：写回了新的 chatScan（在同步之后）')
    app.bring_to_front()
    dlg = wait_until(app, lambda: app.locator('#dlg-list[open]').count() and app.inner_text('#list-rows'), 120) or ''
    heads = app.evaluate("[...document.querySelectorAll('#list-rows h4.grp')].map(h => h.textContent)")
    check(bool(dlg) and heads and any('向卖家索要发票' in h for h in heads) and any('申请平台开票' in h for h in heads),
          '③ 要对外提交、发送的合成一张清单，分组列出（向卖家索要、平台申请等）', heads)
    check(any(h.startswith('需手动处理') for h in heads) and NO['B'] in dlg and '换开发票' in dlg,
          '插件做不了的「需处理」订单（抬头不符的 B）也列在清单里，写明该点哪个操作', heads)
    app.click('#list-cancel')
    fin = wait_until(app, lambda: (t := app.inner_text('#summary')) and '发票处理完成' in t and t, 120) or app.inner_text('#summary')
    check('发票处理完成' in fin, '取消清单后只做下载，处理结束后步骤条下方写明结果', fin[:300])
    lines = [l for l in fin.split('\n') if re.match(r'^[①-⑩] ', l)]
    check([l.split('：')[0][2:] for l in lines] == ['读取订单详情', '刷新淘宝开票记录', '读取卖家旺旺回复', '下载已开具的发票', '确认对外操作', '向卖家索要发票', '按开票入口申请', '请淘宝客服督促', '确认收货', '申请平台开票']
          and '已取消' in lines[4], '总结逐段列出 10 段的结果（确认清单那段写明已取消）', lines)
    check('仍需处理' in fin and '某某虚构电池配件' in fin, '总结写明仍需处理的订单（抬头不符的 B）', fin[:300])
    log = app.evaluate('chrome.storage.local.get("autoLog").then(r => r.autoLog || [])')
    mine = [e for e in log if e.get('t', 0) >= t_run and e.get('src') == 'home']
    run_id = mine[0].get('run') if mine else None
    evs = [(e.get('stage'), e.get('ev')) for e in mine]
    check(mine and all(e.get('run') == run_id and re.fullmatch(r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d', e.get('at', '')) for e in mine)
          and evs[0] == ('run', 'start') and evs[-1] == ('run', 'end') and ('sync', 'start') in evs and ('sync', 'end') in evs and ('scan', 'end') in evs
          and ('confirm', 'end') in evs and all('ms' in e for e in mine if e.get('ev') in ('end', 'skip', 'timeout')) and len(log) <= 300,
          '本机调试日志 autoLog：每段开始 / 结束都记下（时间戳、本次编号、用时），最多 300 条', evs)
    check(any(e.get('src') == 'market.m.taobao.com' and e.get('stage') == 'scan' for e in log if e.get('t', 0) >= t_run), '旺旺页读完回复也写了一条 autoLog',
          [e for e in log if e.get('src') != 'home'][-3:])
    check(app.evaluate('window.__dlgN') == 1, '整个过程只弹出一次确认清单', app.evaluate('window.__dlgN'))
    sent = [s for pg in ctx.pages for fr in pg.frames if '/chat-core/' in fr.url for s in fr.evaluate('window.__mock.sent')]
    check(not sent and not [pg for pg in ctx.pages if 'batchInvoice' in pg.url or 'alimebot' in pg.url], '取消后没有发消息、没有打开批量开票页和客服页', sent)
    work = lambda: [pg.url[:70] for pg in ctx.pages if pg.url.startswith(INV_URL) or '/trade/detail/' in pg.url or 'tmall.com' in pg.url]
    gone = wait_until(app, lambda: not work() and True, 40)
    check(bool(gone), '一轮跑完：插件开的全部发票页、订单详情页都关了', work())
    check(len([pg for pg in ctx.pages if '/app/im/' in pg.url]) <= 1, '旺旺聊天页只有一个', [pg.url[:70] for pg in ctx.pages if '/app/im/' in pg.url])

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
    app.click('.flow li[data-step="2"]'); app.wait_for_timeout(500)
    label = app.evaluate('__otDev.lists()')['ask']
    check(label == 2, '要向卖家索要的：卖家要邮箱的碳纤维加工 + 需找卖家的轴承，共 2 家', label)
    app.evaluate('() => { __otDev.ask(false); }')     # 逐家填好、由人点发送的写法（界面上已无入口），用来测切到别家时清掉输入框等安全检查

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
        check('请核对后手动点击「发送」' in fr.inner_text('div[style*="2147483647"]'), '面板提示用户自己核对、点发送', fr.inner_text('div[style*="2147483647"]'))
        fr.click('.send-btn')                                  # 用户点发送
    nxt = wait_until(app, lambda: filled('某某虚构轴承'), 20)
    check(bool(nxt) and NO['H'] in nxt[1], '发完自动打开第 2 家轴承（从没聊过，按旺旺名打开），消息也填好了', nxt and nxt[1])
    if nxt:
        nxt[0].click('div[style*="2147483647"] button[data-otp="skip"]')     # 这家用户不想发
        done = wait_until(app, lambda: '已处理完毕' in (t := nxt[0].inner_text('div[style*="2147483647"]')) and t, 10)
        check(bool(done) and '发送 1 家' in done and '跳过 1 家' in done, '跳过第 2 家后结束：发送 1 家、跳过 1 家', done)
    sent = app.evaluate('chrome.storage.local.get("askSent").then(r => r.askSent || {})')
    check(set(sent) == {NO['G']}, '只把真发了的那单记成「已发消息」', sent)
    app.bring_to_front(); app.wait_for_timeout(800)
    rows = app.evaluate("() => Object.fromEntries([...document.querySelectorAll('.inv-table tbody tr')].map(r => [r.innerText.match(/\\d{19}/)?.[0], r.innerText.replace(/\\s+/g, ' ')]))")
    check('已向卖家索要发票，等待回复' in (rows.get(NO['G']) or '') and ASK in (rows.get(NO['H']) or ''),
          '主页：发过的碳纤维加工变成「已向卖家索要发票，等待回复」，跳过的轴承还是「需向卖家索要发票」', {k: rows.get(NO[k]) for k in 'GH'})

    print('\n[8b] 消息填好后会话被切到别家：插件马上清掉输入框里的字并停下（2026-10-04 真实页面上消息出现在了别家）')
    skipped_txt = (core_of('某某虚构轴承') or app).evaluate('(document.querySelector(".editBox pre.edit[contenteditable=true]") || {}).innerText || ""')
    check(not skipped_txt.strip(), '[8] 里点了「跳过这家」：填的消息清掉了，没留在输入框里', skipped_txt)
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url]: pg.close()
    app.bring_to_front(); app.reload(); app.wait_for_timeout(1500)
    app.click('.flow li[data-step="2"]'); app.wait_for_timeout(500)
    app.evaluate('() => { __otDev.ask(false); }')
    got = wait_until(app, lambda: filled('某某虚构轴承'), 20)
    check(bool(got), '轴承这家的消息填好了', got and got[1])
    if got:
        fr = got[0]
        pnl = fr.inner_text('div[style*="2147483647"]')
        check('深沟球轴承 608' in pnl and '¥15' in pnl and fr.evaluate("document.querySelectorAll('div[style*=\"2147483647\"] img').length") >= 1,
              '卡片上显示这单的商品（标题、金额、商品图）', pnl)
        fr.click('.conversation-item:has-text("某某虚构零食铺") .name')
        ok = wait_until(app, lambda: '为避免发错对象' in fr.inner_text('div[style*="2147483647"]'), 10)
        txt = fr.evaluate('document.querySelector(".editBox pre.edit[contenteditable=true]").innerText')
        check(bool(ok) and not txt.strip(), '切到零食铺后：输入框里的字清掉了，面板说停下了', {'输入框': txt, '面板': fr.inner_text('div[style*="2147483647"]')})
        check('点了发送' not in fr.evaluate('window.__mock.sent')[-3:], '没有发出去')
        check(not app.evaluate('chrome.storage.local.get("chatQueue").then(r => r.chatQueue || null)'), '队列清掉了，不会再自己往下走')

    print('\n[8c] 自动处理发票的确认清单里勾上「向卖家索要」、点「确认执行」：插件自己点发送，不用人点')
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url]: pg.close()
    app.evaluate('no => chrome.storage.local.get("askSent").then(r => { const a = Object.assign({}, r.askSent); delete a[no]; return chrome.storage.local.set({ askSent: a }); })', NO['H'])
    app.bring_to_front(); app.reload(); app.wait_for_timeout(1500)
    app.click('.flow li[data-step="2"]'); app.wait_for_timeout(500)
    app.click('#summary [data-flow="inv-run"]')
    app.wait_for_selector('#dlg-list[open]', timeout=400000)
    lst = app.inner_text('#list-rows')
    check('某某虚构轴承' in lst and NO['H'] in lst and '税号' in lst, '确认清单列出了店铺、订单号和要发的话', lst[:200])
    # 只留「向卖家索要」这一组
    app.evaluate("() => { const h = [...document.querySelectorAll('#list-rows h4.grp')]; const gi = h.findIndex(x => x.textContent.includes('向卖家索要'));"
                 " document.querySelectorAll('#list-rows input[data-g]').forEach(i => { i.checked = +i.dataset.g === gi; }); }")
    app.click('#list-ok')
    ok = wait_until(app, lambda: (v := app.evaluate('chrome.storage.local.get("askSent").then(r => r.askSent || {})')) and NO['H'] in v and v, 300)
    fr = core_of('某某虚构轴承')
    sent_h = fr.evaluate('window.__mock.posted || []') if fr else []
    check(bool(ok) and any(NO['H'] in p['text'] for p in sent_h), '插件自己点了发送，消息发到了轴承这家', sent_h[-1:] if sent_h else None)
    fin = wait_until(app, lambda: (t := app.inner_text('#summary')) and '发票处理完成' in t and t, 120) or ''
    check('索要发票' in fin and not [pg for pg in ctx.pages if 'batchInvoice' in pg.url or 'alimebot' in pg.url], '结果写明向卖家索要了；没勾的平台申请、客服督促没有执行', fin[:300])

    print('\n[8d] 发票表里点「催卖家」（已向卖家索要、还没过应开票截止日）：打开这家的旺旺会话，填好一句催开票的话，不发送')
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url]: pg.close()
    app.bring_to_front(); app.reload(); app.wait_for_timeout(1500)
    app.click('.flow li[data-step="2"]'); app.wait_for_timeout(500)
    nb = app.locator(f'.inv-table tbody tr:has-text("{NO["H"]}") button[data-act]')
    check(nb.count() == 1 and nb.inner_text() == '催卖家' and '不发送' in (nb.get_attribute('title') or ''), '刚索要过的轴承这一单：操作是「催卖家」，悬停说明写明只填不发',
          nb.count() and nb.inner_text())
    nb.click()
    got = wait_until(app, lambda: filled('某某虚构轴承'), 25)
    check(bool(got) and NO['H'] in got[1] and '的发票麻烦尽快开一下' in got[1] and TAX in got[1] and '开好直接发 PDF 到这个窗口' in got[1],
          '输入框里填好了催促的话（订单号、抬头税号），不是首次索要的那条', got and got[1])
    if got:
        fr = got[0]
        pnl = wait_until(app, lambda: '已填好催促消息，请核对后点发送' in (t := fr.inner_text('div[style*="2147483647"]')) and t, 10)
        check(bool(pnl), '旺旺页面板提示「已填好催促消息，请核对后点发送」', fr.inner_text('div[style*="2147483647"]'))
        fr.page.wait_for_timeout(1500)
        check('点了发送' not in fr.evaluate('window.__mock.sent') and not [p for p in (fr.evaluate('window.__mock.posted || []')) if '尽快开一下' in p['text']],
              '插件没有替用户点「发送」')
    app.evaluate('chrome.storage.local.remove("chatQueue")')
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url]: pg.close()

    print('\n[8e] 自动发送时输入框里已有用户自己打的字：不自动发送（不把没确认的字发给卖家），旺旺页报告在等什么，到时按跳过')
    probe = ctx.new_page(); probe.goto('https://market.m.taobao.com/app/im/chat/index.html?probe=1'); probe.wait_for_timeout(1200)
    probe.evaluate("localStorage.setItem('mockDraft', JSON.stringify({ '某某虚构轴承': '我自己还没写完的话' }))"); probe.close()
    app.evaluate('no => chrome.storage.local.get("askSent").then(r => { const a = Object.assign({}, r.askSent); delete a[no]; return chrome.storage.local.set({ askSent: a }); })', NO['H'])
    app.bring_to_front(); app.reload(); app.wait_for_timeout(1500)
    app.evaluate('() => { __otDev.tmo = { askWait: 6000 }; window.__askR = null; __otDev.ask(true).then(r => { window.__askR = r; }); }')
    waiting = wait_until(app, lambda: (q := store('chatQueue')) and q.get('waiting'), 60)
    check(bool(waiting) and '其他文字' in waiting.get('why', '') and waiting.get('shop') == '某某虚构轴承', '旺旺页把「在等用户处理什么」写回给主页（主页进度里显示）', waiting)
    r = wait_until(app, lambda: app.evaluate('window.__askR'), 60)
    fr = core_of('某某虚构轴承')
    posted = [p for p in (fr.evaluate('window.__mock.posted || []') if fr else []) if '没写完' in p['text'] or NO['H'] in p['text']]
    box = fr.evaluate('document.querySelector(".editBox pre.edit[contenteditable=true]").innerText') if fr else ''
    check(bool(r) and r.get('n') == 0 and not posted and '我自己还没写完的话' in box, '没有自动发送：用户打的字原样留在输入框里，没发出去；等待超时后按跳过结束', {'结果': r, '输入框': box, '发出': posted})
    check(not store('chatQueue') and not store('askBeat'), '这一轮结束后队列和主页心跳都清掉了')
    if fr: fr.evaluate("localStorage.removeItem('mockDraft')")
    app.evaluate('() => { __otDev.tmo = null; }')
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url]: pg.close()

    print('\n[8f] 主页已经不在等的自动发送队列（主页关了、刷新了）：之后打开这家的会话，插件不接管、不自动发送')
    item = {'nick': '某某虚构轴承', 'shop': '某某虚构轴承', 'nos': [NO['H']], 'orders': [{'no': NO['H'], 'date': '2026-09-01', 'amount': 15, 'lines': []}],
            'msg': '残留队列里的消息 税号 ' + TAX}
    app.evaluate('it => chrome.storage.local.set({ chatQueue: { id: "old-run", at: Date.now(), kind: "compose", auto: true, items: [it], done: 0, sent: [], skipped: [], taxId: "" } })', item)
    cp = ctx.new_page(); cp.goto('https://market.m.taobao.com/app/im/chat/index.html?uid=' + quote('cntaobao某某虚构轴承'))
    gone = wait_until(app, lambda: not store('chatQueue'), 20)
    cp.wait_for_timeout(3000)
    core = next((f for f in cp.frames if '/chat-core/' in f.url), None)
    box = core.evaluate('document.querySelector(".editBox pre.edit[contenteditable=true]").innerText') if core else '?'
    leaked = [p for p in (core.evaluate('window.__mock.posted || []') if core else []) if '残留队列' in p['text']]
    check(bool(gone) and not box.strip() and not leaked, '残留的自动发送队列被丢弃：没填、没发', {'输入框': box, '发出': leaked})
    cp.close()

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
    app.click('.flow li[data-step="2"]'); app.wait_for_timeout(500)
    # 上一轮排了这张票的下载、页面却没干完（关掉了）：半小时内再「自动处理」，照样派页面去下（以前说「没有需要下载的」，一直停在待下载）
    queued = app.evaluate('no => __otDev.queue([no])', NO['F'])
    check(queued == 1 and any(j.get('kind') == 'qr' for j in (store('dlJobs') or [])), '先排进下载清单、不开页面（模拟上一轮没下完）', store('dlJobs'))
    app.evaluate('() => { __otDev.download(); }')
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
    frac = re.search(r'发票（已取得 / 应开）\s*(\d+)\s*/\s*(\d+)\s*单', txt)
    check(bool(n) and bool(frac) and int(frac.group(2)) - int(frac.group(1)) == n and f'尚缺 {n} 单' in txt,
          f'进度条：发票「已取得 / 应开」两数相差 {n}，写着尚缺 {n} 单', txt[:300])
    check('需处理' in txt and '等待中' in txt and '待下载' in txt, '进度条按「需处理 / 等待中 / 待下载」分开计数', txt[:300])
    badge = app.evaluate('chrome.action.getBadgeText({})')
    check(badge == str(n), f'插件图标上显示 {n}', badge)
    app.click('.flow li[data-step="2"]'); app.wait_for_timeout(500)
    check(app.locator('#inv-legend:not([hidden])').count() == 1, '点步骤条上的「处理发票」显示发票表和颜色图例')

    print('\n[12] 请淘宝官方人工客服督促：先发「人工」直到转人工，再一单一句督促；转人工之前一句督促的话都不发')
    n_vip = app.evaluate('__otDev.lists()')['vip']
    check(n_vip >= 1, '有超过应开票截止日（10 日）还没开票、要请客服督促的单', n_vip)
    app.evaluate('() => { __otDev.vip(); }')       # 确认清单在 [8c] 测过；这里单独测督促这一段
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
    check(app.evaluate('__otDev.lists()')['vip'] == 0, '督促过的 10 日内不再督促：督促清单变成 0 单', app.evaluate('__otDev.lists()'))
    check('已由淘宝客服督促，等待开票' in app.inner_text('#list'), '督促过的单状态变成「已由淘宝客服督促，等待开票」')
    pu = app.evaluate("() => { const s = [...document.querySelectorAll('.inv-table .st')].find(s => s.textContent.includes('已由淘宝客服督促')); return s ? { cls: s.className, title: s.title } : {}; }")
    check('tone-urge' in pu.get('cls', '') and '投诉' in pu.get('title', ''), '督促状态是单独的颜色（青色），点击打开淘宝投诉记录', pu)
    # 发完以后：客服问要不要投诉 → 插件回「OK」；客服发「提交投诉」卡片 → 插件点
    got = wait_until(app, lambda: (pg2 := core()) and pg2.evaluate('window.__mock.complained || 0') and pg2, 30)
    m = (got or core()).evaluate('window.__mock')
    check(m.get('complained') == 1 and m.get('sent', []).count('OK') == 1, '客服问「发起投诉…您看可以吗」，插件回了「OK」；「提交投诉」按钮点了一次', (m.get('complained'), m.get('sent', [])[-3:]))
    pnl = (got or core()).inner_text('div[style*="2147483647"]')
    check('已点「提交投诉」' in pnl and '已回复「OK」' in pnl, '卡片上写明回了 OK、点了提交投诉', pnl)

    print('\n[12b] 发票表里某一单点「找客服督促」：只为这一单打开官方客服、转人工后发这一单的督促（点了按钮就算确认这一单）')
    app.bring_to_front(); app.click('.flow li[data-step="2"]'); app.wait_for_timeout(500)
    old = {id(pg) for pg in ctx.pages if 'alimebot' in pg.url}
    vb = app.locator(f'.inv-table tbody tr:has-text("{NO["C"]}") button[data-act]')
    check(vb.count() == 1 and vb.inner_text() == '找客服督促', '已申请淘宝开票（督促过）的 C 单：操作是「找客服督促」', vb.count() and vb.inner_text())
    vb.click()
    pg2 = wait_until(app, lambda: next((pg for pg in ctx.pages if 'alimebot' in pg.url and id(pg) not in old), None), 20)
    done = wait_until(app, lambda: pg2 and [t for t in pg2.evaluate('window.__mock.sent') if '督促' in t], 60) or []
    check(len(done) == 1 and NO['C'] in done[0], '新开的客服页先转人工，再只发了 C 这一单的督促', pg2 and pg2.evaluate('window.__mock.sent'))
    check(not app.locator('#dlg-list[open]').count(), '逐单操作不弹确认清单')

    print('\n[13] 整理成报销文件：选下载好的发票文件夹 → 预览 → 生成「订单分拣-报销/学号_姓名_总金额元/」（按报销规范分类）、README.txt、报销清单.xlsx 和压缩包；原文件不动')
    import zipfile
    import openpyxl
    src = dl_dir / '订单分拣-发票'
    before = sorted(x.name for x in src.iterdir())
    app.bring_to_front(); app.click('.flow li[data-step="3"]'); app.wait_for_timeout(500)
    check(app.inner_text('#summary .flow-acts') == '选择发票文件夹并整理', '「整理报销文件」这一步只有一个按钮')
    app.set_input_files('#inv-pack-dir', str(src))
    app.wait_for_selector('#dlg-pack[open]', timeout=10000)
    names = app.evaluate("[...document.querySelectorAll('#pack-list .pk-row')].map(r => r.querySelector('.detail').textContent.split('　←')[0])")
    pat = re.compile(r'不超过1k耗材/发票\d+\.(pdf|ofd|xml)|(超过1k耗材|低值品)/发票/\d+_.+_\d+\.\d{2}元\.(pdf|ofd|xml)')
    check(names and all(pat.fullmatch(n) for n in names), f'预览了 {len(names)} 张发票，不超过 1000 元的按「不超过1k耗材/发票N」命名', names[:3])
    app.fill('#pack-name', '测试批'); app.click('#pack-go')
    out = dl_dir / '订单分拣-报销'
    zp = wait_until(app, lambda: out.is_dir() and (z := [x for x in out.iterdir() if x.suffix == '.zip' and not x.name.endswith('.crdownload')]) and z[0], 30)
    folder = [x for x in out.iterdir() if x.is_dir()] if out.is_dir() else []
    inside = sorted(str(x.relative_to(folder[0])) for x in folder[0].rglob('*') if x.is_file()) if folder else []
    check(bool(folder) and folder[0].name.startswith(SID + '_' + NAME + '_') and folder[0].name.endswith('元') and 'README.txt' in inside and '报销清单.xlsx' in inside
          and len(inside) == len(names) + 2, '下载文件夹里多了「订单分拣-报销/学号_姓名_总金额元/」：发票 + README.txt + 报销清单.xlsx', inside)
    ok_zip = False
    if zp:
        app.wait_for_timeout(1000)
        with zipfile.ZipFile(zp) as z:
            ok_zip = z.testzip() is None and len(z.namelist()) == len(names) + 2 and any(n.endswith('报销清单.xlsx') for n in z.namelist())
    check(ok_zip, '同名压缩包能正常打开，里面也是这些文件', zp and zp.name)
    readme = (folder[0] / 'README.txt').read_text(encoding='utf-8-sig') if folder else ''
    xrows = [[c.value for c in r] for r in openpyxl.load_workbook(folder[0] / '报销清单.xlsx')['报销清单'].iter_rows()] if folder else []
    check(xrows and xrows[-1][0] == '合计' and '尚无发票的实验室订单' in readme and f'报销人：{NAME}' in readme, '报销清单里有合计，README.txt 最后列出尚无发票的实验室订单', readme[:120])
    check(sorted(x.name for x in src.iterdir()) == before, '原来的「订单分拣-发票」文件夹一个文件都没变')

    print('\n[14] 每天自动处理：后台到点打开主页（带 #auto），主页自己点「检查开票情况」')
    app.goto(f'chrome-extension://{eid}/index.html#auto')
    app.reload()                                       # 后台也是改地址后再刷新（只改 # 不会重新加载）
    t = wait_until(app, lambda: re.search('每天自动刷新发票情况', app.inner_text('#toast')) and app.inner_text('#toast'), 15)
    check(bool(t), '打开 #auto 的主页后自动开始刷新发票情况', app.inner_text('#toast'))
    check('#auto' not in app.url, '跑过以后地址里的 #auto 去掉了（刷新不会再跑一次）', app.url)

    print('\n[14b] 每天自动处理到点：主页正在处理时跳过（不记今天已运行）；主页开着时不刷新页面，直接在主页上开始')
    app.goto(f'chrome-extension://{eid}/index.html'); app.wait_for_selector('#main:not([hidden])'); app.wait_for_timeout(1000)
    alarm = app.evaluate("chrome.alarms.get('daily')")
    check(alarm and alarm.get('periodInMinutes') == 60, '每小时检查一次的定时器在', alarm)
    app.evaluate("chrome.storage.local.set({ autoDaily: { on: true, hour: 0 }, autoLast: '' })")
    app.evaluate("chrome.storage.session.set({ homeBusy: { t: Date.now() + 120000, run: 'other' } })")       # 定时器可能晚几十秒才响，别让「正忙」先过期
    app.evaluate('window.__mark = 1')
    t_a = app.evaluate('Date.now()')
    daily = lambda ev: [e for e in (store('autoLog') or []) if e.get('src') == 'background' and e.get('stage') == 'daily' and e.get('ev') == ev and e.get('t', 0) >= t_a]
    # 定时器最快可能要等几十秒才响（浏览器对 alarms 的最短间隔）
    app.evaluate("chrome.alarms.create('daily', { when: Date.now() + 300, periodInMinutes: 60 })")
    skipped = wait_until(app, lambda: daily('skip'), 70)
    check(bool(skipped) and store('autoLast') == '' and app.evaluate('window.__mark') == 1, '主页正忙：这次跳过，不记今天已运行，也不刷新主页', store('autoLast'))
    app.evaluate("chrome.storage.session.remove('homeBusy')")
    # 主页 30 分钟内有人操作过（点按钮、按键）：推迟到下一次检查，不打扰正在用的人
    app.evaluate("chrome.storage.session.set({ homeActive: { t: Date.now() } })")
    t_b = app.evaluate('Date.now()')
    app.evaluate("chrome.alarms.create('daily', { when: Date.now() + 300, periodInMinutes: 60 })")
    busy2 = wait_until(app, lambda: [e for e in (store('autoLog') or []) if e.get('src') == 'background' and e.get('stage') == 'daily' and e.get('ev') == 'skip'
                                     and e.get('t', 0) >= t_b and '30 分钟内有操作' in e.get('msg', '')], 70)
    check(bool(busy2) and store('autoLast') == '' and app.evaluate('window.__mark') == 1, '主页 30 分钟内有操作：推迟到下一次检查，不记今天已运行', busy2)
    app.evaluate("chrome.storage.session.remove('homeActive')")
    n0 = len(ctx.pages)
    app.evaluate("chrome.alarms.create('daily', { when: Date.now() + 300, periodInMinutes: 60 })")
    t = wait_until(app, lambda: '每天自动刷新发票情况' in app.inner_text('#toast') and app.inner_text('#toast'), 70)
    check(bool(t) and app.evaluate('window.__mark') == 1 and store('autoLast') == app.evaluate('new Date().toDateString()')
          and not [pg for pg in ctx.pages[n0:] if pg.url.startswith(f'chrome-extension://{eid}/index.html')],
          '主页开着：没有刷新、没有另开主页，直接在这里开始刷新发票情况', {'提示': t, 'autoLast': store('autoLast')})
    app.evaluate("chrome.storage.local.set({ autoDaily: { on: false, hour: 10 } })")

    print('\n[15] 天猫店：点旺旺图标时不知道旺旺名，订单详情页被重定向到 trade.tmall.com，照样读到旺旺名、打开聊天页（不是订单页）')
    app.evaluate('''no => { const S = JSON.parse(localStorage.getItem('orderTriage.app.v1')); const o = S.orders.find(o => o.no === no); delete o.nick;
                         localStorage.setItem('orderTriage.app.v1', JSON.stringify(S)); }''', NO['A'])
    app.evaluate('() => chrome.storage.local.get("scraped").then(r => { const s = r.scraped || {}; for (const k in s) if (s[k].nick && k.endsWith("101")) delete s[k].nick; return chrome.storage.local.set({ scraped: s }); })')
    app.goto(f'chrome-extension://{eid}/index.html'); app.wait_for_timeout(1500)
    app.click('.flow li[data-step="1"]'); app.wait_for_timeout(500)
    n0 = len(pages)
    app.click(f'article.order:has-text("{NO["A"]}") button[data-ww]')
    chat_pg = wait_until(app, lambda: next((pg for pg in ctx.pages if '/app/im/chat/' in pg.url and 'cntaobao某某虚构卖家' in unquote(pg.url)), None), 40)
    tm = [pg for pg in pages[n0:] if 'tmall.com' in pg.url or '/trade/detail/' in pg.url]
    check(bool(chat_pg), '打开的是和卖家的旺旺聊天页（uid=cntaobao某某虚构卖家），不是订单页', [pg.url[:90] for pg in pages[n0:]])
    check(any('trade.tmall.com/detail/' in pg.url for pg in tm) and all(pg.is_closed() for pg in tm), '重定向到天猫的订单详情页读完旺旺名就关掉了', [pg.url[:90] for pg in tm])
    nick = app.evaluate("no => (JSON.parse(localStorage.getItem('orderTriage.app.v1')).orders.find(o => o.no === no) || {}).nick", NO['A'])
    check(nick == '某某虚构卖家', '旺旺名记下了', nick)

    print('\n[16] 淘宝页面上的「← 订单分拣」：切回已打开的主页；主页没开着就新开')
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url or 'alimebot' in pg.url]: pg.close()
    ip = ctx.new_page(); ip.goto(INV_URL)
    hb = ip.wait_for_selector('#ot-home', timeout=10000)
    box, vp = hb.bounding_box(), ip.viewport_size
    check(hb.inner_text() == '← 订单分拣' and '主页' in (hb.get_attribute('title') or '') and box['x'] + box['width'] > vp['width'] - 40 and box['y'] < 40 and box['height'] < 40,
          '「我的发票」页右上角有一个小按钮「← 订单分拣」', (hb.inner_text(), box))
    ip.bring_to_front(); hb.click()
    back = wait_until(app, lambda: app.evaluate('chrome.tabs.getCurrent().then(t => t.active)'), 10)
    check(bool(back), '点了以后切回已打开的主页标签')
    cp = ctx.new_page(); cp.goto('https://market.m.taobao.com/app/im/chat/index.html?uid=' + quote('cntaobao某某虚构轴承'))
    core = wait_until(cp, lambda: next((fr for fr in cp.frames if '/chat-core/' in fr.url and fr.locator('.send-btn').count()), None), 15)
    cb = cp.wait_for_selector('#ot-home', timeout=10000).bounding_box()
    hit = lambda a, b: a and b and not (a['x'] + a['width'] <= b['x'] or b['x'] + b['width'] <= a['x'] or a['y'] + a['height'] <= b['y'] or b['y'] + b['height'] <= a['y'])
    boxes = [core.locator(s).bounding_box() for s in ('.send-btn', '.editBox')] if core else []
    check(bool(core) and core.locator('#ot-home').count() == 0 and bool(boxes) and not any(hit(cb, b) for b in boxes),
          '旺旺页：按钮只在最外层页面放一个，不挡输入框和「发送」', (cb, boxes))
    app.close()
    cp.bring_to_front(); cp.click('#ot-home')
    home = wait_until(cp, lambda: next((pg for pg in ctx.pages if pg.url.startswith(f'chrome-extension://{eid}/index.html')), None), 10)
    check(bool(home), '主页没开着时，点按钮新开一个主页', [pg.url[:60] for pg in ctx.pages])
    if home:
        part17(ctx, home, tmp, pdfs, dl_dir)
        part18(ctx, home, tmp)
    ctx.close()


def part17(ctx, app, tmp, pdfs, dl_dir):
    print('\n[17] 下载的发票核对与整理：同店合开、挪到同店另一单、不是发票、票面少 1 元以上、按用券前价格开、部分退款')
    app.bring_to_front(); app.wait_for_selector('#main:not([hidden])')
    ctx.new_cdp_session(app).send('Browser.setDownloadBehavior', {'behavior': 'default'})
    csv2 = tmp / '虚构订单表2.csv'
    write_csv(csv2, X17)
    app.set_input_files('#file', str(csv2)); app.wait_for_timeout(800)
    app.evaluate('''nos => { const S = JSON.parse(localStorage.getItem('orderTriage.app.v1'));
        for (const o of S.orders) if (nos.includes(o.no)) for (const l of o.lines) S.decisions[l.key] = o.no.endsWith('126') ? 'personal' : 'lab';
        localStorage.setItem('orderTriage.app.v1', JSON.stringify(S)); }''', list(N17.values()))
    app.reload(); app.wait_for_selector('#main:not([hidden])'); app.wait_for_timeout(800)
    S = lambda: app.evaluate("JSON.parse(localStorage.getItem('orderTriage.app.v1'))")

    # 部分退款：详情页上写着退了 5.00（单价 9.90），以前四舍五入成整件退、整单不再开票
    app.evaluate('no => __otDev.inspect([no])', N17['R1'])
    due = app.evaluate('no => __otDev.due(no)', N17['R1'])
    check(due == 4.9, '部分退款（单价 9.90 退 5.00）：应报金额 = 实付 − 退款 = 4.90，没被当成整单退款', due)

    # 旺旺：挪单店两单共用一个会话（要发票没写订单号），卖家发了一个文件；说明书店卖家发了一份说明书
    app.evaluate('''([v1, v2, n1]) => chrome.storage.local.get('chatScan').then(r => { const c = r.chatScan || { at: 0, convs: {} };
        c.convs['某某虚构挪单店'] = { at: Date.now(), orders: [v1, v2], first: '2026-09-05 10:00:00', asks: [{ time: '2026-09-06 10:00:00', text: '需要发票', nos: [] }],
          files: [{ time: '2026-09-10 10:00:00', name: 'fp_挪单店发票.pdf', size: '80 KB', parsed: null }], images: [], email: [], cards: [] };
        c.convs['某某虚构说明书店'] = { at: Date.now(), orders: [n1], first: '2026-09-06 10:00:00', asks: [{ time: '2026-09-07 10:00:00', text: '需要发票', nos: [] }],
          files: [{ time: '2026-09-08 10:00:00', name: '产品说明书.pdf', size: '1 MB', parsed: null }], images: [], email: [], cards: [] };
        c.at = Date.now(); return chrome.storage.local.set({ chatScan: c }); })''', [N17['V1'], N17['V2'], N17['N1']])
    folder = tmp / '订单分拣-发票17'
    folder.mkdir()
    oss = 'https://einvoice-file.oss-cn-beijing.aliyuncs.com/mock/OSTB_'
    files = {}
    for k, inv, src in (('M1', '26990000000000000121', '合开发票.pdf'), ('V1', '26990000000000000128', 'fp_挪单店发票.pdf'),
                        ('N1', '26990000000000000123', '产品说明书.pdf'), ('S1', '26990000000000000124', '少票.pdf'),
                        ('C1', '26990000000000000125', '券前价.pdf'), ('R1', '26990000000000000127', '价保.pdf')):
        no, d, _, shop, pay, _ = X17[k]
        name = f'{d}_{js_num(pay)}_{shop}_{no}.pdf'
        (folder / name).write_bytes(pdfs[inv])
        files[no] = [{'file': name, 'path': str(folder / name), 'at': int(time.time() * 1000), 'from': 'chat', 'src': src, 'url': oss + inv + '.pdf'}]
    app.evaluate('f => chrome.storage.local.get("dlDone").then(r => chrome.storage.local.set({ dlDone: Object.assign({}, r.dlDone, f) }))', files)
    checked = wait_until(app, lambda: (fc := (S() or {}).get('fileChecks') or {}) and len([k for k in fc if '订单分拣-发票17' in k]) >= 6 and fc, 60) or {}
    check(len([k for k in checked if k.startswith('p:') and '订单分拣-发票17' in k]) == 6, '6 个新下载的文件都读 PDF 核对过（核对结果按下载位置记）', list(checked)[-6:])
    app.wait_for_timeout(800)
    app.click('.flow li[data-step="2"]'); app.wait_for_timeout(600)
    rows = app.evaluate('''() => Object.fromEntries([...document.querySelectorAll('.inv-table tbody tr')].map(tr => [tr.children[2].querySelector('.detail').textContent.trim(),
        { st: tr.querySelector('.st').textContent.trim(), cls: tr.querySelector('.st').className, detail: [...tr.children[5].querySelectorAll('.detail')].map(d => d.textContent).join(' | '),
          btns: [...tr.querySelectorAll('.acts button')].map(b => b.textContent.trim()) }]))''')
    r = lambda k: rows.get(N17[k], {})
    check(r('M1').get('st') == '已下载' and r('M2').get('st') == '已下载' and '合开' in r('M2').get('detail', ''),
          '同店两单合开一张（10.00 + 15.00 = 25.00）：两单都算拿到了票', (r('M1'), r('M2')))
    check(r('V2').get('st') == '已下载' and r('V1').get('st') == '需向卖家索要发票' and '已归入同店另一单' in r('V1').get('detail', ''),
          '文件名那单对不上、同店另一单正好 66.00：挪过去；原来那单退回「需向卖家索要」，写明已归入同店另一单', (r('V1'), r('V2')))
    check(r('N1').get('st') == '需向卖家索要发票' and '不是发票' in r('N1').get('detail', ''),
          '卖家发的说明书（没有「发票」字样）：不当成发票，这单退回「需向卖家索要」', r('N1'))
    check(r('S1').get('st') == '下载的发票核对不通过' and 'tone-bad' in r('S1').get('cls', '') and r('S1').get('btns', [])[:1] == ['联系卖家']
          and '少' in r('S1').get('detail', ''), '票面 45.00、应报 50.00（少 1 元以上）：红色「下载的发票核对不通过」，操作「联系卖家」', r('S1'))
    check(r('C1').get('st') == '已下载' and '略高于实付' in r('C1').get('detail', '') and N17['P2'] not in rows,
          '按用券前价格开的票（实付 10.00、票面 10.50）：留在这单，没被挪给同店正好 10.50 的个人订单', r('C1'))
    check(r('R1').get('st') == '已下载' and '相符' in r('R1').get('detail', ''), '部分退款的单：票面 4.90 = 实付 − 退款，核对相符', r('R1'))
    dash = app.inner_text('#remind')
    check('需处理' in dash, '顶上进度把核对不通过的单算进「需处理」', dash[:200])
    jobs = app.evaluate('nos => __otDev.jobsFor(nos)', [N17['V1'], N17['N1']])
    check(jobs == [], '挪走的、不是发票的文件：原来那单不会再把同一个文件下载一遍', jobs)

    print('\n[17b] 整理报销文件：合开的一张票一行（两单），少 1 元以上写进备注；整理后这一批记为已整理')
    import openpyxl
    app.click('.flow li[data-step="3"]'); app.wait_for_timeout(400)
    app.set_input_files('#inv-pack-dir', str(folder))
    app.wait_for_selector('#dlg-pack[open]', timeout=20000)
    lines = app.evaluate("[...document.querySelectorAll('#pack-list .pk-row')].map(r => r.innerText)")
    merged = [l for l in lines if '等 2 单（合开）' in l and '¥25.00' in l]
    short = [l for l in lines if '¥45.00' in l]
    check(len(merged) == 1 and len(lines) == 5, '预览：合开的两单合成一行（金额 25.00）；共 5 张票', lines)
    check(short and '票面比应报少 5.00 元' in short[0], '票面少 1 元以上的那张：预览里写明少了多少', short)
    app.fill('#pack-name', '测试批二'); app.click('#pack-go')
    out = dl_dir / '订单分拣-报销'
    tot = 25 + 66 + 45 + 10.5 + 4.9
    folder2 = wait_until(app, lambda: next((x for x in out.iterdir() if x.is_dir() and x.name == f'{SID}_{NAME}_{tot:.2f}元' and (x / '报销清单.xlsx').is_file()), None), 30)
    app.wait_for_timeout(1000)
    xr = [[c.value for c in r] for r in openpyxl.load_workbook(folder2 / '报销清单.xlsx')['报销清单'].iter_rows()] if folder2 else []
    m2 = next((x for x in xr if N17['M2'] in str(x[7])), [])
    s1 = next((x for x in xr if N17['S1'] in str(x[7])), [])
    total = next((x for x in xr if x and x[0] == '合计'), [])
    check(m2 and N17['M1'] in m2[7] and m2[6] == 25 and '合开 2 单' in m2[12], '报销清单：合开的两单一行（订单号两个、金额 25.00），备注写明合开', m2)
    check(s1 and '票面比应报少 5.00 元' in s1[12], '报销清单备注写明票面比应报少 5.00 元', s1)
    check(total and abs(float(total[6]) - tot) < 0.005, '合计 = 每张票只算一次', total)
    st = S()
    packed = st.get('packed') or {}
    check(all(N17[k] in packed for k in ('M1', 'M2', 'V2', 'S1', 'C1', 'R1')) and any(x.get('invNo') == '26990000000000000121' for x in st.get('haveIdx', [])),
          '整理完这一批记为已整理（订单和读到的发票号），下一批不会再放进来', sorted(packed)[-6:])
    app.wait_for_timeout(500)
    app.set_input_files('#inv-pack-dir', str(folder))
    app.wait_for_selector('#dlg-pack[open]', timeout=20000)
    note = app.inner_text('#pack-note')
    check(note.startswith('发票 0 张') and app.is_disabled('#pack-go'), '再选同一个文件夹：这一批已整理，不再重复整理', note)
    app.click('#pack-cancel')

    print('\n[17c] 读旺旺：按旺旺名打开的会话标题是店名也认；打不开的、读不出消息的记为「旺旺会话未能读取」，不退回「需向卖家索要」')
    store = lambda k: app.evaluate('k => chrome.storage.local.get(k).then(r => r[k])', k)
    app.evaluate('s => chrome.storage.local.get("scraped").then(r => chrome.storage.local.set({ scraped: Object.assign({}, r.scraped, s) }))',
                  {N17[k]: {'no': N17[k], 'nick': n, 'lines': [{'title': X17[k][5][0][0]}]} for k, n in NICK17.items()})
    app.wait_for_timeout(800)

    def chat_ls(js):
        pr = ctx.new_page(); pr.goto('https://market.m.taobao.com/app/im/chat/index.html?probe=1'); pr.wait_for_timeout(1200)
        pr.evaluate(js); pr.close()

    def scan_once():
        for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url]: pg.close()
        s0 = (store('chatScan') or {}).get('at', 0)
        app.bring_to_front()
        app.evaluate('() => { __otDev.scan(); }')
        return wait_until(app, lambda: (c := store('chatScan')) and c.get('at', 0) != s0 and c, 240) or {}

    def row17(k):
        app.bring_to_front(); app.click('.flow li[data-step="2"]'); app.wait_for_timeout(600)
        return app.evaluate("no => { const tr = [...document.querySelectorAll('.inv-table tbody tr')].find(tr => tr.innerText.includes(no)); "
                            "return tr ? { st: tr.querySelector('.st').textContent.trim(), cls: tr.querySelector('.st').className, "
                            "btns: [...tr.querySelectorAll('.acts button')].map(b => b.textContent.trim()) } : {}; }", N17[k])
    chat_ls("localStorage.removeItem('mockNoTime')")
    cs = scan_once()
    w1 = (cs.get('convs') or {}).get('某某虚构店名会话', {})
    check(w1.get('byNick') == 'nick店名会话' and w1.get('asks'), '按旺旺名打开、标题显示店名的会话：照样认出并读到（以前只认标题 = 旺旺名，判成未打开）', w1)
    f2 = [f for f in cs.get('failed', []) if N17['W2'] in f.get('nos', [])]
    check(f2 and '未打开' in f2[0].get('why', ''), '打不开的会话写进 chatScan.failed，写明原因', cs.get('failed'))
    r2 = row17('W2')
    check(r2.get('st') == '旺旺会话未能读取' and 'tone-bad' in r2.get('cls', '') and r2.get('btns') == ['打开旺旺'],
          '打不开会话的那单：红色「旺旺会话未能读取」，不退回「需向卖家索要」（不会被列进索要清单）', r2)
    check(row17('W3').get('st') == '卖家已发送文件', '改版店第一次读得出：卖家已发送文件', row17('W3'))
    before = (cs.get('convs') or {}).get('某某虚构改版店', {})
    chat_ls("localStorage.setItem('mockNoTime', JSON.stringify(['某某虚构改版店']))")
    cs2 = scan_once()
    after = (cs2.get('convs') or {}).get('某某虚构改版店', {})
    f3 = [f for f in cs2.get('failed', []) if N17['W3'] in f.get('nos', [])]
    check(after.get('at') == before.get('at') and after.get('files') and f3 and '改版' in f3[0].get('why', ''),
          '旺旺页改版、消息一条都读不出来：不覆盖这家上次的结果，记为读取失败（写明可能改版）', {'失败': cs2.get('failed'), '上次': before.get('at'), '这次': after.get('at')})
    check(row17('W3').get('st') == '卖家已发送文件', '读不出来的那家仍按上次结果显示「卖家已发送文件」，没有退回「需向卖家索要」', row17('W3'))
    chat_ls("localStorage.removeItem('mockNoTime')")

    print('\n[17d] 要读 5 家、左侧会话列表里一家都没有（2026-10-09 实测：2 秒就结束、读到 0 个、也没写原因）：知道旺旺名的按网址打开读到，不知道的每家写明原因')
    # 三家上次按旺旺名读过（会话名就是旺旺名，上次的结果里有这三个会话），这次不在左侧列表里；两家不知道卖家旺旺名。
    # 以前：拿上次结果里的会话名当「已读」跳过前三家，后两家悄悄丢掉 → 读到 0 个、failed 为空
    fake = [{'no': '5190000000000000207', 'shop': '某某虚构杜邦线店', 'nick': 'nick207', 'st': 'asked'}, {'no': '5190000000000000208', 'shop': '某某虚构硅胶线店', 'nick': 'nick208', 'st': 'asked'},
            {'no': '5190000000000000209', 'shop': '某某虚构轴承店', 'nick': 'nick209', 'st': 'asked'},
            {'no': '5199000000000000001', 'shop': '某某虚构无名店一', 'nick': '', 'st': 'asked'}, {'no': '5199000000000000002', 'shop': '某某虚构无名店二', 'nick': '', 'st': 'asked'}]
    chat_ls("localStorage.setItem('mockHideList', '1')")
    app.evaluate('''() => chrome.storage.local.get('chatScan').then(r => { const c = r.chatScan || { convs: {} };
        for (const n of ['nick207', 'nick208', 'nick209']) c.convs[n] = { at: 1, orders: [], first: '', asks: [], files: [], images: [], email: [], cards: [] };
        return chrome.storage.local.set({ chatScan: Object.assign({}, c, { at: 1 }) }); })''')
    app.wait_for_timeout(1500)                                   # 主页看到 chatScan 变了会重写 invWant：等它写完再放这 5 家
    app.evaluate('f => chrome.storage.local.get("invWant").then(r => chrome.storage.local.set({ invWant: Object.assign({}, r.invWant, { chat: f, chatSince: "2026-08-01" }) }))', fake)
    app.evaluate("chrome.storage.local.set({ autoLog: [] })")
    t_s = time.time()
    cs = scan_once()
    print(f'  扫描用时 {time.time() - t_s:.0f} 秒')
    convs = cs.get('convs') or {}
    check(cs.get('read') == 3 and all((convs.get(n) or {}).get('at', 0) > 1 for n in ('nick207', 'nick208', 'nick209')),
          '上次读过、这次不在左侧列表里的三家：按旺旺名打开网址读到了（不依赖左侧列表）', {'read': cs.get('read'), 'at': {n: (convs.get(n) or {}).get('at') for n in ('nick207', 'nick208', 'nick209')}})
    fl = {f.get('name'): f.get('why', '') for f in cs.get('failed', [])}
    check(set(fl) == {'某某虚构无名店一', '某某虚构无名店二'} and all('未读到卖家旺旺名' in w for w in fl.values()),
          '不知道旺旺名、又不在左侧列表里的两家：每家写进 chatScan.failed，附原因', cs.get('failed'))
    lg = [e for e in (store('autoLog') or []) if e.get('stage') == 'scan' and e.get('ev') == 'skip']
    check(sorted(e['msg'].split(' ')[0] for e in lg) == ['某某虚构无名店一', '某某虚构无名店二'], '调试日志里每家没读成的店一条 scan skip <店名> <原因>', [e.get('msg') for e in lg])
    # 主页这一段（用主页自己的清单）：列表里一家都没有时照样按旺旺名读；没读成的写明「未能读取 N 家：原因」，发票表标红
    want = app.evaluate('__otDev.want()') or {}
    no_nick = [o for o in want.get('chat', []) if not o.get('nick')]
    text = app.evaluate('__otDev.chatStage().then(r => r.text)')
    cs2 = store('chatScan') or {}
    covered = {no for f in cs2.get('failed', []) for no in f.get('nos', [])}
    none = {no for f in cs2.get('none', []) for no in f.get('nos', [])}
    check(re.search(r'未能读取 \d+ 家：', text or '') and all(o['no'] in (none if o.get('st') == 'ask' else covered) for o in no_nick),
          '主页这一段（旺旺页沿用上一段留下的页面）写「未能读取 N 家：原因」；不知道旺旺名、联系过的单在未能读取的清单里，还没联系过的记为「尚未联系过、没有会话」（不算失败）',
          {'结果': text, '没有旺旺名的单': [(o['no'], o.get('st')) for o in no_nick], 'none': sorted(none)})
    shown = [row17(k).get('st') for k in ('W2',)]
    check(shown == ['旺旺会话未能读取'], '没读成的单在发票表里是红色「旺旺会话未能读取」', shown)
    chat_ls("localStorage.removeItem('mockHideList')")



def part18(ctx, app, tmp):
    print('\n[18] 开票时限（固定 10 日）与天猫订单先确认收货：等待中的单写应开票截止日；天猫、已签收的单列进确认清单，确认后自动确认收货、排进平台申请；密码框一律不碰')
    store = lambda k: app.evaluate('k => chrome.storage.local.get(k).then(r => r[k])', k)
    app.bring_to_front(); app.wait_for_selector('#main:not([hidden])')
    # 等待中的单：应开票截止日一行；C（淘宝平台 09-02 申请）已过截止，H（插件刚索要过：这里直接记一次刚发过）还没到截止
    app.evaluate('no => chrome.storage.local.get(["askSent", "askFirst"]).then(r => chrome.storage.local.set({ askSent: Object.assign({}, r.askSent, { [no]: Date.now() }), askFirst: Object.assign({}, r.askFirst, { [no]: Date.now() }) }))', NO['H'])
    app.wait_for_timeout(800)
    app.click('.flow li[data-step="2"]'); app.wait_for_timeout(600)
    row = lambda no: app.evaluate("no => { const tr = [...document.querySelectorAll('.inv-table tbody tr')].find(tr => tr.innerText.includes(no)); if (!tr) return null; "
                                  "const d = tr.querySelector('.detail.due'); const b = tr.querySelector('button[data-act]'); "
                                  "return { due: d ? d.textContent : '', late: !!d && d.classList.contains('late'), tip: d ? d.title : '', act: b ? b.textContent : '' }; }", no)
    rc, rh = row(NO['C']) or {}, row(NO['H']) or {}
    check(rc.get('due', '').startswith('已超过应开票截止 09-12（淘宝：向商家发出开票要求后 10 日）') and rc.get('late') and '官方客服才可介入' in rc.get('tip', '') and rc.get('act') == '找客服督促',
          'C（淘宝平台 09-02 申请）：说明行「已超过应开票截止 09-12（淘宝：向商家发出开票要求后 10 日）」标红，操作「找客服督促」', rc)
    check(re.match(r'^应开票截止 \d\d-\d\d（(淘宝：向商家发出开票要求|天猫：确认收货)后 10 日）$', rh.get('due', '')) and not rh.get('late') and rh.get('act') == '催卖家',
          'H（刚向卖家索要过）：「应开票截止 MM-DD（向卖家索要…后 10 日）」，没超过截止就只有「催卖家」，不出「找客服督促」', rh)
    dues = app.evaluate('__otDev.dues()')
    check(not dues.get(NO['H'], {}).get('late') and dues.get(NO['C'], {}).get('late'), '截止日计算：C 已超过、H 未超过', {k: dues.get(NO[k]) for k in ('C', 'H')})
    dash = app.inner_text('#remind')
    check(re.search(r'超过 10 日未开票 \d+ 单', dash), '顶上进度写「超过 10 日未开票 N 单」', dash[-120:])

    # 卖家已发货的实验室订单：订单列表上读到的天猫标记、物流标签
    csv3 = tmp / '虚构订单表3.csv'
    write_csv(csv3, X18)
    app.set_input_files('#file', str(csv3)); app.wait_for_timeout(800)
    lst = {'K1': {'tmall': True, 'logi': '已签收 您的包裹已签收'}, 'K2': {'tmall': True, 'logi': '已发货 运输中 · 虚构快递'},
           'K3': {'logi': '已签收 您的包裹已签收'}, 'K4': {'logi': '已签收 您的包裹已签收'}}
    app.evaluate('s => chrome.storage.local.get("scraped").then(r => chrome.storage.local.set({ scraped: Object.assign({}, r.scraped, s) }))',
                 {N18[k]: dict({'no': N18[k], 'status': '卖家已发货', 'nick': 'nick' + N18[k][-3:], 'lines': [{'title': X18[k][5][0][0]}]}, **v) for k, v in lst.items()})
    app.wait_for_timeout(800)
    app.evaluate("""nos => { const S = JSON.parse(localStorage.getItem('orderTriage.app.v1'));
        for (const o of S.orders) if (nos.includes(o.no)) for (const l of o.lines) S.decisions[l.key] = 'lab';
        localStorage.setItem('orderTriage.app.v1', JSON.stringify(S)); }""", list(N18.values()))
    app.reload(); app.wait_for_selector('#main:not([hidden])'); app.wait_for_timeout(800)
    recv0 = app.evaluate('__otDev.lists()')['recv']
    check(recv0 == [N18['K1']], '读详情页之前：只有列表上认出天猫、已签收的 K1 要确认收货（K2 运输中、K3 还不知道是不是天猫、K4 不是天猫）', recv0)
    app.evaluate('nos => __otDev.inspect(nos)', [N18['K3'], N18['K4']])
    o3, o4 = app.evaluate('no => __otDev.order(no)', N18['K3']), app.evaluate('no => __otDev.order(no)', N18['K4'])
    check(o3.get('tmall') is True and '已签收' in (o3.get('logi') or '') and o4.get('tmall') is False,
          '详情页：K3 跳到 trade.tmall.com，记为天猫；K4 没跳，记为不是天猫', {'K3': (o3.get('tmall'), o3.get('logi')), 'K4': o4.get('tmall')})
    recv1 = sorted(app.evaluate('__otDev.lists()')['recv'])
    check(recv1 == sorted([N18['K1'], N18['K3']]), '确认收货的范围：天猫 AND 已签收 AND 卖家已发货的实验室订单（K1、K3）；未签收的 K2、非天猫的 K4 不进', recv1)

    # 自动处理发票：确认清单里多一组「确认收货（天猫，确认后申请平台开票）」，默认勾选；只留这一组确认
    for pg in [pg for pg in ctx.pages if '/app/im/' in pg.url or pg.url.startswith(INV_URL)]: pg.close()
    app.bring_to_front()
    app.evaluate('() => { __otDev.tmo = { apply: 4000 }; }')            # 离线没有批量开票页：申请那一段 4 秒就结束，只看排进去的单
    app.evaluate('chrome.storage.local.set({ applyJob: null })')
    app.click('.flow li[data-step="2"]'); app.wait_for_timeout(500)
    wait_until(app, lambda: not app.evaluate('__otDev.run()')['busy'], 60)
    app.click('#summary [data-flow="inv-run"]')
    app.wait_for_selector('#dlg-list[open]', timeout=600000)
    heads = app.evaluate("[...document.querySelectorAll('#list-rows h4.grp')].map(h => [h.textContent, h.title])")
    gi = next((i for i, h in enumerate(heads) if h[0].startswith('确认收货（天猫，确认后申请平台开票）')), -1)
    check(gi >= 0 and heads[gi][0].endswith('（2）') and '确认收货会把货款打给卖家，且不可撤销；只对物流已签收的订单确认' in heads[gi][1] and '密码' not in heads[gi][1],
          '确认清单里有「确认收货（天猫，确认后申请平台开票）（2）」，悬停写明货款打给卖家、不可撤销、只对已签收的确认', heads)
    rows = app.evaluate("gi => [...document.querySelectorAll('#list-rows input[data-g=\"' + gi + '\"]')].map(i => ({ on: i.checked, tip: i.title, text: i.closest('label').innerText }))", gi)
    check(len(rows) == 2 and all(r['on'] for r in rows) and all('签收：' in r['text'] and '订单号' in r['text'] and '¥' in r['text'] for r in rows)
          and {N18['K1'], N18['K3']} == {n for r in rows for n in N18.values() if n in r['text']} and all('不可撤销' in r['tip'] for r in rows),
          '这一组列出 K1、K3（店铺、下单日期、商品、金额、订单号、签收信息），默认勾选', rows)
    app.evaluate("gi => document.querySelectorAll('#list-rows input[data-g]').forEach(i => { i.checked = +i.dataset.g === gi; })", gi)
    app.click('#list-ok')
    # K1：插件自己点「确认收货」→ 确认页点「确定」→ 交易成功
    k1 = wait_until(app, lambda: (o := app.evaluate('no => __otDev.order(no)', N18['K1'])) and o.get('statusLive') == '交易成功' and o, 120)
    today = app.evaluate("(() => { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })()")
    check(bool(k1) and k1.get('doneAt') == today, 'K1：自动确认收货，订单变成交易成功，交易成功日期记为今天（本机日期）', k1 and (k1.get('statusLive'), k1.get('doneAt')))
    # K3：确认页上有密码框 → 插件停下、切到前台、什么都不填；主页进度写明在等用户
    man = wait_until(app, lambda: (r := store('recvRun')) and r.get('no') == N18['K3'] and r.get('state') == 'manual' and r, 90)
    cpg = next((pg for pg in ctx.pages if 'confirm_goods' in pg.url and N18['K3'] in pg.url), None)
    prog = wait_until(app, lambda: '请在淘宝页面自行完成验证后确认收货（第 2 / 2 单' in (t := app.inner_text('#summary')) and t, 10) or app.inner_text('#summary')
    check(bool(man) and bool(cpg), 'K3：确认页上出现密码框，插件停下（state = manual），没有点「确定」', man)
    check('请在淘宝页面自行完成验证后确认收货（第 2 / 2 单' in prog, '主页进度写「请在淘宝页面自行完成验证后确认收货（第 2 / 2 单…）」', prog[:300])
    if cpg:
        cpg.wait_for_timeout(2500)
        m = cpg.evaluate('({ touched: window.__mockRecv.touched, clicks: window.__mockRecv.clicks, value: document.querySelector(\'input[type=password]\').value, '
                         'vis: document.visibilityState, panel: (document.querySelector(\'div[style*="2147483647"]\') || {}).innerText || \'\' })')
        check(m['touched'] == [] and m['value'] == '' and m['clicks'] == [], '密码框没被聚焦、输入、改值（插件不碰密码框），也没替用户点「确定」', m)
        check(m['vis'] == 'visible' and '插件不填写任何内容' in m['panel'], '这一页切到了前台，面板写明请用户自行完成', m)
        cpg.click('#ok')                                                # 用户自己在页面上完成
    fin = wait_until(app, lambda: (t := app.inner_text('#summary')) and '发票处理完成' in t and t, 180) or app.inner_text('#summary')
    rl = next((l for l in fin.split('\n') if l.startswith('⑨ ')), '')
    check(rl.startswith('⑨ 确认收货：已确认收货 2 / 2 单，已排进申请平台开票'), '总结：确认收货 2 / 2 单，已排进申请平台开票', fin[:500])
    job = store('applyJob') or {}
    check(sorted(job.get('nos') or []) == sorted([N18['K1'], N18['K3']]), '确认收货后的 K1、K3 排进了同一轮的「申请平台开票」（applyJob）', job.get('nos'))
    k3 = app.evaluate('no => __otDev.order(no)', N18['K3'])
    check(k3.get('statusLive') == '交易成功' and not store('recvRun'), 'K3：用户在页面上完成后插件检测到交易成功，任务清掉', (k3.get('statusLive'), store('recvRun')))
    if cpg and not cpg.is_closed():
        check(cpg.evaluate('window.__mockRecv.touched') == [], '直到最后密码框都没被碰过')
    left = app.evaluate('__otDev.lists()')['recv']
    check(left == [], '确认收货以后清单里不再有这两单', left)
    app.evaluate('() => { __otDev.tmo = null; }')


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
