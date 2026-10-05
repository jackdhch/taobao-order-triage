#!/usr/bin/env python3
"""
生成 README 用的截图（docs/screenshots/*.png）。全程离线，数据全部虚构：

    env -u TMPDIR python3 tools/screenshots.py

- 主页总览、分拣列表：插件自带的「载入示例数据」（js/sample.js），商品图是这里画的示意图标
- 发票栏：这里另外编的一组虚构订单，往扩展存储里写入虚构的开票记录；抬头「示例大学」，税号是能通过校验的虚构号码
带扩展启动一个全新的无界面 Chromium（临时配置目录，用完删掉），所有 http/https 请求一律拦下。
需要 playwright 和 Pillow（压缩截图用）。
"""
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlsplit

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs' / 'screenshots'
W, H = 1240, 900
NOW = '2026-10-05T10:00:00+08:00'          # 固定时钟：「已等待几天」这类数字每次生成都一样

# ── 商品示意图：简单的线条图标，代替真实商品照片 ──
GLYPH = {
    'plug': '<rect x="22" y="38" width="22" height="24" rx="3"/><rect x="56" y="38" width="22" height="24" rx="3"/>'
            '<path d="M44 45h12M44 55h12M22 46H10M22 54H10M78 46h12M78 54h12"/>',
    'chip': '<rect x="30" y="30" width="40" height="40" rx="4"/><rect x="40" y="40" width="20" height="20" rx="2"/>'
            '<path d="M38 30V20M50 30V20M62 30V20M38 70v10M50 70v10M62 70v10M30 38H20M30 50H20M30 62H20M70 38h10M70 50h10M70 62h10"/>',
    'screw': '<path d="M38 18h24l6 10-6 10H38l-6-10z"/><path d="M44 38v40l6 8 6-8V38"/><path d="M44 46l12 4M44 54l12 4M44 62l12 4M44 70l12 4"/>',
    'caliper': '<rect x="14" y="40" width="72" height="12" rx="2"/><path d="M22 52v22l8-8V52M70 40V22l-8 8v10"/>'
               '<path d="M30 40v-5M38 40v-3M46 40v-5M54 40v-3"/><rect x="58" y="44" width="16" height="5" rx="1"/>',
    'servo': '<rect x="20" y="34" width="60" height="36" rx="5"/><circle cx="38" cy="52" r="9"/><circle cx="38" cy="52" r="3"/>'
             '<path d="M20 44H12M20 60H12M80 44h8M80 60h8"/>',
    'icepack': '<rect x="18" y="24" width="64" height="52" rx="8"/><path d="M39 24v52M61 24v52M18 41h64M18 59h64"/>',
    'phone': '<rect x="32" y="16" width="36" height="68" rx="8"/><circle cx="44" cy="28" r="5"/><circle cx="44" cy="28" r="1.5"/>',
    'tissue': '<path d="M20 48h60v30H20z"/><path d="M40 48c0-14 6-22 10-26 4 4 10 12 10 26"/><path d="M34 60h32"/>',
    'shirt': '<path d="M36 20l-18 10 7 14 8-4v40h34V40l8 4 7-14-18-10c-2 6-7 9-14 9s-12-3-14-9z"/>',
    'glove': '<path d="M34 84V50l-8-14c-2-4 3-7 6-4l6 10V22c0-4 6-4 6 0v18-24c0-4 6-4 6 0v24-20c0-4 6-4 6 0v22-16c0-4 6-4 6 0v36c0 10-4 16-6 26z"/>',
    'stirrer': '<rect x="20" y="56" width="60" height="26" rx="5"/><circle cx="34" cy="69" r="5"/><path d="M50 69h20"/>'
               '<path d="M36 56V30h28v26"/><path d="M42 48h16"/>',
    'lens': '<circle cx="50" cy="50" r="28"/><circle cx="50" cy="50" r="18"/><path d="M36 38c4-4 9-6 14-6"/>',
    'bottle': '<path d="M42 16h16v12l8 10v42a4 4 0 0 1-4 4H38a4 4 0 0 1-4-4V38l8-10z"/><path d="M34 54h32"/>',
    'board': '<rect x="16" y="24" width="68" height="52" rx="4"/><circle cx="24" cy="32" r="2.5"/><circle cx="76" cy="68" r="2.5"/>'
             '<rect x="38" y="38" width="22" height="22" rx="2"/><path d="M60 46h14M60 54h10M26 46h12M26 54h12"/>',
    'cable': '<path d="M20 70c0-30 60-10 60-40"/><rect x="12" y="68" width="16" height="14" rx="2"/><rect x="72" y="18" width="16" height="14" rx="2"/>',
}
TINT = [('#E6EEF2', '#3C6A80'), ('#EEEAE3', '#7A6446'), ('#E8EEE6', '#4D7148'), ('#EFE7EC', '#7E4A66'), ('#E9E9F1', '#4F5590')]


def thumb(kind, k):
    bg, fg = TINT[k % len(TINT)]
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="' + bg + '"/>'
           '<g fill="none" stroke="' + fg + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' + GLYPH[kind] + '</g></svg>')
    return 'data:image/svg+xml,' + quote(svg)


# 示例数据（js/sample.js）每件商品配哪个图标，按商品名的开头认
SAMPLE_IMG = [('XT60', 'plug'), ('重复使用凝胶冰袋', 'icepack'), ('氧化铝陶瓷片', 'chip'), ('适用苹果', 'phone'), ('304', 'screw'),
              ('绿色 数显游标卡尺', 'caliper'), ('抽纸', 'tissue'), ('纯棉', 'shirt'), ('空心杯', 'servo')]

# 发票栏用的虚构订单：(订单号, 下单时间, 店铺, 实付, [(商品, 规格, 数量, 单价, 图标)])，全部判为实验室
INV_ORDERS = [
    ('示例-1013', '2026-09-29 13:36:00', '某某化学试剂', '38.00', [('无水乙醇 分析纯 500ml', '500ml×1 瓶', 1, '38.00', 'bottle')]),
    ('示例-1012', '2026-09-28 16:20:00', '某某实验耗材', '45.00', [('一次性丁腈手套 无粉 实验室用', 'M 码 100 只', 1, '45.00', 'glove')]),
    ('示例-1011', '2026-09-26 10:05:00', '某某仪器旗舰店', '389.00', [('数显恒温磁力搅拌器 加热型', '标准款', 1, '389.00', 'stirrer')]),
    ('示例-1010', '2026-09-22 21:40:00', '某某电子元件', '27.60', [('贴片电阻包 0805 常用阻值', '170 种 各 25 只', 1, '18.00', 'chip'),
                                                            ('排针排母套装 2.54mm', '40P 各 10 条', 1, '9.60', 'board')]),
    ('示例-1009', '2026-09-18 14:12:00', '某某五金工具', '126.00', [('精密螺丝刀套装 磁性批头', '63 合 1', 1, '126.00', 'screw')]),
    ('示例-1008', '2026-09-10 09:30:00', '某某模型', '596.00', [('空心杯 双轴舵机 80KG 全金属', '带两个金属舵盘', 2, '298.00', 'servo')]),
    ('示例-1007', '2026-09-05 19:48:00', '某某航模配件店', '42.00', [('XT60 插头带线 航模电池连接线', '公头+母头 10cm', 2, '21.00', 'plug')]),
    ('示例-1006', '2026-08-30 11:15:00', '某某光学', '158.00', [('平凸透镜 K9 玻璃 直径 25mm', '焦距 50mm', 2, '79.00', 'lens')]),
    ('示例-1005', '2026-08-25 15:02:00', '某某试剂耗材', '64.00', [('塑料洗瓶 弯头 500ml', '5 只装', 1, '64.00', 'bottle')]),
    ('示例-1004', '2026-08-20 08:50:00', '某某电子元件', '33.80', [('杜邦线 公对母 20cm', '40 根', 2, '16.90', 'cable')]),
]


def tax_id(base17):
    """按统一社会信用代码的规则给 17 位补上校验位（只用来造能通过校验的虚构号码）"""
    chars, w = '0123456789ABCDEFGHJKLMNPQRTUWXY', [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28]
    s = sum(chars.index(c) * w[i] for i, c in enumerate(base17))
    return base17 + chars[(31 - s % 31) % 31]


FAKE_TAX = tax_id('91' + '0' * 15)           # 行政区划码全 0，不可能对应真实单位


def save(page, name, clip=None, full=False):
    raw = OUT / (name + '.raw.png')
    page.screenshot(path=str(raw), clip=clip, full_page=full, animations='disabled', caret='hide')
    im = Image.open(raw).convert('RGB')
    # 界面是平涂色块，量化到 256 色几乎看不出差别，体积能小好几倍
    im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(OUT / (name + '.png'), optimize=True)
    raw.unlink()
    print('  ', name + '.png', im.size, (OUT / (name + '.png')).stat().st_size // 1024, 'KB')


def reset(page, home):
    page.evaluate('() => { localStorage.clear(); return chrome.storage.local.clear(); }')
    page.goto(home)


def load_sample(page, home):
    """点「载入示例数据」，再给每件商品配上示意图（相当于第 3 步补完图片）"""
    page.click('#btn-sample')
    page.wait_for_selector('#main:not([hidden])')
    page.evaluate('''([pairs, imgs]) => {
        const S = JSON.parse(localStorage.getItem('orderTriage.app.v1'));
        for (const o of S.orders) for (const l of o.lines) {
            const k = pairs.findIndex(([p]) => l.title.startsWith(p));
            if (k >= 0) l.img = imgs[k];
        }
        S.since = 'none';
        localStorage.setItem('orderTriage.app.v1', JSON.stringify(S));
    }''', [SAMPLE_IMG, [thumb(kind, i) for i, (_, kind) in enumerate(SAMPLE_IMG)]])
    page.goto(home)
    page.wait_for_selector('#main:not([hidden])')


def load_invoice(page, home):
    """发票栏：虚构订单 + 虚构的开票记录，凑齐几种状态"""
    rows = [['订单号', '订单提交时间', '订单状态', '店铺名称', '商品名称', '型号款式', '商品数量', '商品金额', '实付金额', '运费']]
    imgs = {}
    k = 0
    for no, t, shop, pay, lines in INV_ORDERS:
        for i, (title, sku, q, price, kind) in enumerate(lines):
            rows.append([no if i == 0 else '', t if i == 0 else '', '交易成功' if i == 0 else '', shop if i == 0 else '',
                         title, sku, str(q), '￥' + price, '￥' + pay if i == 0 else '', '￥0.00' if i == 0 else ''])
            imgs[title] = thumb(kind, k)
            k += 1
    ts = lambda d: int(datetime.fromisoformat(d).timestamp() * 1000)
    page.evaluate('''([rows, imgs, tax]) => {
        const orders = window.Normalize.rowsToOrders(rows), decisions = {};
        for (const o of orders) for (const l of o.lines) { l.img = imgs[l.title] || ''; decisions[l.key] = 'lab'; }
        localStorage.setItem('orderTriage.app.v1', JSON.stringify({ orders, decisions, refunds: {}, rules: null, since: 'none',
            prefs: { autoNext: true, sort: 'desc', remindDays: 7 }, invoice: { title: '示例大学', taxId: tax, template: '', email: '' },
            invFiles: {}, haveIdx: [] }));
    }''', [rows, imgs, FAKE_TAX])
    plat = {
        '示例-1011': {'tab': 'unapplied'},
        '示例-1009': {'tab': 'applying', 'progress': '开票中', 'date': '2026-09-24'},
        '示例-1007': {'tab': 'issued', 'title': '示例大学', 'type': '电子普通发票', 'date': '2026-09-08', 'amount': 42},
        '示例-1006': {'tab': 'issued', 'title': '示例大学', 'type': '电子普通发票', 'date': '2026-09-02', 'amount': 158},
    }
    page.evaluate('''([plat, at, ask, vip]) => chrome.storage.local.set({
        invSync: { at, rows: plat },
        askSent: { '示例-1010': ask, '示例-1008': ask - 9 * 864e5 },
        vipSent: { '示例-1008': vip },
        chatScan: { at, convs: { '某某化学试剂': { orders: ['示例-1013'], cards: [{ time: '2026-09-30 14:05', title: '无水乙醇 分析纯 500ml', price: '38.00' }] } } },
        dlDone: { '示例-1005': [{ file: '2026-08-27_64.00_某某试剂耗材_示例-1005.pdf', at }],
                  '示例-1004': [{ file: '2026-08-22_33.80_某某电子元件_示例-1004.pdf', at }] },
    })''', [plat, ts('2026-10-05T09:12:00+08:00'), ts('2026-10-02T15:30:00+08:00'), ts('2026-09-27T10:00:00+08:00')])
    page.goto(home)
    page.wait_for_selector('#main:not([hidden])')


FONTS = """<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>
<alias binding="strong"><family>system-ui</family><prefer><family>Microsoft YaHei UI</family><family>Noto Sans CJK SC</family></prefer></alias>
<alias binding="strong"><family>sans-serif</family><prefer><family>Microsoft YaHei UI</family><family>Noto Sans CJK SC</family></prefer></alias>
<alias binding="strong"><family>monospace</family><prefer><family>DejaVu Sans Mono</family><family>Microsoft YaHei UI</family></prefer></alias>
</fontconfig>"""


def box(page, sel):
    """元素在整页上的位置（整页截图用）"""
    return page.evaluate('s => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY }; }', sel)


def band(y0, y1):
    return {'x': 0, 'y': max(0, y0), 'width': W, 'height': y1 - max(0, y0)}


def run(p, tmp):
    # 中文界面在 Windows 上默认用微软雅黑：临时 HOME 里放一份字体配置，让 Linux 上的截图字形接近（有这个字体时才生效）
    (tmp / 'home' / '.config' / 'fontconfig').mkdir(parents=True)
    (tmp / 'home' / '.config' / 'fontconfig' / 'fonts.conf').write_text(FONTS, encoding='utf-8')
    ctx = p.chromium.launch_persistent_context(
        str(tmp / 'profile'), channel='chromium', headless=True, viewport={'width': W, 'height': H}, device_scale_factor=1,
        locale='zh-CN', timezone_id='Asia/Shanghai', env=dict(os.environ, HOME=str(tmp / "home"), LANG="zh_CN.UTF-8", LANGUAGE="zh_CN"),
        args=['--disable-extensions-except=' + str(ROOT), '--load-extension=' + str(ROOT), '--lang=zh-CN',
              '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND'])
    ctx.route(lambda u: urlsplit(u).scheme in ('http', 'https', 'ws', 'wss'), lambda r: r.abort())   # 不联网
    ctx.clock.set_fixed_time(NOW)
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
    home = f'chrome-extension://{urlsplit(sw.url).hostname}/index.html'
    page = ctx.new_page()
    page.goto(home)
    assert page.evaluate('t => Invoice.taxIdOk(t)', FAKE_TAX), FAKE_TAX
    OUT.mkdir(parents=True, exist_ok=True)

    for scheme, suffix in (('light', ''), ('dark', '-dark')):
        page.emulate_media(color_scheme=scheme)
        reset(page, home)
        load_sample(page, home)
        page.wait_for_timeout(400)
        # 主页总览：从顶上到待定列表结束
        save(page, 'overview' + suffix, clip=band(0, box(page, '#list')['bottom'] + 24), full=True)
        if scheme == 'dark':
            continue
        # 分拣列表：第 6 步「检查实验室」
        page.click('.flow li[data-step="5"]')
        page.wait_for_timeout(300)
        page.click('.flow-acts [data-goto="lab"]')
        page.wait_for_timeout(400)
        page.evaluate('() => window.scrollTo(0, 0)')
        y0 = box(page, '#summary')['top']
        save(page, 'sorting', clip=band(y0 - 12, y0 + 1080), full=True)

    page.emulate_media(color_scheme='light')
    reset(page, home)
    load_invoice(page, home)
    page.click('#seg-cat [data-cat="invoice"]')
    page.wait_for_timeout(300)
    for d in page.query_selector_all('details.inv-sect:not([open]) summary'):
        d.click()
    page.wait_for_timeout(400)
    page.evaluate('() => window.scrollTo(0, 0)')
    save(page, 'invoice', clip=band(box(page, '#bar')['top'] - 6, box(page, '#list')['bottom'] + 24), full=True)

    reset(page, home)
    ctx.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix='ot-shot-', dir='/tmp'))
    try:
        with sync_playwright() as p:
            run(p, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('截图已存到', OUT)


if __name__ == '__main__':
    sys.exit(main())
