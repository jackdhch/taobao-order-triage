#!/usr/bin/env python3
"""
离线端到端测试：申请平台开票（批量开票页）。全程不连淘宝、不联网，订单、店铺全部虚构。

    env -u TMPDIR python3 tools/e2e-apply.py

用 ctx.route 把淘宝「批量开票」页回应成 tools/mock-batch.html（结构照 2026-10 用户在真实页面上的示范），「全部发票」页回应成 mock-invoice.html。
核对：只勾要申请的单（跨三页），跳过已经有票的、个人的；列表里没有的单改成「需找卖家」；补选「明细」；
停在「批量开票确认」绝不点「确认提交」；用户点了「确认提交」后主页自动同步；抬头对不上时停下、不点「下一步」。
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
MOCKS = [(BATCH_URL, 'mock-batch.html'), (INV_URL, 'mock-invoice.html')]
TITLE, TAX = '某大学', '121000009999999996'
# 订单号末三位和 mock-batch.html 对得上
O = {
    'T1': ('5190000000000000201', '2026-08-02', '某某虚构五金工具', '23.50', '304不锈钢螺丝 M3'),
    'T2': ('5190000000000000202', '2026-08-20', '某某虚构接插件', '6.50', '杜邦线 公对母'),
    'T3': ('5190000000000000203', '2026-09-05', '某某虚构线材', '19.00', '硅胶线 16AWG'),
    'T4': ('5190000000000000204', '2026-08-15', '某某虚构轴承', '15.00', '深沟球轴承 608'),     # 批量开票页上没有
    'N1': ('5190000000000000205', '2026-08-10', '某某虚构电池配件', '12.80', 'XT60 插头'),     # 已有卖家开的票
    'P1': ('5190000000000000206', '2026-08-12', '某某虚构日用百货', '29.90', '牙膏 家庭装'),   # 个人
}
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
    blocked, errors, dialogs, pages = [], [], [], []

    def handle(route):
        u = route.request.url
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
    scraped = {no: {'no': no, 'time': d, 'status': '交易成功', 'shop': shop, 'inv': '申请开票', 'nick': 'nick' + no[-3:],
                    'lines': [{'title': t, 'img': 'https://img.alicdn.com/x.jpg'}]} for no, d, shop, pay, t in O.values()}
    app.evaluate('s => chrome.storage.local.set({ scraped: s })', scraped)
    app.wait_for_timeout(800)
    # N1 已经报销过（主页存储里的已报销订单号 haveNos；导入 JSON 清单的入口已从界面去掉，直接写进存储）
    app.evaluate('''no => { const S = JSON.parse(localStorage.getItem('orderTriage.app.v1')); S.haveNos = [no];
                         localStorage.setItem('orderTriage.app.v1', JSON.stringify(S)); }''', NO['N1'])
    app.reload(); app.wait_for_selector('#main:not([hidden])'); app.wait_for_timeout(800)
    # 导入已有票的订单号后，插件会自动把最晚那单当成「上次报销到这」；这里要从第一单开始算
    app.click('.flow li[data-step="1"]'); app.click('button[data-flow="since-none"]'); app.wait_for_timeout(400)
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
        check(t4 and '需找卖家' in t4[0], 'T4 在主页改成了「需找卖家」', t4)

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

    print('\n[5] 杂项')
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
