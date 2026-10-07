#!/usr/bin/env python3
"""
离线端到端测试：申请平台开票（批量开票页）。全程不连淘宝、不联网，订单、店铺全部虚构。

    env -u TMPDIR python3 tools/e2e-apply.py

用 ctx.route 把淘宝「批量开票」页回应成 tools/mock-batch.html（结构照 2026-10 用户在真实页面上的示范），「全部发票」页回应成 mock-invoice.html。
核对：只勾要申请的单（跨三页），跳过已经有票的、个人的；列表里没有的单改成「需向卖家索要发票」；补选「明细」；
停在「批量开票确认」绝不点「确认提交」；用户点了「确认提交」后主页自动同步；抬头对不上时停下、不点「下一步」。
另测「按卖家的开票入口申请」：旺旺里卖家发来的开票卡片（mock-chat-core.html）不算图片、状态是「卖家发来开票申请入口」；
确认清单后逐单点卡片上的「去申请」，申请页（mock-invoice-apply.html）等抬头加载出来、核对后提交并确认；抬头对不上、加载不出来的不提交；
插件开的干活页做完都关掉，用户自己点状态标签打开的页面不关。
"""
import csv
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / 'tools'
BATCH_URL = 'https://i.taobao.com/my_itaobao/pricelist/batchInvoice'
INV_URL = 'https://i.taobao.com/my_itaobao/invoice'
CHAT_URL = 'https://market.m.taobao.com/app/im/chat/index.html'
APPLY_URL = 'https://invoice-ua.taobao.com/e-invoice/'
MOCKS = [(BATCH_URL, 'mock-batch.html'), (INV_URL, 'mock-invoice.html'), (CHAT_URL, 'mock-chat.html'),
         ('https://market.m.taobao.com/app/im/chat-core/', 'mock-chat-core.html'), (APPLY_URL, 'mock-invoice-apply.html')]
INV_DETAIL = 'https://invoice-ua.taobao.com/detail/pc'                 # 状态标签「已申请淘宝开票」点开的发票详情页
TITLE, TAX = '某大学', '121000009999999996'
# 订单号末三位和 mock-batch.html 对得上
O = {
    'T1': ('5190000000000000201', '2026-08-02', '某某虚构五金工具', '23.50', '304不锈钢螺丝 M3'),
    'T2': ('5190000000000000202', '2026-08-20', '某某虚构接插件', '6.50', '杜邦线 公对母'),
    'T3': ('5190000000000000203', '2026-09-05', '某某虚构线材', '19.00', '硅胶线 16AWG'),
    'T4': ('5190000000000000204', '2026-08-15', '某某虚构轴承', '15.00', '深沟球轴承 608'),     # 批量开票页上没有
    'N1': ('5190000000000000205', '2026-08-10', '某某虚构电池配件', '12.80', 'XT60 插头'),     # 已有卖家开的票
    'P1': ('5190000000000000206', '2026-08-12', '某某虚构日用百货', '29.90', '牙膏 家庭装'),   # 个人
    # 批量开票页上没有入口、卖家在旺旺里发来开票卡片的（旺旺名 nick207~209，见 mock-chat-core.html）
    'C1': ('5190000000000000207', '2026-08-21', '某某虚构工具店', '149.00', '杜邦线 母对母 40P 20cm'),     # 卡片价格 139，实付 149：不按金额对单
    'C2': ('5190000000000000208', '2026-08-22', '某某虚构仪表店', '58.00', '硅胶线 20AWG 黑色'),          # 申请页抬头是别的单位
    'C3': ('5190000000000000209', '2026-08-23', '某某虚构配件店', '22.00', '深沟球轴承 6900ZZ'),          # 申请页抬头一直加载不出来
}
CARD = ('C1', 'C2', 'C3')
NO = {k: v[0] for k, v in O.items()}
fails = []


def check(ok, msg, detail=''):
    print(('  通过  ' if ok else '  失败  ') + msg + ('' if ok or not detail else '\n          ' + str(detail)))
    if not ok:
        fails.append(msg)


def wait_until(fn, timeout, page):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        page.wait_for_timeout(300)
    return None


def run(p, tmp):
    ctx = p.chromium.launch_persistent_context(str(tmp / 'profile'), channel='chromium', headless=True, args=[
        '--disable-extensions-except=' + str(ROOT), '--load-extension=' + str(ROOT),
        '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND'])
    html = {f: (TOOLS / f).read_text(encoding='utf-8') for _, f in MOCKS}
    blocked, errors, dialogs, pages, reports = [], [], [], [], []
    # 申请页报进度：页面跳走、关掉以后也查得到
    ctx.expose_function('mockReport', lambda kind, no, at, extra: reports.append((kind, no, at, extra)))

    def handle(route):
        u = route.request.url
        if u.startswith(INV_DETAIL):
            return route.fulfill(status=200, content_type='text/html; charset=utf-8', body='<meta charset="utf-8"><title>发票详情</title>模拟发票详情')
        for pre, f in MOCKS:
            if u.startswith(pre):
                return route.fulfill(status=200, content_type='text/html; charset=utf-8', body=html[f])
        blocked.append(u); route.abort()
    ctx.route(lambda u: urlsplit(u).scheme in ('http', 'https'), handle)

    def watch(pg, tag):
        pg.on('pageerror', lambda e: errors.append(f'{tag}: {e}'))
        pg.on('dialog', lambda d: (dialogs.append(f'{tag}: {d.message}'), d.dismiss()))
        return pg
    ctx.on('page', lambda pg: pages.append(watch(pg, '新开页')))
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
    eid = urlsplit(sw.url).hostname

    print('[1] 主页：导入订单表、抬头税号、开票按钮、已有票的订单号')
    path = tmp / '虚构订单表.csv'
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['订单号', '订单提交时间', '订单状态', '店铺名称', '商品名称', '型号款式', '商品数量', '商品金额', '实付金额', '运费'])
        for no, d, shop, pay, t in O.values():
            w.writerow([no, d + ' 10:00:00', '交易成功', shop, t, '', 1, pay, pay, '0.00'])
    app = watch(ctx.new_page(), '主页')
    app.goto(f'chrome-extension://{eid}/index.html')
    app.set_input_files('#file', str(path))
    app.wait_for_selector('#main:not([hidden])')
    app.click('#btn-settings'); app.fill('#inv-title', TITLE); app.fill('#inv-tax', TAX); app.click('#rules-save')
    # 订单页上这几单都有「申请开票」按钮（补图时记下的 inv）
    # 卡片那几单订单页上没有「申请开票」按钮（批量开票页上也没有）
    scraped = {no: dict({'no': no, 'time': d, 'status': '交易成功', 'shop': shop, 'nick': 'nick' + no[-3:],
                    'lines': [{'title': t, 'img': 'https://img.alicdn.com/x.jpg'}]}, **({} if k in CARD else {'inv': '申请开票'})) for k, (no, d, shop, pay, t) in O.items()}
    app.evaluate('s => chrome.storage.local.set({ scraped: s })', scraped)
    app.wait_for_timeout(800)
    # N1 已经报销过（主页存储里的已报销订单号 haveNos；导入 JSON 清单的入口已从界面去掉，直接写进存储）
    app.evaluate('''no => { const S = JSON.parse(localStorage.getItem('orderTriage.app.v1')); S.haveNos = [no];
                         localStorage.setItem('orderTriage.app.v1', JSON.stringify(S)); }''', NO['N1'])
    app.reload(); app.wait_for_selector('#main:not([hidden])'); app.wait_for_timeout(800)
    # 已报销的订单号不再自动推断「上次报销到哪天」（用户 2026-10-07 去掉了这一步），全部订单照常参与判断
    app.click('#seg-cat button[data-cat="invoice"]'); app.wait_for_timeout(500)
    btn = app.inner_text('#inv-apply')
    rows = app.evaluate(r"[...document.querySelectorAll('.inv-table tbody tr')].map(tr => tr.innerText.replace(/\s+/g, ' ').slice(0, 90))")
    check(btn == '申请平台开票（4 单）', '「申请平台开票」按钮显示 4 单（T1~T4；已有票的 N1、个人的 P1 不算）', btn + ' ｜ ' + ' ｜ '.join(rows))
    nick = app.evaluate('chrome.storage.local.get("invWant").then(r => (r.invWant.orders || []).map(o => o.nick))')
    check(all(n.startswith('nick') for n in nick) and nick, '补图时记下的卖家旺旺名带进了 invWant', nick)

    print('\n[2] 申请平台开票')
    n0 = len(pages)
    app.click('#inv-apply')
    res = lambda: app.evaluate('chrome.storage.local.get("applyResult").then(r => r.applyResult)')
    r = wait_until(lambda: (x := res()) and (x.get('stage') or x.get('error')) and x, 90, app) or res()
    bp = next((pg for pg in pages[n0:] if pg.url.startswith(BATCH_URL)), None)
    check(bool(bp), '打开了批量开票页')
    check(r and r.get('stage') == 'confirm', '停在「批量开票确认」', r)
    if bp:
        sel = bp.evaluate("[...document.querySelectorAll('input.next-checkbox-input')].length")   # 页面在确认弹窗下面
        m = bp.evaluate('window.__mock')
        hdr = bp.evaluate("[...document.querySelectorAll('.next-dialog-header')].map(e => e.innerText)")
        check('批量开票确认' in hdr, '页面上弹窗是「批量开票确认」', hdr)
        check(sorted(r.get('found', [])) == sorted([NO['T1'], NO['T2'], NO['T3']]), '只勾了 T1、T2、T3（分在三页上）', r.get('found'))
        check(r.get('missing') == [NO['T4']], 'T4 列表里没有，记为平台开不了', r.get('missing'))
        check(m.get('atNext', {}).get('detail') is True and m['atNext'].get('enterprise') is True, '点「下一步」时「企业」「明细」都已选（明细是插件补选的）', m.get('atNext'))
        check(m.get('confirm') is False and '确认提交' not in m.get('clicks', []), '插件没点「确认提交」', m.get('clicks'))
        # 主页：T4 改成需找卖家
        app.bring_to_front(); app.wait_for_timeout(800)
        t4 = app.evaluate("no => [...document.querySelectorAll('.inv-table tr')].filter(tr => tr.innerText.includes(no)).map(tr => tr.innerText.replace(/\\s+/g, ' '))", NO['T4'])
        check(t4 and '需向卖家索要发票' in t4[0], 'T4 在主页改成了「需向卖家索要发票」', t4)

        # 停在确认页时，同时开着「全部发票」页（也注入了 batch.js）：不能误判为「已提交」（2026-10-03 真实窗口里出过）
        other = ctx.new_page(); other.goto(INV_URL); other.wait_for_timeout(3500)
        r_mid = res()
        check(r_mid and r_mid.get('stage') == 'confirm', '另开着「全部发票」页时，还是「停在确认页」，没被误判成已提交', r_mid)
        other.close()

        print('\n[3] 用户自己点「确认提交」后，主页自动同步')
        bp.bring_to_front()
        before = app.evaluate('chrome.storage.local.get("invSync").then(r => r.invSync ? r.invSync.at : 0)')
        ok = bp.evaluate("(() => { const b = [...document.querySelectorAll('.next-dialog button')].find(b => b.innerText === '确认提交'); if (b) b.click(); return !!b; })()")
        check(ok, '确认页上有「确认提交」可以点')
        r2 = wait_until(lambda: (x := res()) and x.get('stage') == 'submitted' and x, 20, app)
        check(bool(r2), '察觉到提交（applyResult = submitted）', res())
        synced = wait_until(lambda: app.evaluate('chrome.storage.local.get("invSync").then(r => r.invSync ? r.invSync.at : 0)') != before, 90, app)
        check(bool(synced), '提交后自动同步了一次「全部发票」')

    print('\n[4] 弹窗里的抬头和设置不一样：停下，不点「下一步」')
    for pg in list(ctx.pages):
        if pg.url.startswith(BATCH_URL) or pg.url.startswith(INV_URL): pg.close()
    app.bring_to_front()
    probe = ctx.new_page(); probe.goto(BATCH_URL); probe.evaluate("localStorage.setItem('mockTitle', '某别的大学')"); probe.close()
    app.evaluate('chrome.storage.local.set({ applyResult: null })')
    n1 = len(pages)
    app.click('#inv-apply')
    r3 = wait_until(lambda: (x := res()) and (x.get('stage') or x.get('error')) and x, 90, app) or res()
    bp2 = next((pg for pg in pages[n1:] if pg.url.startswith(BATCH_URL)), None)
    check(r3 and '抬头' in (r3.get('error') or ''), '抬头对不上：停下并说明原因', r3)
    if bp2:
        m2 = bp2.evaluate('window.__mock')
        check('下一步' not in m2.get('clicks', []) and not m2.get('confirm'), '没点「下一步」，更没点「确认提交」', m2.get('clicks'))

    print('\n[5] 按卖家的开票入口申请：先读旺旺，卡片单独认出来（不算图片）')
    for pg in list(ctx.pages):
        if pg != app: pg.close()
    app.bring_to_front(); app.reload(); app.wait_for_selector('#main:not([hidden])'); app.wait_for_timeout(800)
    app.evaluate('chrome.storage.local.remove("chatScan")')
    app.click('#seg-cat button[data-cat="invoice"]'); app.wait_for_timeout(500)
    app.evaluate("document.querySelector('details.more').open = true")
    app.click('#inv-scan')
    scan = wait_until(lambda: app.evaluate('chrome.storage.local.get("chatScan").then(r => r.chatScan)'), 120, app) or {}
    convs = scan.get('convs', {})
    c1 = convs.get('nick207', {})
    check(len(c1.get('cards', [])) == 1 and c1['cards'][0].get('title') == '杜邦线 母对母 40P 20cm' and c1['cards'][0].get('price') == '139.00',
          '卖家的开票卡片认出来了：商品标题、卡片价格', c1.get('cards'))
    check(c1.get('asks') and not c1.get('images'), '卡片里的背景图不再算成「卖家发来的图片（可能是二维码）」', {k: c1.get(k) for k in ('asks', 'images')})
    check(all(len(convs.get('nick' + NO[k][-3:], {}).get('cards', [])) == 1 for k in CARD), '三家的卡片都读到了', sorted(convs))
    app.bring_to_front(); app.wait_for_timeout(800)
    st = lambda k: app.evaluate("no => { const tr = [...document.querySelectorAll('.inv-table tbody tr')].find(tr => tr.innerText.includes(no)); "
                                "return tr ? { st: tr.querySelector('.st').textContent.trim(), tag: tr.querySelector('.st').tagName, cls: tr.querySelector('.st').className, "
                                "title: tr.querySelector('.st').title, detail: [...tr.children[5].querySelectorAll('.detail')].map(d => d.textContent).join(' | ') } : null; }", NO[k])
    got = {k: (st(k) or {}).get('st') for k in CARD}
    check(all(v == '卖家发来开票申请入口' for v in got.values()), '三单状态都是「卖家发来开票申请入口」', got)
    s1 = st('C1') or {}
    check('tone-bad' in s1.get('cls', '') and s1.get('tag') == 'BUTTON' and '旺旺' in s1.get('title', ''), '这个状态是红色（需处理），可点击，悬停说明写着去旺旺聊天', s1)
    btn = app.inner_text('#inv-card')
    # 主按钮按流程顺序：还有可在平台申请的单时是「申请平台开票」，否则是这个
    main = '#inv-apply' if not app.is_disabled('#inv-apply') else '#inv-card'
    check(btn == '按卖家的开票入口申请（3 单）' and 'primary' in app.get_attribute(main, 'class') and app.locator('#inv-bar .btn.primary').count() == 1,
          '发票栏有「按卖家的开票入口申请（3 单）」；主按钮按流程顺序只有一个', (btn, main))
    check(bool(app.get_attribute('#inv-card', 'title')), '按钮有悬停说明')

    print('\n[6] 确认清单后逐单申请：等抬头加载出来再提交；抬头不对、加载不出来的不提交')
    n0 = len(pages)
    app.click('#inv-card')
    app.wait_for_selector('#dlg-list[open]', timeout=30000)
    lst = app.inner_text('#list-rows')
    check(all(O[k][2] in lst and NO[k] in lst and O[k][1] in lst and O[k][3].rstrip('0').rstrip('.') in lst for k in CARD) and '杜邦线 母对母 40P 20cm' in lst,
          '确认窗口列出店铺全名、下单日期、商品、金额、订单号和卡片', lst[:300])
    check(not reports and not [p for p in pages[n0:] if APPLY_URL in p.url], '确认之前什么都没做（没打开申请页）', reports)
    app.click('#list-ok')
    done = wait_until(lambda: app.evaluate("document.querySelector('#dlg-list[open]') && document.querySelector('#list-title').textContent.includes('完成') && document.querySelector('#list-rows').innerText"), 360, app)
    print('  结果窗口：', (done or '').replace('\n', ' | '))
    applied = app.evaluate('chrome.storage.local.get("cardApplied").then(r => r.cardApplied || {})')
    result = app.evaluate('chrome.storage.local.get("cardResult").then(r => r.cardResult || {})')
    by = lambda kind, k: [r for r in reports if r[0] == kind and r[1] == NO[k]]
    check(bool(done) and '已提交' in done and done.count('未完成') == 2, '结果窗口：1 单已提交，2 单未完成并写明原因', done)
    check(set(applied) == {NO['C1']}, '只有抬头核对通过的 C1 记成已提交（cardApplied）', applied)
    op, sub = by('open', 'C1'), by('submit', 'C1')
    check(sub and by('confirm', 'C1') and by('detail', 'C1') and sub[0][3] == '某大学', 'C1：点了「提交申请」（完整点击）→「确认提交」→ 跳到发票详情页', [r[:2] for r in reports if r[1] == NO['C1']])
    check(op and sub and sub[0][2] - op[0][2] >= 2000, 'C1：申请页打开 2 秒后、抬头加载出来才点「提交申请」', op and sub and sub[0][2] - op[0][2])
    for k, word in (('C2', '抬头'), ('C3', '抬头')):
        r = result.get(NO[k], {})
        check(by('open', k) and not by('submit', k) and not by('confirm', k) and r.get('ok') is False and word in (r.get('why') or ''),
              f'{k}：申请页打开了，但抬头{"对不上" if k == "C2" else "一直没加载出来"}——没提交，原因送回主页', (r, [x[:2] for x in reports if x[1] == NO[k]]))
    app.wait_for_timeout(800)
    got = {k: (st(k) or {}) for k in CARD}
    check(got['C1'].get('st') == '已申请淘宝开票，等待商家开具' and 'tone-plat' in got['C1'].get('cls', ''), 'C1 状态变成「已申请淘宝开票，等待商家开具」（蓝色）', got['C1'])
    check(all(got[k].get('st') == '卖家发来开票申请入口' and '未完成' in got[k].get('detail', '') for k in ('C2', 'C3')), 'C2、C3 仍是「卖家发来开票申请入口」，说明里写着上次没完成的原因', {k: got[k] for k in ('C2', 'C3')})
    clicks = [r[1] for r in reports if r[0] == 'cardClick']           # 旺旺页每单都会重新加载，点击记录由模拟页报给测试
    check(sorted(clicks) == sorted(NO[k] for k in CARD), '每单的「去申请」各被完整点击了一次', clicks)

    print('\n[7] 标签页：插件开的干活页做完都关了，旺旺页只留一个；用户点状态标签开的页面不关')
    gone = wait_until(lambda: not [p for p in ctx.pages if APPLY_URL in p.url or p.url.startswith(BATCH_URL) or p.url.startswith(INV_URL)] and True, 25, app)
    check(bool(gone), '申请页、发票详情页、批量开票页、全部发票页都关掉了', [p.url[:80] for p in ctx.pages if p != app])
    chats = [p for p in ctx.pages if '/app/im/' in p.url]
    check(len(chats) == 1, '旺旺聊天页始终只有一个', [p.url[:80] for p in chats])
    n1 = len(pages)
    app.bring_to_front()
    app.click('#list-cancel')                                         # 先关掉结果窗口
    app.click(f'.inv-table tbody tr:has-text("{NO["C1"]}") button.st')
    opened = wait_until(lambda: [p for p in pages[n1:] if p.url.startswith(INV_DETAIL)], 10, app)
    check(bool(opened) and NO['C1'] in opened[0].url, '点「已申请淘宝开票」状态：打开这单的淘宝发票详情页', [p.url for p in pages[n1:]])
    app.wait_for_timeout(4000)
    check(opened and not opened[0].is_closed(), '用户点开的发票详情页没被插件关掉')

    print('\n[8] 杂项')
    check(not errors, '页面没有报错', errors)
    check(not dialogs, '没有弹窗', dialogs)
    check(not [u for u in blocked if not u.endswith('favicon.ico') and 'alicdn' not in u], '没有别的外部请求', blocked[:5])
    ctx.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix='order-triage-apply-'))
    try:
        with sync_playwright() as p:
            run(p, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('\n' + ('全部通过' if not fails else f'{len(fails)} 项失败：\n  ' + '\n  '.join(fails)))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
