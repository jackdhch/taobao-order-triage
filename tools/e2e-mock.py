#!/usr/bin/env python3
"""
离线回归测试：Chrome 扩展 + 抓取脚本 + 模拟订单页，全程不连淘宝、不联网，数据全部虚构。

    python3 tools/e2e-mock.py

需要 python3 和 playwright（含它自带的 Chromium：python3 -m playwright install chromium）。
流程：起本地 http 服务（只端出模拟页）→ 带扩展启动无界面 Chromium → 扩展主页导入虚构订单表 →
打开 tools/mock-taobao.html?v=new 点「开始补图片」→ 等自动翻页（两遍）结束 → 逐单逐件核对；
最后用旧版模拟页（无参数）确认「按文字特征猜」的回退解析还能用。
自动翻页每页会停 2.5~5 秒（抓取脚本故意放慢），整个测试大约一分钟。
"""
import csv
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]         # 项目根目录本身就是扩展
PANEL = 'div[style*="2147483647"]'                 # 抓取脚本在淘宝页右下角加的面板
# 订单表里有、两种列表里都没有的订单（真实页面上大概率是删进了回收站）
NEVER = {'no': '5190000000000000050', 'd': '2026-08-12', 'shop': '某某虚构文具', 'st': '交易成功', 'pay': '15.80', 'ship': '0.00',
         'items': [{'t': '中性笔 0.5mm 黑色 12支', 'sku': '12支装', 'p': '15.80', 'q': 1}]}
NOT_IN_TABLE = {'5190000000000000016'}             # 页面上有、订单表里没有（导出之后才下的单）：不该被存下来

fails = []


def check(ok, msg, detail=''):
    print(('  通过  ' if ok else '  失败  ') + msg + ('' if ok or not detail else '\n          ' + str(detail)))
    if not ok:
        fails.append(msg)


def free_port():
    while True:
        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
        s.close()
        if port not in (8765, 9333):                # 8765 是开发用服务，9333 可能是操作者正在用的浏览器
            return port


def write_csv(path, orders):
    # 淘宝导出表的样子：一单多件时，后续行订单号（和整单字段）留空
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['订单号', '订单提交时间', '订单状态', '店铺名称', '商品名称', '型号款式', '商品数量', '商品金额', '实付金额', '运费'])
        for k, o in enumerate(orders):
            y, mo, d = o['d'].split('-')
            # 一半订单用「2026/8/5 10:00」写法：别人的导出表不一定是 YYYY-MM-DD，主页要统一过来，不然翻页提前停的判断会错
            t = o['d'] + ' 10:00:00' if k % 2 else f'{int(y)}/{int(mo)}/{int(d)} 10:00'
            for i, it in enumerate(o['items']):
                head = [o['no'], t, o['st'], o['shop']] if i == 0 else ['', '', '', '']
                w.writerow(head + [it['t'], it.get('sku', ''), it['q'], it['p']] + ([o['pay'], o['ship']] if i == 0 else ['', '']))


def wait_until(page, fn, timeout):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        page.wait_for_timeout(250)
    return None


def compare(got, o):
    """抓到的一单 vs 模拟页数据，返回不一致的地方"""
    bad = []
    for k, want in (('time', o['d']), ('status', o['st']), ('shop', o['shop']), ('pay', float(o['pay'])), ('ship', float(o['ship']))):
        if got.get(k) != want:
            bad.append(f'{k}: 抓到 {got.get(k)!r}，应为 {want!r}')
    lines = got.get('lines') or []
    if len(lines) != len(o['items']):               # 多了就是「常买常逛」推荐栏混进来了
        bad.append(f'件数: 抓到 {len(lines)}，应为 {len(o["items"])}（标题：{[l.get("title") for l in lines]}）')
    for i, (l, it) in enumerate(zip(lines, o['items'])):
        for k, want in (('title', it['t']), ('sku', it.get('sku', '')), ('price', float(it['p'])), ('qty', it['q']),
                        ('img', it.get('imgSaved', it['img'])), ('refund', it.get('refund', '')), ('link', it['link'])):
            if l.get(k) != want:
                bad.append(f'第 {i + 1} 件 {k}: 抓到 {l.get(k)!r}，应为 {want!r}')
    return bad


def run(p, base, tmp):
    ctx = p.chromium.launch_persistent_context(str(tmp / 'profile'), channel='chromium', headless=True, args=[
        '--disable-extensions-except=' + str(ROOT), '--load-extension=' + str(ROOT),
        # 双保险不联网：不走系统代理；除 127.0.0.1 以外的域名一律解析失败（下面的 route 还会再拦一道）
        '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'])
    blocked, errors, dialogs, logs = [], [], [], []

    GIF1 = bytes.fromhex('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b')
    PNG2 = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000001049444154789c63f8cfc000440c100a001fee03fd8b5f14d40000000049454e44ae426082')

    def block(route):
        url = route.request.url
        blocked.append(url)
        if urlsplit(url).hostname == 'img.alicdn.com':
            # 假图片：正常的回 2×2 小图；「_200x200」小图和「-dead」回 1×1 灰点（淘宝 CDN 不带 Referer 时就是这样）
            bad = '_200x200' in url or '-dead' in url
            route.fulfill(status=404 if bad else 200, content_type='image/gif' if bad else 'image/png', body=GIF1 if bad else PNG2)
            return
        route.abort()
    ctx.route(lambda u: urlsplit(u).scheme in ('http', 'https', 'ws', 'wss') and urlsplit(u).hostname != '127.0.0.1', block)

    def watch(page, tag):
        page.on('pageerror', lambda e: errors.append(f'{tag}: {e}'))
        page.on('dialog', lambda d: (dialogs.append(f'{tag}: {d.message}'), d.dismiss()))
        page.on('console', lambda c: logs.append(f'{tag}: {c.text}') if '订单分拣' in c.text else None)
        return page

    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
    eid = urlsplit(sw.url).hostname
    print('扩展已加载，ID', eid)

    # 模拟页的数据就是期望值（页面把它放在 window.__mock 里）
    m = ctx.new_page()
    m.goto(base + 'tools/mock-taobao.html?v=new')
    mock = m.evaluate('window.__mock')
    m.close()
    table = [o for o in mock['orders'] if o['no'] not in NOT_IN_TABLE] + [NEVER]
    findable = [o for o in table if o is not NEVER]
    hidden = {o['no'] for o in mock['orders'] if o.get('hideDefault')}
    all_lines = sum(len(o['items']) for o in table)
    csv_path = tmp / '虚构订单表.csv'
    write_csv(csv_path, table)

    print('\n[1] 扩展主页导入虚构订单表')
    app = watch(ctx.new_page(), '主页')
    app.goto(f'chrome-extension://{eid}/index.html')
    app.set_input_files('#file', str(csv_path))
    get_want = lambda: app.evaluate('chrome.storage.local.get("want").then(r => r.want)')
    want = wait_until(app, lambda: (w := get_want()) and len(w['nos']) == len(table) and w, 10)
    check(bool(want), f'缺图清单写进扩展存储：{len(table)} 单', get_want())
    check(f'有图 0 / {all_lines} 件' in app.inner_text('.flow'), f'导入后步骤条「补图片」显示「有图 0 / {all_lines} 件」', app.inner_text('.flow'))
    check(app.get_attribute('#seg-cat button[aria-pressed="true"]', 'data-cat') == 'unsure', '主页打开默认在「待定」', app.inner_text('#seg-cat'))

    print('\n[2] 新版模拟页：开始补图片，自动翻页')
    m = watch(ctx.new_page(), '模拟页')
    m.goto(base + 'tools/mock-taobao.html?v=new')
    m.wait_for_selector(PANEL)
    check(f'清单还差 {len(table)} 单' in m.inner_text(PANEL), '面板拿到了主页的清单', m.inner_text(PANEL))
    btns = m.evaluate("p => [...document.querySelector(p).querySelectorAll('button[data-ot]')].map(b => b.dataset.ot)", PANEL)
    check(sorted(btns) == ['auto', 'mini'], '淘宝页面板只有「开始补图片」和「收起」两个按钮', btns)
    get_scraped = lambda: app.evaluate('chrome.storage.local.get("scraped").then(r => r.scraped || {})')
    t0 = time.time()
    m.click(PANEL + ' button[data-ot="auto"]')
    seen_running = False
    while time.time() - t0 < 300:
        txt = m.inner_text(PANEL)
        seen_running |= '自动翻页中' in txt
        if seen_running and '自动翻页中' not in txt:
            break
        m.wait_for_timeout(300)
    panel = m.inner_text(PANEL)
    print(f'  自动翻页用时 {time.time() - t0:.0f} 秒；面板：' + panel.replace('\n', ' | '))
    check(seen_running and '自动翻页中' not in panel, '自动翻页在 300 秒内停下')

    log = m.evaluate('window.__mock.log')
    print('  模拟页翻过的页：', log)
    n_def = len(mock['lists']['default'])
    # 真实页面上漏掉的都是用户删掉的订单（按订单号都搜不到），所以翻完默认列表就停，不再换搜索列表重翻；
    # 模拟页里 hideDefault 的订单就相当于删掉的
    check(log == [f'default:{i + 1}' for i in range(n_def)], f'只翻默认列表 {n_def} 页（最后一页「下一页」带 trade-button-disabled，在这里停），不再换列表重翻', log)
    check(not dialogs, '标题里带「滑块」「验证码」的商品没被当成安全验证', dialogs)

    visible = {o['no'] for o in findable} - hidden
    scraped = get_scraped()
    got = set(scraped)
    check(got == visible, f'列表里有的 {len(visible)} 单全找到（含刚打开时没渲染、要往下滚才出齐的），没存订单表以外的',
          f'多了 {sorted(got - visible)}，少了 {sorted(visible - got)}')
    left = hidden | {NEVER['no']}
    check(f'清单还差 {len(left)} 单' in panel and f'已找到 {len(visible)} 单' in panel, f'面板最后显示还差 {len(left)} 单', panel)
    want = get_want()
    dead_nos = {o['no'] for o in findable if o['no'] in visible and any(it.get('imgSaved') == '' for it in o['items'])}
    check(want and set(want['nos']) == left | dead_nos and want['from'] == min(o['d'] for o in table if o['no'] in left | dead_nos),
          '主页的缺图清单只剩列表里没有的几单，加上图全坏的那单；日期统一成了 YYYY-MM-DD（订单表里一半是「2026/8/5」写法）', want)
    check(any('多半是已删除的订单' in l for l in logs), '控制台提示剩下的多半是已删除的订单', logs[-3:])

    bad = {o['no']: b for o in findable if o['no'] in scraped and (b := compare(scraped[o['no']], o))}
    check(not bad, '逐单核对：日期/状态/店铺/实付/运费，逐件：标题/规格/单价/数量/图片/退款/链接；件数对（推荐栏没混进来）',
          '\n          '.join(f'{no}: {x}' for no, b in bad.items() for x in b))
    check(m.evaluate('localStorage.length') == 0, '淘宝页（模拟页）自己的 localStorage 是空的', m.evaluate('Object.keys(localStorage)'))

    dead = [it['t'] for o in findable if o['no'] in visible for it in o['items'] if it.get('imgSaved') == '']
    check(len(dead) == 1, '模拟页里有 1 件图全坏', dead)
    app.bring_to_front()
    img_n = all_lines - sum(len(o['items']) for o in table if o['no'] in left) - len(dead)
    foot = wait_until(app, lambda: (t := app.inner_text('.flow')) and f'有图 {img_n} / {all_lines} 件' in t and t, 5) or app.inner_text('.flow')
    check(f'有图 {img_n} / {all_lines} 件' in foot, f'扩展主页显示「有图 {img_n} / {all_lines} 件」（图全坏的那件不算有图）', foot)
    app.click('#seg-cat button[data-cat="all"]'); app.wait_for_timeout(300)
    err = app.evaluate("t => { const e = [...document.querySelectorAll('.line')].find(x => x.textContent.includes(t)); const p = e && e.querySelector('.thumb'); return p ? [p.className, p.textContent, getComputedStyle(p).color] : null; }", dead[0])
    check(err and 'err' in err[0] and 'ERROR' in err[1] and err[2] == 'rgb(208, 2, 27)', '图全坏的那件：主页上是红色粗体 ERROR，不是灰色图', err)
    grey = app.evaluate("() => [...document.querySelectorAll('img.thumb')].filter(i => i.complete && i.naturalWidth === 1).map(i => i.src)")
    check(not grey, '主页上没有 1×1 灰点图', grey)
    # 退款由插件判：显示「退款成功」的那一件就算退款（交易成功的单也一样，用户 2026-10-02 要求不用他核对），交易关闭的整单算
    maybe = [it['t'] for o in table if o['no'] in visible and o['st'] == '交易成功' for it in o['items'] if it.get('refund')]
    ref_n = sum(1 for o in table for it in o['items'] if o['st'] == '交易关闭') + len(maybe)
    ref_cell = app.inner_text('#seg-cat button[data-cat="refund"] .c')
    check(ref_cell.strip() == str(ref_n), f'「退款/关闭」{ref_n} 件（交易关闭的 + 交易成功单里显示退款成功的 {len(maybe)} 件）', ref_cell)
    app.click('#seg-cat button[data-cat="refund"]'); app.wait_for_timeout(300)
    inref = app.evaluate("t => t.map(x => [...document.querySelectorAll('.line')].some(e => e.textContent.includes(x)))", maybe)
    check(len(maybe) == 2 and inref == [True, True], '交易成功的单里显示退款成功的两件：直接在「退款/关闭」里，不进待定', inref)
    same = [o for o in table if o['no'] in visible and o['st'] == '交易成功' and any(it.get('refund') for it in o['items']) and len(o['items']) > 1]
    kept = [it['t'] for o in same for it in o['items'] if not it.get('refund')]
    app.click('#seg-cat button[data-cat="all"]'); app.wait_for_timeout(300)
    notref = app.evaluate("t => t.map(x => [...document.querySelectorAll('.line:not(.is-ref)')].some(e => e.textContent.includes(x)))", kept)
    check(all(notref), f'同一单里没退的 {len(kept)} 件照常分拣（只有退了的那件算退款）', list(zip(kept, notref)))
    app.click('#seg-cat button[data-cat="unsure"]')

    # 剩下几单在别处补上了图（往扩展存储的抓取数据里加上它们），主页写回空清单。
    # 空清单 = 订单表里的都有图了，淘宝页面板不能改口成「没有订单表、抓全部」，再点开始也不该翻页
    # scrapedAt：近期的单要定期回看退款，6 小时内看过的才算「已经看过」
    rest = {o['no']: {'no': o['no'], 'time': o['d'], 'status': o['st'], 'shop': o['shop'], 'scrapedAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
                      'lines': [{'title': it['t'], 'img': 'https://img.alicdn.com/imgextra/mock/filled.jpg'} for it in o['items']]}
            for o in table if o['no'] in left}
    app.evaluate('x => chrome.storage.local.get("scraped").then(r => chrome.storage.local.set({ scraped: Object.assign(r.scraped || {}, x) }))', rest)
    only_dead = wait_until(app, lambda: (w := get_want()) and set(w['nos']) == dead_nos, 5)
    check(bool(only_dead), '剩下几单补上图后，清单里只剩图全坏的那单', get_want())
    m.wait_for_timeout(500)
    txt = m.inner_text(PANEL)
    check('1 单有图片打不开' in txt and '图片没补完' in txt and '都已有图' not in txt,
          '有图打不开时，淘宝页面板写明「图片没补完」，不说「都已有图」（用户 2026-10-03 要求）', txt.replace('\n', ' | '))
    # 那单后来换了能打开的图
    fix = {no: dict(rest[next(iter(rest))], no=no, lines=[{'title': it['t'], 'img': 'https://img.alicdn.com/imgextra/mock/filled.jpg'} for it in o['items']])
           for o in table for no in [o['no']] if no in dead_nos}
    app.evaluate('x => chrome.storage.local.get("scraped").then(r => chrome.storage.local.set({ scraped: Object.assign(r.scraped || {}, x) }))', fix)
    done = wait_until(app, lambda: (w := get_want()) and not w['nos'], 5)
    check(bool(done), '图都补上后，主页写回空清单', get_want())
    m.wait_for_timeout(500)
    txt = m.inner_text(PANEL)
    check('还没有订单表' not in txt and '都已有图' in txt, '清单为空时，淘宝页面板说「都已有图」，不改口成「没有订单表」', txt.replace('\n', ' | '))
    n_log = len(m.evaluate('window.__mock.log'))
    m.click(PANEL + ' button[data-ot="auto"]')
    m.wait_for_timeout(4000)
    check(len(m.evaluate('window.__mock.log')) == n_log and len(get_scraped()) == len(visible) + len(left),
          '清单为空时再点「开始补图片」：不翻页、不多存订单', m.evaluate('window.__mock.log')[n_log:])

    # 主页「清除全部数据」后，淘宝页内存里的旧数据不能再写回去
    app.evaluate('chrome.storage.local.clear()')
    m.wait_for_timeout(500)
    m.click(PANEL + ' button[data-ot="auto"]')
    t0 = time.time()
    while time.time() - t0 < 300 and '自动翻页中' not in m.inner_text(PANEL): m.wait_for_timeout(200)
    while time.time() - t0 < 300 and '自动翻页中' in m.inner_text(PANEL): m.wait_for_timeout(300)
    after = set(get_scraped())
    check(after and not (after & left), '主页清空扩展存储后再补图：只存页面上看得到的单，不把内存里的旧数据（列表里没有的几单）写回',
          f'写回了 {sorted(after & left)}')

    print('\n[3] 旧版模拟页（无参数）：回退到按文字特征猜')
    m.close()
    old = [{'no': '5124000000000000011', 'shop': '某某航模店', 'lines': [('AM32 电调调参卡 支持 BLHeli 调参', 9.9, 1, '')]},
           {'no': '5124000000000000012', 'shop': '某某3D打印', 'lines': [('金属 3D 打印加工服务 不锈钢 铝合金 手板打样', 120.0, 1, '')]},
           {'no': '5123000000000000001', 'shop': '某某五金工具', 'lines': [('304不锈钢内六角螺丝 杯头螺钉 M3', 19.8, 1, ''),
                                                                    ('数显游标卡尺 0-150mm 高精度', 68.8, 1, '退款成功')]}]
    app.evaluate('w => chrome.storage.local.set({ want: w, scraped: {} })', {'nos': [o['no'] for o in old], 'from': '2026-07-10'})
    m2 = watch(ctx.new_page(), '旧版模拟页')
    m2.goto(base + 'tools/mock-taobao.html')
    m2.wait_for_selector(PANEL)
    m2.click(PANEL + ' button[data-ot="auto"]')
    s2 = wait_until(m2, lambda: (s := get_scraped()) and len(s) >= len(old) and s, 15) or get_scraped()
    bad = []
    for o in old:
        g = s2.get(o['no'])
        if not g:
            bad.append(f'{o["no"]}: 没抓到')
            continue
        if g['shop'] != o['shop']:
            bad.append(f'{o["no"]} 店铺: {g["shop"]!r}')
        got_lines = [(l['title'], l['price'], l['qty'], l['refund']) for l in g['lines']]
        if got_lines != o['lines']:
            bad.append(f'{o["no"]} 商品: {got_lines}')
        if not all(l['img'].startswith('https://img.alicdn.com/mock/item-') for l in g['lines']):
            bad.append(f'{o["no"]} 图片: {[l["img"] for l in g["lines"]]}')
    check(not bad, '旧版页面第 1 页 3 单：店铺、标题、单价、数量、逐件退款、商品图都抓对', '\n          '.join(bad))
    check(m2.evaluate('localStorage.length') == 0, '旧版模拟页的 localStorage 也是空的')

    print('\n[4] 订单表之前的订单：填「提取到哪天」，按订单页建单')
    m2.close()
    app.evaluate('chrome.storage.local.clear()')
    app.evaluate("localStorage.removeItem('orderTriage.app.v1')")
    app.reload()
    early = sorted(findable, key=lambda o: o['d'])[:3]          # 最早的 3 单不放进订单表（相当于淘宝导不出来的月份）
    table2 = [o for o in table if o not in early]
    before, frm = min(o['d'] for o in table2), '2026-07-10'
    expect = {o['no'] for o in early if frm <= o['d'] < before}
    csv2 = tmp / '虚构订单表-近几个月.csv'
    write_csv(csv2, table2)
    app.set_input_files('#file', str(csv2))
    # 存储里留着一条比要提取的日期还早的旧抓取数据（比如以前没订单表时抓的）：不该被建单
    stale = {'no': '5190000000000000099', 'time': '2026-06-15', 'status': '交易成功', 'shop': '某某虚构旧店', 'lines': [{'title': '旧的抓取数据'}]}
    app.evaluate('x => chrome.storage.local.set({ scraped: { [x.no]: x } })', stale)
    app.wait_for_timeout(800)
    app.click('.flow li[data-step="2"]'); app.click('button[data-flow="img-dlg"]')
    app.fill('#img-older', frm)
    w = wait_until(app, lambda: (x := get_want()) and x.get('older') and x, 5) or get_want()
    check(w and w.get('older') == {'from': frm, 'before': before}, f'清单里带上「{frm} 至订单表最早一天 {before} 之前」', w)
    app.click('#img-close')
    m3 = watch(ctx.new_page(), '模拟页（订单表之前）')
    m3.goto(base + 'tools/mock-taobao.html?v=new')
    m3.wait_for_selector(PANEL)
    check('订单表之前' in m3.inner_text(PANEL), '淘宝页面板显示「订单表之前」的提取数', m3.inner_text(PANEL).replace('\n', ' | '))
    m3.click(PANEL + ' button[data-ot="auto"]')
    t0 = time.time()
    while time.time() - t0 < 300 and '自动翻页中' not in m3.inner_text(PANEL): m3.wait_for_timeout(200)
    while time.time() - t0 < 300 and '自动翻页中' in m3.inner_text(PANEL): m3.wait_for_timeout(300)
    got = set(get_scraped())
    check(expect <= got and not ({o['no'] for o in early} - expect) & got, f'存下了 {frm} 之后、订单表之前的 {len(expect)} 单，更早的没存',
          f'存了 {sorted(got & {o["no"] for o in early})}，应为 {sorted(expect)}')
    home = lambda: set(app.evaluate("JSON.parse(localStorage.getItem('orderTriage.app.v1')).orders.filter(o => o.source === 'scrape').map(o => o.no)"))
    made = wait_until(app, lambda: home() == expect, 5)
    check(made, f'主页按订单页建了这 {len(expect)} 单（存储里那条比 {frm} 还早的旧数据没建）', home())
    cleared = wait_until(app, lambda: (x := get_want()) and 'older' not in x and x, 5)
    check(bool(cleared) and not app.evaluate("JSON.parse(localStorage.getItem('orderTriage.app.v1')).older"),
          '翻完后主页清掉了「提取到哪天」，以后补图找齐就停', get_want())
    app.set_input_files('#file', str(csv2))
    app.wait_for_timeout(1500)
    check(home() == expect, '重新导入订单表后，这几单还在（没被当成「没有订单表时临时建的单」删掉）', home())
    m3.close()

    print('\n[5] 杂项')
    check(not errors, '页面没有报错', errors)
    check(not dialogs, '没有弹窗（没出现安全验证提示等）', dialogs)
    outside = [u for u in blocked if not urlsplit(u).hostname.endswith(('alicdn.com', 'taobao.com'))]
    check(not outside, f'拦下的外部请求 {len(blocked)} 个，都是模拟页里的假图片地址', outside[:5])
    if fails:
        print('\n抓取脚本的控制台输出：\n  ' + '\n  '.join(logs))
    ctx.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix='order-triage-e2e-'))
    # http 服务只端出模拟页：项目根目录下有 local-data/（私人订单），不能整个目录端出去
    (tmp / 'www' / 'tools').mkdir(parents=True)
    (tmp / 'www' / 'tools' / 'mock-taobao.html').symlink_to(ROOT / 'tools' / 'mock-taobao.html')
    port = free_port()
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '--directory', str(tmp / 'www')],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                socket.create_connection(('127.0.0.1', port), 0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        with sync_playwright() as p:
            run(p, f'http://127.0.0.1:{port}/', tmp)
    finally:
        srv.terminate()
        srv.wait(5)
        shutil.rmtree(tmp, ignore_errors=True)       # 连同测试浏览器的配置目录（里面的 localStorage、扩展存储）一起删掉
    print('\n' + ('全部通过' if not fails else f'{len(fails)} 项失败：\n  ' + '\n  '.join(fails)))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
