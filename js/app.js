/* 订单分拣 —— 界面与状态。全部在本机浏览器内运行。 */
(function () {
  'use strict';
  const N = window.Normalize, C = window.Classify, T = window.TableReader, I = window.Invoice, Z = window.Zip, RB = window.Reimburse, OF = window.Office;
  const STORE = 'orderTriage.app.v1';
  // 作为 Chrome 扩展主页打开时：缺图清单写给淘宝页，淘宝页抓到的数据从扩展存储自动并进来
  const EXT = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.runtime && chrome.runtime.id);
  const TAOBAO = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = n => String(n).padStart(2, '0');
  const yuan = n => n == null ? '—' : '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── 状态 ──
  // person：报销人姓名、学号（工程师没有学号，可空；整理报销文件的文件夹名、README.txt 用）
  // lowval：用户点标签确认过的「是不是低值品」，按商品标题（N.norm）记 'low' / 'no'，同名商品以后自动沿用
  // batches：每次整理报销文件记一批（和导入时认出的历史批次），含到账记录 pays，见「报销记录」
  let S = { orders: [], decisions: {}, refunds: {}, rules: null, prefs: { autoNext: true, sort: 'desc' },
            invoice: { title: I.DEFAULT_TITLE, taxId: I.DEFAULT_TAX, template: '', email: '' }, invFiles: {}, haveIdx: [],
            person: { name: '', sid: '' }, lowval: {}, batches: [] };
  // 扩展存储里淘宝页读回来的发票数据：全部发票同步结果、旺旺扫描结果、已下载记录（只在扩展里有）
  // cardApplied：按卖家开票卡片提交过申请的单（extension/apply-card.js 记）；cardResult：每单按卡片申请的结果；qrFail：二维码发票核对没通过的
  // attDone：从旺旺下载的附件（3D 打印明细表格等，background.js 记）
  const X = { invSync: null, chatScan: null, dlDone: {}, cardApplied: {}, cardResult: {}, qrFail: {}, attDone: {} };
  const XKEYS = ['invSync', 'chatScan', 'dlDone', 'askSent', 'vipSent', 'goneNos', 'cardApplied', 'cardResult', 'qrFail', 'attDone'];
  const XEMPTY = k => k === 'goneNos' ? [] : ['invSync', 'chatScan'].includes(k) ? null : {};
  // step：用户点开的那一步（null = 当前该做的那一步）；list：下方显示商品列表还是发票表（renderSummary 按显示的那一步定）
  // cat：第 2 步「核对商品」的分类筛选（null = 按默认）；sortStep：下方列表现在是不是第 2 步的
  const view = { q: '', focus: null, step: null, list: 'goods', cat: null, sortStep: false };
  let derived = null;           // 每次数据/判断变化后重算
  let undoStack = [];
  let restoring = false;        // 正在从备份恢复：页面马上刷新，期间不再写存储，免得旧数据盖掉刚恢复的

  function persist() {
    if (restoring) return;
    try { localStorage.setItem(STORE, JSON.stringify(S)); }
    catch (e) { toast('本机存储写入失败，可能是浏览器存储空间不足'); }
  }
  // 网页版「补充图片 → 复制抓取脚本」带的缺图清单。还没有任何订单时给 null，脚本就抓看到的全部订单来建单。
  // 扩展版只从主页「读取订单」发起，淘宝页按 readJob 全部读（extension/taobao.js），不用这份清单
  function wantList() {
    const table = S.orders.filter(o => !/^示例-/.test(o.no));
    if (!table.length) return null;
    const r = olderRange(), w = N.missingImages(table);
    // 过后还可能退款的单：没确认收货的、有件在退款中的、30 天内交易成功的（确认收货后的售后大多在这段时间）。
    // 已经有图也让淘宝页回来看看，不然之后的退款永远进不来；更早的不自动回看，要改就按 R 手动标
    const recent = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const live = table.filter(o => { const st = o.statusLive || o.status || '';
      if (derived && !o.lines.some(l => { const x = derived.byKey.get(l.key); return x && effCat(x) !== 'personal'; })) return false;   // 个人用品不回看
      return !/交易关闭/.test(st) && (!/交易成功/.test(st) || (o.time || '').slice(0, 10) >= recent || o.lines.some(l => N.refundState(l, o) === 'refunding')); });
    // 要找卖家、却还不知道卖家旺旺名的单（之前补图时还没记旺旺名）：让淘宝页回去看一眼，补上旺旺名
    const noNick = derived ? invOrders().filter(x => !x.o.nick && needsChat(invStatus(x))).map(x => x.o) : [];
    live.push(...noNick.filter(o => !live.includes(o)));
    if (live.length) {
      w.refresh = live.map(o => o.no);
      const d = live.map(o => (o.time || '').slice(0, 10)).filter(Boolean).sort()[0];
      if (d && (!w.from || d < w.from)) w.from = d;
    }
    return Object.assign(w, r ? { older: r } : {});
  }
  // 淘宝只能导出最近几个月的订单表：用户填了「提取到哪天」，订单表最早日期之前、那天及以后的订单从订单页上读来建单
  const tableFirst = () => S.orders.filter(o => o.source !== 'scrape').map(o => (o.time || '').slice(0, 10)).filter(Boolean).sort()[0] || '';
  function olderRange() {
    const first = tableFirst();
    return S.older && first && S.older < first ? { from: S.older, before: first } : null;
  }
  // 给发票页、旺旺页的范围：要报销的实验室订单（没退款），和本机设置的抬头税号
  // chat：只给旺旺页「还需要卖家回复」的单（需找卖家 / 已要过 / 卖家回了还没下）——打开会话会让对方看到已读，
  // 已经开好票、平台申请中、已下载的店就别去打开了
  // 还要卖家回复的单（旺旺要看的范围）：需向卖家索要 / 已索要 / 卖家已回 / 卖家发来开票卡片 / 已索要后又找客服督促过的
  const needsChat = st => ['ask', 'asked', 'replied', 'card', 'chatfail'].includes(st.key) || (st.key === 'urged' && st.base === 'asked');
  // 试用的示例订单（「示例-」开头，全部虚构）：只看界面，不去淘宝页面上处理（以前点「自动处理发票」会为虚构订单打开真实的淘宝页）
  const isSample = no => /^示例-/.test(no);
  const hasSample = () => S.orders.some(o => isSample(o.no));
  const SAMPLE_TIP = '示例数据仅供试用界面，不处理发票；读取真实订单后可用';
  function invWant() {
    if (!derived) return null;
    const list = invOrders().filter(x => !isSample(x.o.no));
    const pick = xs => xs.map(x => ({ no: x.o.no, shop: x.o.shop, nick: x.o.nick || '', time: x.o.time, amount: x.o.pay }));
    const first = xs => xs.map(x => (x.o.time || '').slice(0, 10)).filter(Boolean).sort()[0] || '';
    const chat = list.filter(x => needsChat(invStatus(x)));
    // st：这单现在的状态。还没联系过卖家的（ask）找不到会话是正常的，旺旺页不把它算成「未能读取」
    return { orders: pick(list), since: first(list), chat: pick(chat).map((o, i) => Object.assign(o, { st: invStatus(chat[i]).key })), chatSince: first(chat),
             title: S.invoice.title, taxId: S.invoice.taxId };
  }
  function mergeFromExt(scraped) {
    const list = Object.values(scraped || {});
    if (!list.length) return;
    const none = !S.orders.length;
    // 读过的日期范围（S.readFrom 起）里、主页还没有的订单按订单页建单；从没读过时沿用旧规则（没有订单时全建、「订单表之前」那段）
    const rr = readRange();
    const r = N.mergeScraped(S.orders, list, { addNew: none && !rr, addRange: rr || olderRange() });
    if (!r.matched && !r.added) return;
    persist(); derive(); render();
    // 读取订单期间每翻一页并一次，进度在第 1 步里显示，不逐页弹提示
    if ((r.filled || r.added) && !readBusy()) toast('已从淘宝订单页' + (r.added ? '新增 ' + r.added + ' 单' : '') + (r.added && r.filled ? '，' : '') + (r.filled ? '补充图片 ' + r.filled + ' 件' : ''));
  }
  // 淘宝页翻完了订单表之前的那段：过去的订单不会再变，清掉「提取到哪天」，以后补图找齐就停，不用每次翻回去（要刷新再填一次）
  function olderFinished(d) {
    if (!d) return;
    chrome.storage.local.remove('olderDone');         // 用过就删：留着的话，用户重新填同一天，主页一刷新又被这个旧信号清掉
    if (!S.older || d.from !== S.older) return;
    S.older = ''; persist();
    toast('订单表之前的订单已提取至 ' + d.from + '；此后补图不再回溯，如需重新提取请再次填写日期');
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.orders)) S = Object.assign(S, d);
      S.person = S.person || { name: '', sid: '' }; S.lowval = S.lowval || {}; S.batches = S.batches || [];
    } catch (e) { /* 私密窗口等情况下读不到，当作空白开始 */ }
  }
  // 词表写死在代码里（设置里的词表编辑已删）；以前保存的自定义词表不再使用
  const rules = () => C.DEFAULT_RULES;

  // 上次报销到哪天（S.since = 'YYYY-MM-DD'）：读取对话框里唯一要填的日期（用户 2026-10-07：主线一条线，不再有单独的「上次报销截止点」一步）。
  // 只读这天之后的订单；这天及以前的旧订单（以前读过、导入过的）不再判断。
  // 以前版本存的 'none'（从第一单开始）、空（按已整理发票自动识别）都当作没有截止日。
  // guess：导入过已整理的发票时，对得上的订单里最晚的一天，只用作读取对话框的默认值
  function sinceInfo() {
    if (/^\d{4}-\d{2}-\d{2}$/.test(S.since || '')) return { mode: 'date', at: S.since + '~', date: S.since };   // '~' 排在时分秒后面，当天的单都算「以前」
    let best = null;
    for (const o of S.orders) if (o.time && haveOf(o) && (!best || o.time > best.time)) best = o;
    return { mode: 'unknown', guess: best ? best.time.slice(0, 10) : '' };
  }
  // 这单是不是已经有本单位抬头的发票（平台已开、整理过、下载过、申请中）：有的话多半是实验室的东西
  function invoicedFor(o) {
    const p = platOf(o);
    if (p && p.tab === 'issued' && (!S.invoice.title || !p.title || p.title.includes(S.invoice.title))) return '已开具「' + (S.invoice.title || '本单位') + '」抬头的发票';
    if (haveOf(o)) return '在已整理的发票中';
    if ((X.dlDone[o.no] || []).length || (S.invFiles[o.no] || []).length) return '已下载发票';
    if (p && p.tab === 'applying') return '已申请发票';
    return '';
  }

  // ── 派生：分类结果、摊分金额、退款状态 ──
  function derive() {
    const titleMemory = new Map(), shopMemory = new Map();
    const byKey = new Map();
    for (const o of S.orders) for (const l of o.lines) byKey.set(l.key, { o, l });
    for (const [k, cat] of Object.entries(S.decisions)) {
      const hit = byKey.get(k);
      if (!hit || (cat !== 'lab' && cat !== 'personal')) continue;
      if (C.isSurcharge(hit.l.title)) continue;        // 补差价链接的判断不推给同店、同名商品
      titleMemory.set(N.norm(hit.l.title), cat);
      const m = shopMemory.get(hit.o.shop) || { lab: 0, personal: 0 };
      m[cat]++; shopMemory.set(hit.o.shop, m);
    }
    const ctx = { compiled: C.compile(rules()), norm: N.norm, titleMemory, shopMemory };
    const results = C.classifyAll(S.orders, ctx);
    const rows = [];
    const since = sinceInfo();
    for (const o of S.orders) {
      const shares = N.lineShares(o);
      const past = !!(since.at && (o.time || '') <= since.at);       // 上次报销那天及以前：不再判断
      const inv = invoicedFor(o);
      o.lines.forEach((l, i) => {
        const manual = S.decisions[l.key];
        let a = results.get(l.id);
        // 这单已经开过抬头是本单位的发票：多半是给实验室买的。规则判个人的改成待定，没认出来的改成实验室
        if (!manual && inv && a.cat !== 'lab' && a.via !== 'surcharge')
          a = Object.assign({}, a, a.cat === 'personal'
            ? { cat: 'unsure', via: 'invoice', why: '关键词判为个人，但本单' + inv + '，需确认' }
            : { cat: 'lab', via: 'invoice', why: '本单' + inv });
        const r = manual ? { cat: manual, via: 'manual', why: '手动判断', hits: a.hits } : a;
        const d = lineDue(o, l, shares[i]);
        // 低值品（js/reimburse.js lowJudge）：按件的单价；发票明细只在这单只有一件时拿来看（几件时分不清明细对应哪件，只看标题）
        const unit = RB.unitPrice(d.share, shares[i], l.qty, d.keep, d.refAmt);
        const low = RB.lowJudge({ unit, title: l.title, sku: l.sku, inv: o.lines.length === 1 ? invItemsOf(o) : '', memo: (S.lowval || {})[N.norm(l.title)] });
        rows.push({ o, l, share: d.share, share0: shares[i], r, ref: d.ref, past, keep: d.keep, refAmt: d.refAmt, refManual: S.refunds[l.key] !== undefined, unit, low });
      });
    }
    derived = { rows, byKey: new Map(rows.map(x => [x.l.key, x])) };
    if (EXT && !restoring) chrome.storage.local.set({ invWant: invWant() });      // 判断一变，要报销的订单就跟着变
  }

  // 一件商品退没退、按多少报销（derive 和应报金额 dueOf 共用这一份规则）：
  //   退款由插件按每一件旁边的退款文字判断，不用用户核对：退款成功 → 这一件退了；退款关闭 → 申请撤销了，东西留下；交易关闭 → 整单关闭。
  //   同一件买了几个只退了其中几个（比如买 3 个退 2 个）在订单列表上看不出数量，记在 S.partial：{ key: 留下的个数 }
  //   用户 2026-10-05 的规则：「退款成功」要看退了多少钱——退款 ≥ 实付才算退掉；少于实付是部分退款，照样要开票，金额 = 实付 − 退款
  //   （退款金额来自订单详情页，见 inspectOrders；用户手动标过的以手动为准）
  function lineDue(o, l, share0) {
    const mr = S.refunds[l.key];
    const keep = S.partial && S.partial[l.key];
    let ref = mr === true ? 'refunded' : mr === false ? '' : N.refundState(l, o);
    let share = share0;
    const ra = mr === undefined && S.refundAmt ? S.refundAmt[l.key] : null;
    if (ra != null) {
      if (ra + 0.005 < share) { ref = ''; share = Math.round((share - ra) * 100) / 100; }
      else ref = 'refunded';
    } else if (keep != null && ref === 'refunded' && l.qty > 1) { ref = ''; share = Math.round(share * keep / l.qty * 100) / 100; }
    return { ref, share, keep: keep != null && !ref && ra == null ? keep : null, refAmt: ra != null && !ref ? ra : null };
  }
  // 应报金额 = 本单实付 − 退款（整件退的、部分退款的退款金额、退了几个只留几个的）。要报销多少、给卖家的消息里写多少、
  // 发票核对、已整理发票对单、整理报销的兜底金额都用这一个数
  function dueOf(o) {
    const shares = N.lineShares(o);
    let off = 0;
    o.lines.forEach((l, i) => { const d = lineDue(o, l, shares[i]); off += d.ref === 'refunded' ? shares[i] : shares[i] - d.share; });
    return Math.round(((+o.pay || 0) - off) * 100) / 100;
  }

  const effCat = x => x.r.cat;                         // lab / personal / unsure
  const counted = x => !x.ref;                         // 退款、交易关闭的不计金额
  // 实验室商品里「是否低值品」判断不出的（黄色标签，和待定一样要用户点一下）
  const lowAsk = x => !x.ref && !x.past && effCat(x) === 'lab' && x.low && x.low.v === 'ask';

  // ── 筛选 ──
  // 「核对商品」一张列表（用户 2026-10-07：不再分待定 / 个人 / 实验室三个视图来回切）：
  // 一律按下单日期排（新的在前）；退款的放最后。待定、待确认是否低值品的不挪位置，整行标黄（用户 2026-10-09：
  // 「应该先自动判断有一个总表，然后有两种分类的筛选，用户可以验看」，按是否已判断重排会打乱日期顺序）
  const rankOf = x => x.ref ? 1 : 0;
  // 第 2 步的分类筛选（用户 2026-10-09：筛出全部判为「实验室」或「个人」的，从上往下扫一遍商品图，没错就一次确认）：
  // 全部（总表）/ 实验室 / 个人 / 待定（有待定时才显示）；退款的只在「全部」里。没选过时显示「全部」
  const CATS = ['all', 'lab', 'personal', 'unsure'];
  const SORT_NAME = { unsure: '待定', lab: '实验室', personal: '个人', all: '全部' };
  const inCat = (x, c) => c === 'all' || (!x.ref && effCat(x) === c);
  const unconf = x => !x.ref && effCat(x) !== 'unsure' && S.decisions[x.l.key] !== effCat(x);
  const catRows = c => derived.rows.filter(x => !x.past && inCat(x, c));
  // 这一类还要用户处理的件数：待定是还没判的；实验室 / 个人是自动判断、还没确认的
  const catLeft = c => c === 'unsure' ? catRows('unsure').length : c === 'all' ? 0 : catRows(c).filter(unconf).length;
  const curCat = () => view.cat || 'all';
  const nextCat = () => ['lab', 'personal'].find(c => catLeft(c) > 0) || 'all';
  function visibleRows() {
    const q = view.q.trim().toLowerCase(), cat = view.sortStep ? curCat() : 'all';
    return derived.rows.filter(x => {
      if (x.past || !inCat(x, cat)) return false;
      if (q) {
        const hay = (x.l.title + ' ' + x.l.sku + ' ' + x.o.shop + ' ' + x.o.no).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => rankOf(a) - rankOf(b) || (b.o.time || '').localeCompare(a.o.time || ''));
  }

  // ── 渲染 ──
  // ── 提醒：还有多少单没拿到发票（用户 2026-10-05：「还有多少单没开，不应该是你提醒我，而应该是插件来做到」）──
  // 按在等谁分三类：等平台开票 / 等卖家回复 / 要你动手；等了几天从申请日期、发消息的时间算，超过 remindDays 天的标出来。
  // 数字也写进扩展存储（invPending），后台把它显示在工具栏的插件图标上
  const remindDays = () => +(S.prefs.remindDays || 7);
  const daysSince = s => { const t = typeof s === 'number' ? s : Date.parse(String(s || '').replace(' ', 'T')); return t ? Math.floor((Date.now() - t) / 864e5) : null; };
  function invReminder() {
    if (!EXT || !derived) return null;
    const g = { platform: [], seller: [], you: [] };
    for (const x of invOrders()) {
      const st = invStatus(x), o = x.o;
      if (INV_GROUP[st.key] === 'done' || st.key === 'none') continue;
      let since = null, kind;
      const k = st.key === 'urged' ? st.base : st.key, detail = st.key === 'urged' ? st.since : st.detail;   // 督促过的按原来在等谁算
      if (k === 'applying') { kind = 'platform'; since = (platOf(o) || {}).date || (X.cardApplied || {})[o.no]; }
      // 等卖家：从插件发消息的时间、或聊天里最后一次要发票的时间算
      else if (k === 'asked') { kind = 'seller'; since = (X.askSent || {})[o.no] || ((/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.exec(detail || '') || [])[0]); }
      else kind = 'you';
      g[kind].push({ o, st, lines: x.lines, days: since ? daysSince(since) : null });
    }
    const all = g.platform.length + g.seller.length + g.you.length;
    const late = [...g.platform, ...g.seller].filter(r => r.days != null && r.days > remindDays());
    const sum = [...g.platform, ...g.seller, ...g.you].reduce((a, r) => a + dueOf(r.o), 0);
    return { g, all, late, sum };
  }
  function vipList() {
    const r = invReminder(); if (!r) return [];
    const sent = X.vipSent || {}, lim = remindDays() * 864e5;
    return r.late.filter(x => !(sent[x.o.no] && Date.now() - sent[x.o.no] < lim)).sort((a, b) => b.days - a.days);
  }
  // 找淘宝官方人工客服督促（不限 88VIP）：打开官方客服页，extension/vip.js 发「人工」直到转人工，再一单一句督促（用户 2026-10-05 示范）
  // 督促清单保持宽松（用户 2026-10-05：督促宁可多，不能漏；督促错了客服会说明），这里不加额外的排除条件
  const VIP_URL = 'https://consumerservice.taobao.com/online-help';
  // 清单里一单一行（「自动处理发票」的确认清单用）
  const vipRows = xs => xs.map(x => orderRow(x.o, x.lines || [], '已等待 ' + (x.days == null ? '—' : x.days) + ' 天 · ' + x.st.label));
  // 已确认的督促：打开官方客服页，等督促消息发出（vipSent 记下这几单），最多 6 分钟；之后的跟进（回「OK」、提交投诉）在客服页里继续
  async function doVip(xs) {
    if (!xs.length) return 0;
    const now = Date.now();
    await chrome.storage.local.set({ vipJob: { at: now, title: S.invoice.title, taxId: S.invoice.taxId, orders: xs.map(x => ({ no: x.o.no, days: x.days, shop: x.o.shop })) } });
    // 客服给的「填写开票申请」入口如果打开的也是淘宝「开具发票」页，由 extension/apply-card.js 按这份任务核对后提交（待真实页面验证）
    await addCardJobs(xs.map(x => x.o), 'vip');
    chrome.runtime.sendMessage({ type: 'openWorkTab', url: VIP_URL });
    // 客服页报了失败（没加载出来、安全验证、转不到人工）就不再等，原因写进结果
    let why = '';
    await until(async () => xs.every(x => ((X.vipSent || {})[x.o.no] || 0) >= now) || !!(why = await jobFailSince(now, ['vip'])), tmo('vip', 6 * 60000));
    doVip.why = why;
    return xs.filter(x => ((X.vipSent || {})[x.o.no] || 0) >= now).length;
  }


  // ── 按卖家发来的开票卡片申请（用户 2026-10-05）：批量开票页上没有入口的单，卖家（或淘宝客服）有时在旺旺里发一张「请填写发票申请」卡片，
  // 点卡片上的「去申请」→ 淘宝「开具发票」页 →「提交申请」→「确认提交」，这单就进入淘宝平台开票流程。
  // 主页逐单：排 cardJobs（核对用的抬头、税号，带过期时间）和 cardRun（这次要点哪张卡片）→ 旺旺页（extension/chat.js）找到卡片点「去申请」
  // → 申请页（extension/apply-card.js）核对订单号、抬头后提交，结果写回 cardResult。一单失败不影响下一单
  const cardList = () => invOrders().filter(x => invStatus(x).key === 'card');
  // 已经提交过（或正在确认提交）的单不再改回 queued：不然晚到的申请页会把它再提交一次
  const SETTLED_JOB = ['done', 'confirming', 'unconfirmed'];
  async function addCardJobs(os, source) {
    const { cardJobs, cardApplied } = await chrome.storage.local.get(['cardJobs', 'cardApplied']), now = Date.now();
    const keep = Object.fromEntries(Object.entries(cardJobs || {}).filter(([, j]) => j.exp > now));     // 过期的清掉
    for (const o of os) {
      if ((keep[o.no] && SETTLED_JOB.includes(keep[o.no].state)) || (cardApplied || {})[o.no]) continue;
      keep[o.no] = { at: now, exp: now + 40 * 60000, state: 'queued', source, shop: o.shop, title: S.invoice.title, taxId: S.invoice.taxId };
    }
    await chrome.storage.local.set({ cardJobs: keep });
  }
  async function patchCardJob(no, p) {
    const { cardJobs } = await chrome.storage.local.get('cardJobs');
    if (!cardJobs || !cardJobs[no]) return;
    if (p.state === 'queued' && SETTLED_JOB.includes(cardJobs[no].state)) return;
    await chrome.storage.local.set({ cardJobs: Object.assign({}, cardJobs, { [no]: Object.assign({}, cardJobs[no], p) }) });
  }
  const cardOfX = x => { const c = chatOf(x.o) || { cards: [] }; return c.cards[c.cards.length - 1]; };
  const cardRows = xs => xs.map(x => { const k = cardOfX(x); return orderRow(x.o, x.lines, '卡片：' + (k ? String(k.time).slice(0, 16) + ' ' + k.title + (k.price ? ' ' + yuan(+k.price) : '') : '—')
    + (k && k.shared ? '　⚠ 同店多单，申请页订单号不符时不提交' : '')); });
  // 已确认的按开票入口申请：逐单打开会话点卡片上的「去申请」，申请页核对订单号、抬头一致才提交；返回每单的结果
  async function runCards(sel, w) {
    const out = [];
    if (!sel.length) return out;
    await addCardJobs(sel.map(x => x.o), 'chat');
    for (let i = 0; i < sel.length; i++) {
      const x = sel[i], c = chatOf(x.o) || { cards: [] }, k = c.cards[c.cards.length - 1];
      if (w) w('第 ' + (i + 1) + ' / ' + sel.length + ' 单：' + x.o.shop);
      let r;
      // 这一轮里已经提交过的（比如申请页自己跳到了这单）：不再点卡片、不再提交第二次
      const { cardApplied } = await chrome.storage.local.get('cardApplied');
      if ((cardApplied || {})[x.o.no]) r = { ok: true };
      else try { r = k ? await runCard(x.o, k, c) : { ok: false, why: '未找到开票卡片' }; }
      catch (e) { if (e === STOPPED) { await patchCardJob(x.o.no, { state: 'cancelled' }); throw e; } r = { ok: false, why: e.message }; }
      if (!r.ok) await patchCardJob(x.o.no, { state: 'cancelled' });          // 晚到的申请页不再提交
      out.push({ ok: r.ok, text: (r.ok ? '已提交　' : '未完成　') + x.o.shop + '（' + (x.o.time || '').slice(0, 10) + '，' + yuan(+x.o.pay) + '，' + x.o.no + '）' + (r.ok ? '' : '：' + r.why) });
      if (i < sel.length - 1) await sleepMs(3000 + Math.random() * 3000);       // 单与单之间隔几秒
    }
    derive(); render();
    return out;
  }
  // 一单：排 cardRun，让唯一的旺旺页跳到这家的会话；等 cardResult（申请页写）或 cardRun 报错（旺旺页写），最多 2 分钟
  async function runCard(o, k, c) {
    const nick = o.nick || c.nick;
    if (!nick) return { ok: false, why: '卖家旺旺名未知，无法打开会话' };
    const id = Math.random().toString(36).slice(2), t0 = Date.now();
    await patchCardJob(o.no, { state: 'queued' });
    await chrome.storage.local.set({ cardRun: { id, no: o.no, nick, shop: o.shop, card: { time: k.time, title: k.title }, at: t0 } });
    chrome.runtime.sendMessage({ type: 'openJobTab', url: chatUrl(nick) });        // 后台只留一个旺旺页，开着就在它上面跳转
    while (Date.now() - t0 < 120000) {
      await sleepMs(1000);
      stopCheck();
      const { cardRun, cardResult, cardJobs } = await chrome.storage.local.get(['cardRun', 'cardResult', 'cardJobs']);
      const r = (cardResult || {})[o.no];
      if (r && r.at >= t0) return r.ok ? { ok: true } : { ok: false, why: r.why };
      if (cardRun && cardRun.id === id && cardRun.error) return { ok: false, why: cardRun.error };
      const why = await chatTrouble(t0);
      if (why) return { ok: false, why };
      const job = (cardJobs || {})[o.no] || {};
      if (cardRun && cardRun.id === id && cardRun.clicked && !job.opened && Date.now() - cardRun.clicked > 30000)
        return { ok: false, why: '已点击「去申请」，但 30 秒内未打开申请页' };
    }
    return { ok: false, why: '2 分钟内未完成' };
  }
  // 二维码发票核对没通过（extension/qr.js 记的）：主页提示原因（那一页会自己关掉）
  function onQrFail(prev, cur) {
    const fresh = Object.entries(cur || {}).filter(([k, v]) => !(prev || {})[k] || prev[k].at !== v.at);
    if (fresh.length) toast('二维码发票未下载：' + fresh.map(([, v]) => v.why + '（订单 ' + v.no + '）').join('；') + '，请手动核对');
  }

  // 确认清单里的一单（「自动处理发票」的确认清单用，见 confirmGroups）
  function orderRow(o, lines, extra) {
    const t = (lines[0] && lines[0].title) || '';
    return '<b>' + esc(o.shop || '未知店铺') + '</b><span class="detail">' + esc((o.time || '').slice(0, 10)) + ' · ' + esc(t.length > 40 ? t.slice(0, 40) + '…' : t)
      + (lines.length > 1 ? ' 等 ' + lines.length + ' 件' : '') + ' · ' + esc(yuan(+o.pay)) + ' · 订单号 ' + esc(o.no) + '</span>'
      + (extra ? '<span class="ask-msg">' + esc(extra) + '</span>' : '');
  }
  // ── 顶上的进度条：分拣、发票、金额三个分数，加上发票在等谁。替代原来一大段文字提醒（用户 2026-10-05）──
  // 数字同时写进扩展存储（invPending），后台把「还差几单」显示在工具栏的插件图标上
  let lastBadge = '';
  const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
  const meter = (a, b) => '<span class="meter"><b style="width:' + pct(a, b) + '%"></b></span>';
  function renderDash() {
    const el = $('remind');
    let n = 0, sure = 0, unsure = 0, labN = 0, labSum = 0;
    for (const x of derived.rows) {
      if (x.past || x.ref) continue;
      n++;
      if (S.decisions[x.l.key]) sure++;
      if (effCat(x) === 'unsure') unsure++;
      if (effCat(x) === 'lab') { labN++; labSum += x.share || 0; }
    }
    // 只显示，不能点（用户 2026-10-07：只是切换视图的入口和步骤条重复，去掉）
    const cell = (goto, k, v, s, tip) => '<div class="dc" title="' + tip + '"><span class="k">' + k + '</span>'
      + '<span class="v num">' + v + '</span>' + s + '</div>';
    const sortCell = cell(unsure ? 'unsure' : 'lab', '商品分拣（已确认 / 全部）', sure + ' <small>/ ' + n + ' 件</small>',
      meter(sure, n) + '<span class="s">' + (unsure ? '待定 ' + unsure + ' 件' : n - sure ? '自动判断、未确认 ' + (n - sure) + ' 件' : '全部已确认') + '</span>',
      '已确认商品数 / 本次待判断商品数（不含退款及上次已报销的商品）');
    const r = invReminder();
    if (!r) {
      el.className = 'dash web';
      el.innerHTML = sortCell + cell('lab', '实验室商品', labN + ' <small>件</small>', '<span class="s num">' + yuan(Math.round(labSum * 100) / 100) + '</span>', '判为实验室且未退款的商品');
      return;
    }
    const badge = JSON.stringify([r.all, r.late.length]);
    if (badge !== lastBadge) { lastBadge = badge; chrome.storage.local.set({ invPending: { n: r.all, late: r.late.length, at: Date.now() } }); }
    let total = 0, got = 0, due = 0, gotSum = 0;
    const tone = { bad: 0, wait: 0, info: 0 };
    for (const x of invOrders()) {
      const st = invStatus(x);
      if (st.key === 'none') continue;
      const d = dueOf(x.o);
      total++; due += d;
      if (INV_GROUP[st.key] === 'done') { got++; gotSum += d; }
      const t = invTone(x.o, st);
      if (WAIT_TONES.includes(t)) tone.wait++; else if (t in tone) tone[t]++;
    }
    // 圆点用实心色块色（--*-sw），与发票栏图例一致：需处理红、等待中黄、待下载紫
    const dot = (t, label, v) => '<span><i style="background:var(--' + t + '-sw)"></i>' + label + ' <b class="num">' + v + '</b></span>';
    el.className = 'dash';
    el.innerHTML = sortCell
      + cell('invoice', '发票（已取得 / 应开）', got + ' <small>/ ' + total + ' 单</small>',
        meter(got, total) + '<span class="s">' + (total - got ? '尚缺 ' + (total - got) + ' 单' : total ? '已全部取得' : '暂无需开票的订单') + '</span>',
        '已下载或已整理发票的订单数 / 需报销的实验室订单数')
      + cell('invoice', '金额（已取得发票 / 应报）', yuan(Math.round(gotSum * 100) / 100) + ' <small>/ ' + yuan(Math.round(due * 100) / 100) + '</small>',
        meter(gotSum, due) + '<span class="s">尚缺 ' + yuan(Math.round((due - gotSum) * 100) / 100) + '</span>',
        '已取得发票的订单金额 / 需报销的实验室订单金额（部分退款按实付减退款计）')
      + '<div class="dc" title="未取得发票的订单按当前状态分类计数"><span class="k">未取得发票的订单</span>'
      + '<div class="dots">' + dot('bad', '需处理', tone.bad) + dot('wait', '等待中', tone.wait) + dot('info', '待下载', tone.info) + '</div>'
      + '<span class="s' + (r.late.length ? ' late' : '') + '">' + (r.late.length ? '超过 ' + remindDays() + ' 天未开票 ' + r.late.length + ' 单' : '无超过 ' + remindDays() + ' 天未开票的订单') + '</span></div>';
  }

  function render() {
    const has = S.orders.length > 0;
    $('empty').hidden = has;
    $('main').hidden = !has;
    // 「更多」一直在：没有数据时也要能从备份恢复；只是要有数据才有意义的几项先藏起来
    for (const el of document.querySelectorAll('#more .need-data')) el.hidden = !has;
    if (!has) { renderGuide(); return; }
    renderDash();
    renderSummary();
    renderList();
  }

  // 发票的三类：还没开 / 开好了还没下载 / 已开好并下载
  // badinv：下载的票核对不通过（少 1 元以上、金额不符、读不出等），不算已取得；chatfail：旺旺会话没能读取（不退回「需向卖家索要」）
  const INV_GROUP = { apply: 'todo', ask: 'todo', asked: 'todo', applying: 'todo', urged: 'todo', card: 'todo', wrong: 'todo', check: 'todo',
                      badinv: 'todo', chatfail: 'todo', gone: 'gone', ready: 'ready', replied: 'ready', paper: 'ready', done: 'done', have: 'done' };
  function invCounts() {
    const c = { todo: 0, ready: 0, done: 0 };
    for (const x of invOrders()) { const g = INV_GROUP[invStatus(x).key]; if (g) c[g]++; }
    return c;
  }

  // ── 一条线的四步：读取订单 → 核对商品 → 处理发票 → 整理报销文件 ──
  // 用户 2026-10-07 定的准则：一条主线、同一件事只有一个入口；插件能自动做的都自动做；不写大段说明（细节放悬停）；
  // 状态用颜色和标签区分；只切换视图、滚动页面的按钮一律不要。每一步只有一个主按钮和一行提示；不常用的在顶栏「更多」里。
  // list：选中这一步时下方显示什么（goods 商品列表 / invoice 发票表）
  const pb = (attr, label, tip, primary, off) => '<button class="btn' + (primary === false ? '' : ' primary') + '" ' + attr + (off ? ' disabled' : '') + ' title="' + tip + '">' + label + '</button>';
  function sortCounts() {
    const live = derived.rows.filter(x => !x.past);
    const n = { lab: 0, personal: 0, unsure: 0, ref: 0, unconf: 0, img: 0, live: live.length, lowAsk: 0 };
    for (const x of live) {
      if (x.l.img) n.img++;
      if (x.ref) { n.ref++; continue; }
      n[effCat(x)]++;
      if (lowAsk(x)) n.lowAsk++;
      if (effCat(x) !== 'unsure' && S.decisions[x.l.key] !== effCat(x)) n.unconf++;
    }
    return n;
  }
  function flowSteps() {
    const live = derived.rows.filter(x => !x.past), n = sortCounts();
    // 只算这次要判断的（上次报销那天之后的）订单
    const times = live.map(x => (x.o.time || '').slice(0, 10)).filter(Boolean).sort(), nOrders = new Set(live.map(x => x.o.no)).size;
    const ic = EXT ? invCounts() : null;
    const t0 = times[0] || '', t1 = times[times.length - 1] || '';
    const range = t0 === t1 ? t0 : t0.slice(0, 4) === t1.slice(0, 4) ? t0 + ' 至 ' + t1.slice(5) : t0 + ' 至 ' + t1;
    const since = sinceInfo();
    const pack = EXT ? packState() : null;
    const sorted = n.live > 0 && n.unsure === 0 && n.unconf === 0 && n.lowAsk === 0;
    const cat = curCat(), catTodo = cat === 'lab' || cat === 'personal' ? catRows(cat).filter(unconf) : [];
    // 悬停说明写清楚会确认哪几件
    const catTip = '将当前筛选中以下 ' + catTodo.length + ' 件自动判断、尚未确认的商品确认为「' + SORT_NAME[cat] + '」（可撤销）：\n'
      + catTodo.slice(0, 20).map(x => '· ' + x.l.title.slice(0, 30)).join('\n') + (catTodo.length > 20 ? '\n…共 ' + catTodo.length + ' 件' : '');
    return [
      // 读取订单（用户 2026-10-07）：订单、图片、逐件退款一次读完；订单表（xlsx）降为可选，在「更多」里导入。
      // 网页版没有扩展读不了淘宝页面，仍是导入订单表 + 复制抓取脚本
      EXT ? { id: 'read', title: '读取订单', list: 'goods', done: S.orders.length > 0,
        text: readBusy() ? readShort() : S.orders.length ? nOrders + ' 单 · ' + range : '未读取',
        tip: S.orders.length ? nOrders + ' 单，' + t0 + ' 至 ' + t1 + '，有图 ' + n.img + ' / ' + n.live + ' 件' + (since.date ? '；上次报销到 ' + since.date : '') : '',
        hint: S.orders.length ? '有新订单时再次读取，已有判断保留' : '自动读取上次报销之后的订单、图片和退款',
        // 读过以后这一步已完成：按钮改叫「再次读取」，免得像是还要再做一遍
        acts: pb('data-flow="read"', S.orders.length ? '再次读取（补充新订单）' : '从淘宝读取订单', READ_TIP, true, readBusy()) }
      : { id: 'import', title: '导入订单表', list: 'goods', done: S.orders.length > 0,
        text: S.orders.length ? nOrders + ' 单 · ' + range : '未导入',
        tip: '网页版无法自动读取淘宝页面：在淘宝「已买到的宝贝」点「导出订单」，导入下载的 xlsx；安装为 Chrome 扩展后可一键读取',
        hint: '网页版：导入从淘宝导出的订单表',
        acts: pb('data-flow="import"', '导入订单表', '选择从淘宝导出的订单表（xlsx 或 csv）')
          + pb('data-flow="img-dlg"', '补充图片', '复制抓取脚本，在淘宝订单页的控制台运行，补充商品图片和退款', false) },
      // 核对商品：原来的「判断待定 / 检查个人 / 检查实验室」三步合成一步，列表就在下方，待定的排最前
      { id: 'sort', title: '核对商品', list: 'goods', done: sorted,
        text: !n.live ? '暂无商品' : n.unsure ? '待定 ' + n.unsure + ' 件' : n.lowAsk ? '待确认低值品 ' + n.lowAsk + ' 件' : sorted ? '已确认' : '实验室 ' + n.lab + ' · 个人 ' + n.personal,
        tip: '实验室 ' + n.lab + ' 件、个人 ' + n.personal + ' 件、待定 ' + n.unsure + ' 件、退款 ' + n.ref + ' 件' + (n.lowAsk ? '、待确认是否低值品 ' + n.lowAsk + ' 件' : ''),
        // 主按钮随分类筛选变：待定 → 逐件按 1 / 2；实验室 / 个人 → 把这一类自动判断、未确认的一次确认；全部 → 确认核对完成
        hint: cat === 'unsure' ? (n.unsure ? '按 1 实验室、2 个人，还有 ' + n.unsure + ' 件待定' : '没有待定的商品')
          : cat === 'lab' ? (n.lowAsk ? '点黄色标签确认是否低值品，还有 ' + n.lowAsk + ' 件' : '从上往下看商品图，判错的按 2 改为个人')
          : cat === 'personal' ? '从上往下看商品图，判错的按 1 改为实验室'
          : n.unsure ? '按 1 实验室、2 个人，还有 ' + n.unsure + ' 件待定' : n.lowAsk ? '点黄色标签确认是否低值品，还有 ' + n.lowAsk + ' 件'
          : sorted ? '已全部确认' : '核对下方判断，判错的按 1 / 2 改正',
        acts: cat === 'unsure' ? pb('data-flow="sort-cat"', '按 1 / 2 判断', '待定的商品逐件判断：按 1 判为实验室，按 2 判为个人', true, true)
          : cat !== 'all' ? (catTodo.length ? pb('data-flow="sort-cat"', '这 ' + catTodo.length + ' 件都是' + SORT_NAME[cat] + '，确认', esc(catTip), true, false)
            : pb('data-flow="sort-cat"', '已全部确认', '「' + SORT_NAME[cat] + '」中的商品均已确认', true, true))
          : pb('data-flow="sort-done"', '确认核对完成', n.unsure ? '还有 ' + n.unsure + ' 件待定，判完才能确认'
          : n.lowAsk ? '还有 ' + n.lowAsk + ' 件待确认是否低值品（单价超过 200 元、判断不出设备还是耗材），点黄色标签确认后才能确认'
          : '将下方自动判断的商品全部确认（实验室 ' + n.lab + ' 件、个人 ' + n.personal + ' 件），之后不再自动变更', true, n.unsure > 0 || n.lowAsk > 0 || sorted) },
      { id: 'invoice', title: '处理发票', list: 'invoice', done: !!ic && ic.todo === 0 && ic.ready === 0 && invOrders().length > 0,
        text: J.busy ? (J.quiet ? '后台刷新中…' : '处理中…') : ic ? '已取得 ' + ic.done + ' / ' + (ic.todo + ic.ready + ic.done) + ' 单' : '需安装为 Chrome 扩展',
        tip: EXT ? '需在本浏览器中保持淘宝登录，并已在「设置」中填写抬头和税号' : '发票功能需安装为 Chrome 扩展后使用',
        hint: EXT ? '自动检查、申请、索要并下载发票；对外操作先确认' : '需安装为 Chrome 扩展',
        // 每天自动刷新（后台性质）进行中时按钮照常可点：点了先停掉它
        acts: EXT ? pb('data-flow="inv-run"', J.busy && !J.quiet ? '正在处理…' : '自动处理发票', hasSample() ? SAMPLE_TIP : RUN_TIP, true, (J.busy && !J.quiet) || hasSample()) : '' },
      { id: 'pack', title: '整理报销文件', list: 'invoice', done: !!pack && pack.done, text: pack ? pack.text : '需安装为 Chrome 扩展',
        tip: '按报销规范整理到下载文件夹的「订单分拣-报销/学号_姓名_总金额元」：不超过1k耗材、超过1k耗材（发票 + 附件原图）、低值品，附 README.txt、报销清单.xlsx 和压缩包；原文件不变',
        hint: EXT ? '选择下载文件夹里的「订单分拣-发票」' : '需安装为 Chrome 扩展',
        acts: EXT ? pb('data-flow="pack"', '选择发票文件夹并整理', hasSample() ? SAMPLE_TIP : '选择下载文件夹里的「订单分拣-发票」（浏览器询问「上传」时确认即可，文件只在本机读取），预览后生成报销文件夹和压缩包；需先在「设置」中填写报销人姓名', true, hasSample()) : '' },
    ];
  }
  const RUN_TIP = '依次自动：刷新发票情况（淘宝开票记录、卖家旺旺回复）、下载已开具的发票；需要申请开票、向卖家索要、请客服督促的，先列一张清单，确认一次后自动完成';
  // 第 4 步：上次整理时已下载的发票都整理进去了，就算做完；之后又下了新发票，就又要整理
  function packState() {
    const lp = S.lastPack;
    const got = invOrders().filter(x => ['done', 'badinv'].includes(invStatus(x).key)).map(x => x.o.no);
    const left = lp ? got.filter(no => !(lp.nos || []).includes(no)).length : got.length;
    return { done: !!lp && left === 0, text: lp ? (left ? '新增 ' + left + ' 单发票' : '已整理 ' + lp.n + ' 张') : got.length ? got.length + ' 单可整理' : '暂无发票' };
  }
  // 读取订单、处理发票的进度和结果：放在步骤条和说明区之间，不随选中的步骤切换消失；结果一直留着，直到点「关闭」或下次再做
  function statusBar() {
    // 处理发票进行中：进度后面一个「停止」（只停插件自己的等待和后面几段）
    const one = (t, busy, bad, close, id, running) => '<div class="read-bar' + (busy ? ' busy' : bad ? ' bad' : '') + '" data-bar="' + id + '"><span>' + esc(t) + '</span>'
      + (busy && id === 'inv' ? (J.stop ? '' : '<button class="linkbtn" data-flow="inv-stop" title="' + STOP_TIP + '">停止</button>')
        : busy || running ? '' : '<button class="linkbtn" data-flow="' + close + '" title="关闭这条提示">关闭</button>') + '</div>';
    let h = '';
    const t = EXT ? readNote() : '';
    if (t) { const s = readTone(); h += one(t, s.busy, s.bad, 'read-close', 'read', readBusy()); }
    // 处理发票时显示当前第几段、在等什么、等了多久（每秒更新，见 showProgress）；结束后是每段的结果
    if (J.busy || J.note) h += one(J.busy ? progressText() : J.note, J.busy, J.bad, 'inv-close', 'inv');
    return h;
  }
  // 当前显示哪一步：用户点过的那一步，否则当前该做的那一步
  function shownStep(steps) {
    const cur = steps.findIndex(x => !x.done);
    return view.step != null && steps[view.step] ? view.step : cur >= 0 ? cur : steps.length - 1;
  }
  function renderSummary() {
    const steps = flowSteps();
    const cur = steps.findIndex(x => !x.done), show = shownStep(steps);
    const d = steps[show];
    view.list = d.list; view.sortStep = d.id === 'sort';
    $('summary').innerHTML = '<ol class="flow">' + steps.map((x, i) =>
        '<li class="' + (x.done ? 'is-done' : i === cur ? 'is-cur' : '') + (i === show ? ' is-sel' : '') + '" data-step="' + i + '" role="button" tabindex="0" title="第 ' + (i + 1) + ' 步：' + x.title + '（' + esc(x.tip || x.text) + '）">'
        + '<span class="flow-h"><span class="flow-n">' + (x.done ? '✓' : i + 1) + '</span><span class="flow-t">' + x.title + '</span></span>'
        + '<span class="flow-s">' + esc(x.text) + '</span></li>').join('') + '</ol>'
      + statusBar()
      + '<div class="flow-detail"><div class="fd-text"><span class="fd-title">第 ' + (show + 1) + ' 步　' + d.title + '</span>'
      + '<span class="fd-hint">' + esc(d.hint) + '</span></div><div class="flow-acts">' + d.acts + '</div></div>'
      // 第 4 步说明区下方：报销记录（每批一行，只读；到账在行内「填写到账」）
      + (d.id === 'pack' && EXT ? batchView() : '');
  }

  function statusClass(s) {
    if (/交易成功|交易完成/.test(s)) return 'st-ok';
    if (/关闭|退款/.test(s)) return 'st-closed';
    return 'st-other';
  }

  function renderList() {
    const inv = view.list === 'invoice';
    $('inv-legend').hidden = !inv || !EXT;
    $('keys').hidden = inv;
    // 分类筛选只在第 2 步「核对商品」出现；颜色和商品标签一致，带件数
    const seg = $('cat-seg'), cat = curCat();
    seg.hidden = inv || !view.sortStep;
    $('list').classList.toggle('is-sort', !inv && view.sortStep);
    // 没有待定时不显示「待定」这一格
    if (!seg.hidden) seg.innerHTML = CATS.filter(c => c !== 'unsure' || c === cat || catRows('unsure').length).map(c => {
      const n = catRows(c).length, left = catLeft(c);
      const tip = c === 'unsure' ? '只看待定的商品（' + n + ' 件），按 1 / 2 逐件判断'
        : c === 'all' ? '看全部商品（' + n + ' 件，含退款、交易关闭的）'
        : '只看判为' + SORT_NAME[c] + '的商品（' + n + ' 件' + (left ? '，其中 ' + left + ' 件尚未确认' : '，均已确认') + '），从上往下核对商品图';
      return '<button type="button" class="seg seg-' + c + (c === cat ? ' is-on' : '') + '" data-cat="' + c + '" aria-pressed="' + (c === cat) + '" title="' + esc(tip) + '">'
        + SORT_NAME[c] + ' <b class="num">' + n + '</b></button>';
    }).join('');
    if (inv) { renderInvoice(); return; }
    const rows = visibleRows();
    if (!rows.length) { $('list').innerHTML = '<div class="none">' + (view.q ? '没有符合条件的商品' : view.sortStep && cat !== 'all' ? '没有' + SORT_NAME[cat] + '的商品' : '暂无商品') + '</div>'; return; }
    // 按订单分组，保持排序
    const groups = [], idx = new Map();
    for (const x of rows) {
      let g = idx.get(x.o.no);
      if (!g) { g = { o: x.o, rows: [] }; idx.set(x.o.no, g); groups.push(g); }
      g.rows.push(x);
    }
    if (view.focus && !rows.some(x => x.l.key === view.focus)) view.focus = null;
    // 按 1 / 2 直接判第一件待定；筛选「实验室」「个人」时从第一件开始，判错的直接按 1 / 2 改
    if (!view.focus) { const u = rows.find(x => effCat(x) === 'unsure') || (view.sortStep && rows.find(x => !x.ref)); if (u) view.focus = u.l.key; }
    const html = [];
    for (const g of groups) {
      const o = g.o, st = o.statusLive || o.status || '';
      html.push('<article class="order">'
        + '<div class="ohead"><span class="d num">' + esc((o.time || '').slice(0, 10) || '无日期') + '</span>'
        + '<span class="no num">订单号 ' + esc(o.no) + '</span>'
        + '<span class="shop">' + esc(o.shop || '未知店铺') + wwBtn(o) + '</span>'
        + '<span class="st ' + statusClass(st) + '">' + esc(st || '状态未知') + '</span></div>');
      for (const x of g.rows) html.push(lineHtml(x));
      if (o.lines.length > 1 || o.ship) {
        html.push('<div class="ofoot"><span>本单实付 <b class="num">' + yuan(o.pay) + '</b></span>'
          + (o.ship ? '<span>含运费 <b class="num">' + yuan(o.ship) + '</b></span>' : '') + '</div>');
      }
      html.push('</article>');
    }
    $('list').innerHTML = html.join('');
  }

  // 点商品图、商品名：在淘宝打开这单的订单详情核对（用户 2026-10-05）
  const detailUrl = no => 'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=' + no;
  const detailA = (no, inner, cls) => '<a class="' + (cls || 'lk') + '" href="' + esc(detailUrl(no)) + '" target="_blank" rel="noopener noreferrer" data-detail="'
    + esc(no) + '" title="在淘宝打开本单订单详情">' + inner + '</a>';
  function openDetail(no) {
    if (isSample(no)) { toast('示例订单是虚构的，淘宝上没有这一单'); return; }
    if (EXT) chrome.tabs.create({ url: detailUrl(no), active: true });
    else window.open(detailUrl(no), '_blank', 'noopener');
  }
  // 店名旁边的旺旺图标：打开和这家店的聊天。不知道卖家旺旺名时，先去订单详情页读（旺旺名常常和店名对不上）
  const chatUrl = nick => 'https://market.m.taobao.com/app/im/chat/index.html?&uid=' + encodeURIComponent('cntaobao' + nick) + '&gid=&type=web';
  const WW_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.5C4.13 1.5 1 4.13 1 7.38c0 1.86 1.03 3.52 2.64 4.6L3.1 14.5l3.02-1.6c.6.13 1.23.2 1.88.2 3.87 0 7-2.64 7-5.87S11.87 1.5 8 1.5z"/>'
    + '<circle cx="5.5" cy="7.4" r="1.05" fill="#fff"/><circle cx="10.5" cy="7.4" r="1.05" fill="#fff"/></svg>';
  const wwBtn = o => '<button type="button" class="ww" data-ww="' + esc(o.no) + '" title="打开与该店铺的旺旺聊天" aria-label="打开与该店铺的旺旺聊天">' + WW_SVG + '</button>';
  async function openChat(no) {
    const o = S.orders.find(x => x.no === no);
    if (!o) return;
    if (isSample(no)) { toast('示例订单是虚构的，淘宝上没有这一单'); return; }
    if (!EXT) { window.open(o.nick ? chatUrl(o.nick) : detailUrl(o.no), '_blank', 'noopener'); return; }
    // 旺旺页只有一个：「自动处理发票」正在用它时，打开别家会话会把正在干活的页面带走
    if (!await freeForUser()) return;
    if (!o.nick) await inspectOrders([o]);
    if (!o.nick) { toast('订单详情页未读取到卖家旺旺名，已打开订单详情页，请在该页点击旺旺图标'); openDetail(o.no); return; }
    chrome.runtime.sendMessage({ type: 'openJobTab', url: chatUrl(o.nick) });       // 后台只留一个旺旺页，开着就在它上面跳转
  }

  // 商品图地址：订单页有时给出拼坏的地址（imgextra//gw.alicdn.com/…），这里先修好
  function fixImg(u) {
    u = String(u || '').trim();
    const m = /\/imgextra\/\/((?:gw|img)\.alicdn\.com\/.*)$/.exec(u);
    if (m) u = 'https://' + m[1];
    return u.startsWith('//') ? 'https:' + u : u;
  }
  // 淘宝的 _200x200 小图有时已经没了（404，回一张 1×1 灰色 gif）：再试 _.webp 和原图
  const imgAlts = u => { const b = u.replace(/(\.(?:jpe?g|png|gif|webp))_[^/]*$/i, '$1'); return [b + '_.webp', b].filter(v => v !== u).join(' '); };
  function thumbHtml(src, cls) {
    if (!src) return '<div class="' + cls + ' ph err" title="订单页上未抓取到该商品图片">ERROR<br>缺少图片</div>';
    const u = fixImg(src);
    return '<img class="' + cls + '" loading="lazy" referrerpolicy="no-referrer" alt="" src="' + esc(u) + '" data-alt="' + esc(imgAlts(u)) + '">';
  }
  function onThumb(e) {
    const im = e.target;
    if (!(im instanceof HTMLImageElement) || !im.hasAttribute('data-alt')) return;
    if (e.type === 'load' && im.naturalWidth > 1) return;
    const alts = im.dataset.alt.split(' ').filter(Boolean);
    if (alts.length) { im.dataset.alt = alts.slice(1).join(' '); im.src = alts[0]; return; }
    const d = document.createElement('div');
    d.className = im.className + ' ph err'; d.title = '图片加载失败：' + im.src; d.innerHTML = 'ERROR<br>图片无法加载';
    im.replaceWith(d);
  }
  document.addEventListener('load', onThumb, true);
  document.addEventListener('error', onThumb, true);

  // 打开主页时把每件的图都试一遍：换个地址能看的就换上；都看不了的清掉地址，并删掉淘宝页那边这单的暂存，
  // 这样缺图清单里会重新出现这单，下次补图时淘宝页重新抓（抓的时候会挑能打开的地址）
  let imgChecked = false;
  const tryImg = u => new Promise(ok => {
    const i = new Image(); i.referrerPolicy = 'no-referrer';
    const t = setTimeout(() => ok(false), 10000);
    i.onload = () => { clearTimeout(t); ok(i.naturalWidth > 1); };
    i.onerror = () => { clearTimeout(t); ok(false); };
    i.src = u;
  });
  async function checkImages() {
    if (imgChecked || !S.orders.length) return;
    imgChecked = true;
    const todo = [];
    for (const o of S.orders) for (const l of o.lines) if (l.img) todo.push({ o, l });
    let i = 0, fixed = 0;
    const dead = new Set();
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (i < todo.length) {
        const { o, l } = todo[i++];
        const u = fixImg(l.img);
        let good = '';
        for (const v of [u].concat(imgAlts(u).split(' ').filter(Boolean))) if (await tryImg(v)) { good = v; break; }
        if (good && good !== l.img) { l.img = good; fixed++; }
        if (!good) { l.img = ''; dead.add(o.no); }
      }
    }));
    if (!fixed && !dead.size) return;
    if (EXT && dead.size) {
      const r = await chrome.storage.local.get('scraped');
      const sc = Object.assign({}, r.scraped);
      for (const no of dead) delete sc[no];
      await chrome.storage.local.set({ scraped: sc });
    }
    persist(); derive(); render();
    toast((fixed ? '已替换 ' + fixed + ' 张无法加载的商品图' : '') + (fixed && dead.size ? '；' : '')
      + (dead.size ? dead.size + ' 单的图片均无法加载，已标红 ERROR，下次补图时重新抓取' : ''), true);
  }

  function lineHtml(x) {
    const { l, r } = x;
    const cat = r.cat, manual = r.via === 'manual';
    const img = detailA(x.o.no, thumbHtml(l.img, 'thumb'), 'thumb-a');
    const title = detailA(x.o.no, esc(l.title));
    const viaLabel = { manual: '手动', rule: '自动', shop: '店铺记忆', title: '同商品记忆', invoice: '发票记录', surcharge: '补差价' }[r.via] || '自动';
    const labCls = manual && cat === 'lab' ? 'on-lab' : (!manual && cat === 'lab' ? 'sug-lab' : '');
    const perCls = manual && cat === 'personal' ? 'on-per' : (!manual && cat === 'personal' ? 'sug-per' : '');
    // 颜色标签：实验室蓝、个人粉、待定黄（整行也标黄）、退款灰；自动判断还没确认的标签是虚线框
    const auto = !manual && !x.ref ? ' auto' : '';
    const pill = x.ref ? '' : cat === 'lab' ? '<span class="pill p-lab' + auto + '">实验室</span>'
               : cat === 'personal' ? '<span class="pill p-per' + auto + '">个人</span>' : '<span class="pill p-uns">待定</span>';
    const refPill = x.ref === 'refunded' ? '<span class="pill p-ref">已退款</span>'
                  : x.ref === 'refunding' ? '<span class="pill p-ref">退款中</span>'
                  : x.ref === 'closed' ? '<span class="pill p-ref">交易关闭</span>'
                  : x.refAmt != null ? '<span class="pill p-ref">部分退款：已退 ' + yuan(x.refAmt) + '，按 ' + yuan(x.share) + ' 报销</span>'
                  : x.keep != null ? '<span class="pill p-ref">退 ' + (x.l.qty - x.keep) + ' 个，留 ' + x.keep + ' 个</span>' : '';
    return '<div class="line' + (x.ref ? ' is-ref' : cat === 'unsure' || lowAsk(x) ? ' is-uns' : '') + (view.focus === l.key ? ' focus' : '') + '" data-key="' + esc(l.key) + '">'
      + img
      + '<div><div class="title">' + title + '</div>'
      + (l.sku ? '<div class="sku">' + esc(l.sku) + '</div>' : '')
      + '<div class="why"><span class="via">' + viaLabel + '</span>' + esc(r.why || '') + (refPill ? ' ' + refPill : '') + '</div>'
 + '</div>'
      + '<div class="price num">' + yuan(l.price) + '<span class="q">× ' + (l.qty || 1) + '</span></div>'
      + '<div class="share num" title="按本单实付分摊到该商品的金额">' + yuan(x.share) + '<span class="l">分摊实付</span></div>'
      + '<div class="cls"><div class="pick">'
      + '<button data-set="lab" class="' + labCls + '" title="判为实验室（快捷键 1）">实验室</button>'
      + '<button data-set="personal" class="' + perCls + '" title="判为个人（快捷键 2）">个人</button></div>'
      + '<div class="meta">' + pill + lowPill(x)
      + (manual ? '<button class="linkbtn" data-set="auto" title="撤回为自动判断（快捷键 0）">撤回</button>' : '')
      + ((x.ref === 'refunded' && x.l.qty > 1) || x.keep != null ? '<button class="linkbtn" data-keep="1" title="同一商品购买 ' + x.l.qty + ' 个，订单页无法看出退款数量">' + (x.keep != null ? '修改保留数量' : '仅部分退款') + '</button>' : '')
      + '</div></div></div>';
  }

  // 低值品标签（只给单价超过 200 元的实验室商品）：深色「低值品」、浅色「耗材」、黄色「是否低值品？」；点一下在低值品 / 耗材间切换，
  // 按商品标题记住（S.lowval），同名商品以后自动沿用
  const LOW_PILL = { low: ['p-low', '低值品'], no: ['p-cons', '非低值品'], ask: ['p-lowask', '是否低值品？'] };
  // 待确认时显示「是否低值品？」加「是 / 否」两个选项，用户直接选；已确认的标签点一下在两者间切换
  const lowAskBtns = (attr, id) => '<span class="low-ask"><span class="pill p-lowask">是否低值品？</span>'
    + '<button type="button" class="pill p-low" ' + attr + '="' + esc(id) + '" data-lowv="low" title="单件超过 200 元的设备器械，需先开低值票（同名商品以后沿用）">是</button>'
    + '<button type="button" class="pill p-cons" ' + attr + '="' + esc(id) + '" data-lowv="no" title="不是低值品，按普通耗材报销（同名商品以后沿用）">否</button></span>';
  function lowPill(x) {
    if (x.ref || effCat(x) !== 'lab' || !x.low || !LOW_PILL[x.low.v]) return '';
    const [cls, label] = LOW_PILL[x.low.v], to = x.low.v === 'low' ? '非低值品' : '低值品';
    if (x.low.v === 'ask' && !x.low.fixed) return lowAskBtns('data-low', x.l.key);
    if (x.low.fixed) return '<span class="pill ' + cls + '" title="' + esc(x.low.why) + '">' + label + '</span>';
    return '<button type="button" class="pill ' + cls + '" data-low="' + esc(x.l.key) + '" title="' + esc(x.low.why + '。点击改为「' + to + '」（同名商品以后沿用）') + '">' + label + '</button>';
  }
  // 发票表、整理预览里一单（一张票）的低值品标签：待确认的几件一起改；没有待确认的，在低值品 / 耗材间切换
  function toggleLowOrder(no, want) {
    const xs = derived.rows.filter(x => x.o.no === no && !x.ref && effCat(x) === 'lab' && x.low && x.low.v && !x.low.fixed);
    if (!xs.length) return;
    const ask = xs.filter(x => x.low.v === 'ask'), v = want || (ask.length || !xs.some(x => x.low.v === 'low') ? 'low' : 'no');
    S.lowval = S.lowval || {};
    for (const x of ask.length ? ask : xs) S.lowval[N.norm(x.l.title)] = v;
    persist(); derive(); render();
    if ($('dlg-pack').open) renderPack();
    toast(v === 'low' ? '已确认为低值品（需先开低值票）' : '已确认不是低值品');
  }
  // 这单的发票明细（读发票 PDF 时记下的项目名称；整理报销文件时读到的也算）
  function invItemsOf(o) {
    const got = (X.dlDone[o.no] || []).concat(S.invFiles[o.no] || []);
    return got.map(g => { const c = fcOf(g) || packRead.get(baseOf(g.path)) || packRead.get(g.file); return c && c.items; }).filter(Boolean).join('；');
  }
  function toggleLow(key, want) {
    const x = derived.byKey.get(key);
    if (!x) return;
    const k = N.norm(x.l.title), prev = (S.lowval || {})[k];
    const v = want || (x.low && x.low.v === 'low' ? 'no' : 'low');
    S.lowval = S.lowval || {}; S.lowval[k] = v;
    undoStack.push({ type: 'low', key: k, prev });
    persist(); derive(); render();
    toast((v === 'low' ? '已确认为低值品（需先开低值票）' : '已确认不是低值品') + '：' + x.l.title.slice(0, 18), true);
  }

  // ── 操作 ──
  function setDecision(key, cat, opts) {
    const prev = S.decisions[key];
    const order = visibleRows().map(x => x.l.key);               // 改判后这件可能离开当前筛选：焦点落到原来它下面的那件
    if (cat === 'auto') delete S.decisions[key]; else S.decisions[key] = cat;
    undoStack.push({ type: 'dec', key, prev });
    persist(); derive();
    const moveOn = cat !== 'auto' && !(opts && opts.stay);
    if (moveOn) view.focus = nextUnsure(key, order) || view.focus;
    // 当前筛选里都判完、确认完了：切到下一个还有没确认的分类
    if (moveOn && view.sortStep) { const c = curCat(); if (c !== 'all' && !catLeft(c)) { view.cat = nextCat(); view.focus = null; } }
    render();
    const x = derived.byKey.get(key);
    toast((cat === 'auto' ? '已撤回为自动判断' : '已判为' + (cat === 'lab' ? '实验室' : '个人')) + (x ? '：' + x.l.title.slice(0, 18) : ''), true);
    if (moveOn) scrollToFocus();
  }
  function undo() {
    const u = undoStack.pop();
    if (!u) return;
    if (u.type === 'bulk') { for (const [k, v] of u.prev) { if (v === undefined) delete S.decisions[k]; else S.decisions[k] = v; } if (u.cat) view.cat = u.cat; }
    else if (u.type === 'low') { if (u.prev === undefined) delete S.lowval[u.key]; else S.lowval[u.key] = u.prev; }
    else { const box = u.type === 'dec' ? S.decisions : S.refunds; if (u.prev === undefined) delete box[u.key]; else box[u.key] = u.prev; }
    persist(); derive(); render();
    toast('已撤销');
  }
  // 快捷键 R：手动标记 / 取消退款。插件读不到退款的单（订单表仍写「交易成功」、订单列表上又找不到这单）由用户自己标
  function toggleRefund(key) {
    const x = derived.byKey.get(key);
    if (!x) return;
    const prev = S.refunds[key];
    const cur = prev === true || (prev === undefined && N.refundState(x.l, x.o) === 'refunded');
    S.refunds[key] = !cur;
    undoStack.push({ type: 'ref', key, prev });
    persist(); derive(); render();
    toast((cur ? '已取消退款标记' : '已标记为退款') + '：' + x.l.title.slice(0, 18), true);
  }
  // 一件买了几个、只退了其中几个：订单列表上只写「退款成功」看不出数量，用户说留下几个（0 = 全退了）
  function setKeep(key) {
    const x = derived.byKey.get(key);
    if (!x) return;
    const cur = S.partial && S.partial[key];
    const v = prompt('「' + x.l.title.slice(0, 20) + '」购买 ' + x.l.qty + ' 个，退款后实际保留几个？（全部退款填 0）', cur != null ? cur : '');
    if (v === null) return;
    const n = parseInt(v, 10);
    if (!(n >= 0 && n < x.l.qty)) { toast('请填写 0 至 ' + (x.l.qty - 1) + ' 的整数'); return; }
    S.partial = S.partial || {};
    if (n === 0) delete S.partial[key]; else S.partial[key] = n;
    persist(); derive(); render();
    toast(n ? '已记录：保留 ' + n + ' 个，按 ' + n + ' 个计算金额' : '已记录：全部退款');
  }
  // 「确认核对完成」：待定都判完后，把自动判断的也全部写成用户的判断，以后不再自动变更；然后显示下一步「处理发票」
  function confirmSort() {
    const live = derived.rows.filter(x => !x.past && !x.ref);
    if (live.some(x => effCat(x) === 'unsure' || lowAsk(x))) return;
    const rows = live.filter(x => S.decisions[x.l.key] !== effCat(x));
    const prev = rows.map(x => [x.l.key, S.decisions[x.l.key]]);
    rows.forEach(x => { S.decisions[x.l.key] = effCat(x); });
    undoStack.push({ type: 'bulk', prev });
    view.step = null;
    persist(); derive(); render();
    const n = { lab: 0, personal: 0 };
    live.forEach(x => n[effCat(x)]++);
    toast('核对完成：实验室 ' + n.lab + ' 件、个人 ' + n.personal + ' 件', true);
    window.scrollTo({ top: 0 });
  }
  // 「这 N 件都是实验室 / 个人，确认」：当前筛选里自动判断、还没确认的一次确认成这一类（Ctrl+Z 一次撤销整批），然后切到下一个还有没确认的分类
  function confirmCat() {
    const cat = curCat();
    if (cat !== 'lab' && cat !== 'personal') return;
    const rows = catRows(cat).filter(unconf);
    if (!rows.length) return;
    undoStack.push({ type: 'bulk', prev: rows.map(x => [x.l.key, S.decisions[x.l.key]]), cat });
    rows.forEach(x => { S.decisions[x.l.key] = cat; });
    persist(); derive();
    view.cat = nextCat(); view.focus = null;
    render();
    toast('已确认 ' + rows.length + ' 件为' + SORT_NAME[cat], true);
    window.scrollTo({ top: 0 });
  }
  function nextUnsure(fromKey, before) {
    const rows = visibleRows();
    const i = rows.findIndex(x => x.l.key === fromKey);
    if (i < 0 && before) {                                         // 这件已不在当前筛选里：取原来排在它后面、还在列表里的那件
      const p = before.indexOf(fromKey), left = new Set(rows.map(x => x.l.key));
      return before.slice(p + 1).find(k => left.has(k)) || before.slice(0, Math.max(p, 0)).reverse().find(k => left.has(k)) || null;
    }
    for (let j = i + 1; j < rows.length; j++) if (effCat(rows[j]) === 'unsure' && !S.decisions[rows[j].l.key]) return rows[j].l.key;
    for (let j = 0; j < i; j++) if (effCat(rows[j]) === 'unsure' && !S.decisions[rows[j].l.key]) return rows[j].l.key;
    return rows[i + 1] ? rows[i + 1].l.key : null;
  }
  function moveFocus(d) {
    const rows = visibleRows();
    if (!rows.length) return;
    let i = rows.findIndex(x => x.l.key === view.focus);
    i = i < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, i + d));
    view.focus = rows[i].l.key;
    renderList(); scrollToFocus();
  }
  function scrollToFocus() {
    const el = document.querySelector('.line.focus');
    if (el) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  // 出错、没办成的提示（导入时丢掉的订单号、二维码发票没下成的原因）不自动消失，点「关闭」才收起；其余按字数多留一会儿，最多 12 秒
  let toastTimer = null;
  const STICKY = /⚠|出错|失败|未导入|未下载/;
  // act：提示后面跟一个链接样式的操作 { label, title, fn }（如「停止」）
  function toast(msg, withUndo, act) {
    const t = $('toast'), sticky = STICKY.test(msg);
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (act ? ' <button class="linkbtn" id="toast-act" title="' + esc(act.title || '') + '">' + esc(act.label) + '</button>' : '')
      + (withUndo ? '<button id="toast-undo" title="撤销上一步操作（Ctrl+Z）">撤销</button>' : '')
      + (sticky ? '<button id="toast-x" title="关闭这条提示">关闭</button>' : '');
    if (act) $('toast-act').onclick = () => { t.hidden = true; act.fn(); };
    t.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { t.hidden = true; }, Math.min(12000, Math.max(3200, String(msg).length * 120)));
    const b = $('toast-undo');
    if (b) b.onclick = () => { t.hidden = true; undo(); };
    const x = $('toast-x');
    if (x) x.onclick = () => { t.hidden = true; };
  }

  // ── 导入 ──
  async function importFiles(files) {
    // 订单表先于抓取 JSON：抓取数据要挂到订单表上，顺序反了会被当成「没有订单表」去建单
    files.sort((a, b) => /\.json$/i.test(a.name) - /\.json$/i.test(b.name));
    const msgs = [], tableNos = new Set();
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        msgs.push(await importBuffer(buf, f.name, tableNos));
      } catch (e) {
        msgs.push(f.name + '：读取失败（' + e.message + '）');
      }
    }
    // 订单表降为可选（用户 2026-10-07）：订单主要从淘宝订单页读来，导入订单表只是合并——表里有的单以订单表字段为准
    // （mergeExport 换成表里的商品行，图片、退款从订单页那份补上，手动判断跟着挪），表里没有的、按订单页建的单照常保留。
    // 只去掉试用的示例订单
    if (tableNos.size) S.orders = S.orders.filter(o => !/^示例-/.test(o.no));
    persist(); derive();
    // 先抓图、后导入订单表的情况：把扩展里已有的抓取数据再并一次
    if (EXT) chrome.storage.local.get('scraped').then(r => mergeFromExt(r.scraped));
    if (!view.focus) { const u = derived.rows.find(x => effCat(x) === 'unsure'); if (u) view.focus = u.l.key; }
    render();
    toast(msgs.join('；'));
  }

  async function importBuffer(buf, name, tableNos) {
    if (/\.json$/i.test(name)) {
      const d = JSON.parse(new TextDecoder().decode(buf));
      if (d && d.format === 'order-triage-project') {
        if (S.orders.length && !confirm('载入项目文件将替换当前全部订单和判断，是否继续？\n\n建议先备份数据（更多 → 备份数据）。')) return name + '：已取消';
        S = Object.assign({ orders: [], decisions: {}, refunds: {}, rules: null, prefs: S.prefs, invoice: S.invoice, invFiles: {}, haveIdx: S.haveIdx || [] }, d.state);
        return name + '：已载入项目（' + S.orders.length + ' 单）';
      }
      const list = d && d.format === 'order-triage-scrape' ? d.orders : Array.isArray(d) ? d : null;
      if (!list) throw new Error('无法识别的 JSON 格式');
      const none = !S.orders.length;
      const r = N.mergeScraped(S.orders, list, { addNew: none, addRange: olderRange() });
      if (r.added && none) return name + '：尚无订单表，已按抓取数据建立 ' + r.added + ' 单';
      return name + '：匹配订单表 ' + r.matched + ' 单，补充图片 ' + r.filled + ' 件' + (r.added ? '，建立订单表之前的订单 ' + r.added + ' 单' : '')
        + (r.unmatched ? '，' + r.unmatched + ' 件在抓取数据中未找到对应商品' : '')
        + (r.skipped ? '；' + r.skipped + ' 单不在订单表中，已忽略' : '');
    }
    const rows = await T.read(buf, name);
    const incoming = N.rowsToOrders(rows);
    incoming.forEach(o => tableNos.add(o.no));
    const lost = incoming.dropped && incoming.dropped.length
      ? '。⚠ ' + incoming.dropped.length + ' 单无法读取商品，未导入：' + incoming.dropped.join('、') + '（请将订单表反馈给维护者）' : '';
    const r = N.mergeExport(S.orders, incoming);
    // 按抓取数据建的单换成订单表的写法后，商品的 key 变了，手动判断和退款标记跟着挪
    for (const [a, b] of Object.entries(r.keyMap))
      for (const box of [S.decisions, S.refunds, S.refundAmt, S.partial]) if (box && a in box) { box[b] = box[a]; delete box[a]; }
    return name + '：新增 ' + r.added + ' 单，更新 ' + r.updated + ' 单' + lost;
  }

  // 开发用：通过本地 http 服务打开时，?load=相对路径 直接读同源文件（不支持外部网址）
  async function devLoad() {
    if (!/^https?:$/.test(location.protocol)) return;
    const ps = new URLSearchParams(location.search).getAll('load');
    const files = [];
    for (const p of ps) {
      const u = new URL(p, location.href);
      if (u.origin !== location.origin) continue;
      const res = await fetch(u);
      if (!res.ok) continue;
      const blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(u.pathname.split('/').pop())));
    }
    if (files.length) await importFiles(files);
  }

  // ── 发票 ──
  // 要报销的订单：至少有一件判成实验室且没退款。发票按整单开，金额用本单实付
  // 要开发票的：实验室的、没退掉的、上次报销之后的；还要「交易成功」（用户 2026-10-05：右上角写交易成功的才报销，没确认收货的先不算），
  // 补图时在订单列表里找不到的（多半是删进回收站了，没有交易争议）也不要发票
  const doneDeal = o => /交易成功|交易完成/.test(o.statusLive || o.status || '');
  // wantGone：只要被当成删进回收站的那几单（发票表里单独一组灰色「已视为删除」，不开票）
  function invOrders(wantGone) {
    const by = new Map(), gone = new Set(X.goneNos || []);
    for (const x of derived.rows) {
      if (effCat(x) !== 'lab' || x.ref || x.past || !doneDeal(x.o) || gone.has(x.o.no) !== !!wantGone) continue;
      const g = by.get(x.o.no) || { o: x.o, lines: [] };
      g.lines.push(x.l); by.set(x.o.no, g);
    }
    return [...by.values()];
  }
  // 发票表空着时说清楚为什么：实验室订单还没点确认收货（不是「交易成功」）、已退款的都不进发票表，新人会以为漏读了
  function emptyInvWhy() {
    const why = new Map();
    for (const x of derived.rows) {
      if (x.past || effCat(x) !== 'lab') continue;
      const r = why.get(x.o.no) || { ref: true, deal: doneDeal(x.o) };
      if (!x.ref) r.ref = false;
      why.set(x.o.no, r);
    }
    if (!why.size) return '暂无判为实验室的订单（在「核对商品」中判断）';
    const rs = [...why.values()], nDeal = rs.filter(r => !r.deal && !r.ref).length, nRef = rs.filter(r => r.ref).length;
    return '实验室订单 ' + why.size + ' 单：' + [nDeal ? nDeal + ' 单尚未交易成功（确认收货后才报销）' : '', nRef ? nRef + ' 单已退款或关闭' : ''].filter(Boolean).join('，');
  }
  const shopKey = s => String(s || '').replace(/\s+/g, '');
  // 这单的聊天：右侧「我的订单」里有这个订单号的会话优先，否则店名完全一样的会话（会话名是聊天窗口顶上的全名）。
  // 一家店几单共用一个会话：再按我们要发票时写的订单号，把对方的回复分到这一单（分不清的标 shared）
  function chatOf(o) {
    const convs = (X.chatScan && X.chatScan.convs) || {};
    const e = Object.entries(convs);
    // 会话名常常是卖家旺旺名（个人卖家多是自己的名字），和店名对不上：店名、旺旺名都认
    const hit = e.find(([, c]) => (c.orders || []).includes(o.no))
      || e.find(([name]) => shopKey(name) && (shopKey(name) === shopKey(o.shop) || (o.nick && shopKey(name) === shopKey(o.nick))));
    if (!hit) return null;
    // 只数这家店还没解决的单：已整理过、已下载的不算，不然只剩一单要发票也会被当成「分不清是哪单」
    const peers = invOrders().filter(x => (shopKey(x.o.shop) === shopKey(o.shop) || (hit[1].orders || []).includes(x.o.no)) && !settled(x.o));
    if (!peers.some(x => x.o.no === o.no)) peers.push({ o, lines: o.lines });
    // 开票卡片按商品标题归单：给出这家店还没解决的几单的商品标题
    const titled = peers.map(x => ({ no: x.o.no, time: x.o.time, titles: x.lines.map(l => l.title) }));
    // 按旺旺名打开的老会话：右侧「我的订单」里看不到这一单时，不确定是不是这单的卖家，交给用户核对
    const unsure = hit[1].byNick && hit[1].matched === false ? { shared: true } : {};
    return Object.assign({ name: hit[0], nick: hit[1].byNick || '' }, I.chatForOrder(hit[1], o.no, peers.length - (settled(o) ? 1 : 0) || 1, o.time, titled), unsure);
  }
  const platOf = o => X.invSync && X.invSync.rows && X.invSync.rows[o.no];
  // 已整理的发票和订单一对一配（I.matchHave）；订单、同步结果、已整理的发票变了才重配
  // S.packed：插件「整理报销文件」整理过的订单 → { file: 报销文件夹里的文件, invNo }（以后不再整理、不再索要）。
  // 它们的票和单已经一一对上，不再参加按金额的对单（不然同金额的另一单会被认成「疑似已整理」）
  let haveCache = { key: '', have: new Map(), contested: new Map() };
  function haveMatch() {
    const packed = S.packed || {};
    const key = S.orders.length + '|' + (S.haveIdx || []).length + '|' + ((X.invSync && X.invSync.at) || 0) + '|' + Object.keys(S.refundAmt || {}).length
      + '|' + Object.keys(S.refunds || {}).length + '|' + Object.keys(packed).length;
    if (haveCache.key !== key) {
      const byNo = new Map(S.orders.map(o => [o.no, o]));
      const used = new Set(Object.values(packed).map(p => p.invNo).filter(Boolean));
      haveCache = Object.assign({ key }, I.matchHave((S.haveIdx || []).filter(x => !used.has(x.invNo)),
        S.orders.filter(o => !packed[o.no]).map(o => ({ no: o.no, time: o.time, amount: dueOf(o) })), no => platOf(byNo.get(no))));
    }
    return haveCache;
  }
  const haveOf = o => (S.packed && S.packed[o.no] ? { file: S.packed[o.no].file } : null) || haveMatch().have.get(o.no)
      || ((S.haveNos || []).includes(o.no) ? { file: '（导入的已报销订单号清单）' } : null);
  const settled = o => !!haveOf(o) || !!(X.dlDone[o.no] || []).length || !!(S.invFiles[o.no] || []).length;
  function invStatus(x) {
    const o = x.o;
    const plat = platOf(o);
    const got = (X.dlDone[o.no] || []).concat(S.invFiles[o.no] || []);
    const have = haveOf(o);
    const st = I.status({ plat, chat: chatOf(o), got, have, canApply: o.inv === '申请开票', cardApplied: (X.cardApplied || {})[o.no] }, { title: S.invoice.title });
    // 「全部发票 → 未申请」里有、批量开票页上却没有的单：平台开不了（2026-10 实测），要找卖家
    const cs = !have && haveMatch().contested.get(o.no);
    if (cs && ['ask', 'apply', 'asked'].includes(st.key))
      return { key: 'check', base: st.key, label: '疑似已整理，请核对', detail: '已整理的发票中有同金额的：' + cs.map(x => x.file).join('、') + '（多单对应同一张或一单对应多张，插件不做推断）' };
    if (st.key === 'apply' && noPlatformOf(o)) return chatFailOr(o, askedOr(o, { key: 'ask', label: I.LABEL.ask, detail: '批量开票页中无此订单，无法在平台开票' }));
    return withBatch(o, withCardFail(o, withVip(o, withCheck(o, chatFailOr(o, askedOr(o, rejectedOnly(o, st)))))));
  }
  // 插件整理过的单：写明是哪一批（「已整理（第 3 批）」）
  function withBatch(o, st) {
    const p = st.key === 'have' && S.packed && S.packed[o.no], b = p && p.batch && (S.batches || []).find(x => x.id === p.batch);
    return b ? Object.assign({}, st, { label: '已整理（' + b.name + '）' }) : st;
  }
  // 上次读旺旺时这家的会话没读成（点不开、读不出）、又从没读到过：标成「旺旺会话未能读取」，不当成「需向卖家索要」（免得把问过的店再问一遍）
  function chatFailOr(o, st) {
    if (st.key !== 'ask' || chatOf(o)) return st;
    const f = ((X.chatScan && X.chatScan.failed) || []).find(x => (x.nos || []).includes(o.no));
    return f ? { key: 'chatfail', label: '旺旺会话未能读取', detail: (f.name ? f.name + '：' : '') + f.why } : st;
  }
  // 按卖家开票入口申请没成功的：在说明里写上原因
  function withCardFail(o, st) {
    const r = (X.cardResult || {})[o.no];
    return st.key === 'card' && r && !r.ok ? Object.assign({}, st, { detail: st.detail + ' · 上次按入口申请未完成：' + r.why }) : st;
  }
  // 插件帮着发过要发票的消息（askSent，旺旺页记的）：还在「需向卖家索要」或「卖家要邮箱」的，改成「已向卖家索要，等待回复」。
  // 下次扫描旺旺时这条消息会被认成「要过发票」，之后卖家发来的文件照常认
  const needsMsg = st => st.key === 'ask' || (st.key === 'replied' && !!st.email);
  function askedOr(o, st) {
    const t = (X.askSent || {})[o.no];
    if (!t || !needsMsg(st)) return st;
    // 扫描没认出这条消息也不推翻（2026-10-04 扫描读漏过一次，几家店变回「需找卖家」，差点重复去问）
    return { key: 'asked', label: I.LABEL.asked, detail: '插件发送于 ' + new Date(t).toLocaleString('zh-CN') };
  }
  // 要给卖家发消息的：需找卖家、或卖家回来要邮箱的。按卖家合并，一家一条
  function askList() {
    const by = new Map(), noNick = new Set(), noNickOrders = [];
    for (const x of invOrders()) {
      const st = invStatus(x);
      if (!needsMsg(st)) continue;
      const o = x.o;
      if (!o.nick) { noNick.add(o.shop); noNickOrders.push(o); continue; }
      const g = by.get(o.nick) || { nick: o.nick, shop: o.shop, orders: [] };
      g.orders.push({ no: o.no, date: (o.time || '').slice(0, 10), amount: dueOf(o), p3d: needOf([x]).p3d,
        lines: x.lines.map(l => ({ title: l.title, img: l.img || '', qty: l.qty || 1 })) });
      by.set(o.nick, g);
    }
    const tpl = S.invoice.template || I.DEFAULT_TEMPLATE;
    // 3D 打印订单：在原消息末尾追加一句索要明细清单（报销要附；原消息一个字不改）
    const items = [...by.values()].map(g => Object.assign(g, { nos: g.orders.map(o => o.no),
      msg: I.renderMsg(tpl, { orders: g.orders, title: S.invoice.title, taxId: S.invoice.taxId, email: S.invoice.email }) + (g.orders.some(o => o.p3d) ? RB.ASK_3D : '') }));
    return { items, noNick: [...noNick], noNickOrders };
  }
  // 逐家打开卖家聊天、把消息填进输入框，用户核对后自己点「发送」（插件不替用户发）；发完自动开下一家
  // 抬头和税号没填：要发票的动作一律先停下，提示去设置里填
  function needInvoiceInfo() {
    if (S.invoice.title && S.invoice.taxId) return false;
    toast('请先在「设置 → 发票信息」中填写发票抬头和税号');
    openSettings();
    return true;
  }
  // 名单上的每一单都先去订单详情页看一眼：卖家旺旺名、是不是已经退款了；返回要发消息的店铺（每家一条）
  async function prepareAsk() {
    const pre = askList();
    await inspectOrders(pre.items.flatMap(g => g.nos).concat(pre.noNickOrders.map(o => o.no)).map(no => S.orders.find(o => o.no === no)).filter(Boolean));
    return askList();
  }
  // 清单里每家一行：店铺、订单、要发的话
  const askRows = items => items.map(g => '<b>' + esc(g.shop) + '</b><span class="detail">' + g.orders.map(o => esc(o.date) + ' ' + esc(yuan(+o.amount)) + ' ' + esc(o.no)).join('；') + '</span>'
    + '<span class="ask-msg">' + esc(g.msg) + '</span>');
  // 已确认的店铺：旺旺页（extension/chat.js）逐家打开会话、核对属于该店铺后自动发送，每家间隔数秒；等它发完（chatQueue 清掉），超时就停掉队列。
  // auto=false 是填好、由用户自己点发送的写法：发票表里逐单的「索要发票」「催卖家」（follow = 催促的那句）用它；
  // 离线测试也用它核对「切到别家会清掉输入框」等安全检查。返回 { n: 发出的家数, timeout }
  // 自动发送这一轮带编号（id）：主页等待期间每两秒写一次 askBeat，旺旺页只在编号对得上、主页还在等时才接管、自动发送，
  // 写回进度前也核对编号——主页关了、刷新了、超时了，留下的队列不会在用户之后打开这家会话时自己发出去。
  // 旺旺页要用户处理时（会话确认不了、输入框里有别的字、自动发送没成功）写 chatQueue.waiting，主页进度里用一句话说明（w）
  const CHAT_STAGES = ['chat', 'scan', 'chatDownload', 'ask'];
  // 等旺旺页时顺便看：旺旺页被新开的旺旺页顶掉了（chatLost，background.js 写）、旺旺页报了失败（jobFail）——有就返回原因
  async function chatTrouble(t0) {
    const { chatLost, jobFail } = await chrome.storage.local.get(['chatLost', 'jobFail']);
    if (chatLost && chatLost.at >= t0) return chatLost.why;
    if (failHits(jobFail, t0, CHAT_STAGES)) return jobFail.why;           // 含旺旺页被关掉
    return '';
  }
  async function doAsk(sel, auto, follow, w) {
    if (!sel.length) return { n: 0 };
    const t0 = Date.now(), id = 'a' + t0.toString(36) + Math.random().toString(36).slice(2, 6), isAuto = auto !== false;
    if (isAuto) await chrome.storage.local.set({ askBeat: { id, t: t0 } });
    await chrome.storage.local.set({ chatQueue: { id, at: t0, kind: 'compose', auto: isAuto, follow: !!follow, items: sel, done: 0, sent: [], skipped: [], taxId: S.invoice.taxId,
      waitMs: tmo('askWait', isAuto ? 3 * 60000 : 30 * 60000) } });
    chrome.runtime.sendMessage({ type: 'openJobTab', url: chatUrl(sel[0].nick) });
    if (!isAuto) return { n: sel.length };
    let why = '';
    const ok = await until(async () => {
      const { chatQueue: q } = await chrome.storage.local.get('chatQueue');
      if (!q || q.id !== id) return true;
      await chrome.storage.local.set({ askBeat: { id, t: Date.now() } });
      if ((why = await chatTrouble(t0))) return true;
      if (w) w(q.waiting ? '旺旺页等待处理：' + q.waiting.shop + '（' + q.waiting.why + '），请切到旺旺页处理或点「跳过此店」'
        : '旺旺页逐家核对会话后发送，每家间隔 8～15 秒（第 ' + Math.min(q.done + 1, sel.length) + ' / ' + sel.length + ' 家）');
      return false;
    }, tmo('ask', (sel.length * 240 + 120) * 1000), 2000);         // 每家最多等用户 3 分钟，加上打开、发送的时间
    await chrome.storage.local.remove('askBeat');
    // 超时、出错：停掉剩下的（删掉这一轮的队列），免得之后在别的步骤用旺旺页时它还在接着发
    const { chatQueue: left } = await chrome.storage.local.get('chatQueue');
    if (left && left.id === id) await chrome.storage.local.remove('chatQueue');
    return { n: sel.filter(g => g.nos.some(no => ((X.askSent || {})[no] || 0) >= t0)).length, timeout: !ok, why };
  }
  // 发票状态的颜色（图例在发票栏顶上，见 index.html .inv-legend）：
  //   ok 绿 已取得 / info 紫 已开具待取得 / plat 蓝 已进入淘宝开票流程 / wait 黄 等待卖家回复 / urge 青 已由淘宝客服督促 / bad 红 需处理 / off 灰 无需开票
  //   off 只给退款的单用，invOrders 已排除退款商品，发票栏里实际不出现，所以图例里没有它
  const TONE = { have: 'ok', done: 'ok', ready: 'info', paper: 'info', replied: 'info', applying: 'plat', asked: 'wait', urged: 'urge',
                 card: 'bad', apply: 'bad', ask: 'bad', wrong: 'bad', check: 'bad', badinv: 'bad', chatfail: 'bad', none: 'off', gone: 'off' };
  const WAIT_TONES = ['plat', 'wait', 'urge'];
  // 下载的票读出来有问题，要用户核对：少了 1 元以上、金额对不上、分不清、抬头不符、读不出金额（扫描版的真发票也读不出，所以不直接判成「不是发票」）、没能取回核对
  const BAD_CHECK = ['short', 'amount', 'many', 'title', 'unread', 'error'];
  function invTone(o, st) {
    if (st.key === 'replied' && (st.shared || needsMsg(st))) return 'bad';     // 分不清是哪单的、卖家要邮箱的
    return TONE[st.key] || 'off';
  }
  // ── 状态标签可点：去这个状态对应的地方（用户 2026-10-05）。用户自己点开的页面插件不会关 ──
  const invDetailUrl = no => 'https://invoice-ua.taobao.com/detail/pc#/?orderId=' + no;
  // 已由淘宝客服督促的单：打开淘宝投诉记录。具体某一单的投诉在电脑网页上看不到（只能在手机淘宝里看），所以打开投诉总表（用户 2026-10-05）
  const complaintUrl = o => 'https://rights.taobao.com/complaint/buyerList.htm';
  const CHAT_TIP = '打开与该店铺的旺旺聊天', INV_TIP = '打开本单的淘宝发票详情页';
  const PILL_GO = {
    asked: ['chat', CHAT_TIP], ask: ['chat', CHAT_TIP], replied: ['chat', CHAT_TIP + '，查看卖家发送的内容'],
    card: ['chat', CHAT_TIP + '，查看卖家发送的开票申请入口'],
    // 「抬头不符」不放在这里：操作列的「换开发票」打开的就是同一个发票详情页，留一个入口（用户 2026-10-08）
    applying: ['inv', INV_TIP + '（开票进度、商家剩余处理时间）'], ready: ['inv', INV_TIP], paper: ['inv', INV_TIP],
    urged: ['complaint', '打开淘宝投诉记录（投诉总表；单笔投诉详情仅能在手机淘宝查看）'],
    apply: ['batch', '打开淘宝「批量开票」页'],
  };
  function stPill(o, s) {
    const cls = 'st st-' + s.key + ' tone-' + invTone(o, s), go = PILL_GO[s.key];
    if (!go) return '<span class="' + cls + '">' + esc(s.label) + '</span>';
    return '<button type="button" class="' + cls + ' st-go" data-go="' + go[0] + '" data-no="' + esc(o.no) + '" title="' + esc(go[1]) + '">' + esc(s.label) + '</button>';
  }
  function openUrl(url) {
    if (EXT) chrome.tabs.create({ url, active: true });
    else window.open(url, '_blank', 'noopener');
  }
  function goStatus(kind, no) {
    const o = S.orders.find(x => x.no === no);
    if (!o) return;
    if (kind === 'chat') openChat(no).catch(err => toast('出错：' + err.message));
    else if (kind === 'inv') openUrl(invDetailUrl(no));
    else if (kind === 'complaint') openUrl(complaintUrl(o));
    else if (kind === 'batch') openUrl(BATCH_URL);
  }
  const whenShort = t => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // ── 发票表每行的「操作」：按状态只给一个主要操作（用户 2026-10-08：一条主线；用户点了这一单的按钮，就算确认了这一单）──
  //   已向卖家索要、等回复 → 催卖家（超过设定天数的 → 找客服督促）；已申请淘宝开票 / 已由客服督促 → 找客服督促；
  //   已开具待下载、卖家已发文件 → 下载；需处理（红）→ 对应的处理动作；已下载、已整理、纸质发票 → 没有
  const ACT_TIP = {
    ask: '打开与该店铺的旺旺会话，在输入框填好索要发票的消息（不发送），请核对后点「发送」',
    nudge: '打开与该店铺的旺旺会话，在输入框填好一句催开票的话（不发送），请核对后点「发送」',
    vip: '打开淘宝官方客服，转人工后发送本单的督促消息（客服提出投诉商家等后续照常跟进）；点击即确认对本单执行',
    card: '打开卖家发来的开票卡片，点「去申请」；申请页的订单号和抬头核对一致才提交。点击即确认对本单执行',
    apply: '打开淘宝「批量开票」页勾选本单并核对抬头，停在确认页，核对后在淘宝页点「确认提交」',
    dl: '下载本单已开具的发票（卖家发送的文件、二维码发票、平台发票），按订单命名存入「订单分拣-发票」',
    inv: '打开本单的淘宝发票详情页：抬头与设置不符，请在该页申请换开',
    chat: '打开与该店铺的旺旺聊天，请卖家核对发票（下载的 PDF 核对不通过）',
    open: '打开与该店铺的旺旺聊天：上次读取卖家回复时未能打开这个会话；下次「自动处理发票」会重新读取',
  };
  function rowAction(x, s, isLate) {
    const k = s.key === 'check' ? s.base : s.key, A = (act, label) => ({ act, label, tip: ACT_TIP[act] });
    if (k === 'ask') return A('ask', '索要发票');
    if (k === 'replied' && s.email) return A('ask', '回复邮箱');
    if (k === 'asked') return isLate ? A('vip', '找客服督促') : A('nudge', '催卖家');
    if (k === 'applying' || k === 'urged') return A('vip', '找客服督促');
    if (k === 'card') return A('card', '按入口申请');
    if (k === 'apply') return A('apply', '申请开票');
    if (k === 'ready' || k === 'replied') return A('dl', '下载');
    if (k === 'wrong') return A('inv', '换开发票');
    if (k === 'badinv') return A('chat', '联系卖家');
    if (k === 'chatfail') return A('open', '打开旺旺');
    return null;
  }
  // 逐单操作：设好这一单的活、打开对应的淘宝页面就返回（不占住主页）；结果由各页面写回，主页照常刷新状态
  async function rowAct(act, no) {
    const x = invOrders().find(g => g.o.no === no);
    if (!x) return;
    if (isSample(no)) { toast(SAMPLE_TIP); return; }
    if (!await freeForUser()) return;
    if (['ask', 'nudge', 'vip', 'card', 'apply'].includes(act) && needInvoiceInfo()) return;
    const o = x.o, who = o.shop + '（' + (o.time || '').slice(0, 10) + '，' + yuan(+o.pay) + '）';
    alog('start', 'row-' + act, who + ' ' + no);
    if (act === 'inv') return openUrl(invDetailUrl(no));
    if (act === 'chat' || act === 'open') return openChat(no);
    if (act === 'ask' || act === 'nudge') {
      if (!o.nick) await inspectOrders([o]);                 // 顺便核对是不是已经整单退款
      if (!invOrders().some(g => g.o.no === no)) return;      // 整单退款了：inspectOrders 已提示
      if (!o.nick) { toast('未读取到卖家旺旺名，已打开订单详情页，请在该页点击旺旺图标联系卖家'); openDetail(no); return; }
      const g = act === 'ask' ? askList().items.find(it => it.nos.includes(no)) : null;
      const item = g || { nick: o.nick, shop: o.shop, nos: [no], orders: [{ no, date: (o.time || '').slice(0, 10), amount: dueOf(o),
        lines: x.lines.map(l => ({ title: l.title, img: l.img || '', qty: l.qty || 1 })) }] };
      if (!g) item.msg = I.renderMsg(act === 'nudge' ? I.FOLLOW_TEMPLATE : (S.invoice.template || I.DEFAULT_TEMPLATE),
        { orders: item.orders, title: S.invoice.title, taxId: S.invoice.taxId, email: S.invoice.email }) + (act === 'ask' && needOf([x]).p3d ? RB.ASK_3D : '');
      await doAsk([item], false, act === 'nudge');
      toast('已打开与 ' + o.shop + ' 的旺旺会话：' + (act === 'nudge' ? '催促消息' : '索要发票的消息') + '填好后请核对，再点「发送」');
      return;
    }
    if (act === 'vip') {
      const r = invReminder(), e = r && [...r.g.platform, ...r.g.seller, ...r.g.you].find(y => y.o.no === no);
      const days = e && e.days != null ? e.days : daysSince(o.time);
      toast('已打开淘宝官方客服：转人工后发送 ' + who + ' 的督促消息');
      doVip([{ o, lines: x.lines, st: invStatus(x), days }]).then(n => toast(n ? '已请淘宝客服督促：' + who : '督促消息未发出（' + (doVip.why || '未能转接人工客服或超时') + '），可稍后再试'));
      return;
    }
    if (act === 'card') {
      toast('正在按卖家的开票入口申请：' + who);
      runCards([x]).then(out => toast(out.map(r => r.text).join('；')));
      return;
    }
    if (act === 'apply') { await doApply([x]); toast('已打开淘宝「批量开票」页：勾选本单并核对抬头后停在确认页，请核对后点击「确认提交」'); return; }
    if (act === 'dl') {
      const r = await startDownloads([no]), c = chatOf(o);
      toast(r.n ? '正在下载 ' + who + ' 的发票（' + r.n + ' 个文件）' : r.busy ? '这单的发票已在下载中'
        : c && !c.files.length && c.images.length ? '卖家发送的图片中没有可识别的税务局发票二维码，请在旺旺中查看' : '没有找到可下载的文件，请先「自动处理发票」刷新发票情况');
    }
  }
  // 状态下面的说明：文件名逐个单行（放不下用省略号，悬停看全名）；有悬停详情的（督促过的）只显示一行要点
  function stDetail(s) {
    const one = (t, tip) => '<div class="detail one" title="' + esc(tip || t) + '">' + esc(t) + '</div>';
    if (s.files && s.files.length) return s.files.map(f => one(f)).join('') + (s.checks ? '<div class="detail">' + esc(s.checks) + '</div>' : '');
    if (s.tip) return one(s.detail, s.tip);
    return s.detail ? '<div class="detail">' + esc(s.detail) + '</div>' : '';
  }
  const invOpen = { todo: true, ready: true, done: false, gone: false };      // 已下载的、已视为删除的默认收起
  // 读订单时这次翻过的日期范围里、订单列表上根本没出现过的单（goneNos）：多半已删进回收站，不开票；单独一组灰色标签，便于核对
  const GONE_ST = { key: 'gone', label: '已视为删除', detail: '读取订单时订单列表中未出现这一单（多半已删除进回收站），不开票' };
  function renderInvoice() {
    if (!EXT) {
      $('list').innerHTML = '<div class="none">发票功能需安装为 Chrome 扩展后使用：扩展读取淘宝「全部发票」和旺旺中的开票情况并下载发票，详见 README。</div>';
      return;
    }
    const q = view.q.trim().toLowerCase();
    const hit = x => !q || (x.o.no + ' ' + x.o.shop + ' ' + x.lines.map(l => l.title).join(' ')).toLowerCase().includes(q);
    const goneList = invOrders(true).filter(hit);
    const list = invOrders().filter(hit).concat(goneList).sort((a, b) => (b.o.time || '').localeCompare(a.o.time || ''));
    const st = new Map(list.map(x => [x.o.no, goneList.includes(x) ? GONE_ST : invStatus(x)]));
    // 主线按钮「自动处理发票」在上方步骤说明里；这里放颜色图例和上次刷新的时间，每行的「操作」列按状态给一个主要操作
    $('inv-note').innerHTML = (S.invoice.title && S.invoice.taxId ? '' : '<span class="warn">请先在「设置」中填写发票抬头和税号。</span>')
      + (X.invSync ? '上次刷新 ' + esc(whenShort(X.invSync.at)) : '尚未刷新发票情况')
      // 「我的发票」页有标签没读完（改版、加载慢）：红色标签说明，这次的结果不完整
      + (X.invSync && X.invSync.partial ? ' <span class="pill tone-bad" title="「我的发票」页的已开具、申请中、未申请三个标签没有全部读完，未读完的沿用上次结果；可能是页面改版或加载慢">仅读取 '
        + (X.invSync.tabs != null ? X.invSync.tabs : '部分') + ' / 3 个标签</span>' : '');
    if (!list.length) { $('list').innerHTML = '<div class="none">' + esc(q ? '没有符合条件的订单' : emptyInvWhy()) + '</div>'; return; }
    const late = new Set(((invReminder() || {}).late || []).map(r => r.o.no));
    // 几张表列宽一样，上下对得齐；订单号 19 位一行放下
    const HEAD = '<div class="tbl-wrap"><table class="inv-table"><colgroup><col style="width:72px"><col style="width:104px"><col style="width:200px"><col>'
      + '<col style="width:92px"><col style="width:250px"><col style="width:180px"></colgroup><thead><tr><th></th><th>下单日期</th><th>店铺 / 订单号</th><th>实验室商品</th><th style="text-align:right">实付</th><th>发票</th><th>操作</th></tr></thead><tbody>';
    const rowHtml = x => {
        const o = x.o, s = st.get(o.no), c = chatOf(o);
        const acts = [], a = rowAction(x, s, late.has(o.no));
        if (a) acts.push('<button type="button" class="btn sm" data-act="' + a.act + '" data-no="' + esc(o.no) + '" title="' + esc(a.tip) + '">' + a.label + '</button>');
        // 卖家发到邮箱的发票、要补的附件（支付记录截图、用途说明、3D 打印明细）只能用户自己挂上：次要操作，小字链接，一个入口（插件按文件判断是发票还是附件）
        const mat = s.key === 'gone' || s.key === 'have' ? null : matOf(x), needA = !!(mat && mat.miss.length);
        if (s.key !== 'gone') acts.push('<label class="add" title="' + (needA ? '选择文件：发票（PDF、OFD）按本单命名存入「订单分拣-发票」；支付记录截图、用途说明、3D 打印明细等存为本单附件，整理报销文件时放入「附件原图」'
          : '选择 PDF 文件（如卖家发送到邮箱的发票），按本单命名复制到下载文件夹的「订单分拣-发票」') + '">' + (needA ? '手动添加发票 / 附件' : '手动添加发票')
          + '<input type="file" accept="' + (needA ? '.pdf,.ofd,.xml,.png,.jpg,.jpeg,.xlsx,.xls,.csv,.doc,.docx' : '.pdf,.ofd,.xml') + '" data-inv="attach" data-no="' + esc(o.no) + '" hidden></label>');
        const okImg = u => /^https:\/\/([\w-]+\.)*(alicdn|taobao|tbcdn|tmall)\.com\//.test(u);
        const imgs = s.key === 'replied' && c && !c.files.length && c.images.length
          ? c.images.slice(-2).filter(im => okImg(im.src)).map(im => '<div><img class="qr" alt="卖家发送的图片" referrerpolicy="no-referrer" crossorigin="anonymous" data-qr="1" src="' + esc(im.src) + '"><div class="detail" data-qr-out></div></div>').join('') : '';
        const pic = x.lines.find(l => l.img);
        const t = x.lines[0].title;
        return '<tr><td>' + detailA(o.no, thumbHtml(pic && pic.img, 'inv-thumb'), 'thumb-a') + '</td>'
          + '<td class="d num">' + esc((o.time || '').slice(0, 10)) + '</td>'
          + '<td class="who"><div class="shop">' + esc(o.shop || '未知店铺') + wwBtn(o) + '</div><div class="detail ono">' + esc(o.no) + '</div></td>'
          + '<td>' + detailA(o.no, esc(t.length > 26 ? t.slice(0, 26) + '…' : t)) + (x.lines.length > 1 ? ' 等 ' + x.lines.length + ' 件' : '') + '</td>'
          + '<td class="amt num">' + yuan(o.pay) + '</td>'
          + '<td class="st-cell">' + stPill(o, s) + stDetail(s) + (mat ? matTags(x) : '') + imgs + '</td>'
          + '<td><div class="acts">' + acts.join('') + '</div></td></tr>';
    };
    const SECT = [['todo', '未开票'], ['ready', '已开票，待下载'], ['done', '已下载'], ['gone', '已视为删除']];
    $('list').innerHTML = SECT.map(([g, name]) => {
      const xs = list.filter(x => INV_GROUP[st.get(x.o.no).key] === g);
      if (!xs.length) return '';
      return '<details class="inv-sect" data-sect="' + g + '"' + (invOpen[g] ? ' open' : '') + '><summary>' + name + '<span class="c">（' + xs.length + '）</span></summary>'
        + HEAD + xs.map(rowHtml).join('') + '</tbody></table></div></details>';
    }).join('');
    for (const d of $('list').querySelectorAll('details.inv-sect')) d.addEventListener('toggle', () => { invOpen[d.dataset.sect] = d.open; });
    decodeQrs();
  }
  // 卖家发来的图片：第一步看是不是二维码（jsQR 在本机读像素），是就读出里面的地址——只显示，不自动打开；
  // 读像素要先把图拿到手：扩展里靠 manifest 的 alicdn 权限；网页版拿不到跨站图片的像素，只能提示用手机扫
  const imgCache = new Map();
  async function imgData(src) {
    if (imgCache.has(src)) return imgCache.get(src);
    const blob = await (await fetch(src)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const r = { data: g.getImageData(0, 0, bmp.width, bmp.height), blob };
    imgCache.set(src, r);
    return r;
  }
  function decodeQrs() {
    for (const img of document.querySelectorAll('img[data-qr]')) {
      const out = img.parentElement.querySelector('[data-qr-out]');
      imgData(img.src).then(({ data }) => {
        const q = window.jsQR && window.jsQR(data.data, data.width, data.height);
        if (q && q.data) { out.textContent = '二维码内容：' + q.data + '（请核对后再打开）'; return; }
        out.textContent = '不是二维码';
      }).catch(() => { out.textContent = '无法读取图片像素，请用手机扫描'; });
    }
  }

  // ── 读发票 PDF（vendor/pdfjs，第一次用到才加载，1.7 MB）──
  let pdfjsP = null;
  function pdfjs() {
    if (!pdfjsP) pdfjsP = import(new URL('vendor/pdfjs/pdf.min.mjs', location.href).href).then(m => {
      m.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
      return m;
    });
    return pdfjsP;
  }
  async function readInvoicePdf(file) {
    const lib = await pdfjs();
    // cMap：有的发票用没嵌进文件的中文字体（如 STSong-Light-UniGB-UCS2-H），没有这些对照表 PDF.js 会把用它写的号码、金额全跳过（2026-09 实测）
    const task = lib.getDocument({ data: await file.arrayBuffer(), cMapUrl: new URL('vendor/pdfjs/cmaps/', location.href).href, cMapPacked: true });
    let t = '';
    try {
      const doc = await task.promise;
      for (let p = 1; p <= Math.min(doc.numPages, 3); p++) t += (await (await doc.getPage(p)).getTextContent()).items.map(x => x.str).join(' ') + '\n';
    } finally { task.destroy(); }                        // PDF.js 6：关文档要关「加载任务」，文档对象上已经没有 destroy 了
    return Object.assign(I.parseInvoiceText(t, S.invoice.title), { file: file.webkitRelativePath || file.name, noInv: I.notInvoiceText(t) });
  }
  async function readPdfFolder(files, what) {
    const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name));
    const got = [], notInv = [];
    for (let i = 0; i < pdfs.length; i++) {
      if (i % 10 === 0) toast('正在读取' + what + '：' + i + ' / ' + pdfs.length + ' 个 PDF');
      try { const r = await readInvoicePdf(pdfs[i]); (r.isInvoice && r.amount != null ? got : notInv).push(r); }
      catch (e) { console.warn('[订单分拣] 读 PDF 出错', pdfs[i].name, e); notInv.push({ file: pdfs[i].webkitRelativePath || pdfs[i].name, err: e.message }); }
    }
    return { got, notInv, total: pdfs.length };
  }
  // 已整理的发票文件夹 → 索引（同一张发票在几个子文件夹里都有，按号码只留一份）
  async function importHaveDir(files) {
    const { got, notInv, total } = await readPdfFolder(files, '已整理的发票');
    const by = new Map((S.haveIdx || []).map(x => [x.invNo, x]));
    got.forEach(r => { if (!by.has(r.invNo)) by.set(r.invNo, { invNo: r.invNo, date: r.date, amount: r.amount, file: r.file }); });
    S.haveIdx = [...by.values()];
    const nb = importBatches(files, got);
    persist(); derive(); render();
    toast('已读取 ' + total + ' 个 PDF：识别发票 ' + got.length + ' 张（' + notInv.length + ' 个非发票文件，如扫描件或说明文档），已整理的发票共 ' + S.haveIdx.length + ' 张'
      + (nb ? '；识别出历史报销批次 ' + nb + ' 个（见第 4 步「报销记录」）' : ''));
  }
  // 能确定的改过来：归错单的挪到对的那单名下；比下单还早的、已报销过的、不是发票的从这单拿掉（这单又会出现在「还没开发票」里）；
  // 同店几单合开一张的，同一条下载记录也挂到其余几单下面（整理报销文件时按发票号合成一行）
  async function applyFileCheck(res) {
    const fix = res.filter(r => ['move', 'old', 'dup', 'notinv', 'merged'].includes(r.kind));
    if (!fix.length) return 0;
    const baseName = p => String(p || '').split(/[\\/]/).pop();
    const dl = EXT ? Object.assign({}, (await chrome.storage.local.get('dlDone')).dlDone) : {};
    let n = 0;
    for (const r of fix) {
      const name = baseName(r.file);
      // 合开：文件名那单也在合开的几单里，就只把记录挂到其余几单；不在（票是同店另外几单的），就整个挪过去
      const merged = r.kind === 'merged', keepHere = merged && (r.nos || []).includes(r.no);
      const to = merged ? (r.nos || []).filter(no => no !== r.no) : r.kind === 'move' ? [r.to] : [];
      for (const store of [dl, S.invFiles]) {
        const list = store[r.no] || [];
        const i = list.findIndex(g => (r.path ? g.path === r.path : baseName(g.path) === name || g.file === name));
        if (i < 0) continue;
        const g = keepHere ? list[i] : list.splice(i, 1)[0];
        if (!list.length) delete store[r.no];
        // 不是这单的：记下卖家发来时的原文件名，以后不再当成这单的票去下载（同店几单共用一个会话，挪走后原订单不能再下一遍）
        if (!keepHere && g.src) (S.rejectedSrc = S.rejectedSrc || {})[g.src] = { kind: merged ? 'move' : r.kind, no: r.no, to: to.join(','), at: Date.now() };
        for (const t of to) {
          const l2 = store[t] = store[t] || [];
          if (!l2.some(x => x.path === g.path && x.file === g.file)) l2.push(Object.assign({}, g, merged ? { mergedWith: r.no } : { movedFrom: r.no }));
        }
        n++;
      }
    }
    if (EXT) { await chrome.storage.local.set({ dlDone: dl }); X.dlDone = dl; }
    persist(); derive(); render();
    return n;
  }

  // ── 报销附件（用户 2026-10-09，按《报销规范手册》3.1）：订单页面截图、支付记录、用途说明、3D 打印明细 ──
  // 截图和用户手动添加的文件存在本机 IndexedDB（库 orderTriage-att，表 att，每条 { id, no, kind, name, type, blob, w, h, at }）；
  // 图片较大，不进备份；「清除本机数据」时一起清掉。旺旺里下载的附件（3D 打印明细表格）在下载文件夹里（X.attDone），整理时从选的文件夹按文件名取
  const ATT = new Map();          // 订单号 → [附件记录]
  let attDb = null;
  function idb() {
    if (!attDb) attDb = new Promise((ok, bad) => {
      const r = indexedDB.open('orderTriage-att', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('att', { keyPath: 'id' });
      r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
    });
    return attDb;
  }
  async function attTx(mode, fn) {
    const db = await idb();
    return new Promise((ok, bad) => { const t = db.transaction('att', mode), r = fn(t.objectStore('att')); t.oncomplete = () => ok(r && r.result); t.onerror = () => bad(t.error); });
  }
  async function attLoad() {
    try {
      const all = await attTx('readonly', st => st.getAll());
      ATT.clear();
      for (const a of all || []) ATT.set(a.no, (ATT.get(a.no) || []).concat(a));
    } catch (e) { console.warn('[订单分拣] 读取本机附件出错', e); }
  }
  async function attPut(rec) {
    await attTx('readwrite', st => st.put(rec));
    ATT.set(rec.no, (ATT.get(rec.no) || []).filter(a => a.id !== rec.id).concat(rec));
  }
  const attClear = () => attTx('readwrite', st => st.clear()).then(() => ATT.clear()).catch(() => {});
  // 这单已有的附件：本机存的（截图、手动添加的）+ 旺旺下载的
  const attsOf = no => (ATT.get(no) || []).map(a => ({ kind: a.kind, name: a.name, id: a.id, src: 'idb' }))
    .concat(((X.attDone || {})[no] || []).map(a => ({ kind: a.kind, name: a.file, path: a.path, src: 'disk' })));

  // 这单（或这张票）要补什么材料（规则在 js/reimburse.js）：价税合计超过 1000 元、开票内容有与科研无关的字样、3D 打印。
  // amount：发票的价税合计（读到才有）；与科研无关的字样只看发票明细（手册说的是开票内容），还没读到发票时先按商品标题提醒
  function needOf(xs, amount, items) {
    const titles = xs.flatMap(x => x.lines.map(l => l.title + ' ' + (l.sku || ''))).join(' ');
    const inv = items != null ? items : xs.map(x => invItemsOf(x.o)).filter(Boolean).join('；');
    return { big: (+amount || 0) > RB.BIG + 0.005 || xs.some(x => dueOf(x.o) > RB.BIG + 0.005), sens: RB.sensitiveWords(inv || titles), p3d: RB.is3d(titles + ' ' + inv) };
  }
  // 这单的低值品情况：实验室商品里有一件低值品 → 'low'；有判断不出的 → 'ask'
  function lowOfOrder(no) {
    const vs = derived.rows.filter(x => x.o.no === no && !x.ref && effCat(x) === 'lab' && x.low).map(x => x.low.v);
    return vs.includes('low') ? 'low' : vs.includes('ask') ? 'ask' : '';
  }
  // 发票表一行（invOrders 的一项）：要的材料、缺的材料、低值品
  function matOf(x) {
    const got = (X.dlDone[x.o.no] || []).concat(S.invFiles[x.o.no] || []);
    const amts = got.map(g => { const c = fcOf(g); return c && c.amount; }).filter(a => a != null);
    const need = needOf([x], amts.length ? Math.max(...amts) : null);
    return { need, miss: RB.missing(need, attsOf(x.o.no).map(a => a.kind)), low: lowOfOrder(x.o.no) };
  }
  // 发票表、整理预览里的标签：低值品深色、待确认黄色、缺材料橙色
  const MAT_TAG = {
    订单页面: ['需订单截图', '要附订单页面截图：「自动处理发票」或「整理报销文件」时插件自动打开订单详情页截图'],
    支付记录: ['需补支付记录', '价税合计超过 1000 元：要附订单页面和支付记录（能证明实际付款的支付宝账单截图），在本行「手动添加发票 / 附件」中添加'],
    用途说明: ['需用途说明', '开票内容含可能与科研无关的字样：要附 Word 用途说明（整理时自动生成草稿，文末附订单截图），填写用途后按要求盖章'],
    '3D打印明细': ['需3D打印明细', '3D 打印订单：要附明细清单（零件名称、材料、数量、单价）；向卖家索要发票时插件一并索要，卖家发来后自动挂上或手动添加'],
  };
  function lowTag(no, v) {
    if (v === 'low') return '<span class="tag t-low" title="单件超过 200 元的设备器械，需先开低值票">低值品</span>';
    if (v === 'ask') return lowAskBtns('data-lowno', no);
    return '';
  }
  function matTags(x) {
    const m = matOf(x);
    const h = lowTag(x.o.no, m.low) + m.miss.map(k => '<span class="tag t-mat" title="' + esc(MAT_TAG[k][1]) + '">' + MAT_TAG[k][0] + '</span>').join('');
    return h ? '<div class="tags">' + h + '</div>' + (m.low === 'low' ? '<div class="detail">需先开低值票</div>' : '') : '';
  }

  // ── 订单详情页截图（chrome.tabs.captureVisibleTab，manifest 要 <all_urls>，只截插件自己打开的订单详情页）──
  // 详情页（extension/detail.js）按主页发的 otShot 逐段滚动，每段截一张（浏览器限制每秒最多截 2 次），拼成一张长图，最多 6 屏。
  // 每段截之前核对这一页还在前台、还是这单的订单详情页——用户中途切走了就不截（不然会截到别的页面）
  const DETAIL_RE = /^https:\/\/(trade\.taobao\.com\/trade\/detail\/|trade\.tmall\.com\/detail\/)/;
  async function shotDetail(o, tab) {
    const segs = [];
    let y = 0, info = null;
    for (let i = 0; i < 6; i++) {
      info = await chrome.tabs.sendMessage(tab.id, { type: 'otShot', no: o.no, y });
      if (!info) throw new Error('订单详情页未响应');
      const t = await chrome.tabs.get(tab.id);
      if (!t.active || !DETAIL_RE.test(t.url || '') || !t.url.includes(o.no)) throw new Error('订单详情页不在前台，未截图');
      if (i) await sleepMs(600);
      segs.push({ y: info.y, url: await chrome.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 85 }) });
      if (info.y + info.vh >= info.h - 2) break;
      y = info.y + info.vh;
    }
    const bmps = await Promise.all(segs.map(async s => createImageBitmap(await (await fetch(s.url)).blob())));
    const scale = bmps[0].width / (info.vw || bmps[0].width), last = segs[segs.length - 1];
    const H = Math.max(1, Math.min(Math.round((last.y + info.vh) * scale), 16000));
    const c = new OffscreenCanvas(bmps[0].width, H), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, H);
    segs.forEach((s, i) => g.drawImage(bmps[i], 0, Math.round(s.y * scale)));
    return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }), w: c.width, h: H };
  }
  // 要截订单页面、还没截到的单（每天自动刷新的后台模式不截：截图要把详情页切到前台）
  const shotList = () => invOrders().filter(x => !isSample(x.o.no) && invStatus(x).key !== 'have' && matOf(x).miss.includes('订单页面')).map(x => x.o);

  // 手动添加：卖家发到邮箱的发票，或补的附件（支付记录截图、用途说明、3D 打印明细）。一个入口，插件按文件判断：
  //   .ofd / .xml → 发票；PDF 读得出是发票（或读不出字、这单又不缺材料）→ 发票；其余 → 附件，类型按这单缺什么和文件类型定
  async function addFile(no, file) {
    const x = invOrders().find(g => g.o.no === no);
    if (!x || !file) return;
    if (/\.(ofd|xml)$/i.test(file.name)) return attachFile(no, file);
    if (/\.pdf$/i.test(file.name)) {
      let r = null;
      try { r = await readInvoicePdf(file); } catch (e) { /* 读不了的按发票处理 */ }
      if (!r || r.isInvoice || (!r.noInv && !matOf(x).miss.length)) return attachFile(no, file);
    }
    const kind = kindFor(x, file.name);
    const rec = { id: no + '|' + kind + '|' + Date.now(), no, kind, name: file.name, type: file.type || '', blob: file, at: Date.now() };
    if (/^image\//.test(file.type)) { try { const b = await createImageBitmap(file); rec.w = b.width; rec.h = b.height; } catch (e) { /* 不是能读的图片 */ } }
    await attPut(rec);
    render();
    toast('已添加附件「' + kind + '」：' + file.name);
  }
  function kindFor(x, name) {
    const miss = matOf(x).miss, first = ks => ks.find(k => miss.includes(k));
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return first(['支付记录', '订单页面']) || '附件';
    if (/\.(xlsx?|csv)$/i.test(name)) return first(['3D打印明细']) || '附件';
    if (/\.docx?$/i.test(name)) return first(['用途说明']) || '附件';
    return first(['3D打印明细', '支付记录', '用途说明']) || '附件';
  }

  // ── 整理成报销文件（用户 2026-10-09 改：按单位《报销规范手册》3.2.2 的结构；原来的序号命名、「低值品（单张超过200元）」文件夹由它取代）──
  //   学号_姓名_总金额元/（没有学号时 姓名_总金额元；存进下载文件夹的「订单分拣-报销/」，另打一个同名压缩包）
  //     README.txt            报销人、学号、生成时间、总金额、各分类合计、特殊情况（部分退款、合开、票面差异、低值品、缺附件）、逐项明细
  //     报销清单.xlsx          序号、分类、商品或说明、销售方、发票号码、开票日期、金额、订单号、下单日期、店铺、材料状态、缺失材料、备注
  //     不超过1k耗材/发票1.pdf、发票2.pdf…（手册要求按「发票 N」顺序命名；N = 报销清单里的序号，这一类排在最前）
  //     超过1k耗材/发票/序号_商品_金额元.pdf、超过1k耗材/附件原图/序号_商品_类型.jpg（订单页面、支付记录、用途说明、3D 打印明细）
  //     低值品/发票/…、低值品/附件原图/…（低值品需先开低值票，单独一个文件夹；超过 1000 元的同样附订单页面和支付记录）
  //   不超过 1000 元、但要用途说明或 3D 打印明细的，附件放在 不超过1k耗材/附件原图/。插件读不了电脑上的文件，所以要用户选一下
  //   下载好的发票文件夹；原文件不动。生成后记一个报销批次（S.batches，见「报销记录」）
  const baseOf = p => String(p || '').split(/[\\/]/).pop();
  const shortTitle = t => String(t || '').replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 14) || '商品';
  const PACK_EXT = /\.(pdf|ofd|xml|xlsx?|csv|docx?|png|jpe?g)$/i;
  const CAT_DIR = { small: '不超过1k耗材', big: '超过1k耗材', low: '低值品' };
  const CAT_NAME = { small: '耗材（不超过1k）', big: '耗材（超过1k）', low: '低值品' };
  let packFiles = null;
  // 每张发票一行：同一张票（同一个发票号，或同一个文件）对着几单的（卖家合开）合成一行
  function packPlan() {
    const byName = new Map(packFiles.map(f => [f.name, f]));
    const groups = new Map(), miss = [];
    for (const x of invOrders()) {
      const st = invStatus(x);
      if (st.key === 'have') continue;                         // 已经整理过（报销过）的不再放
      const got = (X.dlDone[x.o.no] || []).concat(S.invFiles[x.o.no] || []);
      const g = got.find(g => /\.(pdf|ofd|xml)$/i.test(g.file || g.path || '') && (byName.has(baseOf(g.path)) || byName.has(g.file)));
      if (!g) { miss.push({ x, st }); continue; }
      const f = byName.get(baseOf(g.path)) || byName.get(g.file);
      const chk = packRead.get(f.name) || fcOf(g) || null;
      const k = (chk && chk.invNo) || f.name;
      if (!groups.has(k)) groups.set(k, { f, xs: [], chk });
      groups.get(k).xs.push(x);
    }
    const rows = [...groups.values()];
    for (const r of rows) {
      r.xs.sort((a, b) => (a.o.time || '').localeCompare(b.o.time || ''));
      const good = r.chk && r.chk.amount != null && !['error', 'unread', 'old', 'dup', 'title'].includes(r.chk.kind);
      r.due = Math.round(r.xs.reduce((a, x) => a + dueOf(x.o), 0) * 100) / 100;
      r.good = !!good;
      r.amount = good ? +r.chk.amount : r.due;
      r.date = (good && r.chk.date) || (r.xs[0].o.time || '').slice(0, 10);
      r.items = (r.chk && r.chk.items) || '';
      r.seller = (r.chk && r.chk.seller) || '';
      r.invNo = (r.chk && r.chk.invNo) || '';
      r.need = needOf(r.xs, r.amount, r.items || null);
      // 低值品：这张票对着的实验室商品里有一件是低值品，整张票就按低值品报；有判断不出的，先要用户确认
      const lows = r.xs.map(x => lowOfOrder(x.o.no));
      r.low = lows.includes('low') ? 'low' : lows.includes('ask') ? 'ask' : '';
      r.cat = r.low === 'low' ? 'low' : r.need.big ? 'big' : 'small';
      // 旺旺下载的附件要在选的文件夹里才算有
      r.atts = r.xs.flatMap(x => attsOf(x.o.no).map(a => Object.assign({ no: x.o.no }, a))).filter(a => a.src === 'idb' || byName.has(baseOf(a.path)) || byName.has(a.name));
      r.miss = RB.missing(r.need, r.atts.map(a => a.kind));
      const same = r.invNo && (S.haveIdx || []).find(h => h.invNo === r.invNo);
      // 票面和应报金额（实付 − 退款）差 1 元以上：预览和清单备注里写明（用户 2026-10-05：少 1 元以内没关系）
      const diff = good ? Math.round((r.amount - r.due) * 100) / 100 : 0;
      r.diff = Math.abs(diff) >= 0.005 ? diff : 0;
      r.warn = [same ? '与已整理的 ' + same.file + ' 为同一张发票' : '', r.chk && r.chk.titleOk === false ? '抬头不是 ' + S.invoice.title : '',
        good && diff < -1.005 ? '票面比应报少 ' + (-diff).toFixed(2) + ' 元' : ''].filter(Boolean).join('；');
    }
    const ORDER = { small: 0, big: 1, low: 2 };
    rows.sort((a, b) => ORDER[a.cat] - ORDER[b.cat] || a.date.localeCompare(b.date) || (a.xs[0].o.time || '').localeCompare(b.xs[0].o.time || ''));
    rows.forEach((r, i) => {
      r.seq = i + 1;
      r.title = r.xs.flatMap(x => x.lines.map(l => l.title)).join('；');
      const ext = ((/\.(pdf|ofd|xml)$/i.exec(r.f.name) || [, 'pdf'])[1]).toLowerCase();
      r.file = r.cat === 'small' ? CAT_DIR.small + '/发票' + r.seq + '.' + ext
        : CAT_DIR[r.cat] + '/发票/' + r.seq + '_' + shortTitle(r.xs[0].lines[0].title) + '_' + r.amount.toFixed(2) + '元.' + ext;
      r.attDir = CAT_DIR[r.cat] + '/附件原图/';
    });
    const total = Math.round(rows.reduce((a, r) => a + r.amount, 0) * 100) / 100;
    return { rows, miss, total, dir: RB.packDirName(S.person, total), ask: rows.filter(r => r.low === 'ask').length, byName };
  }
  function renderPack() {
    const p = packPlan();
    const nLow = p.rows.filter(r => r.cat === 'low').length, nMiss = p.rows.filter(r => r.miss.length).length;
    $('pack-note').textContent = '发票 ' + p.rows.length + ' 张（' + p.rows.reduce((a, r) => a + r.xs.length, 0) + ' 单），合计 ' + yuan(p.total)
      + ' → 「' + p.dir + '」' + (p.ask ? '；' + p.ask + ' 张待确认是否低值品（点黄色标签）' : '') + (nLow ? '；低值品 ' + nLow + ' 张需先开低值票' : '')
      + (nMiss ? '；' + nMiss + ' 张缺材料' : '') + (p.miss.length ? '；另有 ' + p.miss.length + ' 单尚无发票' : '') + '。';
    const tag = (cls, t, tip) => '<span class="tag ' + cls + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + esc(t) + '</span>';
    $('pack-list').innerHTML = p.rows.map(r => '<div class="pk-row" data-no="' + esc(r.xs[0].o.no) + '"><span class="pk-seq num">' + r.seq + '</span><div>'
      + '<div class="pk-main"><b>' + esc(r.xs[0].lines[0].title.slice(0, 30)) + '</b>' + (r.xs.length > 1 ? ' 等 ' + r.xs.length + ' 单（合开）' : '')
      + ' <span class="num">' + yuan(r.amount) + '</span> ' + lowTag(r.xs[0].o.no, r.low)
      + (r.miss.length ? tag('t-mat', '缺：' + r.miss.join(' / '), r.miss.includes('用途说明') ? '用途说明会按固定模板生成草稿，需填写用途' : '') : '') + '</div>'
      + '<div class="detail">' + esc(r.file) + '　←　' + esc(r.f.name) + (r.atts.length ? '　附件：' + esc(r.atts.map(a => a.kind).join('、')) : '') + '</div>'
      + (r.warn ? '<div class="detail warn">⚠ ' + esc(r.warn) + '</div>' : '') + '</div></div>').join('')
      + (p.miss.length ? '<div class="pk-h">尚无发票（列在 README.txt 末尾，不放入本次报销）</div>' + p.miss.map(m => '<div class="detail">' + esc((m.x.o.time || '').slice(0, 10) + ' ' + m.x.o.shop + ' ' + yuan(m.x.o.pay) + ' ' + m.x.o.no + '（' + m.st.label + '）') + '</div>').join('') : '');
    if (!$('pack-name').value.trim()) $('pack-name').value = RB.nextBatchName(S.batches);
    $('pack-go').disabled = !p.rows.length || p.ask > 0;
    $('pack-go').title = p.ask ? '还有 ' + p.ask + ' 张发票待确认是否低值品，点黄色标签确认后才能生成' : '按上述结构复制发票和附件到「订单分拣-报销」，生成 README.txt、报销清单.xlsx 和压缩包';
    return p;
  }
  // 选好文件夹后，把要用到的每张 PDF 都读一遍：金额、开票日期按票面写，发票明细用来判断低值品和要补的材料
  // （有的票是加「读 PDF 核对」之前下的，没读过；2026-10-05 实测一张票面比实付多 3 元的，按实付写错了）。
  // 要附订单页面、还没截到的，先打开订单详情页截图
  const packRead = new Map();
  async function openPack(files) {
    packFiles = [...files].filter(f => PACK_EXT.test(f.name));
    $('pack-name').value = '';
    const need = packPlan().rows.map(r => r.f).filter(f => /\.pdf$/i.test(f.name) && !packRead.has(f.name));
    for (let i = 0; i < need.length; i++) {
      if (i % 10 === 0) toast('正在读取发票 PDF：' + i + ' / ' + need.length);
      try { const r = await readInvoicePdf(need[i]); if (r.isInvoice && r.amount != null) packRead.set(need[i].name, { kind: 'ok', amount: r.amount, date: r.date, invNo: r.invNo, titleOk: r.titleOk, items: r.items, seller: r.seller }); }
      catch (e) { /* 读不了的按订单实付写 */ }
    }
    derive();
    const nos = new Set(packPlan().rows.flatMap(r => r.miss.includes('订单页面') ? r.xs.map(x => x.o.no) : []));
    const os = EXT && !hasSample() ? S.orders.filter(o => nos.has(o.no)) : [];
    if (os.length) {
      toast('正在截取 ' + os.length + ' 单的订单页面（超过 1000 元或需用途说明）');
      await inspectOrders(os, nos);
      chrome.runtime.sendMessage({ type: 'focusMe' }).catch(() => {});
    }
    render();
    renderPack();
    $('dlg-pack').showModal();
  }
  async function saveBlob(blob, path) {
    const url = URL.createObjectURL(blob);
    try {
      await chrome.runtime.sendMessage({ type: 'ownName', url, name: path });
      await chrome.downloads.download({ url, filename: path, conflictAction: 'uniquify' });
    } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  }
  // 整理报销文件前要有报销人姓名（学号可空）：没填就打开设置，顶上一行提示
  function personOk() {
    if (S.person && S.person.name) return true;
    openSettings('整理报销文件前，请先填写报销人姓名（学号可空）');
    return false;
  }
  const extOf = (name, type) => ((/\.(\w{2,5})$/.exec(name || '') || [])[1] || (/jpeg/.test(type || '') ? 'jpg' : /png/.test(type || '') ? 'png' : 'bin')).toLowerCase();
  const stamp = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  // 长截图切成几段（每段不比 Word 版心更长），一页放得下、字不会缩得太小
  async function splitImage(rec) {
    const bmp = await createImageBitmap(rec.blob), maxH = Math.round(bmp.width * 1.3), out = [];
    for (let y = 0; y < bmp.height && out.length < 8; y += maxH) {
      const h = Math.min(maxH, bmp.height - y), c = new OffscreenCanvas(bmp.width, h);
      c.getContext('2d').drawImage(bmp, 0, -y);
      const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      out.push({ data: new Uint8Array(await b.arrayBuffer()), type: 'jpeg', w: bmp.width, h });
    }
    return out;
  }
  // 用途说明草稿：固定模板（不是 AI）——标题、订单号、下单日期、商品、金额、开票内容、「用途：____」留空，文末附订单页面截图
  async function usageDocx(r, shot) {
    const os = r.xs.map(x => x.o);
    const paras = ['订单号：' + os.map(o => o.no).join('、'), '下单日期：' + os.map(o => (o.time || '').slice(0, 10)).join('、'), '店铺：' + [...new Set(os.map(o => o.shop))].join('、'),
      '商品：' + r.title, '金额：' + r.amount.toFixed(2) + ' 元', '开票内容：' + (r.items || '（未读取到发票明细）'), '',
      { text: '用途：________________________________________', bold: true }, '',
      '报销人：' + S.person.name + (S.person.sid ? '（学号 ' + S.person.sid + '）' : ''), '', '附：订单页面截图' + (shot ? '' : '（未截到，请另附）')];
    return OF.makeDocx({ title: '用途说明', paras, images: shot ? await splitImage(shot) : [] });
  }
  function readmeTxt(p, now, rowsOut) {
    const L = [], who = S.person, nOrders = p.rows.reduce((a, r) => a + r.xs.length, 0);
    L.push('报销人：' + who.name, '学号：' + (who.sid || '无（工程师）'), '生成时间：' + stamp(now), '总金额：' + p.total.toFixed(2) + ' 元（发票 ' + p.rows.length + ' 张，订单 ' + nOrders + ' 单）');
    for (const c of ['small', 'big', 'low']) {
      const rs = p.rows.filter(r => r.cat === c);
      if (rs.length) L.push('  ' + CAT_DIR[c] + '：' + rs.length + ' 张，' + rs.reduce((a, r) => a + r.amount, 0).toFixed(2) + ' 元');
    }
    const sp = [];
    const lows = p.rows.filter(r => r.cat === 'low');
    if (lows.length) sp.push('低值品 ' + lows.length + ' 张（序号 ' + lows.map(r => r.seq).join('、') + '，共 ' + lows.reduce((a, r) => a + r.amount, 0).toFixed(2) + ' 元）：需先开低值票');
    for (const r of p.rows) {
      for (const x of r.xs) {
        const d = dueOf(x.o);
        if (d < (+x.o.pay || 0) - 0.005) sp.push('部分退款：序号 ' + r.seq + ' 订单 ' + x.o.no + ' 实付 ' + (+x.o.pay).toFixed(2) + ' − 退款 ' + ((+x.o.pay) - d).toFixed(2) + ' = ' + d.toFixed(2) + ' 元');
      }
      if (r.xs.length > 1) sp.push('合开发票：序号 ' + r.seq + ' 一张发票对应 ' + r.xs.length + ' 单（' + r.xs.map(x => x.o.no).join('、') + '）');
      if (r.diff) sp.push('票面与应报金额不同：序号 ' + r.seq + ' 票面 ' + r.amount.toFixed(2) + ' 元，应报 ' + r.due.toFixed(2) + ' 元（' + (r.diff > 0 ? '多 ' : '少 ') + Math.abs(r.diff).toFixed(2) + ' 元）');
      if (r.draft) sp.push('用途说明：序号 ' + r.seq + ' 开票内容含「' + r.need.sens.join('、') + '」，已生成草稿 ' + r.draft + '，请填写用途后按要求盖章');
      const miss = r.miss.filter(k => !(k === '用途说明' && r.draft));
      if (miss.length) sp.push('缺附件：序号 ' + r.seq + ' 缺 ' + miss.join('、'));
      const pay = (S.payInfo || {})[r.xs[0].o.no];
      if (r.need.big && pay && (pay.alipay || pay.paidAt)) sp.push('支付信息：序号 ' + r.seq + ' 订单页面截图中有' + (pay.alipay ? '支付宝交易号 ' + pay.alipay : '') + (pay.alipay && pay.paidAt ? '、' : '') + (pay.paidAt ? '付款时间 ' + pay.paidAt : ''));
      if (r.warn) sp.push('请核对：序号 ' + r.seq + ' ' + r.warn);
    }
    L.push('', '特殊情况', ...(sp.length ? sp.map(s => '  - ' + s) : ['  无']));
    L.push('', '逐项明细');
    for (const r of p.rows) L.push('  ' + r.seq + '. [' + CAT_NAME[r.cat] + '] ' + r.title.slice(0, 60) + '　' + r.amount.toFixed(2) + ' 元　发票号 ' + (r.invNo || '未读取')
      + '　订单 ' + r.xs.map(x => x.o.no).join('、') + '　文件 ' + r.file + ((rowsOut.get(r) || []).length ? '　附件 ' + rowsOut.get(r).join('、') : ''));
    if (p.miss.length) {
      L.push('', '尚无发票的实验室订单（未放入本次报销）');
      for (const m of p.miss) L.push('  ' + (m.x.o.time || '').slice(0, 10) + '　' + m.x.o.shop + '　' + (+m.x.o.pay).toFixed(2) + ' 元　' + m.x.o.no + '　' + m.st.label);
    }
    return new TextEncoder().encode('﻿' + L.join('\r\n') + '\r\n');
  }
  function listXlsx(p, now) {
    const head = ['序号', '分类', '商品或说明', '销售方', '发票号码', '开票日期', '金额', '订单号', '下单日期', '店铺', '材料状态', '缺失材料', '备注'];
    const rows = p.rows.map(r => {
      const notes = ['文件 ' + r.file, r.xs.length > 1 ? '合开 ' + r.xs.length + ' 单' : '', r.diff ? '应报 ' + r.due.toFixed(2) + ' 元' : '',
        r.xs.some(x => dueOf(x.o) < (+x.o.pay || 0) - 0.005) ? '部分退款（实付 − 退款）' : '', r.cat === 'low' ? '需先开低值票' : '', r.draft ? '用途说明为草稿，需填写' : '', r.warn].filter(Boolean).join('；');
      return [r.seq, CAT_NAME[r.cat], r.title, r.seller || [...new Set(r.xs.map(x => x.o.shop))].join('、'), r.invNo, r.date, r.amount, r.xs.map(x => x.o.no).join('、'),
        r.xs.map(x => (x.o.time || '').slice(0, 10)).join('、'), [...new Set(r.xs.map(x => x.o.shop))].join('、'), r.miss.length ? '缺材料' : '完整', r.miss.join('、'), notes];
    });
    rows.push(['合计', '', '', '', '', '', p.total]);
    const sheets = [{ name: '报销清单', rows: [head, ...rows], widths: [6, 14, 40, 24, 22, 11, 11, 22, 11, 20, 9, 16, 40] }];
    if (p.miss.length) sheets.push({ name: '尚无发票', rows: [['下单日期', '店铺', '商品', '实付', '订单号', '发票状态']].concat(p.miss.map(m =>
      [(m.x.o.time || '').slice(0, 10), m.x.o.shop, m.x.lines.map(l => l.title).join('；'), +m.x.o.pay, m.x.o.no, m.st.label])), widths: [11, 20, 40, 10, 22, 24] });
    return OF.makeXlsx(sheets, now);
  }
  const MIME = { pdf: 'application/pdf', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  async function makePack() {
    if (!personOk()) return;
    const p = renderPack();
    if (!p.rows.length || p.ask) return;
    $('pack-go').disabled = true;
    toast('正在整理：' + p.rows.length + ' 张发票…');
    const now = new Date(), entries = [], rowsOut = new Map();
    const put = (name, data) => entries.push({ name: p.dir + '/' + name, data });
    for (const r of p.rows) {
      put(r.file, new Uint8Array(await r.f.arrayBuffer()));
      const out = [], used = {}, short = shortTitle(r.xs[0].lines[0].title);
      // 附件按「序号_商品_类型」命名；同类有几个的加 2、3
      const name = (kind, ext) => { const n = (used[kind] = (used[kind] || 0) + 1); return r.attDir + r.seq + '_' + short + '_' + kind + (n > 1 ? n : '') + '.' + ext; };
      let shot = null;
      for (const a of r.atts) {
        let data = null, ext = '';
        if (a.src === 'idb') {
          const rec = (ATT.get(a.no) || []).find(z => z.id === a.id);
          if (!rec || !rec.blob) continue;
          data = new Uint8Array(await rec.blob.arrayBuffer()); ext = extOf(rec.name, rec.type);
          if (rec.kind === '订单页面' && !shot) shot = rec;
        } else {
          const f = p.byName.get(baseOf(a.path)) || p.byName.get(a.name);
          if (!f) continue;
          data = new Uint8Array(await f.arrayBuffer()); ext = extOf(f.name);
        }
        const n = name(a.kind, ext); put(n, data); out.push(n);
      }
      if (r.need.sens.length && !r.atts.some(a => a.kind === '用途说明')) {
        const n = name('用途说明', 'docx');
        put(n, await usageDocx(r, shot)); out.push(n); r.draft = n;
      }
      rowsOut.set(r, out);
    }
    put('README.txt', readmeTxt(p, now, rowsOut));
    put('报销清单.xlsx', listXlsx(p, now));
    // 要写明文件类型：不写的话浏览器按内容猜，可能把 .pdf 存成 .txt（2026-10-05 测试里出现过）
    for (const e of entries) { await saveBlob(new Blob([e.data], { type: MIME[extOf(e.name)] || 'application/octet-stream' }), '订单分拣-报销/' + e.name); await sleepMs(300); }
    await saveBlob(new Blob([Z.makeZip(entries, now)], { type: 'application/zip' }), '订单分拣-报销/' + p.dir + '.zip');
    // 记一个报销批次（「报销记录」里填到账、找差额用）；这一批的订单记为「已整理（第 N 批）」，读到发票号的票记进已整理的发票（识别重复报销）
    const round = v => Math.round(v * 100) / 100;
    const batch = { id: 'b' + Date.now().toString(36), name: $('pack-name').value.trim() || RB.nextBatchName(S.batches), date: ymd(now), dir: p.dir, n: p.rows.length,
      amount: p.total, low: round(p.rows.filter(r => r.cat === 'low').reduce((a, r) => a + r.amount, 0)),
      invNos: p.rows.map(r => r.invNo).filter(Boolean), nos: p.rows.flatMap(r => r.xs.map(x => x.o.no)),
      rows: p.rows.map(r => ({ seq: r.seq, title: shortTitle(r.xs[0].lines[0].title), amount: r.amount, low: r.cat === 'low', invNo: r.invNo })), pays: [], src: 'pack', at: Date.now() };
    S.batches = (S.batches || []).concat(batch);
    S.lastPack = { at: Date.now(), dir: p.dir, n: p.rows.length, nos: batch.nos };
    S.packed = S.packed || {}; S.haveIdx = S.haveIdx || [];
    for (const r of p.rows) {
      const file = p.dir + '/' + r.file;
      for (const x of r.xs) S.packed[x.o.no] = { file, invNo: r.invNo, at: Date.now(), batch: batch.id };
      if (r.invNo && !S.haveIdx.some(h => h.invNo === r.invNo)) S.haveIdx.push({ invNo: r.invNo, date: r.date, amount: r.amount, file });
    }
    persist(); derive(); render();
    $('dlg-pack').close();
    toast('整理完成（' + batch.name + '）：下载文件夹「订单分拣-报销/' + p.dir + '」中已生成 ' + p.rows.length + ' 张发票、README.txt 和报销清单.xlsx，并附同名压缩包', true);
  }

  // ── 报销记录（用户 2026-10-09：取代单独维护的在线台账）：每次整理报销文件记一批，导入以前整理好的文件夹时认出历史批次；
  // 在第 4 步说明区下方只读列出，每批一行；「填写到账」可多次填（分期到账）。有差额时在这一批的发票金额里找哪几张加起来正好等于差额
  const payOf = b => Math.round((b.pays || []).reduce((a, x) => a + (+x.amount || 0), 0) * 100) / 100;
  function batchState(b) {
    const paid = payOf(b), diff = Math.round((b.amount - paid) * 100) / 100;
    if (!(b.pays || []).length) return { paid, diff, tone: 'wait', label: b.src === 'import' ? '待填到账' : '待到账' };
    if (Math.abs(diff) < 0.005) return { paid, diff, tone: 'ok', label: '已到账' };
    return { paid, diff, tone: 'bad', label: '有差额', hint: diff > 0 ? RB.diffHint(b.rows || [], diff) : '到账比报销金额多 ' + (-diff).toFixed(2) + ' 元' };
  }
  function batchView() {
    const bs = S.batches || [];
    if (!bs.length) return '';
    return '<div class="batches" id="batches"><div class="b-h">报销记录</div>' + bs.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.at || 0) - (a.at || 0)).map(b => {
      const s = batchState(b);
      return '<div class="b-row" data-batch="' + esc(b.id) + '" title="' + esc(b.dir + '，发票 ' + b.n + ' 张' + (b.low ? '，其中低值品 ' + yuan(b.low) : '')
          + ((b.pays || []).length ? '；到账：' + b.pays.map(x => x.date + ' ' + (+x.amount).toFixed(2)).join('；') : '')) + '">'
        + '<b>' + esc(b.name) + '</b><span class="num">' + esc(b.date) + '</span><span class="num">' + yuan(b.amount) + '</span>'
        + '<span class="num">已到账 ' + yuan(s.paid) + '</span><span class="num">差额 ' + yuan(s.diff) + '</span>'
        + '<span class="tag tone-' + s.tone + '">' + s.label + '</span>'
        + '<button type="button" class="linkbtn" data-pay="' + esc(b.id) + '" title="记一笔到账（可多次填写，分期到账）">填写到账</button>'
        + (s.hint ? '<div class="b-hint">' + esc(s.hint) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }
  let payBatch = null;
  function openPay(id) {
    const b = (S.batches || []).find(x => x.id === id);
    if (!b) return;
    payBatch = b;
    const s = batchState(b);
    $('pay-title').textContent = '填写到账：' + b.name + '（' + yuan(b.amount) + '）';
    $('pay-amt').value = s.diff > 0 ? s.diff.toFixed(2) : '';
    $('pay-date').value = ymd(new Date());
    $('pay-prev').textContent = (b.pays || []).length ? '已记：' + b.pays.map(x => x.date + ' ' + yuan(+x.amount)).join('；') : '';
    $('pay-err').textContent = '';
    $('dlg-pay').showModal();
  }
  function savePay() {
    const v = Math.round(parseFloat($('pay-amt').value) * 100) / 100, d = $('pay-date').value;
    if (!(v > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) { $('pay-err').textContent = '请填写到账金额和日期'; return; }
    payBatch.pays = (payBatch.pays || []).concat({ amount: v, date: d, at: Date.now() });
    persist(); render();
    $('dlg-pay').close();
    const s = batchState(payBatch);
    toast(payBatch.name + '：已记到账 ' + yuan(v) + '，' + s.label + (s.hint ? '。' + s.hint : ''));
  }
  // 导入以前整理好的发票文件夹时：子文件夹名形如「YYMMDD_……第X批……_金额_报销给某人」的认成历史批次（名称、日期、金额、张数），待填到账
  function importBatches(files, got) {
    const found = new Map();
    const dirOf = path => String(path || '').split('/').slice(0, -1).map(s => RB.parseBatchDir(s)).find(Boolean);
    for (const f of files) { const b = dirOf(f.webkitRelativePath); if (b && !found.has(b.dir)) found.set(b.dir, Object.assign(b, { rows: [], invNos: new Set() })); }
    for (const r of got) {
      const b = dirOf(r.file), e = b && found.get(b.dir);
      if (!e || e.invNos.has(r.invNo)) continue;
      e.invNos.add(r.invNo);
      const name = baseOf(r.file).replace(/\.\w+$/, '');
      e.rows.push({ seq: (/^(\d+)/.exec(name) || [])[1] || null, title: (/-(.+?)-\d+[^-]*$/.exec(name) || [, name])[1].slice(0, 14), amount: r.amount, low: /低值品/.test(r.file), invNo: r.invNo });
    }
    let n = 0;
    S.batches = S.batches || [];
    for (const e of found.values()) {
      if (S.batches.some(b => b.dir === e.dir)) continue;
      S.batches.push({ id: 'b' + Date.now().toString(36) + n, name: e.name, date: e.date, dir: e.dir, n: e.invNos.size, amount: e.amount,
        low: Math.round(e.rows.filter(r => r.low).reduce((a, r) => a + r.amount, 0) * 100) / 100, invNos: [...e.invNos], nos: [], rows: e.rows, pays: [], src: 'import', at: Date.now() + n });
      n++;
    }
    return n;
  }

  // 排活给淘宝页，并打开那个页面（已开着的页面也会领到活）
  // 连着排两份活时，两次「读出再写回」要一个接一个，不然后一次会把前一次盖掉
  let jobChain = Promise.resolve();
  // 返回排活时间（页面领活时记在 invClaim_<kind>.at，主页据此看出有没有页面领走这份活）
  function invJob(kind, url) {
    const at = Date.now();
    jobChain = jobChain.then(() => chrome.storage.local.get('invJobs'))
      .then(r => chrome.storage.local.set({ invJobs: Object.assign({}, r.invJobs, { [kind]: at }) }));
    // 扩展自己开标签页，不受弹窗拦截影响（window.open 点一下只放行一个）；上一份活开的标签页这时已经干完，交给后台关掉
    chrome.runtime.sendMessage({ type: 'openJobTab', url });
    return at;
  }
  // 淘宝页面只领 2 分钟内排的活（extension/panel.js otTakeJob）：过了 2 分 10 秒还没有页面领走，就不会再有了，别干等到这一段超时
  const JOB_CLAIM = 130000;
  async function unclaimed(kind, at) {
    if (Date.now() - at < tmo('claim', JOB_CLAIM)) return false;
    const c = (await chrome.storage.local.get('invClaim_' + kind))['invClaim_' + kind];
    return !c || c.at !== at;
  }
  const INV_URL = 'https://i.taobao.com/my_itaobao/invoice';
  const CHAT_URL = 'https://market.m.taobao.com/app/im/chat/index.html';
  async function queueDownloads(nos, all) {
    const byNo = new Map(invOrders().map(x => [x.o.no, x]));
    const jobs = [], seen = new Set();
    for (const no of nos) {
      const x = byNo.get(no); if (!x) continue;
      const s = invStatus(x), o = x.o, base = { no, saveAs: I.saveName({ time: o.time, amount: o.pay, shop: o.shop, no }) };
      if (s.key === 'ready') jobs.push(Object.assign({ id: 'p' + no, kind: 'platform' }, base));
      const c = chatOf(o);
      // 3D 打印订单缺明细：卖家在旺旺发来的表格、Word 一并下载，挂成这单的「3D打印明细」附件（attach，后台记进 attDone，不算发票）
      if (c && (c.docs || []).length && matOf(x).miss.includes('3D打印明细'))
        c.docs.forEach((f, i) => {
          const k = c.name + '|' + f.name + '|' + f.time;
          if (seen.has(k)) return; seen.add(k);
          jobs.push(Object.assign({ id: 'x' + no + '_' + i, kind: 'chat', attach: '3D打印明细', conv: c.name, nick: o.nick || c.nick || '', file: f.name, time: f.time },
            base, { saveAs: base.saveAs.replace(/\.pdf$/, '_3D打印明细' + (i ? '_' + (i + 1) : '') + '.pdf') }));
        });
      if (s.key !== 'replied' || !c) continue;
      // 分不清是哪单的（同店几单共用一个会话）也下：下完主页读 PDF 上的金额、开票日期，归错的自动挪到对的那单（用户 2026-10-04）
      c.files.forEach((f, i) => {
        const k = c.name + '|' + f.name + '|' + f.time;
        if (seen.has(k) || rejectedFor(f.name, no)) return; seen.add(k);
        // nick：会话不在旺旺左侧列表里时，按卖家旺旺名打开（会话名可能是店名，不能拿来拼地址）
        jobs.push(Object.assign({ id: 'c' + no + '_' + i, kind: 'chat', conv: c.name, nick: o.nick || c.nick || '', file: f.name, time: f.time },
          base, { saveAs: c.files.length > 1 ? base.saveAs.replace(/\.pdf$/, '_' + (i + 1) + '.pdf') : base.saveAs }));
      });
      // 卖家发的二维码：是税务局电子发票地址（dppt.<省>.chinatax.gov.cn…2_<20 位发票号>_…）就打开它下载 PDF
      for (const im of c.images || []) {
        const url = await qrUrl(im.src);
        const m = url && /^https:\/\/dppt\.[a-z]+\.chinatax\.gov\.cn(?::\d+)?\/.*?2_(\d{20})_/.exec(url);
        if (!m || seen.has('q' + m[1])) continue;
        seen.add('q' + m[1]);
        const alts = invOrders().filter(y => y.o.shop === o.shop && y.o.no !== no && !settled(y.o))
          .map(y => ({ no: y.o.no, amount: dueOf(y.o), saveAs: I.saveName({ time: y.o.time, amount: y.o.pay, shop: y.o.shop, no: y.o.no }) }));
        jobs.push(Object.assign({ id: 'q' + m[1], kind: 'qr', url, invNo: m[1], amount: dueOf(o), title: S.invoice.title, taxId: S.invoice.taxId, alts }, base));
      }
    }
    const { dlJobs } = await chrome.storage.local.get('dlJobs'), now = Date.now();
    // 旧活只留「半小时内排的、这单也还要下」的（淘宝页正在下）：连点两次不再派第二个页面重复下；
    // 没找到的、已挂上 PDF / 已整理的旧活清掉，免得以后下别的单时被顺带再下一遍（2026-09 离线复现）
    const still = j => { const x = byNo.get(j.no), k = x && invStatus(x).key;
      return j.attach ? !!x && matOf(x).miss.includes(j.attach) : j.kind === 'platform' ? k === 'ready' : k === 'replied'; };   // chat、qr 都是「卖家已回」
    const keep = (dlJobs || []).filter(j => now - (j.at || 0) < 1800e3 && still(j));
    const busy = new Set(keep.map(j => j.id));
    const add = jobs.filter(j => !busy.has(j.id)).map(j => Object.assign(j, { at: now }));
    await chrome.storage.local.set({ dlJobs: keep.concat(add) });
    // again：这次要下的、半小时内已经排过还没下完的（上一轮的页面可能没干完就关了）
    const again = keep.filter(j => jobs.some(x => x.id === j.id));
    return { add, again, busy: again.length };
  }
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  // 卖家发的图片 → 二维码里的地址（认不出就是空）
  async function qrUrl(src) {
    try { const { data } = await imgData(src); const q = window.jsQR && window.jsQR(data.data, data.width, data.height); return q ? q.data : ''; }
    catch (e) { return ''; }
  }

  // 每张新下载的发票：插件按下载地址把 PDF 取回来读（阿里云上的文件，扩展有权限），用价税合计、开票日期核对是不是这单的；
  // 不是的挪到对的那单、比下单还早的从这单拿掉（用户 2026-10-04：分不清几单就下下来，读金额和日期核对）。结果记在 S.fileChecks
  // 正在核对时又有新下载完成的：记下来，这一轮做完再来一轮（以前直接返回，后到的发票要等下一次下载才会被核对，
  // 「自动处理发票」结束时那一单还显示旧状态）
  let verifying = false, verifyAgain = false;
  async function verifyDownloads() {
    if (!EXT || !S.orders.length) return;
    if (verifying) { verifyAgain = true; return; }
    verifying = true; verifyAgain = false;
    try {
      const done = S.fileChecks || (S.fileChecks = {});
      const todo = [];
      for (const [no, list] of Object.entries(X.dlDone || {})) for (const g of list) if (g.url && !fcOf(g)) todo.push({ g, no });
      if (!todo.length) return;
      // 候选订单：要报销的实验室订单（应报金额 = 实付 − 退款），加上文件现在挂着的那一单。个人的、已报销的、关闭的单不参加，
      // 不然按用券前价格开的票会被挪给同店正好同价的个人订单
      const pick = new Map(invOrders().map(x => [x.o.no, x.o]));
      for (const t of todo) { const o = S.orders.find(y => y.no === t.no); if (o) pick.set(o.no, o); }
      const orders = [...pick.values()].map(o => ({ no: o.no, shop: o.shop, time: o.time, amount: dueOf(o) }));
      const have = new Map((S.haveIdx || []).map(x => [x.invNo, x]));
      const res = [];
      for (const { g, no } of todo) {
        const key = fcKey(g);
        try {
          const r = await readInvoicePdf(new File([await (await fetch(g.url)).blob()], g.file));
          // 读得出字、却没有「发票」字样的（说明书、报价单）：不是发票，从这单拿掉，这单退回「需向卖家索要」
          if (r.noInv) { done[key] = { kind: 'notinv' }; res.push({ file: g.file, path: g.path, no, kind: 'notinv' }); continue; }
          if (!r.isInvoice || r.amount == null) { done[key] = { kind: 'unread' }; continue; }
          const [c0] = I.checkFiles([Object.assign(r, { file: g.file })], orders);
          // 发票号和已整理（已报销）的一样：是那一单的票，不是这单的（2026-10-04 实测：一张票被「多一点」规则算到同店另一单，其实是以前已报销过的票）
          const c = Object.assign({}, c0, { path: g.path, no: c0.no || no }, have.has(r.invNo) ? { kind: 'dup' } : {});
          done[key] = { kind: c.kind, amount: c.amount, date: c.date, invNo: c.invNo, to: c.to || '', nos: c.nos || [], short: c.short || 0, dup: have.has(r.invNo) ? have.get(r.invNo).file : '',
                        items: r.items || '', seller: r.seller || '' };
          res.push(c);
        } catch (e) { done[key] = { kind: 'error', err: String(e.message || e) }; }    // 下载链接过期等：标红，请用户打开文件核对
      }
      persist();
      await applyFileCheck(res);
      const n = k => res.filter(c => k.includes(c.kind)).length;
      const good = n(['ok', 'more', 'merged', 'less']), moved = n(['move']), gone = n(['old', 'dup', 'notinv']), bad = todo.length - good - moved - gone;
      toast('已核对 ' + todo.length + ' 张新下载的发票（按金额和开票日期）：相符 ' + good + ' 张'
        + (moved ? '，' + moved + ' 张归属有误、已移至正确订单' : '') + (gone ? '，' + gone + ' 张不属于本单（以往、已报销的发票或不是发票），已移除' : '')
        + (bad > 0 ? '，' + bad + ' 张需核对（发票栏中已标红）' : ''), true);
      render();
    } finally { verifying = false; if (verifyAgain) verifyDownloads(); }
  }
  const CHECK_NOTE = { ok: '✓ PDF 金额、日期相符', more: '✓ 票面略高于实付（按用券前价格开具）', merged: '✓ 同店多单合开', less: '✓ 票面低于实付不足 1 元',
    short: '⚠ 票面低于应报金额 1 元以上，请联系卖家核对',
    move: '已移至正确订单', old: '⚠ 开票日期早于下单日期：属于以往其他订单', dup: '⚠ 与已整理（已报销）的发票为同一张，不属于本单', amount: '⚠ PDF 金额不符', many: '⚠ 同店多单均可匹配，请核对',
    title: '⚠ 抬头不符', unread: '⚠ 无法读取 PDF 金额，请打开文件核对', error: '⚠ 未能取回 PDF 核对，请打开文件核对' };
  // 核对结果按下载的实际位置记（同一个建议文件名可能先后下过两次：挪走后原订单又下了一次），旧版本按文件名记的照样认
  const fcKey = g => g.path ? 'p:' + g.path : g.file;
  const fcOf = g => { const fc = S.fileChecks || {}; return fc[fcKey(g)] || fc[g.file] || null; };
  // 卖家发来的文件经核对不是这单的（挪到同店另一单、以往的票、已报销的票、不是发票）：记在 S.rejectedSrc（按卖家发来时的文件名），
  // 以后不再当成这单的票去下载；挪走的只对挪去的那单（to，合开时几单用「,」隔开）照常算
  const rejectedFor = (name, no) => { const r = (S.rejectedSrc || {})[name]; return !!r && !(r.kind === 'move' && String(r.to || '').split(',').includes(no)); };
  const REJ_WHY = { dup: '已报销的发票', notinv: '不是发票', move: '已归入同店另一单' };
  function rejectedOnly(o, st) {
    if (st.key !== 'replied') return st;
    const c = chatOf(o), rej = S.rejectedSrc || {};
    if (!c || !c.files.length || (c.images || []).length || (c.email || []).length || !c.files.every(f => rejectedFor(f.name, o.no))) return st;
    return { key: 'ask', label: I.LABEL.ask, detail: '卖家发送的 ' + c.files.length + ' 个文件经核对均不属于本单（' + c.files.map(f => REJ_WHY[rej[f.name].kind] || '以往的发票').join('、') + '）' };
  }
  // 找淘宝客服督促过（vipSent）、还在等的单（已进入淘宝开票流程 / 已向卖家索要）：单独一个状态「已由淘宝客服督促」（用户 2026-10-05）。
  // base 记着原来在等谁，提醒和「请淘宝客服督促」按原来的等待时间算；别的还没到手的状态只在说明里注明督促过
  const URGED_BASE = { applying: '已申请淘宝开票', asked: '已向卖家索要发票' };
  function withVip(o, st) {
    const t = (X.vipSent || {})[o.no];
    if (!t || INV_GROUP[st.key] === 'done' || INV_GROUP[st.key] === 'ready') return st;
    const note = new Date(t).toLocaleDateString('zh-CN') + ' 已请淘宝客服督促';
    // 说明只留一行要点（「10-05 已督促 · 原状态：已向卖家索要发票」），原状态的进度原文等细节放进悬停说明
    if (st.key === 'applying' || st.key === 'asked') {
      const d = new Date(t), md = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      return { key: 'urged', base: st.key, label: I.LABEL.urged, since: st.detail,
               detail: md + ' 已督促 · 原状态：' + URGED_BASE[st.key],
               tip: note + ' · 原状态：' + st.label + (st.detail ? '（' + st.detail + '）' : '') };
    }
    return Object.assign({}, st, { detail: (st.detail ? st.detail + ' · ' : '') + note });
  }
  // 下载的票的核对结果写进说明；有一张核对不通过的，这单改成红色的「下载的发票核对不通过」（不算已取得，计入要用户动手的）
  function withCheck(o, st) {
    if (st.key !== 'done') return st;
    const got = (X.dlDone[o.no] || []).concat(S.invFiles[o.no] || []);
    const cs = got.map(fcOf).filter(Boolean);
    const notes = cs.map(c => (CHECK_NOTE[c.kind] || '') + (c.kind === 'short' ? '（少 ' + yuan(+c.short) + '）' : '') + (c.amount != null && c.kind !== 'error' ? '（' + yuan(+c.amount) + '，' + (c.date || '日期未读取') + '）' : '') + (c.dup ? '；与已整理的 ' + c.dup + ' 为同一张' : ''));
    const s2 = notes.length ? Object.assign({}, st, { detail: st.detail + ' · ' + notes.join('；'), checks: notes.join('；') }) : st;
    return cs.some(c => BAD_CHECK.includes(c.kind)) ? Object.assign({}, s2, { key: 'badinv', label: '下载的发票核对不通过' }) : s2;
  }

  // 打开每一单的订单详情页（extension/detail.js）：读旺旺图标上的卖家旺旺名，并看商品是不是已经退款成功了。
  // 用户 2026-10-04：「不用猜旺旺名，订单边上的旺旺图标点进去就是他」；同一天发现有一单热缩管在订单表里是交易成功、
  // 其实已经整单退款——给卖家发消息要发票之前先看一眼。整单退款的标成退款（不再要发票），返回被标退款的单数
  // shots：这几单顺便截订单页面（见 shotDetail），结果记在 inspectOrders.shots = { ok, fail: [原因] }
  async function inspectOrders(os, shots) {
    inspectOrders.shots = { ok: 0, fail: [] };
    if (!os.length) return 0;
    await chrome.storage.local.set({ nickWant: Object.fromEntries(os.map(o => [o.no, Date.now()])), detailFound: {} });
    let refunded = 0, partial = 0;
    for (const o of os) {
      toast((shots && shots.has(o.no) ? '正在截取订单页面：' : '正在读取订单详情：') + o.shop + '（' + (o.time || '').slice(0, 10) + '，' + yuan(+o.pay) + '）');
      // 每天自动处理（后台模式）时不抢用户当前的页面
      const tab = await chrome.tabs.create({ url: detailUrl(o.no), active: !J.quiet });
      for (let t = 0; t < 25000 && !J.stop; t += 800) {               // 「停止」后不再等：关掉这一页、记下已读到的
        await sleepMs(800);
        const { detailFound } = await chrome.storage.local.get('detailFound');
        const d = detailFound && detailFound[o.no];
        if (!d) continue;
        if (d.nick) o.nick = d.nick;
        // 整单退款：每件都退了，或者各件退款加起来 ≥ 本单实付（退货退款时详情页上的件数、单价可能和订单表对不上，
        // 之前件数不一样就什么都不记，整单退了的单还被当成要开票，2026-10-05 排查一单退货退款后仍被督促的问题时补上）
        // 整单退款只看退款合计 ≥ 实付；只有页面写了「退款成功」却没写金额（按整件算）的，才按每件都退完算整单退款。
        // 写了金额的部分退款（价保、赔偿，比如单价 9.90 退 5.00）照样开票，金额 = 实付 − 退款
        const refundSum = (d.lines || []).reduce((a, x) => a + (x.refund || 0), 0);
        if ((o.pay > 0 && refundSum + 0.005 >= o.pay) || (d.refunded && (d.lines || []).every(x => !x.stated))) {
          o.lines.forEach(l => { S.refunds[l.key] = true; l.refund = l.refund || '退款成功'; });
          refunded++;
        } else if (d.lines && d.lines.length === o.lines.length) {
          // 部分退款：记下每件退了多少钱（详情页上的商品顺序和订单里一样），报销金额 = 实付 − 退款
          d.lines.forEach((dl, i) => {
            const l = o.lines[i];
            if (dl.refund > 0) {
              l.refund = l.refund || '退款成功';
              (S.refundAmt = S.refundAmt || {})[l.key] = dl.refund;
              partial++;
            }
          });
        }
        // 支付宝交易号、付款时间（在订单信息区，截图里也有）：写进 README.txt，方便对照支付记录
        if (d.pay && (d.pay.alipay || d.pay.paidAt)) (S.payInfo = S.payInfo || {})[o.no] = d.pay;
        if (shots && shots.has(o.no) && !J.quiet) {
          try {
            const s = await shotDetail(o, tab);
            await attPut({ id: o.no + '|订单页面', no: o.no, kind: '订单页面', name: '订单页面.jpg', type: 'image/jpeg', blob: s.blob, w: s.w, h: s.h, at: Date.now() });
            inspectOrders.shots.ok++;
          } catch (e) { inspectOrders.shots.fail.push(o.shop + '：' + e.message); }
        }
        break;
      }
      if (shots && shots.has(o.no) && !(await chrome.storage.local.get('detailFound')).detailFound?.[o.no]) inspectOrders.shots.fail.push(o.shop + '：订单详情页 25 秒内未加载出来');
      try { await chrome.tabs.remove(tab.id); } catch (e) { /* 已经关了 */ }
      if (J.stop) break;
    }
    await chrome.storage.local.remove('nickWant');
    persist(); derive(); render();
    if (refunded || partial) toast((refunded ? refunded + ' 单在订单详情页显示整单退款成功，已标为退款，不再索要发票' : '')
      + (refunded && partial ? '；' : '') + (partial ? partial + ' 件为部分退款，已记录退款金额，报销金额按实付减退款计算' : ''));
    return refunded;
  }
  const resolveNicks = os => inspectOrders(os.filter(o => !o.nick));

  // redo：「自动处理发票」用。上一轮排过、还没下完的也再派一次页面去下（以前半小时内再点，主页说「没有需要下载的」，发票一直停在待下载）；
  // 发票表里逐单点「下载」时不重派（那一单正在下）
  async function startDownloads(nos, all, redo) {
    const { add, again, busy } = await queueDownloads(nos, all);
    const jobs = redo ? add.concat(again) : add;
    if (!jobs.length) return { n: 0, busy, ids: [] };
    // 二维码发票：逐张打开税务局页面（各自核对后下载、下完自己关掉）
    const qrs = jobs.filter(j => j.kind === 'qr');
    for (const j of qrs) { chrome.runtime.sendMessage({ type: 'openWorkTab', url: j.url }); await sleepMs(6000); }
    const plat = jobs.some(j => j.kind === 'platform'), chat = jobs.some(j => j.kind === 'chat');
    // 淘宝页面在后台标签里不干活（常常一片空白），两个页面同时开只有前台那个在下：
    // 两种都有时先开「全部发票」页，它下完平台票后由后台再打开旺旺页（extension/background.js 看 chatAfter）
    // chatAfter 记的是这一次的时间：主页只认这一次排的，后台过了半小时也不再认（留下的旧信号不让以后的下载空等）
    if (plat && chat) await chrome.storage.local.set({ chatAfter: Date.now() });
    if (plat) invJob('download', INV_URL);
    else if (chat) invJob('chatDownload', CHAT_URL);
    return { n: jobs.length, busy, ids: jobs.map(j => j.id) };
  }
  // ── 平台批量申请：交给批量开票页（extension/batch.js），它勾好、核对完停在淘宝的确认页，由用户点「确认提交」──
  const BATCH_URL = 'https://i.taobao.com/my_itaobao/pricelist/batchInvoice';
  const applyList = () => invOrders().filter(x => invStatus(x).key === 'apply');
  async function doApply(list) {
    if (!list.length) return 0;
    const days = list.map(x => (x.o.time || '').slice(0, 10)).filter(Boolean).sort();
    await chrome.storage.local.set({ applyResult: null, applyJob: { nos: list.map(x => x.o.no), from: days[0], to: days[days.length - 1],
      title: S.invoice.title, taxId: S.invoice.taxId, at: Date.now() } });
    chrome.runtime.sendMessage({ type: 'openWorkTab', url: BATCH_URL });         // 插件开的干活页：申请提交（或停下）后自己关掉
    return list.length;
  }
  // 批量开票页上没有的单（S.noPlatform：订单号 → 记下的时间）：14 天后不再算数，再试一次平台开票
  // （以前没有期限：页面加载慢、改版时一次误判就永远去找卖家）
  const NO_PLATFORM_DAYS = 14;
  const noPlatformOf = o => { const t = (S.noPlatform || {})[o.no]; return !!t && Date.now() - t < NO_PLATFORM_DAYS * 864e5; };
  function onApplyResult(r) {
    if (!r) return;
    for (const [no, t] of Object.entries(S.noPlatform || {})) if (Date.now() - t >= NO_PLATFORM_DAYS * 864e5) delete S.noPlatform[no];
    if ((r.missing || []).length) {
      S.noPlatform = S.noPlatform || {};
      r.missing.forEach(no => { S.noPlatform[no] = r.at; });
      persist(); derive(); render();
    }
    if (r.error) toast('平台申请已停止：' + r.error);
    else if (r.stage === 'confirm') toast('淘宝页面已勾选 ' + r.found.length + ' 单，请在「批量开票确认」中核对后点击「确认提交」'
      + (r.missing.length ? '；' + r.missing.length + ' 单无法在平台开票，已改为「' + I.LABEL.ask + '」' : ''));
    else if (r.stage === 'submitted') { toast('检测到已提交，正在刷新发票情况以确认'); invJob('sync', INV_URL); }
    else if (r.stage === 'none') toast('批量开票页中没有这些订单，无法在平台开票，已改为「' + I.LABEL.ask + '」');
  }

  // ── 自动处理发票（用户 2026-10-07：一个按钮做完全部，对外操作合成一次确认）──
  // 分段依次做，每段有超时，一段超时或出错就写明原因、接着做下一段（用户 2026-10-08：跑到最后像卡住了，要看得到在第几段、等什么、等了多久）：
  //   1 读取订单详情（不知道旺旺名、可能部分退款的单）→ 2 刷新淘宝开票记录 → 3 读取卖家旺旺回复 → 4 下载已开具的发票（等 PDF 核对完）
  //   → 5 确认对外操作：要在淘宝上提交或发送的（向卖家索要、按卖家开票入口申请、请客服督促、平台批量申请）列成一张清单，用户确认一次；
  //       插件做不了、要用户自己处理的「需处理」订单也列在清单里（以前它们不在任何一组，清单不弹、那一单就被跳过了）
  //   → 6 向卖家索要 → 7 按开票入口申请 → 8 请客服督促 → 9 平台批量申请（停在淘宝确认页，由用户点「确认提交」）。
  // 下载放在确认清单之前：下载后核对 PDF 可能把发票挪到别的单，清单要按下载、核对之后的状态列（以前先列清单后下载，下载后才变成「需处理」的单没人管）。
  // 几段共用一个旺旺页、都要在前台干活，所以一段做完再做下一段。每天自动刷新（#auto）只做前 4 段，不碰对外操作。
  // 进度在步骤条下方（statusBar）每秒更新；结束后重新计算状态、刷新界面，总结列出每段的结果和仍需处理的订单。每段的开始 / 结束 / 超时 / 出错写进 autoLog
  // quiet：每天自动刷新（后台性质）；stop：已要求停下；done：这一轮结束时兑现（停下后等它收尾再做用户的操作）
  const J = { busy: false, quiet: false, stop: false, done: Promise.resolve(), note: '', bad: false, run: '', cur: null, idx: 0, total: 0, results: [] };
  // 离线测试可以把某段的时限改短（__otDev.tmo = { sync: 3000 }），界面上没有入口
  const tmo = (k, ms) => (window.__otDev && window.__otDev.tmo && window.__otDev.tmo[k]) || ms;
  // 「停止」（用户点的，或用户操作时停掉每天自动刷新）：插件自己的等待就此结束、后面几段不再做；已经发出去的申请和消息不撤回
  const STOPPED = new Error('已停止');
  const stopCheck = () => { if (J.stop) throw STOPPED; };
  async function until(ok, ms, step) {
    for (let t = 0; t < ms; t += step || 1000) { stopCheck(); if (await ok()) return true; await sleepMs(step || 1000); }
    stopCheck();
    return !!(await ok());
  }
  async function stopRun(why) {
    if (!J.busy) return;
    if (!J.stop) {
      J.stop = true;
      alog('stop', J.quiet ? 'daily' : 'run', why);
      if (EXT) {
        // 旺旺页上这一轮还没做完的读取、自动发送队列撤掉；还没有页面领走的活也撤掉（已经在做的由页面做完）
        const { chatQueue, invJobs } = await chrome.storage.local.get(['chatQueue', 'invJobs']);
        if (chatQueue && (chatQueue.kind === 'scan' || (chatQueue.kind === 'compose' && chatQueue.auto))) await chrome.storage.local.remove('chatQueue');
        await chrome.storage.local.remove('askBeat');
        const jobs = Object.assign({}, invJobs), claims = await chrome.storage.local.get(Object.keys(jobs).map(k => 'invClaim_' + k));
        for (const k of Object.keys(jobs)) if (jobs[k] >= J.t0 && (claims['invClaim_' + k] || {}).at !== jobs[k]) delete jobs[k];
        await chrome.storage.local.set({ invJobs: jobs });
      }
      render();
    }
    await J.done;
  }
  const runWaitText = () => '正在自动处理发票' + (J.cur ? '（第 ' + J.cur.i + ' / ' + J.total + ' 段：' + J.cur.name + '）' : '');
  const STOP_TIP = '停止：不再等待淘宝页面、不再做后面几段；已经发出的申请和消息不撤回';
  // 用户要做逐单操作、打开旺旺：每天自动刷新是后台性质，直接停掉让路；用户自己点的「自动处理发票」进行中才拦下，写明在等什么，给「停止」
  async function freeForUser() {
    if (!J.busy) return true;
    if (J.quiet) { await stopRun('用户操作，停止每日刷新'); return true; }
    toast(runWaitText() + '。等它结束，或', false, { label: '停止', title: STOP_TIP, fn: () => stopRun('用户点「停止」') });
    return false;
  }
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + pad2(s % 60) + ' 秒'; };
  const NUMS = '①②③④⑤⑥⑦⑧⑨';
  function progressText() {
    const c = J.cur, head = J.quiet ? '每天自动刷新发票情况' : '正在处理发票';
    if (J.stop) return head + ' · 正在停止…';
    if (!c) return head + '…';
    return head + ' · 第 ' + c.i + ' / ' + J.total + ' 段：' + c.name + (c.wait ? ' · ' + c.wait : '') + ' · 已等 ' + mmss(Date.now() - c.t0);
  }
  const showProgress = () => { const el = document.querySelector('.read-bar[data-bar="inv"] > span'); if (el && J.busy) el.textContent = progressText(); };
  // 本机调试日志（界面上没有入口，用调试协议读 chrome.storage.local 的 autoLog）：由后台排队追加，只留最近 300 条，不进备份。
  // 每条 { t: 毫秒时间戳, at: '2026-10-08 06:15:03'（本机时间）, src: 'home' 或淘宝页面的域名, run: 本次处理的编号, stage: 哪一段, ev: start / end / skip / timeout / fail / error / info, msg, ms: 用时 }
  function alog(ev, stage, msg, extra) {
    if (!EXT) return;
    chrome.runtime.sendMessage({ type: 'autoLog', e: Object.assign({ run: J.run || '', stage, ev, msg: String(msg == null ? '' : msg).slice(0, 500) }, extra) }).catch(() => {});
  }
  // 一段：fn(w) 返回 { text, skip, timeout, bad }；w(文字) 更新「在等什么」。出错不往外抛，记下原因接着下一段
  async function stage(key, name, fn) {
    if (J.stop) return {};                                         // 已停止：后面几段不再做
    J.cur = { i: ++J.idx, name, wait: '', t0: Date.now() };
    alog('start', key, name);
    if (derived) render();
    let r;
    try { r = (await fn(w => { J.cur.wait = w; showProgress(); })) || {}; }
    catch (e) { r = e === STOPPED ? { text: '已停止', stopped: true } : { text: '出错：' + (e && e.message || e), error: true }; }
    if (J.stop && !r.stopped) r = Object.assign({}, r, { text: (r.text || '完成') + '（已停止）', stopped: true });
    const ms = Date.now() - J.cur.t0;
    alog(r.stopped ? 'stop' : r.error ? 'error' : r.timeout ? 'timeout' : r.skip ? 'skip' : r.bad ? 'fail' : 'end', key, r.text || '完成', { ms });
    J.results.push({ key, name, text: r.text || '完成', bad: !r.stopped && !!(r.bad || r.timeout || r.error) });
    return r;
  }
  // 1 读取订单详情：要看卖家回复、却不知道卖家旺旺名的（不然旺旺里找不到会话）；显示「退款成功」、还不知道退了多少钱的
  async function readDetails(w) {
    const miss = invOrders().filter(x => !x.o.nick && needsChat(invStatus(x))).map(x => x.o);
    const part = [...new Set(derived.rows.filter(x => !x.past && N.refundState(x.l, x.o) === 'refunded' && S.refunds[x.l.key] === undefined
      && (S.refundAmt || {})[x.l.key] == null && (S.decisions[x.l.key] || x.r.cat) === 'lab').map(x => x.o))];
    // 要附订单页面截图的（超过 1000 元、需用途说明）：顺便截图。每天自动刷新（后台模式）不截：截图要把详情页切到前台
    const shots = J.quiet ? [] : shotList();
    if (!miss.length && !part.length && !shots.length) return { skip: true, text: '无需读取' };
    if (miss.length) { w('读取 ' + miss.length + ' 单的卖家旺旺名'); await resolveNicks(miss); }
    if (part.length) { w('读取 ' + part.length + ' 单的退款金额'); await inspectOrders(part); }
    let shot = null;
    if (shots.length) { w('截取 ' + shots.length + ' 单的订单页面'); await inspectOrders(shots, new Set(shots.map(o => o.no))); shot = inspectOrders.shots; }
    const still = miss.filter(o => !o.nick).length;
    return { text: '已读取 ' + (miss.length + part.length + shots.length) + ' 单' + (still ? '，' + still + ' 单未读到卖家旺旺名' : '')
      + (shot ? '；截取订单页面 ' + shot.ok + ' / ' + shots.length + ' 单' + (shot.fail.length ? '（' + shot.fail[0] + '）' : '') : ''), bad: !!still || !!(shot && shot.fail.length) };
  }
  // 2 刷新淘宝开票记录（「我的发票」页）。超时就沿用上次的结果
  // 干活页报来的失败（jobFail，panel.js otFail 写）：这一段开始之后、属于这几段的
  // 干活页被关掉（background.js 看 chrome.tabs.onRemoved 写 jobFail { stage: 'closed', page }）：正等着那个页面的这几段立即结束
  const STAGE_PAGES = { sync: ['inv'], download: ['inv', 'chat'], chatDownload: ['chat'], chat: ['chat'], scan: ['chat'], ask: ['chat'], vip: ['vip'], apply: ['batch'] };
  const failHits = (jf, t0, stages) => !!jf && jf.at >= t0
    && (jf.stage === 'closed' ? stages.some(s => (STAGE_PAGES[s] || []).includes(jf.page)) : stages.includes(jf.stage));
  async function jobFailSince(t0, stages) {
    const { jobFail } = await chrome.storage.local.get('jobFail');
    return failHits(jobFail, t0, stages) ? jobFail.why : '';
  }
  async function refreshSync(w) {
    const t0 = Date.now(), lim = tmo('sync', 180000);
    const at = invJob('sync', INV_URL);
    w('等待「我的发票」页面读取开票记录');
    let why = '';
    const got = await until(async () => (X.invSync && X.invSync.at >= t0) || !!(why = await jobFailSince(t0, ['sync']))
      || (await unclaimed('sync', at) && !!(why = '「我的发票」页面未开始读取（页面未打开或未显示在前台）')), lim);
    if (got && X.invSync && X.invSync.at >= t0)
      return { text: '完成，共 ' + Object.keys(X.invSync.rows || {}).length + ' 单开票记录' + (X.invSync.partial ? '（仅读取 ' + (X.invSync.tabs != null ? X.invSync.tabs : '部分') + ' / 3 个标签，其余沿用上次结果）' : ''),
               bad: !!X.invSync.partial };
    const keep = '，沿用' + (X.invSync ? '上次（' + whenShort(X.invSync.at) + '）的结果' : '空结果');
    if (why) return { bad: true, text: '未完成：' + why + keep };
    return { timeout: true, text: '超时：' + mmss(lim) + '内未读到开票记录（可能未登录淘宝或页面空白）' + keep };
  }
  // 3 读取卖家旺旺回复：只看还需要卖家回复的店。超时就停掉旺旺页上的扫描（后面下载、发消息也要用这个旺旺页），沿用上次结果
  async function refreshChat(w) {
    const want = invWant();
    if (!want || !want.chat.length) return { skip: true, text: '没有需要读取的会话' };
    const shops = new Set(want.chat.map(x => x.shop)).size, t1 = Date.now(), lim = tmo('scan', 600000);
    // 旺旺页按扩展存储里的清单读：先写好这一刻的清单再排活（以前只在状态变化时写，可能和这里数的店对不上）
    await chrome.storage.local.set({ invWant: want });
    const at = invJob('scan', CHAT_URL);
    w('等待旺旺页面读取 ' + shops + ' 家店的回复');
    let why = '';
    const stopScan = async () => { const { chatQueue } = await chrome.storage.local.get('chatQueue'); if (chatQueue && chatQueue.kind === 'scan') await chrome.storage.local.remove('chatQueue'); };
    if (await until(async () => (X.chatScan && X.chatScan.at >= t1) || !!(why = await chatTrouble(t1))
      || (await unclaimed('scan', at) && !!(why = '旺旺页面未开始读取（页面未打开或未显示在前台）')), lim)) {
      if (why && !(X.chatScan && X.chatScan.at >= t1)) { await stopScan(); return { bad: true, text: '未完成：' + why + '，沿用上次结果' }; }
      const failed = X.chatScan.failed || [], read = X.chatScan.read;
      // 没读成的会话：这几单标成「旺旺会话未能读取」（不退回「需向卖家索要」），这里写明是哪几家、为什么
      const fl = failed.slice(0, 3).map(f => f.name + '（' + f.why + '）').join('、') + (failed.length > 3 ? ' 等' : '');
      // 还没联系过、也没有会话的店：不算失败，写明几家
      const none = (X.chatScan.none || []).length ? '；' + X.chatScan.none.length + ' 家尚未联系过、没有会话' : '';
      if (!read && failed.length) return { bad: true, text: '旺旺会话未能读取 ' + failed.length + ' 家：' + fl + none };
      return { text: '完成，读取 ' + (read != null ? read : shops) + ' 个会话' + (failed.length ? '；未能读取 ' + failed.length + ' 家：' + fl : '') + none, bad: !!failed.length };
    }
    await stopScan();
    return { timeout: true, text: '超时：' + mmss(lim) + '内未读完旺旺回复，沿用上次结果' };
  }
  // 4 下载已开具的发票：等淘宝页下完（这一批的活都做完；2 分钟没有进展或超过 5 分钟就不等了），再等下载的 PDF 核对完
  const newFiles = t0 => Object.values(X.dlDone || {}).concat(Object.values(X.attDone || {})).reduce((a, l) => a + l.filter(g => (g.at || 0) >= t0).length, 0);
  async function downloadAll(w) {
    const t0 = Date.now();
    const r = await startDownloads(invOrders().map(x => x.o.no), true, true);
    if (!r.n) return { skip: true, text: '没有可下载的发票' };
    const lim = tmo('download', 5 * 60000), idleMax = tmo('downloadIdle', 120000);
    let last = null, idle = Date.now(), left = [], why = '', reopened = false;
    for (;;) {
      stopCheck();
      const { dlJobs, chatAfter } = await chrome.storage.local.get(['dlJobs', 'chatAfter']);
      left = (dlJobs || []).filter(j => r.ids.includes(j.id));
      const key = left.map(j => j.id).join(',');
      if (key !== last) { last = key; idle = Date.now(); }
      w('等待淘宝页面下载：已处理 ' + (r.n - left.length) + ' / ' + r.n + ' 个');
      if (!left.length) { if (chatAfter) await chrome.storage.local.remove('chatAfter'); break; }
      // 干活页报了失败（安全验证、页面没加载出来）：旺旺页失败、或平台票失败而且没有卖家的文件要下，就不再等，写明原因；
      // 平台票失败、还有卖家的文件要下：接着去旺旺页下（下面 chatAfter 那条）
      const { jobFail: jf0 } = await chrome.storage.local.get('jobFail');
      // 页面被关掉的：「我的发票」页按平台票失败算，旺旺页按卖家文件失败算
      const jf = jf0 && jf0.stage === 'closed' ? Object.assign({}, jf0, { stage: jf0.page === 'inv' ? 'download' : jf0.page === 'chat' ? 'chatDownload' : 'closed' }) : jf0;
      const fail = jf && jf.at >= t0 && ['download', 'chatDownload', 'chat'].includes(jf.stage) ? jf : null;
      const chatLeft = left.some(j => j.kind === 'chat');
      if (fail && (fail.stage !== 'download' || !chatLeft)) { why = fail.why; break; }
      // 「我的发票」页没把平台票下完（页面空白、没登录）时，后台不会接着开旺旺页：90 秒没进展，主页自己开旺旺页下卖家发的文件
      // （只认这一次排的 chatAfter：以前留下的旧信号不算）
      if (chatAfter && chatAfter >= t0 && !reopened && (Date.now() - idle > 90000 || fail) && chatLeft) {
        reopened = true; idle = Date.now();
        await chrome.storage.local.remove('chatAfter');
        alog('info', 'download', '「我的发票」页 90 秒没有进展，直接打开旺旺页下载卖家发送的文件');
        invJob('chatDownload', CHAT_URL);
      }
      if (Date.now() - idle > idleMax) { why = mmss(idleMax) + '内没有进展'; break; }
      if (Date.now() - t0 > lim) { why = '超过 ' + mmss(lim); break; }
      await sleepMs(2000);
    }
    await chrome.storage.local.remove('chatAfter');
    // 点了下载的文件要等浏览器下完、后台记进 dlDone；然后等 PDF 核对完（核对可能把发票挪到别的单）
    const tried = r.n - left.length;
    w('等待文件下载完成');
    await until(() => newFiles(t0) >= tried, 30000);
    w('核对下载的发票 PDF');
    verifyDownloads();
    await until(() => !verifying && !verifyAgain, 120000);
    const got = newFiles(t0), miss = r.n - got;
    return { text: '下载 ' + got + ' 个发票文件' + (miss > 0 ? '，' + miss + ' 个未完成（' + (why || '淘宝页面上未找到或下载失败') + '）' : ''),
             timeout: !!why, bad: miss > 0 };
  }
  // 一张确认清单，分组列出（颜色和发票状态一致），每行可取消勾选；返回每组每行是否保留，取消返回 null。
  // info 组（插件做不了、要用户自己处理的）只列出来，没有勾选框；清单里只有这一组时按钮是「知道了」
  function confirmGroups(groups) {
    const acts = groups.filter(g => !g.info), info = !acts.length;
    const n = acts.reduce((a, g) => a + g.rows.length, 0), m = groups.reduce((a, g) => a + g.rows.length, 0);
    $('list-title').textContent = info ? '需手动处理（' + m + ' 单）' : '确认对外操作（' + n + ' 项）';
    $('list-note').textContent = info ? '以下订单插件无法自动处理，请在发票表中点该行的操作。' : '以下操作会在淘宝上提交申请或发送消息。取消勾选的不处理；确认后自动依次完成。';
    $('list-rows').innerHTML = groups.map((g, gi) => '<h4 class="grp tone-' + g.tone + '" title="' + esc(g.tip) + '">' + esc(g.title) + '（' + g.rows.length + '）</h4>'
      + g.rows.map((h, i) => g.info ? '<div class="ask-row"><span aria-hidden="true">•</span> ' + h + '</div>'
        : '<label class="ask-row"><input type="checkbox" data-g="' + gi + '" data-row="' + i + '" checked title="取消勾选则不处理此项"> ' + h + '</label>').join('')).join('');
    $('list-ok').textContent = info ? '知道了' : '确认执行'; $('list-ok').title = info ? '关闭清单' : '按勾选的清单自动依次完成';
    $('list-ok').hidden = false; $('list-cancel').textContent = '取消'; $('list-cancel').hidden = info;
    $('list-hint').hidden = info; $('list-hint').textContent = '取消：不提交、不发送。';
    $('dlg-list').showModal();
    return new Promise(res => {
      const done = ok => { $('dlg-list').close(); res(ok ? groups.map((g, gi) => g.info ? [] : g.rows.map((h, i) => $('list-rows').querySelector('[data-g="' + gi + '"][data-row="' + i + '"]').checked)) : null); };
      $('list-ok').onclick = () => done(true);
      $('list-cancel').onclick = () => done(false);
      $('dlg-list').oncancel = () => done(false);
    });
  }
  // 5 确认对外操作：按下载、核对之后的状态列清单；插件做不了的「需处理」订单单独列一组（写明原因和该点哪个操作）
  async function confirmStage(w, pick) {
    w('整理需要确认的操作（读取要联系的卖家的旺旺名、核对是否已退款）');
    const ask = await prepareAsk(), card = cardList(), vip = vipList(), apply = applyList();
    const covered = new Set(ask.items.flatMap(g => g.nos).concat([card, vip, apply].flat().map(x => x.o.no)));
    const manual = invOrders().filter(x => !covered.has(x.o.no) && invTone(x.o, invStatus(x)) === 'bad');
    const groups = [
      { key: 'ask', title: '向卖家索要发票', tone: 'wait', tip: '每家一条消息，经旺旺自动发送', rows: askRows(ask.items), items: ask.items },
      { key: 'card', title: '按卖家的开票入口申请', tone: 'bad', tip: '点卖家发来的开票卡片，核对订单号和抬头后提交', rows: cardRows(card), items: card },
      { key: 'vip', title: '请淘宝客服督促', tone: 'urge', tip: '超过 ' + remindDays() + ' 天未开票，转人工客服后逐单督促', rows: vipRows(vip), items: vip },
      { key: 'apply', title: '申请平台开票', tone: 'plat', tip: '在淘宝「批量开票」页勾选并核对抬头，停在确认页，由用户点「确认提交」', rows: apply.map(x => orderRow(x.o, x.lines)), items: apply },
      { key: 'manual', title: '需手动处理', tone: 'bad', info: true, tip: '插件无法自动处理，请在发票表中点该行的操作', rows: manual.map(x => orderRow(x.o, x.lines, manualNote(x))), items: manual },
    ].filter(g => g.rows.length);
    if (!groups.length) return { skip: true, text: '没有需要提交、发送或手动处理的订单' };
    w('请在弹出的清单中确认');
    chrome.runtime.sendMessage({ type: 'focusMe' }).catch(() => {});        // 清单弹在主页上：主页在后台标签时用户看不到，像卡住了
    const keep = await confirmGroups(groups);
    for (const [gi, g] of groups.entries()) if (!g.info) pick[g.key] = keep ? g.items.filter((x, i) => keep[gi][i]) : [];
    const n = Object.values(pick).reduce((a, l) => a + l.length, 0);
    return { text: (groups.some(g => !g.info) ? (keep ? '已确认 ' + n + ' 项' : '已取消，不提交、不发送') : '无对外操作')
      + (manual.length ? '；需手动处理 ' + manual.length + ' 单' : '') };
  }
  function manualNote(x) {
    const s = invStatus(x), a = rowAction(x, s, false);
    return s.label + (s.detail ? '：' + String(s.detail).slice(0, 80) : '') + (s.key === 'ask' && !x.o.nick ? '（未读取到卖家旺旺名）' : '')
      + (a ? ' → 点该行的「' + a.label + '」' : '');
  }
  async function runInvoice(checkOnly) {
    if (hasSample()) return;
    // 用户点「自动处理发票」时每天自动刷新正在跑：停掉它，接着做用户这一轮
    if (J.busy) { if (checkOnly || !J.quiet) return; await stopRun('用户操作，停止每日刷新'); if (J.busy) return; }
    if (!checkOnly && needInvoiceInfo()) return;
    const tRun = Date.now();
    let release;
    Object.assign(J, { busy: true, quiet: !!checkOnly, stop: false, done: new Promise(r => { release = r; }), t0: tRun,
                       note: '', bad: false, run: 'r' + Date.now().toString(36), cur: null, idx: 0, total: checkOnly ? 4 : 9, results: [] });
    alog('start', 'run', checkOnly ? '每天自动刷新发票情况' : '自动处理发票');
    // 告诉后台主页正在处理（homeBusy，session 存储，每 15 秒续一次）：每天自动处理到点时看到主页正忙就跳过这一次，不打断
    const beat = () => chrome.storage.session.set({ homeBusy: { t: Date.now(), run: J.run } }).catch(() => {});
    beat();
    let nBeat = 0;
    const tick = setInterval(() => { showProgress(); if (++nBeat % 15 === 0) beat(); }, 1000);
    let waitUser = false;                                             // 平台申请停在淘宝确认页等用户点：结束时别把主页切到前台盖住它
    try {
      await stage('detail', '读取订单详情', readDetails);
      await stage('sync', '刷新淘宝开票记录', refreshSync);
      await stage('scan', '读取卖家旺旺回复', refreshChat);
      await stage('download', '下载已开具的发票', downloadAll);
      if (!checkOnly) {
        const pick = {};
        await stage('confirm', '确认对外操作', w => confirmStage(w, pick));
        await stage('ask', '向卖家索要发票', async w => {
          const sel = pick.ask || [];
          if (!sel.length) return { skip: true, text: '无' };
          w('旺旺页逐家核对会话后发送，每家间隔 8～15 秒（共 ' + sel.length + ' 家）');
          const r = await doAsk(sel, true, false, w);
          return { text: '已发送 ' + r.n + ' / ' + sel.length + ' 家' + (r.why ? '（' + r.why + '，未发的已停止）' : r.timeout ? '（超时，未发的已停止）' : ''), timeout: r.timeout, bad: r.n < sel.length };
        });
        await stage('card', '按开票入口申请', async w => {
          const sel = pick.card || [];
          if (!sel.length) return { skip: true, text: '无' };
          const out = await runCards(sel, w), ok = out.filter(x => x.ok).length;
          return { text: '成功 ' + ok + ' / ' + out.length + ' 单' + (ok < out.length ? '：' + out.filter(x => !x.ok).map(x => x.text.replace(/^未完成\s*/, '')).join('；') : ''), bad: ok < out.length };
        });
        await stage('vip', '请淘宝客服督促', async w => {
          const sel = pick.vip || [];
          if (!sel.length) return { skip: true, text: '无' };
          w('等待官方客服转人工并发送 ' + sel.length + ' 单的督促消息');
          const n = await doVip(sel);
          return { text: '已发送 ' + n + ' / ' + sel.length + ' 单' + (n < sel.length ? '（' + (doVip.why || mmss(tmo('vip', 6 * 60000)) + '内未全部发出，可能未转接到人工客服') + '）' : ''),
                   timeout: n < sel.length && !doVip.why, bad: n < sel.length };
        });
        await stage('apply', '申请平台开票', async w => {
          const sel = pick.apply || [];
          if (!sel.length) return { skip: true, text: '无' };
          const t0 = Date.now(), lim = tmo('apply', 180000);
          await doApply(sel);
          w('等待「批量开票」页勾选并核对 ' + sel.length + ' 单');
          let res = null, why = '';
          await until(async () => { const { applyResult: a } = await chrome.storage.local.get('applyResult'); return !!(res = a && a.at >= t0 ? a : null) || !!(why = await jobFailSince(t0, ['apply'])); }, lim, 1500);
          if (!res && why) return { bad: true, text: '未完成：' + why };
          if (!res) return { timeout: true, text: '超时：' + mmss(lim) + '内「批量开票」页未完成勾选，请查看该页面' };
          if (res.error) return { bad: true, text: '已停止：' + res.error };
          if (res.stage === 'none') return { bad: true, text: '批量开票页中没有这些订单，已改为「' + I.LABEL.ask + '」' };
          waitUser = res.stage === 'confirm';
          return { text: '已勾选 ' + (res.found || []).length + ' 单，停在淘宝「批量开票确认」页，请核对后点击「确认提交」'
            + ((res.missing || []).length ? '；' + res.missing.length + ' 单无法在平台开票' : '') };
        });
      }
    } finally {
      clearInterval(tick);
      chrome.storage.session.remove('homeBusy').catch(() => {});
      const stopped = J.stop;
      J.busy = false; J.quiet = false; J.cur = null;
      // 手动这一轮正常做完（含在清单里点了取消）：今天的每天自动刷新就不必再跑。
      // 每天自动刷新被用户操作停掉的：清掉「今天已运行」，等用户 30 分钟没操作后下一次检查时再跑
      if (EXT && !stopped && !checkOnly) chrome.storage.local.set({ autoLast: new Date().toDateString() }).catch(() => {});
      if (EXT && stopped && checkOnly) chrome.storage.local.set({ autoLast: '' }).catch(() => {});
      // 结束时按最新数据重算一遍状态、刷新整个界面（顶上的计数、发票表、需处理的单）
      derive();
      const bad = invOrders().filter(x => invTone(x.o, invStatus(x)) === 'bad');
      const head = J.results.find(r => r.key === 'download');
      // 每天自动刷新被用户操作停掉：不留提示条（用户正在做自己的事）
      J.note = stopped && checkOnly ? '' : (stopped ? '发票处理已停止（' + whenShort(Date.now()) + '）。' : '发票处理完成（' + whenShort(Date.now()) + '）'
        + (head && /^下载 [1-9]/.test(head.text) ? '：' + head.text.split('，')[0] : '') + '。')
        + (bad.length ? '仍需处理 ' + bad.length + ' 单：' + bad.slice(0, 5).map(x => x.o.shop + '（' + invStatus(x).label + '）').join('、') + (bad.length > 5 ? ' 等' : '') + '，见发票表中标红的行。' : '')
        + '\n' + J.results.map((r, i) => (NUMS[i] || (i + 1) + '.') + ' ' + r.name + '：' + r.text).join('\n');
      J.bad = !stopped && J.results.some(r => r.bad);
      render();
      alog('end', 'run', stopped ? '已停止' : J.note.split('\n')[0], { ms: Date.now() - tRun, results: J.results.map(r => r.key + ':' + (r.bad ? '!' : '') + r.text).slice(0, 12) });
      // 干活页都关了，切回主页看结果（用户 2026-10-08：停在旺旺页上像卡住了）。每天自动刷新是后台打开的主页，不抢前台
      if (!waitUser && !checkOnly && !stopped && EXT) chrome.runtime.sendMessage({ type: 'focusMe' }).catch(() => {});
      J.stop = false;
      release();
    }
  }
  // 离线测试用（tools/e2e-*.py）：单独触发「自动处理发票」里的某一段、逐单操作，或把某段的时限改短（tmo）；界面上没有这些入口
  window.__otDev = {
    tmo: null,
    sync: () => invJob('sync', INV_URL), scan: () => invJob('scan', CHAT_URL), download: () => startDownloads(invOrders().map(x => x.o.no), true, true),
    queue: nos => queueDownloads(nos).then(r => r.add.length),
    lists: () => ({ ask: askList().items.length + askList().noNick.length, card: cardList().length, vip: vipList().length, apply: applyList().length }),
    ask: async auto => doAsk((await prepareAsk()).items, auto), card: () => runCards(cardList()), vip: () => doVip(vipList()), apply: () => doApply(applyList()),
    cards: nos => runCards(cardList().filter(x => nos.includes(x.o.no))),
    refresh: () => refreshSync(() => {}),
    chatStage: () => refreshChat(() => {}),                         // 「读取卖家旺旺回复」这一段，返回这一段的结果文字
    want: () => invWant(),
    row: (act, no) => rowAct(act, no),
    daily: () => runInvoice(true),                                  // 相当于后台到点发来的每天自动刷新
    run: () => ({ busy: J.busy, quiet: J.quiet, stop: J.stop, cur: J.cur && J.cur.name }),
    inspect: nos => inspectOrders(nos.map(no => S.orders.find(o => o.no === no)).filter(Boolean)),
    due: no => { const o = S.orders.find(x => x.no === no); return o ? dueOf(o) : null; },
    // 报销规范（低值品、要补的材料、附件、截图）
    mat: no => { const x = invOrders().find(g => g.o.no === no); return x ? matOf(x) : null; },
    att: no => attsOf(no), attLoad: () => attLoad().then(() => render()),
    details: () => readDetails(() => {}),
    batches: () => (S.batches || []).map(b => Object.assign({}, b, batchState(b))),
    // 这几单现在会排哪些下载（只看不排：排完把下载清单放回原样）
    jobsFor: async nos => { const { dlJobs } = await chrome.storage.local.get('dlJobs'); const r = await queueDownloads(nos);
      await chrome.storage.local.set({ dlJobs: dlJobs || [] }); return r.add.map(j => j.no + ' ' + (j.file || j.kind)); },
  };
  // 手动挂 PDF（比如卖家发到邮箱的）：用扩展的下载功能复制一份进「订单分拣-发票」，按订单改好名
  async function attachFile(no, file) {
    const x = invOrders().find(g => g.o.no === no);
    if (!x || !file) return;
    const ext = ((/\.(pdf|ofd|xml)$/i.exec(file.name) || [])[1] || 'pdf').toLowerCase();
    const name = I.saveName({ time: x.o.time, amount: x.o.pay, shop: x.o.shop, no }, ext);
    const url = URL.createObjectURL(file);
    try {
      await chrome.runtime.sendMessage({ type: 'ownName', url, name });     // 后台决定文件名时按这个填，不然会用原文件名
      await chrome.downloads.download({ url, filename: '订单分拣-发票/' + name, conflictAction: 'uniquify' });
      (S.invFiles[no] = S.invFiles[no] || []).push({ file: name, at: Date.now(), from: 'manual', src: file.name });
      persist(); render(); toast('已添加发票：' + name);
    } catch (e) { toast('保存失败：' + e.message); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
  }

  // ── 从淘宝读取订单（用户 2026-10-07：新人大多没用过淘宝网页版，卡在「导出订单表」；改成插件自己翻订单页读，订单表降为可选）──
  // 主页写 readJob = { at, from }（from = 上次报销那天的后一天；30 分钟内有效）并开一个「已买到的宝贝」干活页 → 淘宝页（extension/taobao.js）领到活后自动翻页，
  // 进度写 readProgress；读完后台写 readResult、关掉干活页、切回主页。读到的订单照常经 scraped 并进来（mergeFromExt）。
  // S.readFrom：读过的最早一天。这一天及以后、主页还没有的订单按订单页建单；已有订单只补图片、退款、状态，判断全部保留
  const READ_LIFE = 30 * 60e3;
  const READ_TIP = '将打开淘宝「已买到的宝贝」，自动翻页读取上次报销之后的订单、商品图片和退款状态；未登录时请在打开的页面登录一次，读取完成后自动回到本页';
  const R = { job: null, progress: null, result: null };
  const readRange = () => S.readFrom ? { from: S.readFrom, before: '9999-12-31' } : null;
  // 正在读：任务还有效（等登录、正在翻），或进度 2 分钟内更新过（读得久的，过了 30 分钟也还在翻）
  const readBusy = () => !!((R.job && Date.now() - R.job.at < READ_LIFE) || (R.progress && Date.now() - (R.progress.t || 0) < 120000));
  const readShort = () => R.progress && R.progress.state === 'reading' ? '读取中 · 第 ' + (R.progress.page + 1) + ' 页'
    : R.progress && R.progress.state === 'verify' ? '等待安全验证' : '等待登录淘宝';
  function readNote() {
    const p = R.progress;
    if (readBusy()) {
      if (p && p.state === 'reading') return '正在读取：第 ' + (p.page + 1) + ' 页，已读 ' + (p.stored || 0) + ' 单。读取期间请勿关闭淘宝页面。';
      if (p && p.state === 'verify') return '淘宝页面出现安全验证：请切换到该页面手动完成验证，完成后自动继续读取。';
      return '已打开淘宝「已买到的宝贝」，等待登录淘宝…未登录时请在打开的页面用手机淘宝 App 扫码，或输入账号密码登录，登录后自动开始读取。';
    }
    return R.result ? readResultText(R.result) : '';
  }
  // 读取进度 / 结果的颜色（步骤条下方和「开始使用」卡片共用）：进行中蓝；等安全验证、没读到、中途停下红（要用户去淘宝页处理）；读完绿
  function readTone() {
    const busy = readBusy(), p = R.progress;
    if (busy) return { busy: !(p && p.state === 'verify'), bad: !!(p && p.state === 'verify') };
    return { busy: false, bad: !!(R.result && (!(R.result.nos || []).length || ['stopped', 'verify', 'stuck', 'max'].includes(R.result.why))) };
  }
  function readResultText(r) {
    const when = new Date(r.done).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const nos = r.nos || [];
    if (r.why === 'stopped') return '读取已停止（' + when + '）：已读取 ' + nos.length + ' 单。再次点击「从淘宝读取订单」可重新读取。';
    if (r.why === 'verify') return '读取未完成（' + when + '）：淘宝页面的安全验证未完成。完成验证后再次点击「从淘宝读取订单」。';
    if (!nos.length) return '未读取到订单（' + when + '）。请确认已在打开的页面登录淘宝、页面显示的是「已买到的宝贝」订单列表；页面正常显示订单仍读取不到时，可能是淘宝改版，请反馈给维护者。';
    const set = new Set(nos), os = S.orders.filter(o => set.has(o.no));
    const lines = os.reduce((a, o) => a + o.lines.length, 0);
    const refunded = os.reduce((a, o) => a + o.lines.filter(l => N.refundState(l, o) === 'refunded').length, 0);
    const days = os.map(o => (o.time || '').slice(0, 10)).filter(Boolean).sort();
    return '已读取 ' + os.length + ' 单 ' + lines + ' 件（' + (days.length ? days[0] + ' 至 ' + days[days.length - 1] : '无日期') + '），其中退款 ' + refunded + ' 件（' + when + '）。'
      + (r.why === 'stuck' || r.why === 'max' ? '翻页中途停止，可能未读到最早的订单，可再次读取。' : '');
  }
  // 读取对话框只问一件事（用户 2026-10-07）：上次报销到哪天。默认：填过的日期 > 导入过已整理发票时推断的那天 > 最近 6 个月
  const ymd = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  function defaultSince() {
    const s = sinceInfo();
    if (s.date || s.guess) return s.date || s.guess;
    const d = new Date(); d.setMonth(d.getMonth() - 6);
    return ymd(d);
  }
  function openRead() {
    if (!EXT) { toast('从淘宝读取订单需安装为 Chrome 扩展；网页版请导入订单表'); return; }
    const s = sinceInfo();
    $('read-since').value = defaultSince();
    $('read-hint').textContent = (s.date ? '默认为上次填写的日期 ' + s.date + '。' : s.guess ? '默认为已整理的发票中最晚一单的下单日期 ' + s.guess + '。' : '默认为 6 个月前。')
      + '订单越多读取越久，每页约 5 秒。';
    $('read-err').textContent = '';
    $('dlg-read').showModal();
  }
  async function startRead() {
    const since = $('read-since').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) { $('read-err').textContent = '请选择上次报销到哪天'; return; }
    $('dlg-read').close();
    // 只读这天之后的订单：淘宝页从最新往前翻到这天的后一天为止；这天及以前的旧订单不再判断（S.since）
    const d = new Date(since + 'T00:00:00'); d.setDate(d.getDate() + 1);
    const from = ymd(d);
    S.since = since;
    if (!S.readFrom || from < S.readFrom) S.readFrom = from;
    S.orders = S.orders.filter(o => !/^示例-/.test(o.no));          // 试用的示例订单不和真实订单混在一起
    persist(); derive(); render();
    R.job = { at: Date.now(), from }; R.progress = null; R.result = null;
    await chrome.storage.local.remove(['readProgress', 'readResult']);
    await chrome.storage.local.set({ readJob: R.job });
    chrome.runtime.sendMessage({ type: 'openWorkTab', url: TAOBAO });        // 插件开的干活页：读完由后台关掉
    render();
    toast('已打开淘宝「已买到的宝贝」：未登录时请在该页面登录，登录后自动开始读取');
  }
  function onReadResult(r) {
    if (!r) return;
    // 最后一页的数据先于结果写进 scraped，这里再并一次保证结果里的订单都在。
    // 读完直接显示当前该做的那一步（用户 2026-10-07：停在第 1 步时下方还是读取按钮，和上方高亮的步骤对不上）；
    // 读取结果在步骤条下方一直显示（statusBar），并用提示条报一次
    chrome.storage.local.get('scraped').then(x => {
      mergeFromExt(x.scraped);
      // 这次真正翻过的日期范围（读到的最早一天到最晚一天）里、订单列表上却根本没出现过的订单：多半是用户删进回收站的
      // （没有交易争议），不再为它要发票（goneNos）。范围只算读到的那几天：认不出「下一页」只读了第 1 页时，后面的订单不会被当成删除；
      // 只读了 1 页就结束的不算；页面上出现过、只是没解析出来的（seen）也不算删除
      if (r.from && ['past', 'end'].includes(r.why) && (r.nos || []).length && !(r.why === 'end' && (r.pages || 0) <= 1)) {
        const seen = new Set((r.seen || []).concat(r.nos)), day = o => (o.time || '').slice(0, 10);
        const ds = S.orders.filter(o => seen.has(o.no)).map(day).filter(Boolean).sort();
        const lo = [r.from, ds[0] || ''].sort().pop(), hi = ds[ds.length - 1] || '';
        chrome.storage.local.set({ goneNos: S.orders.filter(o => { const d = day(o); return d && d >= lo && d <= hi && !seen.has(o.no) && !/^示例-/.test(o.no); }).map(o => o.no) });
      }
      const cur = flowSteps().findIndex(st => !st.done);
      view.step = cur >= 0 ? cur : null;
      render(); toast(readResultText(r));
    });
  }
  function closeReadResult() {
    R.result = null;
    chrome.storage.local.remove('readResult');
    render();
  }

  // ── 首次使用（没有订单时的「开始使用」卡片）：两项——填抬头税号（填了打勾）、从淘宝读取订单（显示读取进度）──
  function renderGuide() {
    const ok = !!(S.invoice.title && S.invoice.taxId);
    const li = document.querySelector('#guide > li[data-g="info"]');
    li.classList.toggle('is-done', ok);
    li.querySelector('.g-n').textContent = ok ? '✓' : '1';
    const el = $('g-read'), note = EXT ? readNote() : '', s = note ? readTone() : {};
    el.hidden = !note;
    el.textContent = note;
    el.className = 'g-note' + (s.busy ? ' busy' : s.bad ? ' bad' : '');
  }
  function guideAction(k) {
    if (k === 'settings') openSettings();
    else if (k === 'read') openRead();
  }

  // ── 补图片 ──
  function openImages() {
    if (!S.orders.length) { toast('请先导入订单表，再补充图片'); return; }
    $('img-older').value = S.older || '';
    renderImages();
    $('dlg-img').showModal();
  }
  function renderImages() {
    const m = N.missingImages(S.orders), r = olderRange();
    let lines = 0, withImg = 0;
    for (const o of S.orders) for (const l of o.lines) { lines++; if (l.img) withImg++; }
    $('img-cov').textContent = S.orders.length + ' 单中有图 ' + (S.orders.length - m.nos.length) + ' 单，'
      + lines + ' 件中有图 ' + withImg + ' 件。'
      + (m.nos.length ? '缺图 ' + m.nos.length + ' 单（最早 ' + (m.from || '日期未知') + '）。' : '已全部有图。');
    const first = tableFirst();
    $('img-older-note').textContent = r ? '将翻页至 ' + r.from + '，' + r.from + ' 至 ' + first + ' 前一天的订单按订单页内容建单'
      : S.older ? '日期须早于订单表最早一天（' + first + '）' : '订单表最早为 ' + (first || '—') + '，如需提取更早的订单请在此填写';
    $('img-copy').disabled = !m.nos.length && !r;
    $('img-msg').textContent = '';
  }
  async function copyScraper() {
    const m = wantList();                             // 和扩展版同一份清单；没有订单表时是 null（抓看到的全部）
    const code = '// 订单分拣 · 补图片抓取脚本（清单 ' + (m ? m.nos.length + ' 单' : '：全部') + '）。只读取本页已显示的订单，不上传任何数据\n('
      + window.orderTriageScraper.toString() + ')(' + JSON.stringify(m) + ');\n';
    let ok = false;
    try { await navigator.clipboard.writeText(code); ok = true; }
    catch (e) {                                       // 剪贴板接口不可用时的老办法；临时框放在弹窗里，弹窗外的元素选不中
      const t = document.createElement('textarea');
      t.value = code; $('dlg-img').appendChild(t); t.select();
      try { ok = document.execCommand('copy'); } catch (e2) { /* 下面提示失败 */ }
      t.remove();
    }
    $('img-msg').textContent = ok ? '已复制（清单 ' + (m ? m.nos.length + ' 单' : '：全部订单') + '），请在淘宝订单页的控制台粘贴运行' : '复制失败，请更换浏览器重试';
  }

  // ── 设置 ──
  // note：打开设置的原因（比如整理报销文件前要填姓名），显示在设置顶上一行
  function openSettings(note) {
    $('set-note').textContent = typeof note === 'string' ? note : '';
    $('set-note').hidden = typeof note !== 'string';
    $('person-name').value = (S.person && S.person.name) || '';
    $('person-sid').value = (S.person && S.person.sid) || '';
    $('inv-title').value = S.invoice.title || '';
    $('inv-tax').value = S.invoice.taxId || '';
    $('inv-tpl').value = S.invoice.template || I.DEFAULT_TEMPLATE;
    $('inv-email').value = S.invoice.email || '';
    $('remind-days').value = remindDays();
    const ad = S.prefs.autoDaily || {};
    $('auto-daily').checked = !!ad.on; $('auto-hour').value = ad.hour != null ? ad.hour : 10;
    $('inv-tax-err').textContent = '';
    $('rules-err').textContent = '';
    $('dlg-settings').showModal();
  }
  function saveSettings() {
    const tax = $('inv-tax').value.trim().toUpperCase();
    if (tax && !I.taxIdOk(tax)) { $('inv-tax-err').textContent = '税号校验不通过，请核对（18 位，最后一位是校验位）'; return; }
    S.invoice = { title: $('inv-title').value.trim(), taxId: tax,
                  template: $('inv-tpl').value.trim() === I.DEFAULT_TEMPLATE ? '' : $('inv-tpl').value.trim(),
                  email: $('inv-email').value.trim() };
    S.person = { name: $('person-name').value.trim(), sid: $('person-sid').value.trim() };
    S.prefs.remindDays = Math.max(1, Math.min(60, +$('remind-days').value || 7));
    const hr = $('auto-hour').value.trim() === '' || isNaN(+$('auto-hour').value) ? 10 : +$('auto-hour').value;     // 0 点也是合法的设置
    S.prefs.autoDaily = { on: $('auto-daily').checked, hour: Math.max(0, Math.min(23, hr)) };
    if (EXT) chrome.storage.local.set({ autoDaily: S.prefs.autoDaily });
    persist(); derive(); render();
    $('dlg-settings').close(); toast('设置已保存');
  }

  // ── 备份数据 / 从备份恢复（用户 2026-10-05）：全部数据只在本机浏览器里，删掉扩展或清浏览器数据就没了 ──
  // 备份文件：{ app: 'orderTriage', kind: 'backup', format: 1, version, at, localStorage: { 'orderTriage.*': 原样字符串 }, storage: chrome.storage.local 全部 }
  // 格式有不兼容的改动时 format 加一；旧插件见到不认识的 format 就拒绝，不去猜
  const VERSION = EXT ? chrome.runtime.getManifest().version : '0.20.0';     // 网页版读不到 manifest，selftest 核对两处一致
  const BACKUP_FORMAT = 1;
  // 恢复时丢掉的扩展存储键：进行中的任务、页面领活记录、标签页编号这类临时状态。恢复回去的话，开着的淘宝页一读到就会接着干活
  // （重新提交开票申请、给卖家发消息、找客服督促、下载），标签页编号也早已失效。
  //   applyJob 平台批量开票任务（extension/batch.js）      applyResult 批量开票的一次性结果通知
  //   cardJobs / cardRun 按开票入口申请的任务（chat.js、apply-card.js）
  //   chatQueue 旺旺页的扫描 / 发消息 / 下载进度（chat.js） chatAfter 平台票下完后接着开旺旺页下载的信号（background.js）
  //   dlJobs 待下载的发票（invoice-list.js、chat.js）      invJobs 主页派给淘宝页的活   invClaim_* 页面领活记录（panel.js）
  //   otReload_* 空白页自动刷新记录（panel.js）            jobTabs 派活开的标签页编号（background.js）
  //   nickWant 待读卖家旺旺名的订单（detail.js）           vipJob 请淘宝客服督促的任务（vip.js）
  //   olderDone 「订单表之前的订单已提取完」的一次性信号  autoLast 每日自动处理上次运行的日期（恢复时记成今天，免得一恢复就自动开始）
  //   readJob / readProgress / readResult 「从淘宝读取订单」的任务、进度和一次性结果（taobao.js、background.js）
  //   autoLog 本机调试日志（见 alog）：只为排查，备份时也不带
  //   askBeat 自动发送这一轮主页还在等的心跳（doAsk）    chatLost 旺旺页被新开的旺旺页顶掉的信号（background.js）
  //   jobFail 干活页没办成的一次性结果（panel.js otFail）
  const BACKUP_SKIP = ['applyJob', 'applyResult', 'cardJobs', 'cardRun', 'chatQueue', 'chatAfter', 'dlJobs', 'invJobs', 'jobTabs', 'nickWant', 'vipJob', 'olderDone', 'autoLast',
    'readJob', 'readProgress', 'readResult', 'autoLog', 'askBeat', 'chatLost', 'jobFail'];
  const skipKey = k => BACKUP_SKIP.includes(k) || /^(invClaim_|otReload_)/.test(k);
  const OWN_LS = k => /^orderTriage\./.test(k);
  const stampOf = d => d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  const newerVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false; };
  async function backupData() {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (OWN_LS(k)) ls[k] = localStorage.getItem(k); }
    const now = new Date();
    const b = { app: 'orderTriage', kind: 'backup', format: BACKUP_FORMAT, version: VERSION, at: now.toISOString(), localStorage: ls,
                storage: EXT ? await chrome.storage.local.get(null) : {} };
    delete b.storage.autoLog;                           // 调试日志不进备份
    const name = '订单分拣-备份-' + stampOf(now) + '.json';
    const blob = new Blob([JSON.stringify(b)], { type: 'application/json' });
    if (EXT) await saveBlob(blob, '订单分拣-备份/' + name);
    else {
      const a = document.createElement('a'), url = URL.createObjectURL(blob);
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    toast('已备份 ' + S.orders.length + ' 单、' + Object.keys(S.decisions || {}).length + ' 条判断：' + (EXT ? '下载文件夹「订单分拣-备份」中的 ' : '下载文件夹中的 ') + name);
  }
  // 校验通过返回 { b, orders, decisions }，否则抛出给用户看的原因
  function readBackup(text) {
    let b;
    try { b = JSON.parse(text); } catch (e) { throw new Error('文件不是有效的 JSON'); }
    if (!b || b.app !== 'orderTriage' || b.kind !== 'backup') throw new Error('不是订单分拣的备份文件');
    if (b.format !== BACKUP_FORMAT) throw new Error('备份文件格式（' + b.format + '）无法识别，本插件仅支持格式 ' + BACKUP_FORMAT + '，请升级插件后再恢复');
    const ls = b.localStorage, st = b.storage == null ? {} : b.storage;
    if (!ls || typeof ls !== 'object' || Array.isArray(ls) || Object.entries(ls).some(([k, v]) => !OWN_LS(k) || typeof v !== 'string'))
      throw new Error('备份文件中的主页数据不完整');
    if (typeof st !== 'object' || Array.isArray(st)) throw new Error('备份文件中的扩展数据不完整');
    let d = null;
    if (ls[STORE] != null) { try { d = JSON.parse(ls[STORE]); } catch (e) { /* 下面报错 */ } if (!d || !Array.isArray(d.orders)) throw new Error('备份文件中的订单数据已损坏'); }
    return { b: Object.assign({}, b, { storage: st }), orders: d ? d.orders.length : 0, decisions: d ? Object.keys(d.decisions || {}).length : 0 };
  }
  async function restoreData(file) {
    let r;
    try { r = readBackup(await file.text()); }
    catch (e) { alert('无法从备份恢复：' + e.message + '。当前数据未改动。'); return; }
    const { b } = r, at = new Date(b.at);
    const lines = ['将用备份覆盖当前全部数据（订单、判断、设置、开票与下载记录），当前数据无法找回。', '',
      '备份时间：' + (isNaN(at) ? '未知' : at.toLocaleString('zh-CN', { hour12: false })),
      '插件版本：' + (b.version || '未知') + (newerVer(b.version, VERSION) ? '（新于当前版本 ' + VERSION + '，部分数据可能无法识别）' : ''),
      '订单：' + r.orders + ' 单', '判断：' + r.decisions + ' 条'];
    if (!EXT && Object.keys(b.storage).length) lines.push('', '网页版仅恢复订单、判断和设置；开票与下载记录需在扩展中恢复。');
    if (S.orders.length) lines.push('', '如需保留当前数据，请先取消，用「更多 → 备份数据」备份。');
    lines.push('', '进行中的任务（申请、发消息、下载等）不恢复。确认恢复？');
    if (!confirm(lines.join('\n'))) return;
    restoring = true;
    try {
      for (const k of Object.keys(localStorage).filter(OWN_LS)) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(b.localStorage)) localStorage.setItem(k, v);
      if (EXT) {
        const keep = Object.fromEntries(Object.entries(b.storage).filter(([k]) => !skipKey(k)));
        keep.autoLast = new Date().toDateString();
        await chrome.storage.local.clear();
        await chrome.storage.local.set(keep);
      }
    } catch (e) {
      restoring = false;
      alert('恢复时写入失败：' + e.message + '。请重新选择备份文件恢复。');
      return;
    }
    location.reload();
  }

  // ── 事件 ──
  function bind() {
    $('btn-import').onclick = $('btn-import2').onclick = () => $('file').click();
    $('read-go').onclick = () => startRead().catch(e => toast('出错：' + e.message));
    $('read-cancel').onclick = () => $('dlg-read').close();
    $('file').onchange = e => { if (e.target.files.length) importFiles([...e.target.files]); e.target.value = ''; };
    $('btn-sample').onclick = async () => {
      S.orders = N.rowsToOrders(window.SAMPLE_ROWS);
      persist(); derive(); render(); toast('已载入 8 单示例数据（全部虚构）');
    };
    $('empty').addEventListener('click', e => { const g = e.target.closest('[data-guide]'); if (g) guideAction(g.dataset.guide); });
    const drop = $('empty');
    ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('drag'); }));
    document.addEventListener('drop', e => { const f = [...(e.dataTransfer && e.dataTransfer.files || [])]; if (f.length) importFiles(f); });

    // 顶栏「更多」：点了里面的一项、或点到外面，就收起来
    const more = $('more');
    more.addEventListener('click', e => { if (e.target.closest('.more-pop button')) more.open = false; });
    document.addEventListener('click', e => { if (more.open && !more.contains(e.target)) more.open = false; });
    // 藏起来的选文件框：由按钮触发（data-pick = 输入框的 id）
    document.addEventListener('click', e => { const p = e.target.closest('[data-pick]'); if (p) $(p.dataset.pick).click(); });
    // 商品图、商品名：在新标签页打开这单的订单详情
    document.addEventListener('click', e => {
      const a = e.target.closest('a[data-detail]');
      if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault(); openDetail(a.dataset.detail);
    });

    $('inv-tax').oninput = e => { const v = e.target.value.trim(); $('inv-tax-err').textContent = v && !I.taxIdOk(v) ? '校验不通过' : v ? '✓ 校验通过' : ''; };
    $('inv-pack-dir').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) openPack(f).catch(err => toast('读取发票出错：' + err.message)); };
    $('pack-list').addEventListener('click', e => { const t = e.target.closest('[data-lowno]'); if (t) toggleLowOrder(t.dataset.lowno, t.dataset.lowv); });
    $('pay-ok').onclick = savePay;
    $('pay-cancel').onclick = () => $('dlg-pay').close();
    $('pack-go').onclick = () => makePack().catch(e => { toast('整理出错：' + e.message); $('pack-go').disabled = false; });
    $('pack-cancel').onclick = () => $('dlg-pack').close();
    $('inv-have-dir').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importHaveDir(f).catch(err => toast('读取 PDF 出错：' + err.message)); };
    $('list').addEventListener('change', e => { const f = e.target.closest('input[data-inv="attach"]'); if (f && f.files[0]) addFile(f.dataset.no, f.files[0]).catch(err => toast('添加出错：' + err.message)); f.value = ''; });
    $('img-copy').onclick = copyScraper;
    $('img-older').onchange = e => { S.older = e.target.value || ''; persist(); renderImages(); };
    $('img-close').onclick = () => $('dlg-img').close();
    $('btn-settings').onclick = openSettings;
    $('btn-taobao').onclick = () => openUrl(TAOBAO);
    $('rules-save').onclick = saveSettings;
    $('rules-cancel').onclick = () => $('dlg-settings').close();
    $('data-backup').onclick = () => backupData().catch(e => toast('备份出错：' + e.message));
    $('backup-file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreData(f).catch(err => alert('恢复出错：' + err.message)); };
    $('data-clear').onclick = async () => {
      if (!confirm('清除本浏览器中保存的全部订单、判断和发票记录？下载文件夹中的发票不受影响。\n\n清除前会自动备份一份到下载文件夹的「订单分拣-备份」，需要时可从备份恢复。')) return;
      // 先自动备份（点错了还能找回）；备份不成就不清
      if (S.orders.length) { try { await backupData(); } catch (e) { toast('自动备份失败，未清除：' + e.message); return; } }
      try { localStorage.removeItem(STORE); } catch (e) { /* 忽略 */ }
      if (EXT) {
        await chrome.storage.local.clear();
        // 设置里的「每天自动刷新」开关存在 S.prefs，清除后仍保留：扩展存储里这份也写回，免得设置显示开着、实际已不运行
        if (S.prefs.autoDaily) await chrome.storage.local.set({ autoDaily: S.prefs.autoDaily });
      }
      await attClear();                                   // 本机存的截图和附件也清掉
      S = { orders: [], decisions: {}, refunds: {}, rules: null, prefs: S.prefs, invoice: { title: I.DEFAULT_TITLE, taxId: I.DEFAULT_TAX, template: '', email: '' }, invFiles: {}, haveIdx: [],
            person: { name: '', sid: '' }, lowval: {}, batches: [] };
      Object.assign(R, { job: null, progress: null, result: null });
      $('dlg-settings').close(); derive(); render();
    };

    $('summary').addEventListener('click', e => {
      const f = e.target.closest('button[data-flow]');
      if (f) {
        const k = f.dataset.flow;
        if (k === 'import') $('file').click();
        else if (k === 'read') openRead();
        else if (k === 'read-close') closeReadResult();
        else if (k === 'inv-close') { J.note = ''; render(); }
        else if (k === 'sort-done') confirmSort();
        else if (k === 'sort-cat') confirmCat();
        else if (k === 'inv-run') runInvoice(false);
        else if (k === 'inv-stop') stopRun('用户点「停止」');
        else if (k === 'pack') { if (personOk()) $('inv-pack-dir').click(); }
        else if (k === 'img-dlg') openImages();
        return;
      }
      const pay = e.target.closest('[data-pay]');
      if (pay) { openPay(pay.dataset.pay); return; }
      const li = e.target.closest('[data-step]');
      if (li) { view.step = +li.dataset.step; render(); }
    });
    $('summary').addEventListener('keydown', e => { if (e.key === 'Enter') { const li = e.target.closest('[data-step]'); if (li) li.click(); } });
    $('cat-seg').addEventListener('click', e => {
      const b = e.target.closest('[data-cat]');
      if (b) { view.cat = b.dataset.cat; view.focus = null; render(); }
    });
    let qt = null;
    $('q').oninput = e => { clearTimeout(qt); qt = setTimeout(() => { view.q = e.target.value; renderList(); }, 120); };

    $('list').addEventListener('click', e => {
      const ww = e.target.closest('[data-ww]');
      if (ww) { openChat(ww.dataset.ww).catch(err => toast('出错：' + err.message)); return; }
      const ra = e.target.closest('button[data-act]');
      if (ra) { rowAct(ra.dataset.act, ra.dataset.no).catch(err => toast('出错：' + err.message)); return; }
      const sg = e.target.closest('[data-go]');
      if (sg) { goStatus(sg.dataset.go, sg.dataset.no); return; }
      const lp = e.target.closest('[data-low]');
      if (lp) { toggleLow(lp.dataset.low, lp.dataset.lowv); return; }
      const lt = e.target.closest('[data-lowno]');
      if (lt) { toggleLowOrder(lt.dataset.lowno, lt.dataset.lowv); return; }
      const line = e.target.closest('.line'); if (!line) return;
      const key = line.dataset.key;
      if (e.target.closest('[data-keep]')) { setKeep(key); return; }
      const set = e.target.closest('[data-set]');
      if (set) { view.focus = key; setDecision(key, set.dataset.set); return; }
      if (!e.target.closest('a')) { view.focus = key; renderList(); }
    });

    document.addEventListener('keydown', e => {
      if (e.target.closest('input,textarea,select,dialog')) { if (e.key === 'Escape') e.target.blur(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) { if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); } return; }
      if (!S.orders.length || view.list === 'invoice') return;      // 发票栏里没有选中的商品，别改到看不见的那件
      const k = e.key.toLowerCase();
      if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
      else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
      else if (k === '/') { e.preventDefault(); $('q').focus(); }
      else if (view.focus && (k === '1' || k === 'l')) setDecision(view.focus, 'lab');
      else if (view.focus && (k === '2' || k === 'p')) setDecision(view.focus, 'personal');
      else if (view.focus && k === 'r') toggleRefund(view.focus);
      else if (view.focus && (k === '0' || e.key === 'Backspace')) { e.preventDefault(); setDecision(view.focus, 'auto', { stay: true }); }
    });
  }

  restore();
  // 另一个主页标签改写了数据：本页的数据已经旧了，不再写回（不然会把那边的判断、读到的旺旺名和退款金额盖掉），提示后刷新
  window.addEventListener('storage', e => {
    if (e.key !== STORE || restoring) return;
    restoring = true;
    toast('数据已在另一个主页标签中更改，正在刷新本页');
    setTimeout(() => location.reload(), 1500);
  });
  if (EXT) {
    document.body.classList.add('is-ext');
    // 用户正在用主页（点按钮、按键、逐单操作）：记在 session 存储 homeActive（最多 15 秒写一次），
    // 后台每天自动刷新到点时看到 30 分钟内有操作就推迟到下一次检查，不打扰正在用的人
    let lastAct = 0;
    const markActive = () => { const now = Date.now(); if (now - lastAct < 15000) return; lastAct = now; chrome.storage.session.set({ homeActive: { t: now } }).catch(() => {}); };
    document.addEventListener('pointerdown', markActive, true);
    document.addEventListener('keydown', markActive, true);
    // 每天自动处理到点（background.js）：主页开着就直接在这里开始，不刷新页面（刷新会丢掉正在弹出的清单和读到的数据）
    chrome.runtime.onMessage.addListener((m, sender, reply) => {
      if (!(m && m.type === 'autoRun')) return;
      reply(true);
      if (!J.busy && S.orders.length) { toast('每天自动刷新发票情况：开始'); runInvoice(true); }
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || restoring) return;
      if (ch.scraped) mergeFromExt(ch.scraped.newValue);
      if (ch.olderDone) olderFinished(ch.olderDone.newValue);
      if (ch.readJob) { R.job = ch.readJob.newValue || null; render(); }
      if (ch.readProgress) { R.progress = ch.readProgress.newValue || null; render(); }
      if (ch.readResult) { R.result = ch.readResult.newValue || null; onReadResult(R.result); }
    });
    chrome.storage.local.get(['scraped', 'olderDone', 'readJob', 'readProgress', 'readResult']).then(r => {
      Object.assign(R, { job: r.readJob || null, progress: r.readProgress || null, result: r.readResult || null });
      mergeFromExt(r.scraped); olderFinished(r.olderDone); render(); });
    chrome.storage.local.remove('want');                // 旧版本留下的缺图清单：淘宝页已不再按它自动出面板
    // 读回同步结果后再写一次 invWant：刚打开时还没读回来，所有单都算「需找卖家」，旺旺要看的店会多出一大堆
    chrome.storage.local.get(XKEYS).then(r => {
      for (const k of XKEYS) X[k] = r[k] || XEMPTY(k);
      derive();                                       // 「已开过发票」会影响分类，读回来要重算
      chrome.storage.local.set({ invWant: invWant() });
      render();
      checkImages();
      verifyDownloads();
      // 后台每天定时打开的（#auto）：数据读回来后自己跑一次「检查开票情况」
      if (location.hash === '#auto' && S.orders.length) {
        history.replaceState(null, '', location.pathname);
        toast('每天自动刷新发票情况：开始');
        runInvoice(true);                              // 只做检查和下载，不碰对外操作
      }
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || restoring) return;
      let hit = false;
      for (const k of XKEYS) if (ch[k]) { X[k] = ch[k].newValue || XEMPTY(k); hit = true; }
      if (ch.applyResult && ch.applyResult.newValue) onApplyResult(ch.applyResult.newValue);
      if (ch.qrFail) onQrFail(ch.qrFail.oldValue, ch.qrFail.newValue);
      if (ch.dlDone) verifyDownloads();
      if (hit && S.orders.length) {
        derive();
        chrome.storage.local.set({ invWant: invWant() });        // 状态变了，旺旺要看的范围跟着变
        render();
      }
    });
  }
  derive();
  { const u = derived.rows.find(x => effCat(x) === 'unsure'); if (u) view.focus = u.l.key; }
  bind();
  render();
  devLoad();
  attLoad().then(() => { if (S.orders.length) render(); });          // 本机存的截图、附件（IndexedDB）
})();
