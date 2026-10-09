#!/usr/bin/env python3
"""
生成 README 用的图片。全程离线，数据全部虚构：

    env -u TMPDIR python3 tools/screenshots.py                 # 全部重新生成
    env -u TMPDIR python3 tools/screenshots.py banner shots    # 只生成其中几类：banner / shots / gifs

- banner：tools/readme-banner.html 按浅色、深色各渲染一次（2 倍清晰度）→ docs/assets/banner-light.png、banner-dark.png
- shots： 静态截图 → docs/screenshots/*.png（「开始使用」卡片、主页浅色 / 深色对照、发票栏、整理报销文件对话框）
- gifs：  演示动图 → docs/screenshots/demo-*.gif（主页总览、键盘分拣、发票状态变化）

数据来源：
- 主页、分拣：插件自带的「载入示例数据」（js/sample.js），商品图是这里画的示意图标
- 发票：这里另外编的一组虚构订单，往扩展存储里写入虚构的开票记录；抬头「示例大学」，税号是能通过校验的虚构号码
带扩展启动一个全新的无界面 Chromium（临时配置目录，用完删掉），所有 http/https 请求一律拦下。
动图里的鼠标指针、按键提示、说明文字、悬停说明框是录制时临时加在页面上的一层（见 DEMO_JS），插件代码不变。
需要 playwright 和 Pillow。生成后逐张看图（动图抽帧看），确认没有真实订单、店铺、抬头税号。
"""
import base64
import io
import os
import re
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
ASSETS = ROOT / 'docs' / 'assets'
W, H = 1240, 900                           # 静态截图的窗口
GW, GH = 1200, 860                         # 动图的窗口（README 里显示时会再缩小，所以不宜更宽）
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
SAMPLE_THUMBS = [thumb(kind, i) for i, (_, kind) in enumerate(SAMPLE_IMG)]

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
INV_BY_NO = {o[0]: o for o in INV_ORDERS}


def tax_id(base17):
    """按统一社会信用代码的规则给 17 位补上校验位（只用来造能通过校验的虚构号码）"""
    chars, w = '0123456789ABCDEFGHJKLMNPQRTUWXY', [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28]
    s = sum(chars.index(c) * w[i] for i, c in enumerate(base17))
    return base17 + chars[(31 - s % 31) % 31]


FAKE_TAX = tax_id('91' + '0' * 15)           # 行政区划码全 0，不可能对应真实单位
TITLE = '示例大学'


def ts(d):
    return int(datetime.fromisoformat(d).timestamp() * 1000)


def file_name(no):
    """下载后的发票文件名，与 js/invoice.js 的 saveName 一致：日期_金额_店铺_订单号.pdf"""
    _, t, shop, pay, _ = INV_BY_NO[no]
    return f'{t[:10]}_{pay}_{shop}_{no}.pdf'


# ── 截图与动图的保存 ──
def to_png(im, path):
    # 不量化：图例色块、状态标签面积小，量化到 256 色时会被并进相近的大面积颜色，颜色就和界面对不上了
    im.convert('RGB').save(path, optimize=True)
    print('  ', path.relative_to(ROOT), im.size, path.stat().st_size // 1024, 'KB')


def save(page, name, clip=None, full=False):
    png = page.screenshot(clip=clip, full_page=full, animations='disabled', caret='hide')
    to_png(Image.open(io.BytesIO(png)), OUT / (name + '.png'))


def ui_colors():
    """index.html 浅色 :root 里的全部颜色：动图调色板先放进这些，状态色、图例色块就不会被量化成别的颜色"""
    css = (ROOT / 'index.html').read_text(encoding='utf-8')
    block = css[css.index(':root{'):css.index('@media (prefers-color-scheme:dark)')]
    return sorted({tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) for h in re.findall(r'#([0-9A-Fa-f]{6})\b', block)})


def save_gif(frames, path):
    """frames: [(RGB 图, 停留毫秒)]。所有帧共用一个调色板（各帧各算一个会闪），不抖动（平涂界面抖动反而显脏）"""
    # 合并相同的连续帧
    merged = []
    for im, ms in frames:
        if merged and im.tobytes() == merged[-1][0].tobytes():
            merged[-1][1] += ms
        else:
            merged.append([im, ms])
    w, h = merged[0][0].size
    # 调色板 = 界面定义的颜色 + 从均匀挑出的十几帧里算出的其余颜色（文字边缘、图标、半透明叠加等）
    fixed = ui_colors()
    pick = merged[::max(1, len(merged) // 14)] + [merged[-1]]
    board = Image.new('RGB', (w, h * len(pick)))
    for i, (im, _) in enumerate(pick):
        board.paste(im, (0, h * i))
    rest = board.quantize(colors=256 - len(fixed), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).getpalette()
    rest = [tuple(rest[i:i + 3]) for i in range(0, 3 * (256 - len(fixed)), 3)]
    pal = Image.new('P', (1, 1))
    pal.putpalette([c for rgb in fixed + rest for c in rgb])
    q = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im, _ in merged]
    q[0].save(path, save_all=True, append_images=q[1:], duration=[ms for _, ms in merged], loop=0, optimize=False)
    print('  ', path.relative_to(ROOT), (w, h), len(merged), '帧', round(sum(ms for _, ms in merged) / 1000, 1), '秒',
          path.stat().st_size // 1024, 'KB')


# ── 录动图时临时加在页面上的一层：鼠标指针、点击波纹、说明文字（含按键提示）、悬停说明框 ──
# 放在 popover 里：它在顶层（top layer），对话框打开后再调一次 top() 就能盖在对话框上面
DEMO_JS = r'''() => {
  if (document.getElementById('demo-layer')) return;
  const L = document.createElement('div');
  L.id = 'demo-layer';
  L.setAttribute('popover', 'manual');
  L.innerHTML = `<style>
    #demo-layer{position:fixed; inset:0; width:100vw; height:100vh; max-width:none; max-height:none; margin:0; padding:0; border:0;
                background:transparent; overflow:visible; pointer-events:none}
    #demo-cur{position:absolute; left:-40px; top:-40px; width:24px; height:24px; filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))}
    #demo-ring{position:absolute; width:34px; height:34px; margin:-17px 0 0 -17px; border-radius:50%; border:2.5px solid #1C6E8C;
               background:rgba(28,110,140,.14); opacity:0}
    #demo-note{position:absolute; left:24px; bottom:24px; max-width:460px; display:none; align-items:center; gap:10px; padding:9px 16px;
               border-radius:10px; background:rgba(24,32,35,.92); color:#fff; font:500 14px/1.5 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
               box-shadow:0 8px 24px -8px rgba(0,0,0,.45)}
    #demo-note kbd{font:700 14px/1 "DejaVu Sans Mono",ui-monospace,monospace; color:#1D2629; background:#fff; border-radius:6px;
                   padding:5px 9px 4px; border-bottom:3px solid #AEB8BC; min-width:30px; text-align:center}
    #demo-note kbd.down{transform:translateY(2px); border-bottom-width:1px; background:#DDE8EC}
    #demo-tip{position:absolute; display:none; max-width:380px; padding:4px 8px; background:#FFFFFF; color:#1D2629; border:1px solid #A7ADB0;
              border-radius:3px; font:12px/1.45 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif; box-shadow:0 2px 8px rgba(0,0,0,.16)}
  </style><div id="demo-tip"></div><div id="demo-ring"></div><div id="demo-note"></div>
  <svg id="demo-cur" viewBox="0 0 24 24"><path d="M5 2.6v17.2l4.3-4.1 2.9 6.6 3-1.3-2.9-6.5h6.1z" fill="#fff" stroke="#1D2629" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  document.body.appendChild(L);
  L.showPopover();
  const q = s => L.querySelector(s);
  window.__demo = {
    top() { L.hidePopover(); L.showPopover(); },
    cursor(x, y) { const c = q('#demo-cur'); c.style.left = (x - 5) + 'px'; c.style.top = (y - 3) + 'px'; },
    ring(x, y, k) { const r = q('#demo-ring'); r.style.left = x + 'px'; r.style.top = y + 'px';
                    r.style.opacity = k < 0 ? '0' : String(0.95 * (1 - k)); r.style.transform = 'scale(' + (0.45 + 0.9 * Math.max(k, 0)) + ')'; },
    note(html) { const n = q('#demo-note'); n.innerHTML = html || ''; n.style.display = html ? 'flex' : 'none'; },
    press(down) { const k = q('#demo-note kbd'); if (k) k.classList.toggle('down', down); },
    tip(text, x, y) { const t = q('#demo-tip'); t.textContent = text || ''; t.style.display = text ? 'block' : 'none';
                      if (text) { t.style.left = x + 'px'; t.style.top = y + 'px';
                                  const r = t.getBoundingClientRect(); if (r.right > innerWidth - 8) t.style.left = (innerWidth - 8 - r.width) + 'px'; } },
  };
}'''


class Reel:
    """把一段操作录成动图：每帧截一次图并记下停留时长；页面里的计时器（提示条几秒后消失等）用 Playwright 的假时钟按同样时长推进，
    动图里的节奏就和真实操作一致，与截图快慢无关"""
    STEP = 40                                    # 动画帧间隔（毫秒）

    def __init__(self, page):
        self.page, self.frames, self.pos = page, [], None

    def inject(self):
        self.page.evaluate(DEMO_JS)
        if self.pos:
            self.page.evaluate('([x, y]) => __demo.cursor(x, y)', list(self.pos))

    def snap(self, ms):
        self.page.wait_for_timeout(30)
        png = self.page.screenshot(animations='disabled', caret='hide')
        self.frames.append((Image.open(io.BytesIO(png)).convert('RGB'), ms))
        self.page.clock.run_for(ms)

    def note(self, html):
        self.page.evaluate('h => __demo.note(h)', html)

    def tip(self, text=None, x=0, y=0):
        self.page.evaluate('([t, x, y]) => __demo.tip(t, x, y)', [text, x, y])

    def glide(self, x, y, ms=520):
        x0, y0 = self.pos or (x + 220, y + 160)
        n = max(3, ms // self.STEP)
        for i in range(1, n + 1):
            t = i / n
            e = 4 * t ** 3 if t < .5 else 1 - (-2 * t + 2) ** 3 / 2       # 先加速后减速
            self.page.evaluate('([x, y]) => __demo.cursor(x, y)', [x0 + (x - x0) * e, y0 + (y - y0) * e])
            if i < n:
                self.snap(self.STEP)
        self.page.mouse.move(x, y)                  # 真的移过去：按钮的悬停样式跟着变
        self.pos = (x, y)
        self.snap(self.STEP)

    def center(self, sel):
        b = self.page.locator(sel).first.bounding_box()
        return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2

    def click(self, sel, hold=600, ms=520, after=None):
        x, y = self.center(sel)
        self.glide(x, y, ms)
        self.page.evaluate('([x, y]) => __demo.ring(x, y, 0)', [x, y])
        self.snap(80)
        self.page.mouse.click(x, y)
        if after:
            after()
        self.page.wait_for_timeout(150)
        for k in (.35, .7):
            self.page.evaluate('([x, y, k]) => __demo.ring(x, y, k)', [x, y, k])
            self.snap(self.STEP)
        self.page.evaluate('() => __demo.ring(0, 0, -1)')
        self.snap(hold)

    def key(self, k, label, hold=1400):
        """按键提示：左下角显示「按键 + 作用」，按下时键帽压下"""
        self.note(f'<kbd>{k}</kbd>{label}')
        self.snap(700)
        self.page.evaluate('() => __demo.press(true)')
        self.snap(120)
        self.page.keyboard.press(k)
        self.page.wait_for_timeout(150)
        self.page.evaluate('() => __demo.press(false)')
        self.snap(hold)

    def scroll_to(self, y, ms=600):
        y0 = self.page.evaluate('() => scrollY')
        n = max(3, ms // self.STEP)
        for i in range(1, n + 1):
            t = i / n
            e = 1 - (1 - t) ** 3
            self.page.evaluate('y => scrollTo(0, y)', y0 + (y - y0) * e)
            self.snap(self.STEP)

    def save(self, name):
        save_gif(self.frames, OUT / (name + '.gif'))


# ── 页面数据 ──
def reset(page, home):
    page.evaluate('() => { localStorage.clear(); return chrome.storage.local.clear(); }')
    page.goto(home)


def wrap_sample(page):
    """让「载入示例数据」直接带上示意图（相当于第 3 步已补完图片）：只在本页临时包一层 Normalize.rowsToOrders，插件代码不变"""
    page.evaluate('''([pairs, imgs]) => {
        const N = window.Normalize, raw = N.rowsToOrders;
        N.rowsToOrders = rows => { const os = raw(rows);
            if (rows === window.SAMPLE_ROWS) for (const o of os) for (const l of o.lines) {
                const k = pairs.findIndex(([p]) => l.title.startsWith(p)); if (k >= 0) l.img = imgs[k]; }
            return os; };
    }''', [SAMPLE_IMG, SAMPLE_THUMBS])


def load_sample(page, home):
    """点「载入示例数据」，商品配上示意图（不设上次报销日期，全部订单参与判断）"""
    wrap_sample(page)
    page.click('#btn-sample')
    page.wait_for_selector('#main:not([hidden])')
    page.evaluate('''() => { const S = JSON.parse(localStorage.getItem('orderTriage.app.v1')); S.since = 'none';
                             localStorage.setItem('orderTriage.app.v1', JSON.stringify(S)); }''')
    page.goto(home)
    page.wait_for_selector('#main:not([hidden])')


def load_invoice(page, home, nos=None, plat=None, store=None):
    """发票栏：虚构订单（全部判为实验室）+ 虚构的开票记录。nos 选用哪几单（默认全部），plat / store 覆盖默认的开票记录"""
    orders = [o for o in INV_ORDERS if not nos or o[0] in nos]
    rows = [['订单号', '订单提交时间', '订单状态', '店铺名称', '商品名称', '型号款式', '商品数量', '商品金额', '实付金额', '运费']]
    imgs = {}
    k = 0
    for no, t, shop, pay, lines in orders:
        for i, (title, sku, q, price, kind) in enumerate(lines):
            rows.append([no if i == 0 else '', t if i == 0 else '', '交易成功' if i == 0 else '', shop if i == 0 else '',
                         title, sku, str(q), '￥' + price, '￥' + pay if i == 0 else '', '￥0.00' if i == 0 else ''])
            imgs[title] = thumb(kind, k)
            k += 1
    page.evaluate('''([rows, imgs, title, tax]) => {
        const orders = window.Normalize.rowsToOrders(rows), decisions = {};
        for (const o of orders) for (const l of o.lines) { l.img = imgs[l.title] || ''; decisions[l.key] = 'lab'; }
        localStorage.setItem('orderTriage.app.v1', JSON.stringify({ orders, decisions, refunds: {}, rules: null, since: 'none',
            prefs: { autoNext: true, sort: 'desc' }, invoice: { title, taxId: tax, template: '', email: '' },
            invFiles: {}, haveIdx: [], person: { name: '张三', sid: '12345678' } }));
    }''', [rows, imgs, TITLE, FAKE_TAX])
    at = ts('2026-10-05T09:12:00+08:00')
    if plat is None:
        plat = {
            '示例-1011': {'tab': 'unapplied'},
            '示例-1009': {'tab': 'applying', 'progress': '开票中', 'date': '2026-09-24'},
            '示例-1007': {'tab': 'issued', 'title': TITLE, 'type': '电子普通发票', 'date': '2026-09-08', 'amount': 42},
            '示例-1006': {'tab': 'issued', 'title': TITLE, 'type': '电子普通发票', 'date': '2026-09-02', 'amount': 158},
        }
    ask = ts('2026-10-02T15:30:00+08:00')
    data = {
        'invSync': {'at': at, 'rows': plat},
        'askSent': {'示例-1010': ask, '示例-1008': ask - 9 * 86400000},
        'vipSent': {'示例-1008': ts('2026-09-27T10:00:00+08:00')},
        'chatScan': {'at': at, 'convs': {'某某化学试剂': {'orders': ['示例-1013'],
                     'cards': [{'time': '2026-09-30 14:05', 'title': '无水乙醇 分析纯 500ml', 'price': '38.00'}]}}},
        'dlDone': {no: [{'file': file_name(no), 'at': at}] for no in ('示例-1005', '示例-1004')},
    }
    data.update(store or {})
    page.evaluate('d => chrome.storage.local.set(d)', data)
    page.goto(home)
    page.wait_for_selector('#main:not([hidden])')


INVOICE_PDF = '''<!doctype html><meta charset="utf-8"><body style="font-family:'Microsoft YaHei',sans-serif;padding:40px">
<h2>电子发票（普通发票）</h2><p>发票号码：{no}</p><p>开票日期：{y}年{m}月{d}日</p>
<p>购买方信息 名称：{title} 统一社会信用代码/纳税人识别号：{tax}</p><p>销售方信息 名称：{shop}</p>
<p>项目名称 {item} 金额 ¥{a1} 税额 ¥{a2}</p><p>价税合计（小写）¥{amt}</p></body>'''


def make_pdfs(p, folder, items):
    """虚构的发票 PDF（浏览器现场打印），供「整理报销文件」读取金额和开票日期。items: [(订单号, 开票日期)]"""
    folder.mkdir(parents=True)
    b = p.chromium.launch()
    pg = b.new_page()
    for i, (no, d) in enumerate(items):
        _, _, shop, pay, lines = INV_BY_NO[no]
        amt = float(pay)
        y, m, dd = d.split('-')
        pg.set_content(INVOICE_PDF.format(no='2699' + '0' * 13 + f'{i + 1:03d}', y=y, m=m, d=dd, title=TITLE, tax=FAKE_TAX, shop=shop,
                                          item=lines[0][0], amt=f'{amt:.2f}', a1=f'{amt / 1.13:.2f}', a2=f'{amt - amt / 1.13:.2f}'))
        pg.pdf(path=str(folder / file_name(no)))
    b.close()


def box(page, sel):
    """元素在整页上的位置（整页截图用）"""
    return page.evaluate('s => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY }; }', sel)


def band(y0, y1, w=W):
    return {'x': 0, 'y': max(0, y0), 'width': w, 'height': y1 - max(0, y0)}


def open_inv_sections(page):
    page.click('.flow li[data-step="2"]')              # 第 3 步「处理发票」：下方显示发票表
    page.wait_for_timeout(300)
    for d in page.query_selector_all('details.inv-sect:not([open]) summary'):
        d.click()
    page.wait_for_timeout(300)


# ── 三类图片 ──
def make_banner(p):
    """横幅：浅色、深色各一张，透明圆角，2 倍清晰度"""
    ASSETS.mkdir(parents=True, exist_ok=True)
    b = p.chromium.launch()
    for scheme in ('light', 'dark'):
        pg = b.new_page(viewport={'width': 1280, 'height': 360}, device_scale_factor=2, color_scheme=scheme)
        pg.goto((ROOT / 'tools' / 'readme-banner.html').as_uri())
        pg.wait_for_timeout(300)
        path = ASSETS / f'banner-{scheme}.png'
        Image.open(io.BytesIO(pg.screenshot(omit_background=True))).save(path, optimize=True)
        print('  ', path.relative_to(ROOT), path.stat().st_size // 1024, 'KB')
    b.close()


def save2x(page, name, clip):
    """2 倍清晰度截图：README 里两张并排、缩小显示的图用，高分屏上不糊（用 CDP 临时把设备像素比改成 2 再截）"""
    cdp = page.context.new_cdp_session(page)
    cdp.send('Emulation.setDeviceMetricsOverride', {'width': W, 'height': H, 'deviceScaleFactor': 2, 'mobile': False})
    try:
        page.wait_for_timeout(300)
        shot = cdp.send('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': True, 'clip': dict(clip, scale=1)})
        to_png(Image.open(io.BytesIO(base64.b64decode(shot['data']))), OUT / (name + '.png'))
    finally:
        cdp.send('Emulation.clearDeviceMetricsOverride')
        cdp.detach()


def make_shots(p, page, home, tmp):
    # 第一次打开：没有数据时的「开始使用」卡片（README「第一次使用」）
    page.emulate_media(color_scheme='light')
    reset(page, home)
    page.wait_for_selector('#empty:not([hidden])')
    page.wait_for_timeout(300)
    r = page.locator('#empty').bounding_box()
    save(page, 'welcome', clip={'x': r['x'] - 12, 'y': max(0, r['y'] - 12), 'width': r['width'] + 24, 'height': r['height'] + 24})

    # 浅色 / 深色对照：主页左上部分（顶栏、进度、前四步），README 里两张并排，取窄一些才看得清
    for scheme in ('light', 'dark'):
        page.emulate_media(color_scheme=scheme)
        reset(page, home)
        load_sample(page, home)
        page.wait_for_timeout(400)
        save2x(page, 'theme-' + scheme, clip=band(0, box(page, '.order')['top'] + 46, w=645))

    page.emulate_media(color_scheme='light')
    reset(page, home)
    load_invoice(page, home)
    open_inv_sections(page)
    page.evaluate('() => window.scrollTo(0, 0)')
    save(page, 'invoice', clip=band(box(page, '#bar')['top'] - 6, box(page, '#list')['bottom'] + 24), full=True)

    # 整理报销文件：7 单已下载发票，选文件夹后预览（按报销规范分类、低值品标签）
    got = ['示例-1011', '示例-1009', '示例-1008', '示例-1007', '示例-1006', '示例-1005', '示例-1004']
    issued = {'示例-1011': '2026-09-29', '示例-1009': '2026-09-25', '示例-1008': '2026-09-15', '示例-1007': '2026-09-08',
              '示例-1006': '2026-09-02', '示例-1005': '2026-08-27', '示例-1004': '2026-08-22'}
    make_pdfs(p, tmp / '订单分拣-发票', [(no, issued[no]) for no in got])
    reset(page, home)
    load_invoice(page, home, store={'dlDone': {no: [{'file': file_name(no), 'at': ts(NOW)}] for no in got}})
    # 相当于在「选择发票文件夹并整理」里选了这个文件夹（Playwright 的选文件夹在这里偶尔卡住，直接把文件交给输入框）
    files = [[f.name, base64.b64encode(f.read_bytes()).decode()] for f in sorted((tmp / '订单分拣-发票').iterdir())]
    page.evaluate('''files => { const dt = new DataTransfer();
        for (const [name, b64] of files) dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type: 'application/pdf' }));
        const inp = document.getElementById('inv-pack-dir'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); }''', files)
    page.wait_for_selector('#dlg-pack[open]', timeout=20000)
    page.fill('#pack-name', '第 5 批')
    # 预览列表拉高到能放下整份清单（相当于用户把窗口拉大）
    page.evaluate('() => { document.getElementById("pack-list").style.maxHeight = "none"; document.activeElement.blur(); }')
    page.wait_for_timeout(300)
    r = page.locator('#dlg-pack').bounding_box()
    save(page, 'pack', clip={'x': r['x'] - 20, 'y': r['y'] - 20, 'width': r['width'] + 40, 'height': r['height'] + 40})
    page.keyboard.press('Escape')


def gif_overview(page, home):
    """主页总览：载入示例数据 → 进度条、四步流程亮起 → 看看后两步 → 回到「核对商品」"""
    page.set_viewport_size({'width': GW, 'height': GH})
    reset(page, home)
    wrap_sample(page)
    r = Reel(page)
    r.inject()
    r.snap(1200)
    r.click('#btn-sample', hold=1800, after=lambda: page.wait_for_selector('#main:not([hidden])'))
    r.inject()
    # 四步流程：点开第 3、4 步，再回到第 2 步「核对商品」（待定排在最前、标黄）
    r.click('.flow li[data-step="2"]', hold=1500)
    r.click('.flow li[data-step="3"]', hold=1500)
    r.click('.flow li[data-step="1"]', hold=2600)
    r.save('demo-overview')


def gif_sorting(page, home):
    """核对商品：按 1 / 2 判断两件待定 → 自动切到「实验室」→「这 N 件都是实验室，确认」→「个人」同样确认 → 进度和步骤条更新"""
    page.set_viewport_size({'width': GW, 'height': GH})
    reset(page, home)
    load_sample(page, home)
    page.clock.run_for(5000)
    r = Reel(page)
    r.inject()
    r.snap(1000)
    r.key('1', '判为实验室', hold=1500)
    r.key('2', '判为个人', hold=1600)
    r.note('')
    r.scroll_to(0, 280)
    r.click('#summary [data-flow="sort-cat"]', hold=1800)          # 实验室这一类一次确认，自动切到「个人」
    r.click('#summary [data-flow="sort-cat"]', hold=1800)
    r.glide(GW - 8, 330, 400)                    # 指针停到页边，不挡按钮
    r.snap(3000)
    r.save('demo-sorting')


def gif_invoice(page, home):
    """发票状态：悬停带「›」的状态看说明 → 一单从「可在淘宝平台申请」依次变为已申请、已开票待下载、已下载"""
    page.set_viewport_size({'width': GW, 'height': GH})
    reset(page, home)
    nos = ['示例-1013', '示例-1011', '示例-1010', '示例-1009', '示例-1008', '示例-1006', '示例-1004']
    load_invoice(page, home, nos=nos)
    open_inv_sections(page)
    page.clock.run_for(5000)
    page.evaluate('() => scrollTo(0, document.getElementById("bar").getBoundingClientRect().top + scrollY - 8)')
    r = Reel(page)
    r.inject()
    # 跟踪的那一单用浅色底标出来
    page.evaluate('''() => { const s = document.createElement('style'); s.id = 'demo-mark';
        s.textContent = '#list tr:has(a[data-detail="示例-1011"]) td{background:#EAF3F6} #list tr:has(a[data-detail="示例-1011"]) td:first-child{box-shadow:inset 3px 0 0 #1C6E8C}';
        document.head.appendChild(s); }''')
    r.note('需报销的订单逐单显示发票状态，颜色见图例')
    r.snap(2200)

    def hover(no, hold):
        sel = f'#list button.st-go[data-no="{no}"]'
        bb = page.locator(sel).bounding_box()
        r.glide(bb['x'] + bb['width'] - 9, bb['y'] + bb['height'] - 4)     # 指在「›」上，不挡状态文字
        r.snap(350)
        r.tip(page.get_attribute(sel, 'title'), r.pos[0] - 6, r.pos[1] + 20)
        r.snap(hold)
        r.tip()

    r.note('带「›」的状态可点击，打开对应的淘宝页面')
    hover('示例-1011', 1700)
    hover('示例-1013', 1700)
    r.glide(GW - 8, GH - 200, 450)

    def step(text, change, hold=2300):
        r.note(text)
        r.snap(700)
        page.evaluate(change)
        page.wait_for_timeout(250)
        # 这一单换到下面的分组、出了画面时，滚过去跟着它（底下留出说明文字的位置）
        y = page.evaluate('''() => { const r = document.querySelector('#list tr:has(a[data-detail="示例-1011"])').getBoundingClientRect();
            return r.bottom > innerHeight - 90 ? Math.min(scrollY + r.bottom - innerHeight + 110, document.documentElement.scrollHeight - innerHeight) : null; }''')
        if y is not None:
            r.snap(500)
            r.scroll_to(y, 360)
        r.snap(hold)

    step('刷新发票情况：已提交平台申请',
         '''() => chrome.storage.local.get('invSync').then(({ invSync }) => { invSync.rows['示例-1011'] = { tab: 'applying', progress: '申请中', date: '2026-10-05' };
             return chrome.storage.local.set({ invSync }); })''')
    step('商家开具后：已开票，待下载',
         '''() => chrome.storage.local.get('invSync').then(({ invSync }) => { invSync.rows['示例-1011'] = { tab: 'issued', title: '示例大学', type: '电子普通发票', date: '2026-10-05', amount: 389 };
             return chrome.storage.local.set({ invSync }); })''')
    step('下载后按订单命名，存入「订单分拣-发票」',
         f'''() => chrome.storage.local.get('dlDone').then(({{ dlDone }}) => {{ dlDone['示例-1011'] = [{{ file: '{file_name("示例-1011")}', at: Date.now() }}];
             return chrome.storage.local.set({{ dlDone }}); }})''', hold=3000)
    r.note('')
    r.snap(800)
    r.save('demo-invoice')


FONTS = """<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>
<alias binding="strong"><family>system-ui</family><prefer><family>Microsoft YaHei UI</family><family>Noto Sans CJK SC</family></prefer></alias>
<alias binding="strong"><family>sans-serif</family><prefer><family>Microsoft YaHei UI</family><family>Noto Sans CJK SC</family></prefer></alias>
<alias binding="strong"><family>monospace</family><prefer><family>DejaVu Sans Mono</family><family>Microsoft YaHei UI</family></prefer></alias>
</fontconfig>"""


def run(p, tmp, what):
    if 'banner' in what:
        make_banner(p)
    if not {'shots', 'gifs'} & set(what):
        return
    # 中文界面在 Windows 上默认用微软雅黑：临时 HOME 里放一份字体配置，让 Linux 上的截图字形接近（有这个字体时才生效）
    (tmp / 'home' / '.config' / 'fontconfig').mkdir(parents=True)
    (tmp / 'home' / '.config' / 'fontconfig' / 'fonts.conf').write_text(FONTS, encoding='utf-8')
    ctx = p.chromium.launch_persistent_context(
        str(tmp / 'profile'), channel='chromium', headless=True, viewport={'width': W, 'height': H}, device_scale_factor=1,
        locale='zh-CN', timezone_id='Asia/Shanghai', reduced_motion='reduce',
        env=dict(os.environ, HOME=str(tmp / "home"), LANG="zh_CN.UTF-8", LANGUAGE="zh_CN"),
        args=['--disable-extensions-except=' + str(ROOT), '--load-extension=' + str(ROOT), '--lang=zh-CN',
              '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND'])
    ctx.route(lambda u: urlsplit(u).scheme in ('http', 'https', 'ws', 'wss'), lambda r: r.abort())   # 不联网
    # 假时钟停在 NOW：只在截图 / 录帧时按需推进（见 Reel.snap）
    ctx.clock.install(time=NOW)
    ctx.clock.pause_at(NOW)
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
    home = f'chrome-extension://{urlsplit(sw.url).hostname}/index.html'
    page = ctx.new_page()
    page.goto(home)
    assert page.evaluate('t => Invoice.taxIdOk(t)', FAKE_TAX), FAKE_TAX
    OUT.mkdir(parents=True, exist_ok=True)
    if 'shots' in what:
        make_shots(p, page, home, tmp)
    if 'gifs' in what:
        page.emulate_media(color_scheme='light')
        gif_overview(page, home)
        gif_sorting(page, home)
        gif_invoice(page, home)
    reset(page, home)
    ctx.close()


def main():
    what = sys.argv[1:] or ['banner', 'shots', 'gifs']
    bad = set(what) - {'banner', 'shots', 'gifs'}
    if bad:
        sys.exit('不认识的参数：' + ' '.join(bad) + '（可选 banner / shots / gifs）')
    tmp = Path(tempfile.mkdtemp(prefix='ot-shot-', dir='/tmp'))
    try:
        with sync_playwright() as p:
            run(p, tmp, what)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('已生成到', OUT.relative_to(ROOT), '和', ASSETS.relative_to(ROOT))


if __name__ == '__main__':
    sys.exit(main())
