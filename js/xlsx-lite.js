/*
 * xlsx-lite —— 只读、零依赖的 xlsx / csv 表格读取器
 *
 * 只用浏览器（或 Node 18+）自带的 DecompressionStream 解 zip，不加载任何外部库，
 * 也不发出任何网络请求。只读取第一个工作表的单元格文本，不处理公式、样式和日期序列号。
 *
 * API:  TableReader.read(arrayBuffer, fileName) -> Promise<string[][]>
 */
(function (root) {
  'use strict';

  async function inflateRaw(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // 读 zip 中央目录，返回 文件名 -> { method, data(压缩数据) }
  function readZip(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('这不是有效的 xlsx 文件（找不到 zip 目录）');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const files = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      files.set(name, { method, data: u8.subarray(start, start + csize) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  async function entryText(files, name) {
    const f = files.get(name);
    if (!f) return null;
    let raw;
    if (f.method === 0) raw = f.data;
    else if (f.method === 8) raw = await inflateRaw(f.data);
    else throw new Error('不支持的 zip 压缩方式：' + f.method);
    return new TextDecoder().decode(raw);
  }

  function decodeXml(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
    });
  }

  // 一段 XML 里所有 <t> 的文本拼起来（共享字符串可能被拆成多个富文本 run）
  function allT(xml) {
    let out = '';
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let m;
    while ((m = re.exec(xml))) out += decodeXml(m[1]);
    return out;
  }

  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref);
    let n = 0;
    for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64);
    return n - 1;
  }

  async function readXlsx(buf) {
    const files = readZip(buf);
    const shared = [];
    const ss = await entryText(files, 'xl/sharedStrings.xml');
    if (ss) {
      const re = /<si>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = re.exec(ss))) shared.push(allT(m[1]));
    }
    const sheets = [...files.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    if (!sheets.length) throw new Error('xlsx 里没有工作表');
    const xml = await entryText(files, sheets[0]);
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const row = [];
      let cm;
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1], body = cm[2] || '';
        const r = /\br="([A-Z]+\d+)"/.exec(attrs);
        const t = (/\bt="(\w+)"/.exec(attrs) || [])[1];
        let v = '';
        if (t === 'inlineStr') v = allT(body);
        else {
          // <v> 可能带属性：Excel 给首尾有空格的文字写 <v xml:space="preserve">，只认裸 <v> 会把整格读成空、整单丢掉（2026-10 实测）
          const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
          v = vm ? decodeXml(vm[1]) : '';
          if (t === 's') v = shared[parseInt(v, 10)] || '';
        }
        row[r ? colIndex(r[1]) : row.length] = v;
      }
      for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
      rows.push(row);
    }
    return rows;
  }

  // CSV：先按 UTF-8 解，出现乱码替换符就改用 GB18030（淘宝早期导出常见）
  function readCsv(buf) {
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) {
      try { text = new TextDecoder('gb18030').decode(buf); } catch (e) { /* 环境不支持就保留 utf-8 */ }
    }
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    // 淘宝 CSV 常把长数字写成 ="5127..." 防止科学计数法
    return rows.map(r => r.map(v => v.replace(/^="(.*)"$/, '$1').trim()));
  }

  async function read(buf, fileName) {
    const u8 = new Uint8Array(buf.slice ? buf.slice(0, 4) : buf);
    const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
    if (isZip || /\.xlsx$/i.test(fileName || '')) return readXlsx(buf);
    return readCsv(buf);
  }

  const api = { read, readXlsx, readCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TableReader = api;
})(typeof self !== 'undefined' ? self : this);
