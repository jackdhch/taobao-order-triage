/*
 * invoice —— 发票这一块的纯逻辑（不碰网页，浏览器和 Node 共用）
 *
 *   - 税号（统一社会信用代码）校验：打错一位就会开出废票，填的时候就拦住
 *   - 认出发票文件：卖家在聊天里发的「dzfp_<20位发票号>_<抬头>_<开票时间>.pdf」这类
 *   - 分析和某个卖家的聊天：我们什么时候要过发票、之后对方发来了文件 / 图片（可能是二维码）/ 说发邮箱
 *   - 每单的发票状态：由「全部发票」页同步结果、聊天扫描结果、已下载记录合起来算
 *
 * 抬头、税号默认留空，由用户在「设置」里填；只存在本机。
 */
(function (root) {
  'use strict';

  // GB 32100-2015：18 位，前 17 位加权求和得校验位；字符集不含 I O S V Z
  const CODE_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const CODE_W = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  function taxIdOk(code) {
    code = String(code || '').trim().toUpperCase();
    if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(code)) return false;
    let s = 0;
    for (let i = 0; i < 17; i++) s += CODE_CHARS.indexOf(code[i]) * CODE_W[i];
    return CODE_CHARS[(31 - s % 31) % 31] === code[17];
  }

  // 开源版默认留空：每个人在「设置 → 发票信息」里填自己单位的抬头和税号
  const DEFAULT_TITLE = '', DEFAULT_TAX = '';
  // 用户 2026-10-03 亲手发给卖家的就是这一句（日期写成 26.8.14、金额用实付）；卖家常要邮箱，设置里填了才带上
  const DEFAULT_TEMPLATE = '您好，订单 {订单号}（{日期}，¥{金额}）需要开电子普通发票：抬头 {抬头}，税号 {税号}，邮箱 {邮箱}，内容按商品明细。'
    + '开好后麻烦直接把 PDF 文件发在这个聊天窗口，谢谢！';
  const shortDate = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? m[1].slice(2) + '.' + +m[2] + '.' + +m[3] : String(d || ''); };
  // v = { no, date, amount, title, taxId, email }，或 { orders: [{ no, date, amount }...], title, taxId, email }（同一家店几单合成一条）
  function renderMsg(tpl, v) {
    let s = String(tpl || DEFAULT_TEMPLATE);
    if (!v.email) s = s.replace(/[，,；;]?\s*邮箱[:：]?\s*\{邮箱\}/g, '');
    const os = v.orders || [{ no: v.no, date: v.date, amount: v.amount }];
    const one = o => o.no + '（' + shortDate(o.date) + '，¥' + o.amount + '）';
    // 模板里「{订单号}（{日期}，¥{金额}）」这一段，几单时换成「A（…）、B（…）」
    if (os.length > 1) s = s.replace(/\{订单号\}（\{日期\}，¥\{金额\}）/, os.map(one).join('、'));
    const map = { 订单号: os.map(o => o.no).join('、'), 日期: shortDate(os[0].date), 金额: os.length > 1 ? os.reduce((a, o) => a + (+o.amount || 0), 0).toFixed(2) : os[0].amount,
                  抬头: v.title, 税号: v.taxId, 邮箱: v.email };
    return s.replace(/\{(订单号|日期|金额|抬头|税号|邮箱)\}/g, (m, k) => map[k] == null ? '' : String(map[k]));
  }

  // 电子发票文件名。能认出发票号就用来去重；认不出但像发票（含「发票」、pdf/ofd）也算
  function parseInvoiceName(name) {
    const s = String(name || '');
    const m = /^(?:dzfp|fp)_(\d{8,20})_(.+?)_(\d{8,14})\.(pdf|ofd|xml)$/i.exec(s);
    if (m) return { invNo: m[1], title: m[2], time: m[3], ext: m[4].toLowerCase(), sure: true };
    const ext = (/\.(pdf|ofd|xml)$/i.exec(s) || [])[1];
    if (ext && /发票|fapiao|invoice|dzfp|^fp_|\d{20}/i.test(s)) return { invNo: (/\d{20}/.exec(s) || [])[0] || '', title: '', time: '', ext: ext.toLowerCase(), sure: false };
    return null;
  }

  // 聊天里的时间「2026-08-12 23:54:10」直接字符串比大小
  const ASK_RE = /发票|开票/;
  const EMAIL_RE = /邮箱|邮件|e-?mail|@[\w-]+\.\w+/i;
  /*
   * msgs: [{ self: bool, time, text, file: { name, size }, img: src }]，从旧到新
   * 返回 { asks: [{ time, text, nos }], files, images, email } —— asks 是我们要发票的消息（nos = 里面提到的订单号）；
   * files/images/email 只收我们第一次要发票之后对方发来的。从没要过的会话，文件只收明显是发票的（别把产品资料当发票）
   */
  function chatAnalyze(msgs, opts) {
    const taxId = opts && opts.taxId ? String(opts.taxId).toUpperCase() : '';
    const asks = msgs.filter(m => m.self && m.text && (ASK_RE.test(m.text) || (taxId && m.text.toUpperCase().includes(taxId))))
      // 消息里单独的 15~20 位数字当订单号：前后不能紧挨着字母数字（税号里那一长串数字不算），也排除税号本身
      .map(m => ({ time: m.time, text: m.text.slice(0, 200),
                   nos: (m.text.match(/(?<![0-9A-Za-z])\d{15,20}(?![0-9A-Za-z])/g) || []).filter(n => !taxId || !taxId.includes(n)) }));
    const since = asks.length ? asks[0].time : '';
    const after = msgs.filter(m => !m.self && (!since || m.time >= since));
    const files = after.filter(m => m.file && (since ? /\.(pdf|ofd|xml|zip)$/i.test(m.file.name) || parseInvoiceName(m.file.name) : parseInvoiceName(m.file.name)))
      .map(m => Object.assign({ time: m.time }, m.file, { parsed: parseInvoiceName(m.file.name) }));
    const images = since ? after.filter(m => m.img).map(m => ({ time: m.time, src: m.img })) : [];
    const email = since ? after.filter(m => m.text && EMAIL_RE.test(m.text)).map(m => ({ time: m.time, text: m.text.slice(0, 80) })) : [];
    return { asks, files, images, email };
  }

  /*
   * 一家店可能有好几单要发票、共用一个会话：把对方的回复分到具体某一单上。
   *   - 我们的消息里写了这单的订单号：这条之后、下一次要发票之前对方发来的，算这单的
   *   - 消息里没写订单号（比如手打的「需要发票」）：这家店只有这一单要发票就算它的；有好几单就标 shared，交给用户核对
   * 返回和 chatAnalyze 一样的结构，另加 shared（这些回复归哪单分不清）
   */
  function chatForOrder(a, no, shopOrders, orderTime) {
    if (!a) return null;
    // 只看这单下单之后的要发票：同一家店以前别的单要过的，不算到这单头上
    const d0 = String(orderTime || '').slice(0, 10);
    const asks = (a.asks || []).filter(k => !d0 || k.time.slice(0, 10) >= d0);
    const mine = asks.filter(k => k.nos.includes(no));
    const generic = asks.filter(k => !k.nos.length);
    let spans = [], shared = false, myAsks = mine;
    if (mine.length) {
      spans = mine.map(k => [k.time, (asks.find(x => x.time > k.time) || {}).time || '9999']);
    } else if (generic.length && !asks.some(k => k.nos.length && !k.nos.includes(no))) {
      spans = [[generic[0].time, '9999']];
      myAsks = generic;
      shared = (shopOrders || 1) > 1;
    } else if (generic.length) {
      // 这家店别的单用订单号要过；手打的那几次归不到这单，只在它们之后、下一次带号的要发票之前算「分不清」
      spans = generic.map(k => [k.time, (asks.find(x => x.time > k.time && x.nos.length) || {}).time || '9999']);
      myAsks = generic; shared = true;
    }
    const inSpan = m => spans.some(([s, e]) => m.time >= s && m.time < e);
    return { asks: myAsks, files: (a.files || []).filter(inSpan), images: (a.images || []).filter(inSpan), email: (a.email || []).filter(inSpan), shared };
  }

  /*
   * 每单发票状态。ctx = { plat: 「全部发票」同步到的这一单（或 undefined）, chat: 这家店的聊天分析, got: 已下载/已挂上的文件, refunded }
   *   key: have 已整理过（导入的发票索引里有）| done 已下载 | ready 已开票待下载 | applying 平台申请中 | apply 可平台申请 | ask 需找卖家 | asked 已要过、等回复
   *        | replied 卖家已回（文件/二维码/邮箱） | wrong 抬头或类型不对 | none 不需要（退款/关闭）
   */
  function status(ctx, want) {
    const p = ctx.plat, c = ctx.chat;
    if (ctx.refunded) return { key: 'none', label: '不需要（已退款/关闭）' };
    if (ctx.have) return { key: 'have', label: '已整理过', detail: '你的发票文件夹里已有：' + ctx.have.file };
    if (ctx.got && ctx.got.length) return { key: 'done', label: '已下载', detail: ctx.got.map(g => g.file).join('、') };
    if (p && p.tab === 'issued') {
      const bad = want && want.title && p.title && !p.title.includes(want.title);
      if (bad) return { key: 'wrong', label: '已开票，但抬头不对', detail: p.title + ' / ' + (p.type || '') };
      // 纸质发票页面上没有「下载到本地」，排进下载只会翻遍「已开具」也找不到；实物在卖家寄来的快递里
      if (p.canDownload === false) return { key: 'paper', label: '已开纸质发票（不能下载）', detail: (p.type || '') + (p.date ? ' · ' + p.date : '') + '，实物在快递里' };
      return { key: 'ready', label: '已开票·待下载', detail: (p.type || '') + (p.date ? ' · ' + p.date : '') };
    }
    if (p && p.tab === 'applying') return { key: 'applying', label: '平台' + (p.progress || '申请中'), detail: p.date || '' };
    const sh = c && c.shared ? '（这家店有几单都要发票，请核对是不是这单的）' : '';
    if (c && c.files && c.files.length) return { key: 'replied', label: '卖家发来了文件' + sh, detail: c.files.map(f => f.name).join('、'), shared: !!sh };
    if (c && c.images && c.images.length) return { key: 'replied', label: '卖家发来了图片（可能是二维码）' + sh, detail: c.images.length + ' 张', shared: !!sh };
    if (c && c.email && c.email.length) return { key: 'replied', label: '卖家提到邮箱' + sh, detail: c.email[0].text, shared: !!sh };
    if (c && c.asks && c.asks.length) return { key: 'asked', label: '已要过发票，等回复', detail: c.asks[c.asks.length - 1].time };
    if ((p && p.tab === 'unapplied') || ctx.canApply) return { key: 'apply', label: '可平台申请' };
    return { key: 'ask', label: '需找卖家' };
  }

  /*
   * 在导入的「已整理发票索引」里找这一单的发票（索引来自 tools/index-invoices.py：发票号码、开票日期、价税合计）
   *   - 平台已开的票：「全部发票」同步到了开票日期和金额，两样都对上才算
   *   - 别的（卖家发的）：金额对上、开票日期在下单后 180 天内，而且只有一张符合才算（金额撞车就不猜）
   */
  function findHave(idx, o, plat) {
    if (!idx || !idx.length) return null;
    if (plat && plat.tab === 'issued' && plat.date && plat.amount != null)
      return idx.find(x => x.date === plat.date && Math.abs(x.amount - plat.amount) < 0.005) || null;
    const d0 = String(o.time || '').slice(0, 10);
    if (!d0 || o.amount == null) return null;
    const end = new Date(new Date(d0).getTime() + 180 * 864e5).toISOString().slice(0, 10);
    const c = idx.filter(x => Math.abs(x.amount - o.amount) < 0.005 && x.date >= d0 && x.date <= end);
    return c.length === 1 ? c[0] : null;
  }

  /*
   * 从发票 PDF 抽出来的文字里认出号码、开票日期、价税合计、购买方是不是这个抬头。
   * PDF.js 抽出来常常是「先所有标签、后所有值」（2026-09 实测），标签后面不一定紧跟着值，所以不按标签找：
   *   号码 = 第一个单独的 20 位数字（全电发票号码 20 位；税号 18 位不会混进来）
   *   日期 = 第一个「某年某月某日」
   *   金额 = 最大的那个 ¥ 金额（价税合计不会比金额、税额小）
   */
  function parseInvoiceText(t, title) {
    const s = String(t || '');
    const flat = s.replace(/\s+/g, '');
    const d = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(flat);
    // 全电发票的 20 位号码前两位是开票年份（2026 年开的是 26…）。文字里可能还有别的 20 位数字（银行账号、老式税号、订单号），
    // 同一家店的几张发票会读成同一个「号码」、核对重复时被当成一张（2026-09 离线复现）：先挑年份对得上的
    const yy = d ? d[1].slice(2) : '';
    const twenty = x => { const all = x.match(/(?<!\d)\d{20}(?!\d)/g) || []; return all.find(n => yy && n.startsWith(yy)) || all[0]; };
    // 老式电子普票：12 位发票代码 + 8 位发票号码。有「发票代码」或「发票号码」后面紧跟 8 位的，就按老式读，别去抓文字里的 20 位账号
    const old = () => (/发票号码[:：]?(\d{8})(?!\d)/.exec(flat) || /(?<!\d)(?:\d{10}|\d{12})\s+(\d{8})(?!\d)/.exec(s) || [])[1];
    const isOld = /发票代码/.test(flat) || /发票号码[:：]?\d{8}(?!\d)/.test(flat);
    // 有的发票号码被拆成长短不一的几段、紧跟着开票年份（「2644…7289 1 361 2026 年」），去掉空白后是 24 位数字 + 年（2026-09 实测 3 张）
    const glued = () => (/(?<!\d)(\d{20})20\d{2}年/.exec(flat) || [])[1];
    // 「一个数字一个空格」逐字隔开的写法拼回去再找（别把号码和后面的年份拼成一串）
    const spaced = () => twenty(s.replace(/(?<![\d])(\d)\s(?=\d(?:\s\d|\D|$))/g, '$1'));
    const byYear = [twenty(s), spaced(), glued()].find(n => n && yy && n.startsWith(yy));
    const no = (isOld && old()) || byYear || twenty(s) || spaced() || glued() || old() || '';
    const amts = [...flat.matchAll(/[¥￥]([\d,]+\.\d{2})/g)].map(m => +m[1].replace(/,/g, ''));
    return { invNo: no, date: d ? d[1] + '-' + d[2].padStart(2, '0') + '-' + d[3].padStart(2, '0') : '',
             amount: amts.length ? Math.max(...amts) : null, isInvoice: /发票/.test(flat) && !!no,
             titleOk: title ? flat.includes(String(title).replace(/\s+/g, '')) : null };
  }

  /*
   * 下载的发票文件 → 核对它是不是文件名里那一单的（同一家店买过好几次时，卖家发的文件常常归错单）。
   *   pdfs:   [{ file, invNo, date: 'YYYY-MM-DD', amount, titleOk }]（parseInvoiceText 读出来的）
   *   orders: [{ no, shop, time, amount }]
   * 规则：价税合计 = 实付；开票日期不早于下单日期（淘宝页面上的时间可能差几天，放宽 3 天）、不晚于下单后 180 天。
   * 返回每个文件一条：
   *   ok     对得上
   *   move   不是文件名那单的；同店另一单金额、日期都对得上（只有一单符合）→ to
   *   merged 同店几单的实付加起来等于这张票（卖家合开）→ nos
   *   many   同店有好几单都对得上，分不清
   *   old    开票日期比下单还早：是以前别的单的票
   *   more   票面比实付多一点（不超过 3 成）、日期对：多半是按优惠前的价开的，算这单的
   *   amount 金额对不上，同店也找不到
   *   title  抬头不是你的单位
   *   none   文件名里没有订单号
   */
  function checkFiles(pdfs, orders) {
    const SLACK = 3, LATE = 180;
    const day = s => Date.parse(String(s || '').slice(0, 10) + 'T00:00:00Z') / 864e5;
    const byNo = new Map(orders.map(o => [String(o.no), o]));
    const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;
    const dateOk = (inv, o) => !inv.date || !o.time || (day(inv.date) >= day(o.time) - SLACK && day(inv.date) <= day(o.time) + LATE);
    return pdfs.map(f => {
      const no = (String(f.file).match(/\d{15,20}/g) || []).find(n => byNo.has(n));
      const o = no && byNo.get(no);
      const base = { file: f.file, no: no || '', amount: f.amount, date: f.date, invNo: f.invNo };
      if (f.titleOk === false) return Object.assign(base, { kind: 'title' });
      if (!o) return Object.assign(base, { kind: 'none' });
      if (eq(f.amount, o.amount) && dateOk(f, o)) return Object.assign(base, { kind: 'ok' });
      const same = orders.filter(x => x.shop === o.shop && dateOk(f, x));
      const hit = same.filter(x => eq(f.amount, x.amount));
      if (hit.length === 1) return Object.assign(base, { kind: 'move', to: hit[0].no });
      if (hit.length > 1) return Object.assign(base, { kind: 'many', nos: hit.map(x => x.no) });
      // 卖家把同店几单合在一张票里：两三单加起来等于票面
      const pool = same.slice(0, 12);
      for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
        if (eq(f.amount, pool[i].amount + pool[j].amount)) return Object.assign(base, { kind: 'merged', nos: [pool[i].no, pool[j].no] });
        for (let k = j + 1; k < pool.length; k++)
          if (eq(f.amount, pool[i].amount + pool[j].amount + pool[k].amount)) return Object.assign(base, { kind: 'merged', nos: [pool[i].no, pool[j].no, pool[k].no] });
      }
      if (f.date && o.time && day(f.date) < day(o.time) - SLACK) return Object.assign(base, { kind: 'old' });
      // 票面比实付多一点：平台常按用券、补贴之前的价开（2026-10 实测：实付 10.00，票面 10.50）
      if (dateOk(f, o) && f.amount > o.amount && f.amount <= o.amount * 1.3) return Object.assign(base, { kind: 'more' });
      return Object.assign(base, { kind: 'amount' });
    });
  }

  /*
   * 已整理的发票 → 订单，一对一（2026-10-04 导入几批已整理的发票后实测：两单同价抢同一张票、平台正在申请的一单
   * 被认成另一张同价的票）：
   *   - 一张票只能算一单的，一单也只认一张；几单抢一张、或一单对上几张，都不猜，放进 contested 交给用户核对
   *   - 平台已开的按开票日期 + 金额对；平台正在申请的不按金额猜（它的票还在路上）
   *   orders: [{ no, time, amount }]，platOf(no) → 「全部发票」同步到的这一单
   * 返回 { have: Map(no → 那张票), contested: Map(no → 候选的几张票) }
   */
  function matchHave(idx, orders, platOf) {
    const have = new Map(), contested = new Map();
    if (!idx || !idx.length) return { have, contested };
    const eq = (a, b) => Math.abs(a - b) < 0.005;
    const cand = new Map(), claims = new Map();
    for (const o of orders) {
      const p = platOf ? platOf(o.no) : null;
      let c = [];
      if (p && p.tab === 'issued' && p.date && p.amount != null) c = idx.filter(x => x.date === p.date && eq(x.amount, p.amount));
      else if (!(p && p.tab === 'applying')) {
        const d0 = String(o.time || '').slice(0, 10);
        if (d0 && o.amount != null) {
          const end = new Date(new Date(d0).getTime() + 180 * 864e5).toISOString().slice(0, 10);
          c = idx.filter(x => eq(x.amount, o.amount) && x.date >= d0 && x.date <= end);
        }
      }
      if (!c.length) continue;
      cand.set(o.no, c);
      for (const x of c) claims.set(x.invNo, (claims.get(x.invNo) || 0) + 1);
    }
    for (const [no, c] of cand) {
      if (c.length === 1 && claims.get(c[0].invNo) === 1) have.set(no, c[0]);
      else contested.set(no, c);
    }
    return { have, contested };
  }

  /*
   * 订单详情页的文字 → 几件商品、几件退款成功（2026-10-04 实测：每件商品后面是「…售后成功 退款成功 平台支持退款 ￥34.65 ￥35.00 x1」，
   * 订单状态仍是「交易成功」，所以订单表看不出来）。refunded = 每一件都退款成功
   */
  //   部分退款时「退款成功」后面跟着退款金额：「…申请售后 退款成功 支付宝¥20.00 ￥10.00 ￥10.50 x3」（2026-10-05 实测，金额这里是虚构的：
  //   买 3 个单价 10.00，退了 20.00 = 2 个）。lines 按页面顺序给出每件：单价、数量、退了几个；没写退款金额的退款成功算整件退
  function detailRefund(text) {
    const t = String(text || '').replace(/\s+/g, ' ');
    const money = s => +String(s).replace(/,/g, '');
    const lines = [];
    const re = /[￥¥]([\d,]+\.\d{2})(?: [￥¥][\d,]+\.\d{2})? x(\d+)/g;
    let m, prev = 0;
    while ((m = re.exec(t))) {
      const seg = t.slice(prev, m.index), unit = money(m[1]), qty = +m[2];
      prev = m.index + m[0].length;
      let refundedQty = 0;
      if (/退款成功/.test(seg)) {
        const a = /退款成功[^￥¥]{0,12}[￥¥]([\d,]+\.\d{2})/.exec(seg);
        refundedQty = a && unit > 0 ? Math.max(0, Math.min(qty, Math.round(money(a[1]) / unit))) : qty;
      }
      lines.push({ unit, qty, refundedQty });
    }
    const items = lines.length;
    return { items, refundedItems: lines.filter(l => l.refundedQty > 0).length,
             refunded: items > 0 && lines.every(l => l.refundedQty >= l.qty), lines };
  }

  // 下载后的文件名：日期_金额_店铺_订单号.pdf（Windows 不允许的字符换掉）
  function saveName(o, ext) {
    const clean = s => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 24);
    return [String(o.time || '').slice(0, 10), o.amount != null ? String(o.amount) : '', clean(o.shop), o.no].filter(Boolean).join('_') + '.' + (ext || 'pdf');
  }

  const api = { taxIdOk, DEFAULT_TITLE, DEFAULT_TAX, DEFAULT_TEMPLATE, renderMsg, parseInvoiceName, chatAnalyze, chatForOrder, status, findHave, matchHave, detailRefund, parseInvoiceText, saveName, checkFiles };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Invoice = api;
})(typeof self !== 'undefined' ? self : this);
