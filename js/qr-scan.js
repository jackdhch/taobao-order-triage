/*
 * qr-scan —— 卖家发来的图片里找二维码（jsQR 多尝试；浏览器和 Node 共用，不碰网页）
 *
 * 卖家常用手机拍电脑屏幕上的「二维码交付」弹窗发过来（2026-10 实测：2268×2319、1.7 MB、摩尔纹明显）。
 * jsQR 的二值化按固定 8 像素小块算阈值：原图太大时二维码一格几十个像素、格子里全是摩尔条纹，常常读不出；
 * 缩小（按面积取平均）会把条纹抹平。所以按几种尺寸、几种二值化、几块裁切依次试，读出一个就停，整张图限时。
 *
 *   attempts(w, h)            → 尝试清单（尺寸长边 500~1600 × 灰度原图 / 大津法 / 自适应阈值 × 整张 / 中间 70%、50% / 四宫格）
 *   scanSync(img, jsQR, opt)  → 二维码内容或 ''（img = { data: RGBA, width, height }；Node 自检用）
 *   scan(src, jsQR, opt)      → Promise，同上；src 也可以是 ImageBitmap / <img>（浏览器）。每试一次让出主线程，界面不卡
 *   opt.budget：整张图最多试多久（毫秒，默认 3000）
 */
(function (root) {
  'use strict';
  const CROPS = { c70: [0.15, 0.15, 0.7, 0.7], c50: [0.25, 0.25, 0.5, 0.5],
                  q1: [0, 0, 0.6, 0.6], q2: [0.4, 0, 0.6, 0.6], q3: [0, 0.4, 0.6, 0.6], q4: [0.4, 0.4, 0.6, 0.6] };
  const QS = ['q1', 'q2', 'q3', 'q4'];

  // 顺序按代价排：二值化后的图 jsQR 很快就有结论（几十毫秒），灰度原图读不出时要转很久（900 像素约 1 秒），放后面
  function attempts(w, h) {
    const long = Math.max(w, h), list = [], seen = new Set();
    const add = (L, mode, crop) => {
      const n = Math.min(L, crop ? Math.round(long * CROPS[crop][2]) : long);
      const k = n + '|' + mode + '|' + (crop || '');
      if (!seen.has(k)) { seen.add(k); list.push({ long: n, mode, crop: crop || '' }); }
    };
    if (long <= 1000) add(long, 'raw');                 // 小图（截图、原始二维码）原尺寸一次就够，快
    add(500, 'raw'); add(900, 'otsu'); add(700, 'otsu'); add(700, 'adaptive'); add(500, 'otsu'); add(1200, 'otsu');
    add(900, 'adaptive'); add(500, 'adaptive'); add(900, 'otsu', 'c70'); add(900, 'otsu', 'c50');
    add(700, 'raw'); add(900, 'adaptive', 'c70'); add(900, 'adaptive', 'c50'); add(1600, 'otsu');
    for (const q of QS) add(900, 'otsu', q);
    add(900, 'raw'); add(900, 'raw', 'c50'); add(1200, 'adaptive'); add(900, 'raw', 'c70');
    for (const q of QS) add(900, 'adaptive', q);
    add(1200, 'raw'); add(1600, 'adaptive');
    for (const q of QS) add(900, 'raw', q);
    add(1600, 'raw');
    return list;
  }

  // 灰度的积分图：缩放、裁切都从它按面积取平均，原图只扫一遍
  function integral(rgba, w, h) {
    const W = w + 1, S = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
        row += (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
        S[(y + 1) * W + x + 1] = S[y * W + x + 1] + row;
      }
    }
    return S;
  }
  // 从积分图取 [x0,x0+cw)×[y0,y0+ch) 这块、缩到 ow×oh（放大时就是最近邻）
  function sample(S, w, x0, y0, cw, ch, ow, oh) {
    const W = w + 1, g = new Uint8Array(ow * oh), sx = cw / ow, sy = ch / oh;
    for (let y = 0; y < oh; y++) {
      const ya = y0 + Math.floor(y * sy), yb = Math.max(ya + 1, y0 + Math.floor((y + 1) * sy));
      for (let x = 0; x < ow; x++) {
        const xa = x0 + Math.floor(x * sx), xb = Math.max(xa + 1, x0 + Math.floor((x + 1) * sx));
        const s = S[yb * W + xb] - S[ya * W + xb] - S[yb * W + xa] + S[ya * W + xa];
        g[y * ow + x] = s / ((xb - xa) * (yb - ya));
      }
    }
    return g;
  }
  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let wB = 0, sB = 0, best = 0, th = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = g.length - wB; if (!wF) break;
      sB += t * hist[t];
      const d = sB / wB - (sum - sB) / wF, v = wB * wF * d * d;
      if (v > best) { best = v; th = t; }
    }
    const o = new Uint8Array(g.length);
    for (let i = 0; i < g.length; i++) o[i] = g[i] > th ? 255 : 0;
    return o;
  }
  // 自适应阈值：比周围一块（约图宽的 1/30）的平均暗 6 以上算黑——屏幕亮度不均、一边亮一边暗时比全局阈值稳
  function adaptive(g, w, h) {
    const W = w + 1, S = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; S[(y + 1) * W + x + 1] = S[y * W + x + 1] + row; } }
    const r = Math.max(7, Math.round(Math.max(w, h) / 60)), o = new Uint8Array(g.length);
    for (let y = 0; y < h; y++) {
      const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
        const m = (S[yb * W + xb] - S[ya * W + xb] - S[yb * W + xa] + S[ya * W + xa]) / ((xb - xa) * (yb - ya));
        o[y * w + x] = g[y * w + x] < m - 6 ? 0 : 255;
      }
    }
    return o;
  }
  function rgbaOf(g) {
    const o = new Uint8ClampedArray(g.length * 4);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) { o[j] = o[j + 1] = o[j + 2] = g[i]; o[j + 3] = 255; }
    return o;
  }
  function tryOne(S, w, h, a, jsQR) {
    const [fx, fy, fw, fh] = a.crop ? CROPS[a.crop] : [0, 0, 1, 1];
    const x0 = Math.floor(w * fx), y0 = Math.floor(h * fy), cw = Math.max(1, Math.floor(w * fw)), ch = Math.max(1, Math.floor(h * fh));
    const k = a.long / Math.max(cw, ch), ow = Math.max(1, Math.round(cw * k)), oh = Math.max(1, Math.round(ch * k));
    let g = sample(S, w, x0, y0, cw, ch, ow, oh);
    if (a.mode === 'otsu') g = otsu(g); else if (a.mode === 'adaptive') g = adaptive(g, ow, oh);
    // 反色（黑底白码）也试：attemptBoth
    const q = jsQR(rgbaOf(g), ow, oh, { inversionAttempts: 'attemptBoth' });
    return q && q.data ? q.data : '';
  }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function scanSync(img, jsQR, opt) {
    const t0 = now(), budget = (opt && opt.budget) || 3000;
    const S = integral(img.data, img.width, img.height);
    for (const a of attempts(img.width, img.height)) {
      if (now() - t0 > budget) break;
      const r = tryOne(S, img.width, img.height, a, jsQR);
      if (r) { if (opt && opt.trace) opt.trace.push(a); return r; }
    }
    return '';
  }
  // 浏览器：位图先画进画布取像素（太大的先缩到长边 2400，省内存）
  function pixels(src) {
    if (src && src.data && src.width) return src;
    const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height, k = Math.min(1, 2400 / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = c.getContext('2d'); g.drawImage(src, 0, 0, w, h);
    return g.getImageData(0, 0, w, h);
  }
  async function scan(src, jsQR, opt) {
    const t0 = now(), budget = (opt && opt.budget) || 3000;
    const img = pixels(src);
    const S = integral(img.data, img.width, img.height);
    for (const a of attempts(img.width, img.height)) {
      if (now() - t0 > budget) break;
      await new Promise(r => setTimeout(r, 0));         // 让出主线程：每次尝试之间界面照常响应
      const r = tryOne(S, img.width, img.height, a, jsQR);
      if (r) { if (opt && opt.trace) opt.trace.push(a); return r; }
    }
    return '';
  }

  // 二维码内容是哪一类：税务局电子发票（带 20 位发票号，插件能自动下载）/ 别的网址（诺诺、百望等开票平台，交给用户；inv = 看得出是开票平台）/ 不是网址
  const TAX_RE = /^https:\/\/dppt\.[a-z]+\.chinatax\.gov\.cn(?::\d+)?\/.*?2_(\d{20})_/;
  const INV_LINK = /nuonuo|baiwang|bwjf|piaotong|aisino|chinatax|fapiao|invoice|dzfp|kaipiao|fp\./i;
  function kindOf(text) {
    const t = String(text || '').trim(), m = TAX_RE.exec(t);
    if (m) return { kind: 'tax', invNo: m[1] };
    return /^https?:\/\/[^\s]+$/i.test(t) ? { kind: 'link', inv: INV_LINK.test(t) } : { kind: t ? 'text' : 'none' };
  }
  // 旺旺里显示的是缩略图（alicdn 地址后面接「_200x200.jpg」「_.webp」「_q50.jpg」之类，或 ?x-oss-process= 缩放）：
  // 拍屏照片缩成两三百像素，二维码一格不到 2 个像素，读不出来。去掉这些后缀取原图
  function fullSrc(src) {
    let u = String(src || '');
    if (!/^https?:/i.test(u)) return u;
    u = u.replace(/[?&]x-oss-process=[^&#]*/i, '').replace(/\?(#|$)/, '$1');
    for (let k = 0; k < 4; k++) {
      const v = u.replace(/(\.(?:jpe?g|png|gif|webp|bmp|heic))(?:_\d+x\d+[^/?#]*|_q\d+[^/?#]*|_\.webp|_sum\.jpg)(?=$|[?#])/i, '$1');
      if (v === u) break; u = v;
    }
    return u;
  }

  const api = { attempts, scanSync, scan, kindOf, fullSrc, pixels, TAX_RE, _integral: integral, _try: tryOne };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QrScan = api;
})(typeof self !== 'undefined' ? self : this);
