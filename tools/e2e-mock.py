#!/usr/bin/env python3
"""
离线回归测试：Chrome 扩展 + 抓取脚本 + 模拟订单页，全程不连淘宝、不联网，数据全部虚构。

    python3 tools/e2e-mock.py

需要 python3 和 playwright（含它自带的 Chromium：python3 -m playwright install chromium）。
流程：起本地 http 服务（只端出模拟页）→ 带扩展启动无界面 Chromium →
[0] 主页「从淘宝读取订单」：真实「已买到的宝贝」网址的请求由这里回应模拟页，淘宝页不点按钮自动翻页、读到截止日期、读完自己关掉；
    之后导入只含两单的订单表只合并不删单；再读一次是增量更新 →
[1][2] 扩展主页导入虚构订单表 →
打开 tools/mock-taobao.html?v=new 点「开始补图片」→ 等自动翻页（两遍）结束 → 逐单逐件核对；
最后用旧版模拟页（无参数）确认「按文字特征猜」的回退解析还能用。
自动翻页每页会停 2.5~5 秒（抓取脚本故意放慢），整个测试大约一分钟。
"""
import csv
import datetime
import re
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
    # 天猫标记（店名前图标写着「天猫」、或店名链接是 tmall.com）、订单上的物流标签（确认收货前看是否已签收，用户 2026-10-09）
    if bool(got.get('tmall')) != bool(o.get('tmall')):
        bad.append(f'tmall: 抓到 {got.get("tmall")!r}，应为 {bool(o.get("tmall"))!r}')
    if o.get('label') and not all(x in (got.get('logi') or '') for x in o['label']):
        bad.append(f'logi: 抓到 {got.get("logi")!r}，应含 {o["label"]!r}')
    lines = got.get('lines') or []
    if len(lines) != len(o['items']):               # 多了就是「常买常逛」推荐栏混进来了
        bad.append(f'件数: 抓到 {len(lines)}，应为 {len(o["items"])}（标题：{[l.get("title") for l in lines]}）')
    for i, (l, it) in enumerate(zip(lines, o['items'])):
        for k, want in (('title', it['t']), ('sku', it.get('sku', '')), ('price', float(it['p'])), ('qty', it['q']),
                        ('img', it.get('imgSaved', it['img'])), ('refund', it.get('refund', '')), ('link', it['link'])):
            if l.get(k) != want:
                bad.append(f'第 {i + 1} 件 {k}: 抓到 {l.get(k)!r}，应为 {want!r}')
    return bad


def read_section(ctx, base, eid, mock, watch, tmp):
    """「从淘宝读取订单」（用户 2026-10-07：不再需要导出订单表）：主页一键 → 模拟订单页领到任务自动翻页 → 读完关页、主页显示结果；
    没有读取任务时不自动翻；截止日期生效；之后导入订单表只合并、不删按订单页建的单；再读一次是增量更新，判断保留"""
    print('\n[0] 从淘宝读取订单')
    store = lambda pg, k: pg.evaluate(f'chrome.storage.local.get("{k}").then(r => r["{k}"])')
    a0 = watch(ctx.new_page(), '主页（读取）')
    a0.goto(f'chrome-extension://{eid}/index.html')
    a0.wait_for_selector('#empty:not([hidden])')
    txt = a0.inner_text('#empty')
    check(a0.locator('#guide > li').count() == 2 and '填写发票抬头和税号' in txt and '从淘宝读取订单' in txt and '导出订单' not in txt,
          '没有数据时显示「开始使用」两项：填写抬头税号、从淘宝读取订单（不再要求导出订单表）', txt)
    untitled = a0.evaluate("[...document.querySelectorAll('#empty button')].filter(b => b.offsetParent && !b.title).map(b => b.textContent)")
    check(not untitled, '「开始使用」里的按钮都有悬停说明', untitled)
    check(a0.inner_text('#guide > li[data-g="info"] .g-n').strip() == '1', '抬头税号未填时第 1 项不打勾')
    a0.click('#empty [data-guide="settings"]'); a0.fill('#inv-title', '某虚构大学'); a0.fill('#inv-tax', '121000009999999996'); a0.click('#rules-save')
    a0.wait_for_timeout(300)
    check(a0.inner_text('#guide > li[data-g="info"] .g-n').strip() == '✓', '填好抬头税号后第 1 项打勾')

    m0 = watch(ctx.new_page(), '模拟页（无读取任务）')
    m0.goto(base + 'tools/mock-taobao.html?v=new')
    m0.wait_for_timeout(3500)
    check(m0.evaluate('window.__mock.log') == ['default:1'] and m0.locator(PANEL).count() == 0,
          '没有读取任务时（用户自己打开订单页），不自动翻页，也不出面板', [m0.evaluate('window.__mock.log'), m0.locator(PANEL).count()])
    m0.close()

    # 顶栏「打开淘宝」（用户 2026-10-08：为了登录只能自己在地址栏输网址）：打开「已买到的宝贝」，不排读取任务
    tip = a0.get_attribute('#btn-taobao', 'title') or ''
    with ctx.expect_page(timeout=10000) as pi:
        a0.click('#btn-taobao')
    tbo = pi.value
    ok = wait_until(a0, lambda: 'buyertrade.taobao.com/trade/itemlist/list_bought_items.htm' in tbo.url and tbo, 10)
    check(bool(ok) and '登录' in tip and store(a0, 'readJob') is None, '顶栏「打开淘宝」打开「已买到的宝贝」（悬停说明写明未登录会先到登录页），不自动读取', [tbo.url, tip])
    tbo.wait_for_timeout(1500)
    hb = tbo.locator('#ot-home')
    check(hb.count() == 1 and hb.inner_text() == '← 订单分拣' and tbo.locator(PANEL).count() == 0, '淘宝订单页右上角有小按钮「← 订单分拣」（不是大面板）')
    if hb.count():
        hb.click()
        back = wait_until(a0, lambda: a0.evaluate('chrome.tabs.getCurrent().then(t => t.active)'), 10)
        check(bool(back), '点「← 订单分拣」切回已打开的主页')
    tbo.close()

    # 「开始使用」卡片里的读取进度：进行中蓝色，等安全验证红色（以前都是绿底，像是成功了）
    def g_read(progress):
        a0.evaluate("p => chrome.storage.local.set({ readJob: { at: Date.now(), from: '2026-08-15' }, readProgress: Object.assign({ at: 1, t: Date.now() }, p) })", progress)
        a0.wait_for_timeout(500)
        return a0.evaluate("(() => { const g = document.getElementById('g-read'); return g.hidden ? null : [g.className, g.textContent]; })()")
    gv, gr = g_read({'state': 'verify'}), g_read({'state': 'reading', 'page': 0, 'stored': 0})
    check(gv and 'bad' in gv[0] and '安全验证' in gv[1] and gr and 'busy' in gr[0] and 'bad' not in gr[0],
          '「开始使用」卡片：等待安全验证标红，正在读取标蓝（不再一律绿底）', [gv, gr])
    a0.evaluate("chrome.storage.local.remove(['readJob', 'readProgress'])"); a0.wait_for_timeout(300)

    a0.click('#empty [data-guide="read"]')
    a0.wait_for_selector('#dlg-read[open]')
    check(a0.locator('#dlg-read input').count() == 1, '读取窗口只有一个问题：上次报销到哪天（没有「读取全部订单」等分支）')
    dv = a0.input_value('#read-since')
    days = (datetime.date.today() - datetime.date.fromisoformat(dv)).days if re.fullmatch(r'\d{4}-\d\d-\d\d', dv) else -1
    check(175 <= days <= 190, '没有上次报销截止点时，默认读取最近 6 个月', dv)
    untitled = a0.evaluate("[...document.querySelectorAll('#dlg-read button, #dlg-read input')].filter(b => !b.title && !b.closest('[title]')).map(b => b.id)")
    check(not untitled, '读取窗口的按钮、输入框都有悬停说明', untitled)
    until = '2026-08-15'                            # 上次报销到 08-14：只读 08-15 及以后的订单
    a0.fill('#read-since', '2026-08-14')
    with ctx.expect_page(timeout=10000) as pi:
        a0.click('#read-go')
    tb = pi.value
    opened = wait_until(a0, lambda: not tb.is_closed() and 'buyertrade.taobao.com/trade/itemlist/list_bought_items.htm' in tb.url, 10)
    check(bool(opened), '打开了淘宝「已买到的宝贝」', tb.url)
    job = store(a0, 'readJob')
    check(job and job.get('from') == until, '扩展存储里写了读取任务 readJob（从上次报销那天的后一天读起）', job)
    shown = wait_until(a0, lambda: (t := a0.inner_text('body')) and ('等待登录淘宝' in t or '正在读取' in t) and t, 15)
    check(bool(shown), '主页显示读取进度（等待登录淘宝 / 正在读取）')
    res = wait_until(a0, lambda: store(a0, 'readResult'), 150)
    expect = [o for o in mock['orders'] if not o.get('hideDefault') and o['d'] >= until]
    check(res and res['why'] == 'past' and sorted(res['nos']) == sorted(o['no'] for o in expect) and res['pages'] == 3,
          f'淘宝页没点按钮就自动翻页，读到 {until} 为止（3 页，{len(expect)} 单；截止日期之前的没存）', res)
    check(bool(wait_until(a0, lambda: tb.is_closed(), 10)), '读完后自动关闭插件打开的淘宝页')
    check(store(a0, 'readJob') is None, '读完后清掉 readJob')
    home_orders = lambda: a0.evaluate("(JSON.parse(localStorage.getItem('orderTriage.app.v1') || '{}').orders) || []")
    got = wait_until(a0, lambda: (x := home_orders()) and len(x) == len(expect) and x, 10) or home_orders()
    check({o['no'] for o in got} == {o['no'] for o in expect}, f'主页按订单页建了 {len(expect)} 单', sorted(o['no'] for o in got))
    n_lines = sum(len(o['items']) for o in expect)
    n_ref = sum(1 for o in expect for it in o['items'] if it.get('refund'))
    summ = wait_until(a0, lambda: (t := a0.inner_text('#summary')) and '已读取' in t and t, 10) or a0.inner_text('body')
    check(f'已读取 {len(expect)} 单 {n_lines} 件' in summ and f'其中退款 {n_ref} 件' in summ, f'主页显示「已读取 {len(expect)} 单 {n_lines} 件（日期范围），其中退款 {n_ref} 件」', summ[:400])
    with_img = sum(1 for o in got for l in o['lines'] if l.get('img'))
    check(with_img == n_lines - 1, '商品图片一起读回（图全坏的那件除外）', with_img)
    tip = a0.get_attribute('.flow li[data-step="0"]', 'title') or ''
    check('读取订单' in tip and f'有图 {n_lines - 1} / ' in tip and [t.strip() for t in a0.locator('.flow .flow-t').all_inner_texts()] == ['读取订单', '核对商品', '处理发票', '整理报销文件'], '主线四步：读取订单 → 核对商品 → 处理发票 → 整理报销文件，第 1 步「从淘宝读取订单」的悬停说明有图片数', tip)
    sel, cur = a0.locator('.flow li.is-sel').get_attribute('data-step'), a0.locator('.flow li.is-cur').get_attribute('data-step')
    check(sel == cur and '从淘宝读取订单' not in a0.locator('#summary .flow-acts').inner_text(), '读完后下方说明切到当前步骤，不再显示「从淘宝读取订单」按钮', (sel, cur))
    branch = a0.evaluate("""() => { const out = [];
        for (let i = 0; i < document.querySelectorAll('.flow li').length; i++) {
          document.querySelector('.flow li[data-step="' + i + '"]').click();
          const acts = document.querySelector('#summary .flow-acts');
          out.push([...acts.querySelectorAll('button, input, label')].length); }
        return out; }""")
    check(all(n <= 1 for n in branch), '主线每一步只有一个操作（没有「手动指定日期」「从第一单开始」这类分支）', branch)
    check(a0.locator('#more [data-pick="inv-have-dir"]').count() == 1 and 'title' in a0.evaluate("document.querySelector('#more [data-pick=\"inv-have-dir\"]').outerHTML"),
          '「导入已整理的发票文件夹」移到「更多」里，作为可选功能')
    more = a0.evaluate("[...document.querySelectorAll('#more .more-pop button')].map(b => b.textContent.trim())")
    check(len(more) == 4 and {'备份数据', '从备份恢复'} <= set(more) and any('已整理的发票' in t for t in more) and any('订单表' in t for t in more),
          '「更多」只有四项：导入已整理的发票文件夹、导入订单表、备份数据、从备份恢复', more)
    scroll_only = a0.evaluate("document.querySelectorAll('[data-goto], [data-bulk], #seg-cat, #inv-bar, #inv-auto, #inv-sync, #inv-scan, #inv-dl-all').length")
    check(scroll_only == 0, '没有只切换视图 / 滚动页面的按钮，也没有发票的五个分步按钮', scroll_only)
    prim = a0.evaluate("""() => [...document.querySelectorAll('.flow li')].map((li, i) => { li.click();
        return document.querySelectorAll('#summary .flow-acts .btn.primary').length; })""")
    check(all(n <= 1 for n in prim), '每一步至多一个主按钮', prim)
    hints = a0.evaluate("""() => [...document.querySelectorAll('.flow li')].map(li => { li.click();
        return document.querySelector('#summary .fd-hint').textContent.length; })""")
    check(all(n <= 30 for n in hints) and a0.locator('#summary ol.fd-how').count() == 0, '每步只有一行短提示（≤ 30 字），没有大段编号说明', hints)
    a0.click('.flow li[data-step="1"]'); a0.wait_for_timeout(200)
    check('已读取' in a0.inner_text('#summary'), '切到别的步骤，读取结果仍显示在步骤条下方')

    # 订单表降为可选：导入订单表只合并。表里有的单换成订单表的商品行（图片从订单页那份补上、手动判断跟着挪），表里没有的单保留
    o9 = next(o for o in got if o['no'] == '5190000000000000009')
    k_old = o9['lines'][0]['key']
    a0.evaluate("k => { const S = JSON.parse(localStorage.getItem('orderTriage.app.v1')); S.decisions[k] = 'lab'; localStorage.setItem('orderTriage.app.v1', JSON.stringify(S)); }", k_old)
    a0.reload(); a0.wait_for_selector('#main:not([hidden])')
    m9 = next(o for o in mock['orders'] if o['no'] == '5190000000000000009')
    tbl = tmp / '订单表-两单.csv'
    write_csv(tbl, [dict(m9, items=[dict(m9['items'][0], sku='白色 1L（订单表写法）')]), next(o for o in mock['orders'] if o['no'] == '5190000000000000015')])
    a0.set_input_files('#file', str(tbl))
    after = wait_until(a0, lambda: (x := home_orders()) and any(o['source'] == 'export' for o in x) and x, 10) or home_orders()
    n9 = next((o for o in after if o['no'] == m9['no']), {})
    dec = a0.evaluate("JSON.parse(localStorage.getItem('orderTriage.app.v1')).decisions")
    l9 = (n9.get('lines') or [{}])[0]
    check(len(after) == len(expect), '导入只含 2 单的订单表后，按订单页建的其他订单都还在', len(after))
    check(n9.get('source') == 'export' and l9.get('sku') == '白色 1L（订单表写法）' and l9.get('img'), '表里有的单以订单表字段为准，商品图从订单页那份补上', l9)
    check(dec.get(l9.get('key')) == 'lab' and k_old not in dec, '手动判断跟着挪到订单表的商品行上', {k: v for k, v in dec.items() if k.startswith(m9['no'])})
    check(a0.is_visible('#btn-import') or a0.evaluate("!!document.getElementById('btn-import') && !document.getElementById('btn-import').classList.contains('need-data')"),
          '「导入订单表（xlsx，可选）」在「更多」里，没有数据时也能用')

    # 再读一次 = 增量更新：已有订单和判断保留
    t0 = res['done']
    a0.click('.flow li[data-step="0"]'); a0.click('#summary [data-flow="read"]')
    a0.wait_for_selector('#dlg-read[open]')
    check(a0.input_value('#read-since') == '2026-08-14', '再次读取时默认用上次填写的日期', a0.input_value('#read-since'))
    a0.fill('#read-since', '2026-08-31')
    with ctx.expect_page(timeout=10000) as pi:
        a0.click('#read-go')
    tb2 = pi.value
    res2 = wait_until(a0, lambda: (r := store(a0, 'readResult')) and r['done'] > t0 and r, 150)
    exp2 = [o for o in mock['orders'] if not o.get('hideDefault') and o['d'] >= '2026-09-01']
    check(res2 and res2['pages'] == 2 and sorted(res2['nos']) == sorted(o['no'] for o in exp2), '再读一次（读到 09-01）：翻 2 页就停', res2)
    check(bool(wait_until(a0, lambda: tb2.is_closed(), 10)), '第二次读完也自动关闭淘宝页')
    a0.wait_for_timeout(800)
    dec2 = a0.evaluate("JSON.parse(localStorage.getItem('orderTriage.app.v1')).decisions")
    check(len(home_orders()) == len(expect) and dec2.get(l9.get('key')) == 'lab', '增量更新后订单一单不少，手动判断保留', [len(home_orders()), dec2])

    # 清干净，后面的测试从空白开始
    a0.evaluate("() => { localStorage.clear(); return chrome.storage.local.clear(); }")
    a0.close()


def sort_filter_section(app, STORE):
    """第 2 步「核对商品」的分类筛选（用户 2026-10-09）：全部（总表，按下单日期）/ 实验室 / 个人 / 待定，主按钮随筛选一次确认这一类"""
    print('\n[1b] 核对商品的分类筛选：计数、切换后只剩这一类、一次确认这一类里未确认的、撤销整批、确认完自动切到下一类')
    S = lambda: app.evaluate(f"JSON.parse(localStorage.getItem('{STORE}'))")
    dec0 = S()['decisions']
    app.click('.flow li[data-step="1"]'); app.wait_for_timeout(200)      # 停在第 2 步（全部确认后不自动跳到第 3 步）
    seg = lambda: app.evaluate("[...document.querySelectorAll('#cat-seg [data-cat]')].map(b => [b.dataset.cat, +b.querySelector('b').textContent, b.classList.contains('is-on'), getComputedStyle(b).backgroundColor])")
    # 每件：[分类标签文字, 是否虚线框（自动判断未确认）, 是否退款]
    lines = lambda: app.evaluate("""[...document.querySelectorAll('#list .line')].map(l => { const p = l.querySelector('.meta .pill:not(button)');
        return [p ? p.textContent : '', !!(p && p.classList.contains('auto')), l.classList.contains('is-ref')]; })""")
    btn = lambda: app.evaluate("(() => { const b = document.querySelector('#summary .flow-acts .btn.primary'); return b ? [b.textContent, b.disabled, b.title, b.dataset.flow] : null; })()")
    sg = seg()
    check(app.is_visible('#cat-seg') and [x[0] for x in sg] == ['all', 'lab', 'personal', 'unsure'] and sg[0][2],
          '第 2 步列表上方一排「全部 / 实验室 / 个人 / 待定」，默认是「全部」总表', sg)
    times = app.evaluate("[...document.querySelectorAll('#list .order:not(:has(.line.is-ref))')].map(o => (o.querySelector('.o-date, .date, .ohead') || o).textContent.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '')")
    check(times and times == sorted(times, reverse=True), '总表按下单日期排，新的在前（待定的不挪到最前）', times[:8])
    app.click('#cat-seg [data-cat="unsure"]'); app.wait_for_timeout(200)
    check(len({x[3] for x in sg}) == 4, '四个筛选颜色各不相同（待定黄、实验室蓝、个人粉）', [x[3] for x in sg])
    n = {x[0]: x[1] for x in sg}
    ls = lines()
    check(len(ls) == n['unsure'] and all(t == '待定' for t, _, _ in ls), f'选「待定」：列表只剩 {n["unsure"]} 件待定', ls[:5])
    b = btn()
    check(b and b[1] and '1 / 2' in b[0], '选「待定」时主按钮不可点，写「按 1 / 2 判断」', b)
    app.click('#cat-seg [data-cat="lab"]'); app.wait_for_timeout(200)
    ls = lines()
    check(len(ls) == n['lab'] and all(t == '实验室' and not r for t, _, r in ls), f'选「实验室」：列表只剩 {n["lab"]} 件实验室（不含退款）', ls[:5])
    auto_n = sum(1 for _, a, _ in ls if a)
    b = btn()
    check(b and not b[1] and b[0] == f'这 {auto_n} 件都是实验室，确认' and b[3] == 'sort-cat' and f'以下 {auto_n} 件' in b[2],
          '主按钮变成「这 N 件都是实验室，确认」，N = 自动判断、未确认的件数，悬停说明列出是哪几件', b)
    # 先手动把第一件判成个人：它离开「实验室」列表，按钮的件数跟着变
    app.locator('#list .line .price').first.click(); app.keyboard.press('2'); app.wait_for_timeout(300)
    moved = S()['decisions']
    ls2 = lines()
    check(len(ls2) == n['lab'] - 1, '在「实验室」里按 2 改判个人：这件离开当前列表', (len(ls2), n['lab']))
    lab_keys = app.evaluate("[...document.querySelectorAll('#list .line')].map(l => l.dataset.key)")
    n_conf = sum(1 for _, a, _ in ls2 if a)
    app.click('#summary [data-flow="sort-cat"]'); app.wait_for_timeout(300)
    d1 = S()['decisions']
    newly = [k for k in d1 if d1[k] != moved.get(k)]
    check(len(newly) == n_conf and all(d1[k] == 'lab' for k in newly) and set(newly) <= set(lab_keys),
          f'点确认：只把当前筛选里 {n_conf} 件未确认的写成「实验室」，个人、待定的不动', (len(newly), n_conf))
    cur = [x[0] for x in seg() if x[2]]
    # 确认成实验室后，「同店默认实验室」可能让同店另一件变成新的自动判断（未确认），这时留在「实验室」显示它
    left_lab = [l for l in lines() if l[1]] if cur == ['lab'] else []
    check(cur in (['personal'], ['all']) or (cur == ['lab'] and left_lab), '确认完自动切到下一个还有未确认的分类（确认引出同店新判断时留在「实验室」，否则去「个人」或「全部」）', (cur, left_lab))
    app.keyboard.press('Control+z'); app.wait_for_timeout(300)
    d2 = S()['decisions']
    check(d2 == moved and [x[0] for x in seg() if x[2]] == ['lab'], 'Ctrl+Z 一次撤销整批确认，回到「实验室」', [k for k in set(d2) | set(moved) if d2.get(k) != moved.get(k)][:5])
    # 全部确认：实验室 → 个人 → 待定逐件判完，最后切到「全部」，第 2 步完成
    app.click('#summary [data-flow="sort-cat"]'); app.wait_for_timeout(300)
    app.click('#cat-seg [data-cat="personal"]'); app.wait_for_timeout(200)
    b = btn()
    check(b and b[0].startswith('这 ') and b[0].endswith('件都是个人，确认'), '选「个人」：主按钮「这 N 件都是个人，确认」', b)
    app.click('#summary [data-flow="sort-cat"]'); app.wait_for_timeout(300)
    app.click('#cat-seg [data-cat="personal"]'); app.wait_for_timeout(200)
    b = btn()
    check(b and b[0] == '已全部确认' and b[1], '这一类全部确认后再选它：按钮「已全部确认」不可点', b)
    app.click('#cat-seg [data-cat="unsure"]'); app.wait_for_timeout(200)
    for _ in range(n['unsure']):
        app.keyboard.press('1'); app.wait_for_timeout(150)
    for _ in range(4):                                     # 判完待定可能引出同店的新自动判断：逐类确认，直到回到「全部」
        cur = [x[0] for x in seg() if x[2]]
        if cur == ['all'] or not (b := btn()) or b[1]: break
        app.click('#summary [data-flow="sort-cat"]'); app.wait_for_timeout(300)
    cur = [x[0] for x in seg() if x[2]]
    st = app.evaluate("[...document.querySelectorAll('.flow li')][1].className")
    check(cur == ['all'] and 'is-done' in st, '待定都判完、各类都已确认：自动切到「全部」，第 2 步完成', (cur, st))
    app.click('.flow li[data-step="0"]'); app.wait_for_timeout(200)
    check(not app.is_visible('#cat-seg'), '切到其他步骤时不显示分类筛选')
    big = app.evaluate("(() => { const i = document.querySelector('#list .thumb'); return i ? i.getBoundingClientRect().width : 0; })()")
    app.click('.flow li[data-step="1"]'); app.wait_for_timeout(200)
    big2 = app.evaluate("(() => { const i = document.querySelector('#list .thumb'); return i ? i.getBoundingClientRect().width : 0; })()")
    check(big2 >= 96 and big2 > big, '核对商品时商品图放大（96px），方便从上往下扫一眼', (big, big2))
    # 恢复判断，后面的测试照旧
    app.evaluate(f"d => {{ const s = JSON.parse(localStorage.getItem('{STORE}')); s.decisions = d; localStorage.setItem('{STORE}', JSON.stringify(s)); }}", dec0)
    app.reload(); app.wait_for_selector('#main:not([hidden])')


def run(p, base, tmp):
    ctx = p.chromium.launch_persistent_context(str(tmp / 'profile'), channel='chromium', headless=True, args=[
        '--disable-extensions-except=' + str(ROOT), '--load-extension=' + str(ROOT),
        # 双保险不联网：不走系统代理；除 127.0.0.1 以外的域名一律解析失败（下面的 route 还会再拦一道）
        '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'])
    blocked, errors, dialogs, logs = [], [], [], []

    GIF1 = bytes.fromhex('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b')
    PNG2 = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000001049444154789c63f8cfc000440c100a001fee03fd8b5f14d40000000049454e44ae426082')

    MOCK_HTML = (ROOT / 'tools' / 'mock-taobao.html').read_bytes()

    def block(route):
        url = route.request.url
        blocked.append(url)
        if urlsplit(url).hostname == 'buyertrade.taobao.com':
            # 「从淘宝读取订单」打开的真实「已买到的宝贝」网址：回应模拟页（模拟页按网址认出来，显示新版结构）
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=MOCK_HTML)
            return
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

    read_section(ctx, base, eid, mock, watch, tmp)

    print('\n[1] 扩展主页导入虚构订单表（可选的 xlsx 入口）')
    app = watch(ctx.new_page(), '主页')
    app.goto(f'chrome-extension://{eid}/index.html')
    app.set_input_files('#file', str(csv_path))
    STORE = 'orderTriage.app.v1'
    home_orders = lambda: app.evaluate(f"(JSON.parse(localStorage.getItem('{STORE}') || '{{}}').orders) || []")
    check(bool(wait_until(app, lambda: len(home_orders()) == len(table), 10)), f'导入订单表：{len(table)} 单', len(home_orders()))
    step0 = lambda: app.get_attribute('.flow li[data-step="0"]', 'title') or ''
    check(f'有图 0 / {all_lines} 件' in step0(), f'第 1 步的悬停说明显示「有图 0 / {all_lines} 件」', step0())
    check(app.get_attribute('.flow li.is-cur', 'data-step') == '1' and '核对商品' in app.inner_text('.flow li.is-cur'), '导入后当前步骤是「核对商品」')
    uns = app.evaluate("[...document.querySelectorAll('#list .line.is-uns')].map(l => l.innerText.includes('待定'))")
    check(uns and all(uns), '商品列表里待定的整行标黄、带「待定」标签（位置按下单日期，不挪到最前）', uns)
    sort_filter_section(app, STORE)

    print('\n[2] 新版模拟页：主页排读取任务，订单页自动翻页读取（订单、图片、退款）')
    # 相当于在读取窗口里填「上次报销到 2026-06-30」：只读 07-01 及以后（模拟页全部订单）
    app.evaluate(f"() => {{ const S = JSON.parse(localStorage.getItem('{STORE}')); S.since = '2026-06-30'; S.readFrom = '2026-07-01'; localStorage.setItem('{STORE}', JSON.stringify(S)); }}")
    app.reload(); app.wait_for_selector('#main:not([hidden])')
    get_scraped = lambda: app.evaluate('chrome.storage.local.get("scraped").then(r => r.scraped || {})')
    store = lambda k: app.evaluate(f'chrome.storage.local.get("{k}").then(r => r["{k}"])')
    app.evaluate("chrome.storage.local.set({ readJob: { at: Date.now(), from: '2026-07-01' } })")
    m = watch(ctx.new_page(), '模拟页')
    t0 = time.time()
    m.goto(base + 'tools/mock-taobao.html?v=new')
    m.wait_for_selector(PANEL)
    res = wait_until(app, lambda: store('readResult'), 300)
    print(f'  自动翻页用时 {time.time() - t0:.0f} 秒；面板：' + m.inner_text(PANEL).replace('\n', ' | '))
    check(bool(res) and res['why'] == 'end', '订单页没点按钮就自动翻页，翻到最后一页停下', res and res['why'])
    log = m.evaluate('window.__mock.log')
    print('  模拟页翻过的页：', log)
    n_def = len(mock['lists']['default'])
    check(log == [f'default:{i + 1}' for i in range(n_def)], f'只翻默认列表 {n_def} 页（最后一页「下一页」带 trade-button-disabled，在这里停）', log)
    check(not dialogs, '标题里带「滑块」「验证码」的商品没被当成安全验证', dialogs)
    visible = {o['no'] for o in mock['orders'] if not o.get('hideDefault')}
    scraped = get_scraped()
    check(set(scraped) == visible and sorted(res['nos']) == sorted(visible), f'列表里的 {len(visible)} 单全读到（含刚打开时没渲染、要往下滚才出齐的；含订单表里没有的新订单）',
          f'多了 {sorted(set(scraped) - visible)}，少了 {sorted(visible - set(scraped))}')
    bad = {o['no']: b for o in mock['orders'] if o['no'] in scraped and (b := compare(scraped[o['no']], o))}
    check(not bad, '逐单核对：日期/状态/店铺/实付/运费/天猫标记/物流标签，逐件：标题/规格/单价/数量/图片/退款/链接；件数对（推荐栏没混进来）',
          '\n          '.join(f'{no}: {x}' for no, b in bad.items() for x in b))
    check(m.evaluate('localStorage.length') == 0, '淘宝页（模拟页）自己的 localStorage 是空的', m.evaluate('Object.keys(localStorage)'))
    hidden = {o['no'] for o in mock['orders'] if o.get('hideDefault')}
    gone = wait_until(app, lambda: store('goneNos'), 5) or []
    check(set(gone) == hidden | {NEVER['no']}, '订单列表上没有的（多半是删进回收站的）记成 goneNos，不再为它要发票', gone)
    nos_home = {o['no'] for o in home_orders()}
    check(set(NOT_IN_TABLE) <= nos_home, '订单表里没有、订单页上有的新订单按订单页建了单', sorted(set(NOT_IN_TABLE) - nos_home))

    dead = [it['t'] for o in mock['orders'] if o['no'] in visible for it in o['items'] if it.get('imgSaved') == '']
    check(len(dead) == 1, '模拟页里有 1 件图全坏', dead)
    app.bring_to_front()
    all_lines2 = sum(len(o['lines']) for o in home_orders())
    no_img = sum(len(o['items']) for o in table if o['no'] in hidden | {NEVER['no']}) + len(dead)
    img_n = all_lines2 - no_img
    foot = wait_until(app, lambda: (t := step0()) and f'有图 {img_n} / {all_lines2} 件' in t and t, 5) or step0()
    check(f'有图 {img_n} / {all_lines2} 件' in foot, f'主页显示「有图 {img_n} / {all_lines2} 件」（图全坏的那件不算有图）', foot)
    app.click('.flow li[data-step="1"]'); app.wait_for_timeout(300)
    app.click('#cat-seg [data-cat="all"]'); app.wait_for_timeout(200)      # 退款的只在「全部」里
    err = app.evaluate("t => { const e = [...document.querySelectorAll('.line')].find(x => x.textContent.includes(t)); const p = e && e.querySelector('.thumb'); return p ? [p.className, p.textContent, getComputedStyle(p).color] : null; }", dead[0])
    check(err and 'err' in err[0] and 'ERROR' in err[1] and err[2] == 'rgb(208, 2, 27)', '图全坏的那件：主页上是红色粗体 ERROR，不是灰色图', err)
    grey = app.evaluate("() => [...document.querySelectorAll('img.thumb')].filter(i => i.complete && i.naturalWidth === 1).map(i => i.src)")
    check(not grey, '主页上没有 1×1 灰点图', grey)
    # 退款由插件判：显示「退款成功」的那一件就算退款（交易成功的单也一样），交易关闭的整单算；退款的排在列表最后、标灰
    homes = {o['no'] for o in home_orders()}
    maybe = [it['t'] for o in mock['orders'] if o['no'] in visible and o['st'] == '交易成功' for it in o['items'] if it.get('refund')]
    ref_n = sum(1 for o in mock['orders'] if o['no'] in homes for it in o['items'] if o['st'] == '交易关闭') + len(maybe)
    refs = app.evaluate("() => [...document.querySelectorAll('#list .line')].map(l => l.classList.contains('is-ref'))")
    check(refs.count(True) == ref_n and refs[-1], f'退款 / 交易关闭的 {ref_n} 件标灰；整单退款、关闭的订单排在列表最后', refs)
    inref = app.evaluate("t => t.map(x => [...document.querySelectorAll('.line.is-ref')].some(e => e.textContent.includes(x)))", maybe)
    check(len(maybe) == 2 and inref == [True, True], '交易成功的单里显示退款成功的两件：直接算退款，不进待定', inref)
    same = [o for o in mock['orders'] if o['no'] in visible and o['st'] == '交易成功' and any(it.get('refund') for it in o['items']) and len(o['items']) > 1]
    kept = [it['t'] for o in same for it in o['items'] if not it.get('refund')]
    notref = app.evaluate("t => t.map(x => [...document.querySelectorAll('.line:not(.is-ref)')].some(e => e.textContent.includes(x)))", kept)
    check(all(notref), f'同一单里没退的 {len(kept)} 件照常分拣（只有退了的那件算退款）', list(zip(kept, notref)))

    print('\n[2b] 认不出「下一页」只读了第 1 页：不把后面几页的订单当成删除；页面上出现过、只是没读出商品的订单也不算删除')
    def reread(q):
        app.evaluate("chrome.storage.local.set({ goneNos: [] }).then(() => chrome.storage.local.remove('readResult'))"
                     ".then(() => chrome.storage.local.set({ readJob: { at: Date.now(), from: '2026-07-01' } }))")
        pg = watch(ctx.new_page(), '模拟页（' + q + '）')
        pg.goto(base + 'tools/mock-taobao.html?v=new&' + q)
        r = wait_until(app, lambda: store('readResult'), 300) or {}
        app.wait_for_timeout(1500)
        pg.close()
        return r, store('goneNos')
    r3, gone3 = reread('nonext=1')
    check(r3.get('why') == 'end' and r3.get('pages') == 1 and gone3 == [], '只读了第 1 页就结束：不计算「删进回收站」，第 2 页以后的订单不会从发票表里消失',
          {'结果': {k: r3.get(k) for k in ('why', 'pages')}, 'goneNos': gone3})
    noitem = mock['lists']['default'][0][1]
    r4, gone4 = reread('noitems=' + noitem)
    check(r4.get('why') == 'end' and noitem in (r4.get('seen') or []) and noitem not in (gone4 or []) and set(gone4 or []) == hidden | {NEVER['no']},
          '页面上出现过、没读出商品的那单：报回主页（seen），不当成删进回收站；根本没出现过的照常算', {'seen 里有': noitem in (r4.get('seen') or []), 'goneNos': gone4})

    print('\n[3] 旧版模拟页（无参数）：回退到按文字特征猜')
    m.close()
    old = [{'no': '5124000000000000011', 'shop': '某某航模店', 'lines': [('AM32 电调调参卡 支持 BLHeli 调参', 9.9, 1, '')]},
           {'no': '5124000000000000012', 'shop': '某某3D打印', 'lines': [('金属 3D 打印加工服务 不锈钢 铝合金 手板打样', 120.0, 1, '')]},
           {'no': '5123000000000000001', 'shop': '某某五金工具', 'lines': [('304不锈钢内六角螺丝 杯头螺钉 M3', 19.8, 1, ''),
                                                                    ('数显游标卡尺 0-150mm 高精度', 68.8, 1, '退款成功')]}]
    app.evaluate("chrome.storage.local.set({ scraped: {}, readJob: { at: Date.now(), from: '2026-07-10' } })")
    m2 = watch(ctx.new_page(), '旧版模拟页')
    m2.goto(base + 'tools/mock-taobao.html')
    r2 = wait_until(m2, lambda: (r := store('readResult')) and r.get('from') == '2026-07-10' and r, 60) or {}
    s2 = get_scraped()
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
    check(not bad and r2.get('why') == 'past' and set(s2) == {o['no'] for o in old}, '旧版页面：读到 07-10 为止（第 2 页更早就停），店铺、标题、单价、数量、逐件退款、商品图都抓对',
          '\n          '.join(bad) or r2)
    check(m2.evaluate('localStorage.length') == 0, '旧版模拟页的 localStorage 也是空的')
    m2.close()

    print('\n[4] 杂项')
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
