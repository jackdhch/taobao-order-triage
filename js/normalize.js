/*
 * normalize —— 把各种来源的订单表整理成统一结构
 *
 *   Order { no, time, status, shop, pay, ship, source, lines: Line[] }
 *   Line  { id, title, sku, qty, price, link, img, refund }
 *
 * 支持：
 *   - 淘宝「导出订单」xlsx/csv（一单多件时，后续行订单号为空，自动并入上一单）
 *   - 每行都重复订单号的表格（按订单号归并）
 *   - scraper/taobao-scraper.js 抓下来的 JSON（带商品图和逐件退款状态）
 */
(function (root) {
  'use strict';

  // 列名别名。先精确匹配，再做包含匹配。别人的导出列名不同，往这里加即可。
  const ALIASES = {
    no:     ['订单号', '订单编号', '主订单编号', '订单ID', '订单id'],
    time:   ['订单提交时间', '下单时间', '订单创建时间', '创建时间', '成交时间', '付款时间'],
    status: ['订单状态', '交易状态'],
    shop:   ['店铺名称', '店铺', '卖家昵称', '卖家', '商家'],
    title:  ['商品名称', '宝贝标题', '商品标题', '宝贝名称', '标题'],
    link:   ['商品链接', '宝贝链接', '链接'],
    sku:    ['型号款式', '商品属性', '颜色分类', 'SKU', '规格', '款式'],
    qty:    ['商品数量', '购买数量', '宝贝数量', '数量'],
    price:  ['商品金额', '商品单价', '单价', '价格'],
    pay:    ['实付金额', '实付款', '买家实际支付金额', '实际支付金额', '支付金额'],
    ship:   ['运费', '邮费'],
    img:    ['商品图片', '主图', '图片链接', '图片'],
    refund: ['退款状态', '售后状态'],
  };

  // 每件商品的稳定标识：订单号 + 标题 + 规格。重新导入同一订单时，之前的判断能对上
  function assignKeys(o) {
    const seen = {};
    for (const l of o.lines) {
      let k = o.no + '|' + norm(l.title).slice(0, 48) + '|' + norm(l.sku).slice(0, 24);
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] > 1) k += '|' + seen[k];
      l.key = k;
    }
    return o;
  }

  // 时间统一成「YYYY-MM-DD HH:MM:SS」：自动翻页靠它和页面日期比大小。
  // 别人的导出可能是「2026/5/21 10:00」，或 xlsx 里没设格式的日期序号（45798.41）
  function normTime(v) {
    const s = String(v == null ? '' : v).trim();
    let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*(.*)$/.exec(s);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') + (m[4] ? ' ' + m[4] : '');
    if (/^\d{5}(\.\d+)?$/.test(s) && +s > 20000 && +s < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(+s * 86400) * 1000);
      return d.toISOString().slice(0, 19).replace('T', ' ');
    }
    return s;
  }

  function money(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/[￥¥,\s元]/g, '');
    if (s === '' || isNaN(+s)) return null;
    return Math.round(+s * 100) / 100;
  }

  function mapHeader(header) {
    const idx = {};
    const h = header.map(x => String(x || '').trim());
    for (const [key, names] of Object.entries(ALIASES)) {
      let i = -1;
      for (const n of names) { i = h.indexOf(n); if (i >= 0) break; }
      if (i < 0) for (const n of names) { i = h.findIndex(x => x && x.includes(n)); if (i >= 0) break; }
      if (i >= 0) idx[key] = i;
    }
    return idx;
  }

  function findHeaderRow(rows) {
    for (let r = 0; r < Math.min(rows.length, 20); r++) {
      const idx = mapHeader(rows[r]);
      if ('title' in idx && Object.keys(idx).length >= 3) return { r, idx };
    }
    throw new Error('未找到表头：至少需包含「商品名称/宝贝标题」及另外两列（订单号、实付金额等）');
  }

  function rowsToOrders(rows) {
    const { r: hr, idx } = findHeaderRow(rows);
    const get = (row, k) => (k in idx ? String(row[idx[k]] ?? '').trim() : '');
    const byNo = new Map();
    const order = [];
    let cur = null, anon = 0;
    for (let r = hr + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every(v => String(v || '').trim() === '')) continue;
      const no = get(row, 'no');
      if (no) {
        cur = byNo.get(no);
        if (!cur) {
          cur = { no, time: normTime(get(row, 'time')), status: get(row, 'status'), shop: get(row, 'shop'),
                  pay: money(get(row, 'pay')), ship: money(get(row, 'ship')), source: 'export', lines: [] };
          byNo.set(no, cur); order.push(cur);
        }
      } else if (!cur) {                    // 没有订单号列的表：每行当一单
        cur = { no: 'row-' + (++anon), time: normTime(get(row, 'time')), status: get(row, 'status'), shop: get(row, 'shop'),
                pay: money(get(row, 'pay')), ship: money(get(row, 'ship')), source: 'export', lines: [] };
        byNo.set(cur.no, cur); order.push(cur);
      }
      const title = get(row, 'title');
      if (!title) continue;
      cur.lines.push({
        id: cur.no + '#' + cur.lines.length,
        title, sku: get(row, 'sku'), link: get(row, 'link'), img: get(row, 'img'),
        qty: parseInt(get(row, 'qty'), 10) || 1, price: money(get(row, 'price')),
        refund: get(row, 'refund'),
      });
      if (!('no' in idx)) cur = null;
    }
    // 表里有订单号、却一件商品都没读出来的单：不能悄悄丢掉，交给页面明确告诉用户是哪几单
    const out = order.filter(o => o.lines.length).map(assignKeys);
    out.dropped = order.filter(o => !o.lines.length && !/^row-/.test(o.no)).map(o => o.no);
    return out;
  }

  // 每件商品的「实付估算」：按 单价×数量 把整单实付摊到各件（含优惠/运费的摊销）
  function lineShares(o) {
    const base = o.lines.map(l => (l.price || 0) * (l.qty || 1));
    const sum = base.reduce((a, b) => a + b, 0);
    const pay = o.pay != null ? o.pay : sum;
    return o.lines.map((l, i) => Math.round((sum > 0 ? pay * base[i] / sum : pay / o.lines.length) * 100) / 100);
  }

  const norm = s => String(s || '').replace(/[\s【】\[\]（）()「」,，。.:：;；!！?？/\\|*+\-_~·]/g, '').toLowerCase();

  // 两个标题的相似度：公共前缀长度 + 共同字符比例
  function titleSim(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    const set = new Set(b);
    let common = 0;
    for (const c of a) if (set.has(c)) common++;
    return p * 2 + common / Math.max(a.length, 1) * 10;
  }

  // 按标题相似度把 src 的每件配到 lines 的每件上，补图片/退款/链接；返回配上的 [src 件, lines 件]
  function fillLines(lines, src) {
    const free = src.slice(), pairs = [];
    for (const l of lines) {
      let best = -1, bs = -1, bk = -1;
      // 同一个商品买了几个规格时标题一样：标题打平再按规格分，不然退款、图片会贴到另一个规格上（2026-09 离线复现）
      free.forEach((c, j) => {
        if (!c) return;
        const v = titleSim(l.title, c.title), k = l.sku && c.sku ? titleSim(l.sku, c.sku) : 0;
        if (v > bs || (v === bs && k > bk)) { bs = v; bk = k; best = j; }
      });
      if (best < 0) continue;
      const c = free[best];
      free[best] = null; pairs.push([c, l]);
      if (c.img && !l.img) l.img = c.img;
      if (c.refund) l.refund = c.refund;
      if (c.link && !l.link) l.link = c.link;
    }
    return pairs;
  }

  // 把抓取数据并进导出数据：以导出表为准，同订单号的只补图片、退款文字、链接。
  // 导出表里没有的订单默认忽略（抓取可能多翻了页）；只有完全没有导出表时（addNew）才用抓取数据建单
  function mergeScraped(orders, scraped, opts) {
    const addNew = !!(opts && opts.addNew);
    // 淘宝只能导出最近几个月的订单表：订单表之前、用户要的那段（addRange = { from, before }）按订单页上读到的建单。
    // 下界也要看：存储里可能留着更早的抓取数据（没订单表时抓的全部、以前填得更早的）
    const ar = opts && opts.addRange;
    const byNo = new Map(orders.map(o => [o.no, o]));
    let matched = 0, added = 0, skipped = 0, filled = 0, unmatched = 0;
    for (const s of scraped) {
      if (!s || !s.no || !Array.isArray(s.lines)) continue;
      const o = byNo.get(s.no);
      const day = normTime(s.time || s.date || '').slice(0, 10);
      if (!o && !addNew && !(ar && day && day >= ar.from && day < ar.before)) { skipped++; continue; }
      if (!o) {
        const n = { no: s.no, time: normTime(s.time || s.date || ''), status: s.status || '', shop: s.shop || '',
                    pay: money(s.pay), ship: money(s.ship), source: 'scrape', lines: [] };
        if (s.inv !== undefined) n.inv = s.inv;
        if (s.nick) n.nick = s.nick;
        if (!addNew) n.older = true;                        // 用户要的「订单表之前」那段：再导入订单表时要留着
        s.lines.forEach((l, i) => n.lines.push({
          id: s.no + '#' + i, title: l.title || '', sku: l.sku || '', link: l.link || '', img: l.img || '',
          qty: parseInt(l.qty, 10) || 1, price: money(l.price), refund: l.refund || '' }));
        if (n.lines.length) { assignKeys(n); orders.push(n); byNo.set(n.no, n); added++; }
        continue;
      }
      matched++;
      if (s.inv !== undefined) o.inv = s.inv;              // 订单页操作栏的开票按钮文字，发票栏用来判断能不能平台开票
      if (s.nick) o.nick = s.nick;                         // 卖家旺旺名：找聊天会话、开聊天页用
      if (s.status && !o.status) o.status = s.status;
      if (s.status && s.status !== o.status) o.statusLive = s.status;
      else if (s.status) delete o.statusLive;                // 订单页和订单表又一致了（比如后来都交易关闭了）
      const noImg = o.lines.filter(l => !l.img).length;
      unmatched += o.lines.length - fillLines(o.lines, s.lines).length;
      filled += noImg - o.lines.filter(l => !l.img).length;
    }
    return { matched, added, skipped, filled, unmatched };
  }

  // 还缺图的订单（任一件没图就算），给抓取脚本当清单用；from 是其中最早的日期，脚本翻到比它更早就停
  function missingImages(orders) {
    const miss = orders.filter(o => o.lines.some(l => !l.img));
    const dates = miss.map(o => (o.time || '').slice(0, 10)).filter(Boolean).sort();
    return { nos: miss.map(o => o.no), from: dates[0] || '' };
  }

  // 退款判断：逐件退款文字优先；整单「交易关闭」视为全单关闭（可能是退款，也可能是取消）
  function refundState(line, order) {
    const t = String(line.refund || '');
    if (/退款成功|已退款|退货退款成功|售后成功|退款完成/.test(t)) return 'refunded';
    if (/退款中|售后中|处理中|待商家|待买家退货/.test(t)) return 'refunding';
    if (/交易关闭/.test(order.statusLive || order.status || '')) return 'closed';
    return '';
  }

  // 新导入的导出表并进已有订单：新订单加入；已有订单更新状态/实付，保留图片和退款信息。
  // 返回的 keyMap（旧 key → 新 key）给界面把手动判断挪过去：按抓取数据建的单，标题写法和订单表不同，key 会变
  function mergeExport(orders, incoming) {
    const byNo = new Map(orders.map(o => [o.no, o]));
    let added = 0, updated = 0;
    const keyMap = {};
    for (const n of incoming) {
      const o = byNo.get(n.no);
      if (!o) { orders.push(n); byNo.set(n.no, n); added++; continue; }
      updated++;
      if (n.status && n.status !== o.status) delete o.statusLive;   // 新导出的表更新了状态：以前在订单页上读到的旧状态作废
      o.status = n.status || o.status;
      if (n.pay != null) o.pay = n.pay;
      if (n.ship != null) o.ship = n.ship;
      if (o.source === 'scrape') {
        for (const [p, l] of fillLines(n.lines, o.lines)) if (p.key !== l.key) keyMap[p.key] = l.key;
        o.lines = n.lines; o.source = 'export';
      } else {
        const old = new Map(o.lines.map(l => [l.key, l]));
        o.lines = n.lines.map(l => {
          const p = old.get(l.key);
          if (p) { l.img = l.img || p.img; l.refund = l.refund || p.refund; l.link = l.link || p.link; }
          return l;
        });
      }
    }
    return { added, updated, keyMap };
  }

  const api = { ALIASES, money, normTime, fillLines, mapHeader, rowsToOrders, lineShares, mergeScraped, missingImages, mergeExport, refundState,
                titleSim, norm, assignKeys };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Normalize = api;
})(typeof self !== 'undefined' ? self : this);
