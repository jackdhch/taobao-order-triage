// 只给自检用的最小 JPEG 解码：基线（SOF0/SOF1）哈夫曼编码，只还原亮度（Y）分量，输出灰度 RGBA。
// Node 自带的模块读不了 JPEG，自检要拿 tools/fixtures 里合成的拍屏照片喂给 js/qr-scan.js（插件在浏览器里用 createImageBitmap，不用这个）。
// 渐进式 JPEG 不支持（make-qr-photo.py 用 Pillow 默认参数存的是基线）
const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

function huff(counts, syms) {
  // 按码长从短到长：code → 符号，用「长度|码值」作键
  const map = new Map();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) map.set((len << 16) | code++, syms[k++]);
    code <<= 1;
  }
  return map;
}

export function decodeLuma(buf) {
  const d = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const qt = [], dc = [], ac = [];
  let frame = null, ri = 0, p = 2;
  if (d[0] !== 0xff || d[1] !== 0xd8) throw new Error('不是 JPEG');
  const u16 = i => (d[i] << 8) | d[i + 1];
  for (;;) {
    while (d[p] === 0xff && d[p + 1] === 0xff) p++;
    if (d[p] !== 0xff) throw new Error('JPEG 结构不对 @' + p);
    const m = d[p + 1], len = u16(p + 2), s = p + 4, e = p + 2 + len;
    if (m === 0xdb) {
      for (let i = s; i < e;) { const pq = d[i] >> 4, t = d[i] & 15; i++; const q = new Int32Array(64);
        for (let k = 0; k < 64; k++) { q[k] = pq ? u16(i) : d[i]; i += pq ? 2 : 1; } qt[t] = q; }
    } else if (m === 0xc0 || m === 0xc1) {
      const n = d[s + 5], comps = [];
      for (let i = 0; i < n; i++) comps.push({ id: d[s + 6 + i * 3], h: d[s + 7 + i * 3] >> 4, v: d[s + 7 + i * 3] & 15, tq: d[s + 8 + i * 3] });
      frame = { h: u16(s + 1), w: u16(s + 3), comps };
    } else if (m === 0xc2 || m === 0xc3 || (m >= 0xc5 && m <= 0xcf && m !== 0xc8 && m !== 0xcc)) {
      throw new Error('只支持基线 JPEG');
    } else if (m === 0xc4) {
      for (let i = s; i < e;) { const tc = d[i] >> 4, th = d[i] & 15; const counts = d.subarray(i + 1, i + 17);
        const n = counts.reduce((a, b) => a + b, 0); (tc ? ac : dc)[th] = huff(counts, d.subarray(i + 17, i + 17 + n)); i += 17 + n; }
    } else if (m === 0xdd) {
      ri = u16(s);
    } else if (m === 0xda) {
      return scan(d, e, frame, d.subarray(s + 1, s + 1 + d[s] * 2), qt, dc, ac, ri);
    } else if (m === 0xd9) throw new Error('JPEG 没有图像数据');
    p = e;
  }
}

function scan(d, p, frame, sel, qt, dcT, acT, ri) {
  const { w, h, comps } = frame;
  const hmax = Math.max(...comps.map(c => c.h)), vmax = Math.max(...comps.map(c => c.v));
  const mx = Math.ceil(w / (8 * hmax)), my = Math.ceil(h / (8 * vmax));
  const order = [];
  for (let i = 0; i < sel.length; i += 2) {
    const c = comps.find(x => x.id === sel[i]);
    order.push(Object.assign(c, { dc: dcT[sel[i + 1] >> 4], ac: acT[sel[i + 1] & 15], pred: 0 }));
  }
  const Y = comps[0], PW = mx * Y.h * 8, PH = my * Y.v * 8, plane = new Uint8ClampedArray(PW * PH);
  // 位读取：0xFF 00 是转义；遇到别的标记就停（RST 由下面按间隔处理）
  let bits = 0, nb = 0, marker = false;
  const fill = () => {
    if (marker) { bits = (bits << 8) & 0xffffff; nb += 8; return; }
    let b = d[p];
    if (b === 0xff) { const n = d[p + 1]; if (n === 0) p += 2; else { marker = true; b = 0; } } else p++;
    bits = ((bits << 8) | b) & 0xffffff; nb += 8;
  };
  const bit = () => { if (!nb) fill(); nb--; return (bits >> nb) & 1; };
  const recv = n => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bit(); return v; };
  const ext = (v, n) => (n && v < (1 << (n - 1)) ? v - (1 << n) + 1 : v);
  const dec = t => { let code = 0; for (let len = 1; len <= 16; len++) { code = (code << 1) | bit(); const s = t.get((len << 16) | code); if (s !== undefined) return s; } throw new Error('哈夫曼码错'); };
  // 8×8 反变换（直接按定义算，自检里够快）
  const C = new Float64Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) C[x * 8 + u] = (u ? 1 : Math.SQRT1_2) * Math.cos((2 * x + 1) * u * Math.PI / 16) / 2;
  const blk = new Float64Array(64), tmp = new Float64Array(64);
  function block(c, keep, bx, by) {
    blk.fill(0);
    const q = qt[c.tq], t = dec(c.dc);
    c.pred += t ? ext(recv(t), t) : 0;
    blk[0] = c.pred * q[0];
    for (let k = 1; k < 64;) {
      const rs = dec(c.ac), r = rs >> 4, s = rs & 15;
      if (!s) { if (r === 15) { k += 16; continue; } break; }
      k += r; if (k > 63) break;
      blk[ZZ[k]] = ext(recv(s), s) * q[k]; k++;
    }
    if (!keep) return;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { let a = 0; for (let u = 0; u < 8; u++) a += C[x * 8 + u] * blk[y * 8 + u]; tmp[y * 8 + x] = a; }
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) { let a = 0; for (let v = 0; v < 8; v++) a += C[y * 8 + v] * tmp[v * 8 + x];
      plane[(by * 8 + y) * PW + bx * 8 + x] = Math.round(a + 128); }
  }
  let n = 0;
  for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++) {
    if (ri && n && n % ri === 0) {            // 重新同步：丢掉剩余位，跳过 RSTn，DC 预测清零
      nb = 0; bits = 0; marker = false;
      while (p < d.length && !(d[p] === 0xff && d[p + 1] >= 0xd0 && d[p + 1] <= 0xd7)) p++;
      p += 2; order.forEach(c => { c.pred = 0; });
    }
    for (const c of order) for (let v = 0; v < c.v; v++) for (let hh = 0; hh < c.h; hh++) block(c, c === Y, i * c.h + hh, j * c.v + v);
    n++;
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const g = plane[y * PW + x], o = (y * w + x) * 4; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; }
  return { data: out, width: w, height: h };
}
