/* 订单分拣 —— 界面与状态。全部在本机浏览器内运行。 */
(function () {
  'use strict';
  const N = window.Normalize, C = window.Classify, T = window.TableReader, I = window.Invoice, Z = window.Zip;
  const STORE = 'orderTriage.app.v1';
  // 作为 Chrome 扩展主页打开时：缺图清单写给淘宝页，淘宝页抓到的数据从扩展存储自动并进来
  const EXT = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.runtime && chrome.runtime.id);
  const TAOBAO = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = n => String(n).padStart(2, '0');
  const yuan = n => n == null ? '—' : '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── 状态 ──
  let S = { orders: [], decisions: {}, refunds: {}, rules: null, prefs: { autoNext: true, sort: 'desc' },
            invoice: { title: I.DEFAULT_TITLE, taxId: I.DEFAULT_TAX, template: '', email: '' }, invFiles: {}, haveIdx: [] };
  // 扩展存储里淘宝页读回来的发票数据：全部发票同步结果、旺旺扫描结果、已下载记录（只在扩展里有）
  // cardApplied：按卖家开票卡片提交过申请的单（extension/apply-card.js 记）；cardResult：每单按卡片申请的结果；qrFail：二维码发票核对没通过的
  const X = { invSync: null, chatScan: null, dlDone: {}, cardApplied: {}, cardResult: {}, qrFail: {} };
  const XKEYS = ['invSync', 'chatScan', 'dlDone', 'askSent', 'vipSent', 'goneNos', 'cardApplied', 'cardResult', 'qrFail'];
  const XEMPTY = k => k === 'goneNos' ? [] : ['invSync', 'chatScan'].includes(k) ? null : {};
  const view = { cat: 'unsure', q: '', from: '', to: '', focus: null, step: null };   // 打开先看「待定」：要你动手的在这里
  let derived = null;           // 每次数据/判断变化后重算
  let undoStack = [];
  let restoring = false;        // 正在从备份恢复：页面马上刷新，期间不再写存储，免得旧数据盖掉刚恢复的

  function persist() {
    if (restoring) return;
    try { localStorage.setItem(STORE, JSON.stringify(S)); }
    catch (e) { toast('本机存储写入失败，可能是浏览器存储空间不足'); }
    if (EXT) chrome.storage.local.set({ want: wantList() });
  }
  // 给淘宝页的缺图清单：只算订单表里的订单。没有订单表时给 null，淘宝页就抓看到的全部订单来建单
  // （按抓取数据临时建的单如果也算进清单，淘宝页会只盯着这几单，后面几页的订单就不存了）
  function wantList() {
    const table = S.orders.filter(o => o.source !== 'scrape' || o.older);      // 按订单页建的「订单表之前」的单缺图也要补
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
  const needsChat = st => ['ask', 'asked', 'replied', 'card'].includes(st.key) || (st.key === 'urged' && st.base === 'asked');
  function invWant() {
    if (!derived) return null;
    const list = invOrders();
    const pick = xs => xs.map(x => ({ no: x.o.no, shop: x.o.shop, nick: x.o.nick || '', time: x.o.time, amount: x.o.pay }));
    const first = xs => xs.map(x => (x.o.time || '').slice(0, 10)).filter(Boolean).sort()[0] || '';
    const chat = list.filter(x => needsChat(invStatus(x)));
    return { orders: pick(list), since: first(list), chat: pick(chat), chatSince: first(chat),
             title: S.invoice.title, taxId: S.invoice.taxId };
  }
  function mergeFromExt(scraped) {
    const list = Object.values(scraped || {});
    if (!list.length) return;
    const none = !S.orders.length;
    const r = N.mergeScraped(S.orders, list, { addNew: none, addRange: olderRange() });
    if (!r.matched && !r.added) return;
    persist(); derive(); render();
    if (r.filled || r.added) toast('已从淘宝订单页补充图片 ' + r.filled + ' 件' + (r.added ? (none ? '（尚无订单表，已按抓取数据建立 ' : '（订单表之前的订单，已按订单页建立 ') + r.added + ' 单）' : ''));
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
    } catch (e) { /* 私密窗口等情况下读不到，当作空白开始 */ }
  }
  // 词表写死在代码里（设置里的词表编辑已删）；以前保存的自定义词表不再使用
  const rules = () => C.DEFAULT_RULES;

  // 上次报销到哪一单：那一单及以前的订单不再判断。
  // 用户指定了日期就按日期；否则自动找「已整理的发票」（导入的发票文件夹 / 已报销订单号清单）对得上的订单里最晚的一单。
  // S.since：'YYYY-MM-DD' 指定日期；'none' 从订单表第一单开始算；空 = 自动
  function sinceInfo() {
    if (S.since === 'none') return { mode: 'none' };
    if (/^\d{4}-\d{2}-\d{2}$/.test(S.since || '')) return { mode: 'date', at: S.since + '~', date: S.since };   // '~' 排在时分秒后面，当天的单都算「以前」
    let best = null;
    for (const o of S.orders) if (o.time && haveOf(o) && (!best || o.time > best.time)) best = o;
    return best ? { mode: 'auto', at: best.time, date: best.time.slice(0, 10), no: best.no, shop: best.shop } : { mode: 'unknown' };
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
      const past = !!(since.at && (o.time || '') <= since.at);       // 上次报销截止那单及以前：不再判断
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
        // 退款由插件按每一件旁边的退款文字判断，不用用户核对：
        //   退款成功 → 这一件退了；退款关闭 → 申请撤销了，东西留下；交易关闭 → 整单关闭。一单多件只退了几件时，只有那几件算退款。
        // 同一件买了几个只退了其中几个（比如买 3 个退 2 个）在订单列表上看不出数量，记在 S.partial：{ key: 留下的个数 }
        const mr = S.refunds[l.key];
        const keep = S.partial && S.partial[l.key];
        let ref = mr === true ? 'refunded' : mr === false ? '' : N.refundState(l, o);
        let share = shares[i];
        // 用户 2026-10-05 的规则：「退款成功」要看退了多少钱——退款 ≥ 实付才算退掉；少于实付是部分退款，照样要开票，金额 = 实付 − 退款
        // （退款金额来自订单详情页，见 inspectOrders；用户手动标过的以手动为准）
        const ra = mr === undefined && S.refundAmt ? S.refundAmt[l.key] : null;
        if (ra != null) {
          if (ra + 0.005 < share) { ref = ''; share = Math.round((share - ra) * 100) / 100; }
          else ref = 'refunded';
        } else if (keep != null && ref === 'refunded' && l.qty > 1) { ref = ''; share = Math.round(share * keep / l.qty * 100) / 100; }
        rows.push({ o, l, share, r, ref, past, keep: keep != null && !ref && ra == null ? keep : null, refAmt: ra != null && !ref ? ra : null, refManual: mr !== undefined });
      });
    }
    derived = { rows, byKey: new Map(rows.map(x => [x.l.key, x])) };
    if (EXT && !restoring) chrome.storage.local.set({ invWant: invWant() });      // 判断一变，要报销的订单就跟着变
  }

  const effCat = x => x.r.cat;                         // lab / personal / unsure
  const counted = x => !x.ref;                         // 退款、交易关闭的不计金额

  // ── 筛选 ──
  function visibleRows() {
    const q = view.q.trim().toLowerCase();
    return derived.rows.filter(x => {
      if (x.past) return false;
      if (view.cat === 'refund') { if (!x.ref) return false; }
      else if (view.cat !== 'all' && (x.ref || effCat(x) !== view.cat)) return false;
      if (view.from && (x.o.time || '').slice(0, 10) < view.from) return false;
      if (view.to && (x.o.time || '').slice(0, 10) > view.to) return false;
      if (q) {
        const hay = (x.l.title + ' ' + x.l.sku + ' ' + x.o.shop + ' ' + x.o.no).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => {
      if (view.cat === 'lab' || view.cat === 'personal') {
        const ua = S.decisions[a.l.key] !== view.cat, ub = S.decisions[b.l.key] !== view.cat;
        if (ua !== ub) return ua ? -1 : 1;
      }
      const c = (a.o.time || '').localeCompare(b.o.time || '');
      return S.prefs.sort === 'asc' ? c : -c;
    });
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
    const sum = [...g.platform, ...g.seller, ...g.you].reduce((a, r) => a + (+r.o.pay || 0), 0);
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
  async function startVip() {
    if (needInvoiceInfo()) return;
    const all = vipList();
    if (!all.length) { toast('没有超过 ' + remindDays() + ' 天未开票且未督促过的订单'); return; }
    // 发出去之前列清单确认（对外发消息都要确认，用户 2026-10-05）
    const keep = await confirmList({
      title: '请淘宝客服督促开票',
      note: '共 ' + all.length + ' 单。确认后打开淘宝官方客服，转接人工客服后逐单发送督促消息（订单号、等待天数、抬头、税号）。'
        + '客服提出投诉商家时自动回复「OK」并提交投诉；客服发来开票申请入口时，自动核对抬头后提交申请。',
      rows: all.map(x => orderRow(x.o, x.lines || [], '已等待 ' + (x.days == null ? '—' : x.days) + ' 天 · ' + x.st.label)),
      ok: '确认并开始督促', okTip: '打开淘宝官方客服，按上述清单逐单督促',
    });
    if (!keep) return;
    const xs = all.filter((x, i) => keep[i]);
    if (!xs.length) { toast('未勾选任何订单，未督促'); return; }
    const now = Date.now();
    await chrome.storage.local.set({ vipJob: { at: now, title: S.invoice.title, taxId: S.invoice.taxId, orders: xs.map(x => ({ no: x.o.no, days: x.days, shop: x.o.shop })) } });
    // 客服给的「填写开票申请」入口如果打开的也是淘宝「开具发票」页，由 extension/apply-card.js 按这份任务核对后提交（待真实页面验证）
    await addCardJobs(xs.map(x => x.o), 'vip');
    chrome.runtime.sendMessage({ type: 'openWorkTab', url: VIP_URL });
    toast('已打开淘宝官方客服：转接人工客服后逐单督促开票（共 ' + xs.length + ' 单）');
  }

  // ── 按卖家发来的开票卡片申请（用户 2026-10-05）：批量开票页上没有入口的单，卖家（或淘宝客服）有时在旺旺里发一张「请填写发票申请」卡片，
  // 点卡片上的「去申请」→ 淘宝「开具发票」页 →「提交申请」→「确认提交」，这单就进入淘宝平台开票流程。
  // 主页逐单：排 cardJobs（核对用的抬头、税号，带过期时间）和 cardRun（这次要点哪张卡片）→ 旺旺页（extension/chat.js）找到卡片点「去申请」
  // → 申请页（extension/apply-card.js）核对订单号、抬头后提交，结果写回 cardResult。一单失败不影响下一单
  const cardList = () => invOrders().filter(x => invStatus(x).key === 'card');
  async function addCardJobs(os, source) {
    const { cardJobs } = await chrome.storage.local.get('cardJobs'), now = Date.now();
    const keep = Object.fromEntries(Object.entries(cardJobs || {}).filter(([, j]) => j.exp > now));     // 过期的清掉
    for (const o of os) keep[o.no] = { at: now, exp: now + 40 * 60000, state: 'queued', source, shop: o.shop, title: S.invoice.title, taxId: S.invoice.taxId };
    await chrome.storage.local.set({ cardJobs: keep });
  }
  async function patchCardJob(no, p) {
    const { cardJobs } = await chrome.storage.local.get('cardJobs');
    if (!cardJobs || !cardJobs[no]) return;
    await chrome.storage.local.set({ cardJobs: Object.assign({}, cardJobs, { [no]: Object.assign({}, cardJobs[no], p) }) });
  }
  let cardBusy = false;
  async function startCard() {
    if (cardBusy) { toast('正在按开票入口申请，请等待当前任务完成'); return; }
    if (needInvoiceInfo()) return;
    let xs = cardList();
    if (!xs.length) { toast('没有卖家发来开票申请入口的订单'); return; }
    // 打开会话要用卖家旺旺名：不知道的先去订单详情页读
    const noNick = xs.filter(x => !x.o.nick && !(chatOf(x.o) || {}).nick).map(x => x.o);
    if (noNick.length) { await inspectOrders(noNick); xs = cardList(); }
    const cardOfX = x => { const c = chatOf(x.o) || { cards: [] }; return c.cards[c.cards.length - 1]; };
    const keep = await confirmList({
      title: '按卖家的开票入口申请',
      note: '共 ' + xs.length + ' 单。确认后逐单打开与卖家的旺旺会话，点击卖家发来的开票卡片上的「去申请」；'
        + '在淘宝「开具发票」页核对订单号与发票抬头「' + S.invoice.title + '」一致后，点击「提交申请」并「确认提交」。核对不一致的不提交。',
      rows: xs.map(x => { const k = cardOfX(x); return orderRow(x.o, x.lines, '卡片：' + (k ? String(k.time).slice(0, 16) + ' ' + k.title + (k.price ? ' ' + yuan(+k.price) : '') : '—')
        + (k && k.shared ? '　⚠ 同店多单，请核对归属（申请页订单号不符时不会提交）' : '')); }),
      ok: '确认并提交申请', okTip: '按上述清单逐单打开开票申请页，核对后提交',
    });
    if (!keep) return;
    const sel = xs.filter((x, i) => keep[i]);
    if (!sel.length) { toast('未勾选任何订单，未申请'); return; }
    cardBusy = true;
    const out = [];
    try {
      await addCardJobs(sel.map(x => x.o), 'chat');
      for (let i = 0; i < sel.length; i++) {
        const x = sel[i], c = chatOf(x.o) || { cards: [] }, k = c.cards[c.cards.length - 1];
        toast('按开票入口申请 ' + (i + 1) + ' / ' + sel.length + '：' + x.o.shop);
        let r;
        try { r = k ? await runCard(x.o, k, c) : { ok: false, why: '未找到开票卡片' }; }
        catch (e) { r = { ok: false, why: e.message }; }
        if (!r.ok) await patchCardJob(x.o.no, { state: 'cancelled' });          // 晚到的申请页不再提交
        out.push((r.ok ? '已提交　' : '未完成　') + x.o.shop + '（' + (x.o.time || '').slice(0, 10) + '，' + yuan(+x.o.pay) + '，' + x.o.no + '）' + (r.ok ? '' : '：' + r.why));
        if (i < sel.length - 1) await sleepMs(3000 + Math.random() * 3000);       // 单与单之间隔几秒
      }
    } finally { cardBusy = false; }
    derive(); render();
    const nOk = out.filter(s => s.startsWith('已提交')).length;
    showResult('按开票入口申请：完成', '提交成功 ' + nOk + ' 单' + (out.length - nOk ? '，未完成 ' + (out.length - nOk) + ' 单（原因见下）' : '') + '。已提交的订单状态显示为「' + I.LABEL.applying + '」。', out);
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
      const { cardRun, cardResult, cardJobs } = await chrome.storage.local.get(['cardRun', 'cardResult', 'cardJobs']);
      const r = (cardResult || {})[o.no];
      if (r && r.at >= t0) return r.ok ? { ok: true } : { ok: false, why: r.why };
      if (cardRun && cardRun.id === id && cardRun.error) return { ok: false, why: cardRun.error };
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

  // ── 确认清单窗口（对外操作前用）：每行一个勾选框；返回 [是否保留] 或 null（取消）──
  function orderRow(o, lines, extra) {
    const t = (lines[0] && lines[0].title) || '';
    return '<b>' + esc(o.shop || '未知店铺') + '</b><span class="detail">' + esc((o.time || '').slice(0, 10)) + ' · ' + esc(t.length > 40 ? t.slice(0, 40) + '…' : t)
      + (lines.length > 1 ? ' 等 ' + lines.length + ' 件' : '') + ' · ' + esc(yuan(+o.pay)) + ' · 订单号 ' + esc(o.no) + '</span>'
      + (extra ? '<span class="ask-msg">' + esc(extra) + '</span>' : '');
  }
  function confirmList(opt) {
    $('list-title').textContent = opt.title;
    $('list-note').textContent = opt.note;
    $('list-rows').innerHTML = opt.rows.map((h, i) => '<label class="ask-row"><input type="checkbox" data-row="' + i + '" checked title="取消勾选则不处理此项"> ' + h + '</label>').join('');
    $('list-ok').textContent = opt.ok; $('list-ok').title = opt.okTip || opt.ok;
    $('list-ok').hidden = false; $('list-cancel').textContent = '取消'; $('list-hint').hidden = false;
    $('dlg-list').showModal();
    return new Promise(res => {
      const done = ok => { $('dlg-list').close(); res(ok ? opt.rows.map((h, i) => $('list-rows').querySelector('[data-row="' + i + '"]').checked) : null); };
      $('list-ok').onclick = () => done(true);
      $('list-cancel').onclick = () => done(false);
      $('dlg-list').oncancel = () => done(false);
    });
  }
  // 结果窗口：同一个窗口，只留「关闭」
  function showResult(title, note, lines) {
    $('list-title').textContent = title;
    $('list-note').textContent = note;
    $('list-rows').innerHTML = lines.map(s => '<div class="ask-row res-row">' + esc(s) + '</div>').join('');
    $('list-ok').hidden = true; $('list-hint').hidden = true; $('list-cancel').textContent = '关闭';
    $('list-cancel').onclick = () => $('dlg-list').close();
    $('dlg-list').oncancel = null;
    if (!$('dlg-list').open) $('dlg-list').showModal();
  }
  // ── 顶上的进度条：分拣、发票、金额三个分数，加上发票在等谁。替代原来一大段文字提醒（用户 2026-10-05）──
  // 数字同时写进扩展存储（invPending），后台把「还差几单」显示在工具栏的插件图标上
  let lastBadge = '';
  // 应报金额 = 本单实付 − 部分退款的退款金额
  const dueOf = o => { const ra = S.refundAmt || {}; return Math.round(((+o.pay || 0) - o.lines.reduce((a, l) => a + (ra[l.key] || 0), 0)) * 100) / 100; };
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
    const cell = (goto, k, v, s, tip) => '<div class="dc" data-goto="' + goto + '" role="button" tabindex="0" title="' + tip + '"><span class="k">' + k + '</span>'
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
      + '<div class="dc" data-goto="invoice" role="button" tabindex="0" title="未取得发票的订单按当前状态分类计数"><span class="k">未取得发票的订单</span>'
      + '<div class="dots">' + dot('bad', '需处理', tone.bad) + dot('wait', '等待中', tone.wait) + dot('info', '待下载', tone.info) + '</div>'
      + '<span class="s' + (r.late.length ? ' late' : '') + '">' + (r.late.length ? '超过 ' + remindDays() + ' 天未开票 ' + r.late.length + ' 单' : '无超过 ' + remindDays() + ' 天未开票的订单') + '</span></div>';
  }

  function render() {
    const has = S.orders.length > 0;
    $('empty').hidden = has;
    $('main').hidden = !has;
    // 「更多」一直在：没有数据时也要能从备份恢复；只是要有数据才有意义的几项先藏起来
    for (const el of document.querySelectorAll('#more .need-data')) el.hidden = !has;
    if (!has) return;
    renderDash();
    renderSummary();
    renderSeg();
    renderList();
  }

  // 发票的三类：还没开 / 开好了还没下载 / 已开好并下载
  const INV_GROUP = { apply: 'todo', ask: 'todo', asked: 'todo', applying: 'todo', urged: 'todo', card: 'todo', wrong: 'todo', check: 'todo',
                      ready: 'ready', replied: 'ready', paper: 'ready', done: 'done', have: 'done' };
  function invCounts() {
    const c = { todo: 0, ready: 0, done: 0 };
    for (const x of invOrders()) { const g = INV_GROUP[invStatus(x).key]; if (g) c[g]++; }
    return c;
  }
  function goCat(cat) {
    view.cat = cat; view.step = null;
    if (cat === 'unsure') { const u = visibleRows().find(x => effCat(x) === 'unsure'); view.focus = u ? u.l.key : null; }
    render();
    // 滚到工具条本来的位置（它是吸顶的，直接 scrollIntoView 会盖住下面一截）
    window.scrollTo({ top: $('summary').getBoundingClientRect().bottom + window.scrollY });
  }

  // ── 一条线的步骤：导入订单表 → 上次报销到哪 → 补图片 → 待定 → 检查个人 → 检查实验室 → 开发票 → 整理成报销文件 ──
  // 每一步只有一个主按钮；不常用的放在顶栏「更多」里
  const pb = (attr, label, tip, primary) => '<button class="btn' + (primary === false ? '' : ' primary') + '" ' + attr + ' title="' + tip + '">' + label + '</button>';
  function flowSteps() {
    const live = derived.rows.filter(x => !x.past), past = derived.rows.length - live.length;
    const n = { lab: 0, personal: 0, unsure: 0, ref: 0 }, unconf = { lab: 0, personal: 0 };
    let img = 0;
    for (const x of live) {
      if (x.l.img) img++;
      if (x.ref) { n.ref++; continue; }
      n[effCat(x)]++;
      if (effCat(x) !== 'unsure' && S.decisions[x.l.key] !== effCat(x)) unconf[effCat(x)]++;
    }
    const since = sinceInfo(), times = S.orders.map(o => (o.time || '').slice(0, 10)).filter(Boolean).sort();
    const ic = EXT ? invCounts() : null;
    // 步骤格里的第二行要短（八步排一行）：识别方式只放在悬停说明和下方的详细说明里；同一年的日期范围后一个日期省掉年份
    const sinceText = since.mode === 'auto' || since.mode === 'date' ? '截至 ' + since.date : since.mode === 'none' ? '从第一单开始' : '未设置';
    const sinceTip = since.mode === 'auto' ? '，自动识别' : since.mode === 'date' ? '，手动指定' : '';
    const t0 = times[0] || '', t1 = times[times.length - 1] || '';
    const range = t0 === t1 ? t0 : t0.slice(0, 4) === t1.slice(0, 4) ? t0 + ' 至 ' + t1.slice(5) : t0 + ' 至 ' + t1;
    const sinceNote = since.mode === 'auto' ? '自动识别：上次报销截至 ' + since.date + ' ' + (since.shop || '') + ' 的订单，此前 ' + past + ' 件不再判断。'
      : since.mode === 'date' ? since.date + ' 及以前的 ' + past + ' 件不再判断。' : since.mode === 'none' ? '订单表中的全部订单均需判断。' : '';
    const pack = EXT ? packState() : null;
    return [
      { id: 'import', title: '导入订单表', done: S.orders.length > 0,
        text: S.orders.length ? S.orders.length + ' 单 · ' + range : '未导入',
        tip: S.orders.length ? S.orders.length + ' 单，' + t0 + ' 至 ' + t1 : '',
        help: '在淘宝「已买到的宝贝」页点击「导出订单」，导入下载的 xlsx。有新订单时重新导入，已有判断保留。',
        acts: pb('data-flow="import"', '导入订单表', '选择从淘宝导出的订单表（xlsx 或 csv）') },
      { id: 'since', title: '上次报销截止点', done: ['auto', 'date', 'none'].includes(since.mode), text: sinceText, tip: sinceText + sinceTip,
        help: sinceNote + '截止订单及更早的订单不再判断。可导入已整理的发票文件夹自动识别，或手动指定日期。',
        acts: pb('data-flow="have-dir"', '导入已整理的发票文件夹', '选择以往整理好的发票文件夹：读取每张 PDF 的号码、日期、金额，识别已报销的订单', since.mode === 'unknown')
          + '<label class="flow-date">或手动指定：截至 <input type="date" data-flow="since-date" title="上次报销截止的日期，此日及以前的订单不再判断" value="' + (since.mode === 'date' ? since.date : '') + '"></label>'
          + (since.mode !== 'none' ? '<button class="linkbtn" data-flow="since-none" title="订单表中的全部订单均需判断">从第一单开始</button>' : '')
          + (since.mode === 'date' || since.mode === 'none' ? '<button class="linkbtn" data-flow="since-auto" title="按已整理的发票自动识别上次报销截止的订单">改为自动识别</button>' : '') },
      { id: 'images', title: '补充图片', done: live.length > 0 && img === live.length, text: '有图 ' + img + ' / ' + live.length + ' 件',
        help: (img < live.length ? '尚有 ' + (live.length - img) + ' 件缺少图片（列表中以红色 ERROR 标出）。' : '')
          + (EXT ? '打开淘宝订单页，点击页面右下角「开始补图片」，插件自动翻页，读取商品图片和退款情况。如出现滑块验证，请手动完成后再次点击。'
                 : '复制抓取脚本，在淘宝订单页的控制台运行。安装为 Chrome 扩展后可自动完成。'),
        acts: (EXT ? pb('data-flow="taobao"', '打开淘宝订单页', '在新标签页打开淘宝「已买到的宝贝」') : pb('data-flow="img-dlg"', '补充图片', '复制抓取脚本，在淘宝订单页运行'))
          + (EXT ? '<button class="linkbtn" data-flow="img-dlg" title="淘宝仅能导出最近几个月的订单表，更早的订单从订单页读取">提取订单表之前的订单</button>' : '') },
      { id: 'unsure', cat: 'unsure', title: '判断待定', done: n.unsure === 0, text: n.unsure ? '剩余 ' + n.unsure + ' 件' : '已全部判断',
        help: '自动判断无法确定的商品，逐件按 1（实验室）或 2（个人）判断。已退款商品自动排除。',
        acts: pb('data-goto="unsure"', '判断待定商品' + (n.unsure ? '（' + n.unsure + ' 件）' : ''), '列出待定商品，逐件判断') },
      { id: 'personal', cat: 'personal', title: '检查个人', done: n.unsure === 0 && unconf.personal === 0, text: n.personal + ' 件' + (unconf.personal ? ' · ' + unconf.personal + ' 件未确认' : ' · 已确认'),
        help: '逐件核对判为个人的商品，判错的按 1 改为实验室；核对无误后点击「全部确认为个人」。确认后不再自动变更。',
        acts: pb('data-goto="personal"', '检查个人商品', '列出判为个人的商品，未确认的排在前面') },
      { id: 'lab', cat: 'lab', title: '检查实验室', done: n.unsure === 0 && unconf.lab === 0, text: n.lab + ' 件' + (unconf.lab ? ' · ' + unconf.lab + ' 件未确认' : ' · 已确认'),
        help: '逐件核对判为实验室的商品，判错的按 2 改为个人；核对无误后点击「全部确认为实验室」。这些商品即本次报销范围。',
        acts: pb('data-goto="lab"', '检查实验室商品', '列出判为实验室的商品，未确认的排在前面') },
      { id: 'invoice', cat: 'invoice', title: '开具发票', done: !!ic && ic.todo === 0 && ic.ready === 0 && invOrders().length > 0,
        text: ic ? '已下载 ' + ic.done + ' / ' + (ic.todo + ic.ready + ic.done) + ' 单' : '需安装为 Chrome 扩展',
        help: EXT ? '先点击「检查开票情况」，同步开票状态并下载已开具的发票；再依次申请平台开票、按卖家的开票入口申请、向卖家索要发票、请淘宝客服督促。'
                  : '发票功能需安装为 Chrome 扩展后使用。',
        acts: pb('data-goto="invoice"', '查看发票状态', '列出需报销的实验室订单及每单的发票状态') },
      { id: 'pack', title: '整理报销文件', done: !!pack && pack.done, text: pack ? pack.text : '需安装为 Chrome 扩展',
        help: EXT ? '选择下载文件夹中的「订单分拣-发票」，按报销格式复制并重命名，附汇总表和压缩包，存入「订单分拣-报销」。原文件不变。'
                  : '整理报销文件需安装为 Chrome 扩展后使用。',
        acts: EXT ? pb('data-pick="inv-pack-dir"', '选择发票文件夹并整理', '选择已下载的发票文件夹（如「订单分拣-发票」），预览新文件名，确认后生成报销文件夹和压缩包') : '' },
    ];
  }
  // 第 8 步：上次整理时已下载的发票都整理进去了，就算做完；之后又下了新发票，就又要整理
  function packState() {
    const lp = S.lastPack;
    const got = invOrders().filter(x => invStatus(x).key === 'done').map(x => x.o.no);
    const left = lp ? got.filter(no => !(lp.nos || []).includes(no)).length : got.length;
    return { done: !!lp && left === 0, text: lp ? (left ? '新增 ' + left + ' 单发票' : '已整理 ' + lp.n + ' 张') : got.length ? got.length + ' 单可整理' : '暂无发票' };
  }
  function renderSummary() {
    const steps = flowSteps();
    const cur = steps.findIndex(x => !x.done);
    const sel = view.step != null ? view.step : steps.findIndex(x => x.cat && x.cat === view.cat);
    const show = sel >= 0 ? sel : (cur >= 0 ? cur : steps.length - 1);
    const d = steps[show];
    $('summary').innerHTML = '<ol class="flow">' + steps.map((x, i) =>
        '<li class="' + (x.done ? 'is-done' : i === cur ? 'is-cur' : '') + (i === show ? ' is-sel' : '') + '" data-step="' + i + '" role="button" tabindex="0" title="第 ' + (i + 1) + ' 步：' + x.title + '（' + esc(x.tip || x.text) + '）">'
        + '<span class="flow-h"><span class="flow-n">' + (x.done ? '✓' : i + 1) + '</span><span class="flow-t">' + x.title + '</span></span>'
        + '<span class="flow-s">' + esc(x.text) + '</span></li>').join('') + '</ol>'
      + '<div class="flow-detail"><div class="fd-text"><div class="fd-title">第 ' + (show + 1) + ' 步　' + d.title
      + (show !== cur && cur >= 0 ? '<span class="hint">当前步骤：第 ' + (cur + 1) + ' 步 ' + steps[cur].title + '</span>' : cur < 0 ? '<span class="hint">全部完成</span>' : '')
      + '</div><p>' + esc(d.help) + '</p></div><div class="flow-acts">' + d.acts + '</div></div>';
  }

  function renderSeg() {
    const c = { all: 0, unsure: 0, lab: 0, personal: 0, refund: 0 };
    for (const x of derived.rows) { if (x.past) continue; c.all++; if (x.ref) c.refund++; else c[effCat(x)]++; }
    const items = [['all', '全部', '全部商品（不含上次已报销的）'], ['unsure', '待定', '自动判断无法确定的商品'], ['lab', '实验室', '判为实验室的商品'],
                   ['personal', '个人', '判为个人的商品'], ['refund', '退款/关闭', '已退款或交易关闭的商品，不计入报销'], ['invoice', '发票', '需报销的实验室订单及发票状态（数字为待处理订单数）']];
    c.invoice = invOrders().filter(x => !['done', 'none', 'applying', 'urged', 'have', 'paper'].includes(invStatus(x).key)).length;   // 还要处理的（纸质发票在快递里，插件帮不上）
    $('seg-cat').innerHTML = items.map(([k, lab, tip]) =>
      '<button data-cat="' + k + '" aria-pressed="' + (view.cat === k) + '" title="' + tip + '">' + lab + ' <span class="c">' + c[k] + '</span></button>').join('');
  }

  function statusClass(s) {
    if (/交易成功|交易完成/.test(s)) return 'st-ok';
    if (/关闭|退款/.test(s)) return 'st-closed';
    return 'st-other';
  }

  function renderList() {
    $('inv-bar').hidden = $('inv-legend').hidden = view.cat !== 'invoice' || !EXT;
    $('bar').querySelector('.chk').hidden = view.cat === 'invoice';
    $('keys').hidden = view.cat === 'invoice' || view.cat === 'refund';
    if (view.cat === 'invoice') { renderInvoice(); return; }
    const rows = visibleRows();
    const head = listHead(rows);
    if (!rows.length) { $('list').innerHTML = head + (head ? '' : '<div class="none">没有符合条件的商品</div>'); return; }
    // 按订单分组，保持排序
    const groups = [], idx = new Map();
    for (const x of rows) {
      let g = idx.get(x.o.no);
      if (!g) { g = { o: x.o, rows: [] }; idx.set(x.o.no, g); groups.push(g); }
      g.rows.push(x);
    }
    if (view.focus && !rows.some(x => x.l.key === view.focus)) view.focus = null;
    const html = [];
    for (const g of groups) {
      const o = g.o, st = o.statusLive || o.status || '';
      html.push('<article class="order">'
        + '<div class="ohead"><span class="d num">' + esc((o.time || '').slice(0, 10) || '无日期') + '</span>'
        + '<span class="no num">订单号 ' + esc(o.no) + '</span>'
        + '<span class="shop">' + esc(o.shop || '未知店铺') + wwBtn(o) + '</span>'
        + (o.source === 'scrape' ? '<span class="src" title="订单表中没有此单，按淘宝订单页内容建立">抓取建单</span>' : '')
        + '<span class="st ' + statusClass(st) + '">' + esc(st || '状态未知') + '</span></div>');
      for (const x of g.rows) html.push(lineHtml(x));
      if (o.lines.length > 1 || o.ship) {
        html.push('<div class="ofoot"><span>本单实付 <b class="num">' + yuan(o.pay) + '</b></span>'
          + (o.ship ? '<span>含运费 <b class="num">' + yuan(o.ship) + '</b></span>' : '') + '</div>');
      }
      html.push('</article>');
    }
    $('list').innerHTML = head + html.join('');
  }

  // 每一页顶上告诉用户这一页要做什么、做完去哪
  const CAT_NAME = { lab: '实验室', personal: '个人' };
  function nextBtn(cat, label, tip) { return '<button class="btn primary" data-goto="' + cat + '" title="' + tip + '">' + label + ' →</button>'; }
  function listHead(rows) {
    const filtered = view.q || view.from || view.to;
    if (view.cat === 'unsure') {
      if (!rows.length && !filtered) return '<div class="page-bar done"><span><b>待定商品已全部判断</b>　下一步：检查个人</span>' + nextBtn('personal', '检查个人商品', '列出判为个人的商品') + '</div>';
      return rows.length ? '<div class="page-bar"><span>待定 <b class="num">' + rows.length + '</b> 件。按 <kbd>1</kbd> 判为实验室、按 <kbd>2</kbd> 判为个人，判断后自动跳到下一件。</span></div>' : '';
    }
    if (view.cat === 'lab' || view.cat === 'personal') {
      const cat = view.cat, name = CAT_NAME[cat], todo = rows.filter(x => S.decisions[x.l.key] !== cat).length;
      const next = cat === 'personal' ? nextBtn('lab', '检查实验室商品', '列出判为实验室的商品') : nextBtn('invoice', '查看发票状态', '列出需报销的实验室订单及发票状态');
      if (!rows.length) return '';
      if (!todo) return '<div class="page-bar done"><span><b>' + rows.length + ' 件均已确认为' + name + '</b>' + (filtered ? '（当前有筛选条件）' : '') + '</span>' + (filtered ? '' : next) + '</div>';
      return '<div class="page-bar"><span>共 ' + rows.length + ' 件，其中 <b class="num">' + todo + '</b> 件为自动判断、尚未确认，排在前面。判错的按 '
        + (cat === 'lab' ? '<kbd>2</kbd> 改为个人' : '<kbd>1</kbd> 改为实验室') + '。</span>'
        + '<button class="btn primary" data-bulk="' + cat + '" title="将本页自动判断的商品全部确认为' + name + '，此后不再自动变更">全部确认为' + name + '（' + todo + ' 件）</button></div>';
    }
    if (view.cat === 'refund') return '<div class="page-bar"><span>根据订单页上每件商品的「退款成功」和订单的「交易关闭」自动识别，不计入报销。部分退款的订单只列出已退款的商品。</span></div>';
    return '';
  }

  // 点商品图、商品名：在淘宝打开这单的订单详情核对（用户 2026-10-05）
  const detailUrl = no => 'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=' + no;
  const detailA = (no, inner, cls) => '<a class="' + (cls || 'lk') + '" href="' + esc(detailUrl(no)) + '" target="_blank" rel="noopener noreferrer" data-detail="'
    + esc(no) + '" title="在淘宝打开本单订单详情">' + inner + '</a>';
  function openDetail(no) {
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
    if (!EXT) { window.open(o.nick ? chatUrl(o.nick) : detailUrl(o.no), '_blank', 'noopener'); return; }
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
    const unconf = (view.cat === 'lab' || view.cat === 'personal') && !manual && !x.ref;
    const pill = unconf ? '<span class="pill p-uns">未确认</span>'
               : cat === 'lab' ? '<span class="pill p-lab">实验室</span>'
               : cat === 'personal' ? '<span class="pill p-per">个人</span>' : '<span class="pill p-uns">待定</span>';
    const refPill = x.ref === 'refunded' ? '<span class="pill p-ref">已退款</span>'
                  : x.ref === 'refunding' ? '<span class="pill p-ref">退款中</span>'
                  : x.ref === 'closed' ? '<span class="pill p-ref">交易关闭</span>'
                  : x.refAmt != null ? '<span class="pill p-ref">部分退款：已退 ' + yuan(x.refAmt) + '，按 ' + yuan(x.share) + ' 报销</span>'
                  : x.keep != null ? '<span class="pill p-ref">退 ' + (x.l.qty - x.keep) + ' 个，留 ' + x.keep + ' 个</span>' : '';
    return '<div class="line' + (x.ref ? ' is-ref' : '') + (view.focus === l.key ? ' focus' : '') + '" data-key="' + esc(l.key) + '">'
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
      + '<div class="meta">' + pill
      + (manual ? '<button class="linkbtn" data-set="auto" title="撤回为自动判断（快捷键 0）">撤回</button>' : '')
      + ((x.ref === 'refunded' && x.l.qty > 1) || x.keep != null ? '<button class="linkbtn" data-keep="1" title="同一商品购买 ' + x.l.qty + ' 个，订单页无法看出退款数量">' + (x.keep != null ? '修改保留数量' : '仅部分退款') + '</button>' : '')
      + '</div></div></div>';
  }

  // ── 操作 ──
  function setDecision(key, cat, opts) {
    const prev = S.decisions[key];
    if (cat === 'auto') delete S.decisions[key]; else S.decisions[key] = cat;
    undoStack.push({ type: 'dec', key, prev });
    persist(); derive();
    const moveOn = S.prefs.autoNext && cat !== 'auto' && !(opts && opts.stay);
    if (moveOn) view.focus = nextUnsure(key) || view.focus;
    render();
    const x = derived.byKey.get(key);
    toast((cat === 'auto' ? '已撤回为自动判断' : '已判为' + (cat === 'lab' ? '实验室' : '个人')) + (x ? '：' + x.l.title.slice(0, 18) : ''), true);
    if (moveOn) scrollToFocus();
  }
  function undo() {
    const u = undoStack.pop();
    if (!u) return;
    if (u.type === 'bulk') for (const [k, v] of u.prev) { if (v === undefined) delete S.decisions[k]; else S.decisions[k] = v; }
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
  // 个人 / 实验室页从头看到尾都没问题：一次把这一页电脑判的也全部写成「你的判断」，以后改词表也不会再变
  function bulkConfirm(cat) {
    const rows = visibleRows().filter(x => effCat(x) === cat && !x.ref && S.decisions[x.l.key] !== cat);
    if (!rows.length) return;
    const prev = rows.map(x => [x.l.key, S.decisions[x.l.key]]);
    rows.forEach(x => { S.decisions[x.l.key] = cat; });
    undoStack.push({ type: 'bulk', prev });
    persist(); derive(); render();
    toast('已将本页 ' + rows.length + ' 件确认为' + (cat === 'lab' ? '实验室' : '个人'), true);
  }
  function nextUnsure(fromKey) {
    const rows = visibleRows();
    const i = rows.findIndex(x => x.l.key === fromKey);
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

  let toastTimer = null;
  function toast(msg, withUndo) {
    const t = $('toast');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (withUndo ? '<button id="toast-undo" title="撤销上一步操作（Ctrl+Z）">撤销</button>' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
    const b = $('toast-undo');
    if (b) b.onclick = () => { t.hidden = true; undo(); };
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
    // 订单表是基准：试用过的示例订单、没有订单表时按抓取数据临时建的单（这次导入的表里都没有的），都不留；
    // 只留用户要的「订单表之前」那段按订单页建的单。等所有表都读完再筛，一次拖进两份表时，只在第二份里的单不会被第一份误删
    if (tableNos.size) {
      const r = olderRange(), inRange = o => { const d = (o.time || '').slice(0, 10); return !!(r && d && d >= r.from && d < r.before); };
      S.orders = S.orders.filter(o => {
        if (o.source === 'scrape' && !o.older && inRange(o)) o.older = true;     // 网页版：先按抓取 JSON 建的单，落在要的日期范围里的也留下
        return !/^示例-/.test(o.no) && !(o.source === 'scrape' && !tableNos.has(o.no) && !o.older);
      });
    }
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
      for (const box of [S.decisions, S.refunds]) if (a in box) { box[b] = box[a]; delete box[a]; }
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
  function invOrders() {
    const by = new Map(), gone = new Set(X.goneNos || []);
    for (const x of derived.rows) {
      if (effCat(x) !== 'lab' || x.ref || x.past || !doneDeal(x.o) || gone.has(x.o.no)) continue;
      const g = by.get(x.o.no) || { o: x.o, lines: [] };
      g.lines.push(x.l); by.set(x.o.no, g);
    }
    return [...by.values()];
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
  let haveCache = { key: '', have: new Map(), contested: new Map() };
  function haveMatch() {
    const key = S.orders.length + '|' + (S.haveIdx || []).length + '|' + ((X.invSync && X.invSync.at) || 0);
    if (haveCache.key !== key) {
      const byNo = new Map(S.orders.map(o => [o.no, o]));
      haveCache = Object.assign({ key }, I.matchHave(S.haveIdx, S.orders.map(o => ({ no: o.no, time: o.time, amount: o.pay })), no => platOf(byNo.get(no))));
    }
    return haveCache;
  }
  const haveOf = o => haveMatch().have.get(o.no)
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
      return { key: 'check', label: '疑似已整理，请核对', detail: '已整理的发票中有同金额的：' + cs.map(x => x.file).join('、') + '（多单对应同一张或一单对应多张，插件不做推断）' };
    if (st.key === 'apply' && (S.noPlatform || {})[o.no]) return askedOr(o, { key: 'ask', label: I.LABEL.ask, detail: '批量开票页中无此订单，无法在平台开票' });
    return withCardFail(o, withVip(o, withCheck(o, askedOr(o, rejectedOnly(o, st)))));
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
      g.orders.push({ no: o.no, date: (o.time || '').slice(0, 10), amount: o.pay,
        lines: x.lines.map(l => ({ title: l.title, img: l.img || '', qty: l.qty || 1 })) });
      by.set(o.nick, g);
    }
    const tpl = S.invoice.template || I.DEFAULT_TEMPLATE;
    const items = [...by.values()].map(g => Object.assign(g, { nos: g.orders.map(o => o.no),
      msg: I.renderMsg(tpl, { orders: g.orders, title: S.invoice.title, taxId: S.invoice.taxId, email: S.invoice.email }) }));
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
  async function startAsk() {
    if (needInvoiceInfo()) return;
    // 名单上的每一单都先去订单详情页看一眼：卖家旺旺名、是不是已经退款了
    const pre = askList();
    await inspectOrders(pre.items.flatMap(g => g.nos).concat(pre.noNickOrders.map(o => o.no)).map(no => S.orders.find(o => o.no === no)).filter(Boolean));
    const { items, noNick } = askList();
    if (!items.length) { toast(noNick.length ? noNick.length + ' 家店铺的卖家旺旺名未知，请先在淘宝订单页补充一次图片' : '没有需向卖家索要发票的订单'); return; }
    // 先列清单给用户确认（发给哪几家、每家发什么），确认后插件逐家自动发；也可以选「我自己逐家点发送」（用户 2026-10-05）
    const pick = await confirmAsk(items, noNick);
    if (!pick) return;
    const sel = items.filter((g, i) => pick.keep[i]);
    if (!sel.length) { toast('未勾选任何店铺，未发送'); return; }
    await chrome.storage.local.set({ chatQueue: { at: Date.now(), kind: 'compose', auto: pick.auto, items: sel, done: 0, sent: [], skipped: [], taxId: S.invoice.taxId } });
    chrome.runtime.sendMessage({ type: 'openJobTab', url: chatUrl(sel[0].nick) });
    toast((pick.auto ? '开始自动发送（共 ' + sel.length + ' 家）' : '已打开第 1 家（共 ' + sel.length + ' 家）：消息已填入，请核对后手动点击「发送」') + '：' + sel[0].shop);
  }
  // 确认窗口：每家一行（勾选框、店铺、订单、要发的话），返回 { auto, keep: [是否发] } 或 null（取消）
  function confirmAsk(items, noNick) {
    $('ask-note').textContent = '共 ' + items.length + ' 家。确认后插件逐家打开旺旺，核对会话属于该店铺后发送以下消息，每家间隔数秒。'
      + (noNick.length ? ' 另有 ' + noNick.length + ' 家卖家旺旺名未知，本次不发送。' : '');
    $('ask-list').innerHTML = items.map((g, i) => '<label class="ask-row"><input type="checkbox" data-ask="' + i + '" checked title="取消勾选则不发送给该店铺"> <b>' + esc(g.shop) + '</b>'
      + '<span class="detail">' + g.orders.map(o => esc(o.date) + ' ' + esc(yuan(+o.amount)) + ' ' + esc(o.no)).join('；') + '</span>'
      + '<span class="ask-msg">' + esc(g.msg) + '</span></label>').join('');
    $('dlg-ask').showModal();
    return new Promise(res => {
      const done = auto => { $('dlg-ask').close(); res(auto == null ? null : { auto, keep: items.map((g, i) => $('ask-list').querySelector('[data-ask="' + i + '"]').checked) }); };
      $('ask-auto').onclick = () => done(true);
      $('ask-manual').onclick = () => done(false);
      $('ask-cancel').onclick = () => done(null);
    });
  }
  // 发票状态的颜色（图例在发票栏顶上，见 index.html .inv-legend）：
  //   ok 绿 已取得 / info 紫 已开具待取得 / plat 蓝 已进入淘宝开票流程 / wait 黄 等待卖家回复 / urge 青 已由淘宝客服督促 / bad 红 需处理 / off 灰 无需开票
  //   off 只给退款的单用，invOrders 已排除退款商品，发票栏里实际不出现，所以图例里没有它
  const TONE = { have: 'ok', done: 'ok', ready: 'info', paper: 'info', replied: 'info', applying: 'plat', asked: 'wait', urged: 'urge',
                 card: 'bad', apply: 'bad', ask: 'bad', wrong: 'bad', check: 'bad', none: 'off' };
  const WAIT_TONES = ['plat', 'wait', 'urge'];
  const BAD_CHECK = ['short', 'amount', 'many', 'title'];     // 下载的票读出来有问题，要你核对
  function invTone(o, st) {
    if (st.key === 'done') {
      const got = (X.dlDone[o.no] || []).concat(S.invFiles[o.no] || []);
      return got.some(g => BAD_CHECK.includes(((S.fileChecks || {})[g.file] || {}).kind)) ? 'bad' : 'ok';
    }
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
    applying: ['inv', INV_TIP + '（开票进度、商家剩余处理时间）'], ready: ['inv', INV_TIP], paper: ['inv', INV_TIP], wrong: ['inv', INV_TIP],
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
  // 状态下面的说明：文件名逐个单行（放不下用省略号，悬停看全名）；有悬停详情的（督促过的）只显示一行要点
  function stDetail(s) {
    const one = (t, tip) => '<div class="detail one" title="' + esc(tip || t) + '">' + esc(t) + '</div>';
    if (s.files && s.files.length) return s.files.map(f => one(f)).join('') + (s.checks ? '<div class="detail">' + esc(s.checks) + '</div>' : '');
    if (s.tip) return one(s.detail, s.tip);
    return s.detail ? '<div class="detail">' + esc(s.detail) + '</div>' : '';
  }
  const invOpen = { todo: true, ready: true, done: false };      // 已下载的默认收起
  function renderInvoice() {
    if (!EXT) {
      $('list').innerHTML = '<div class="none">发票功能需安装为 Chrome 扩展后使用：扩展读取淘宝「全部发票」和旺旺中的开票情况并下载发票，详见 README。</div>';
      return;
    }
    const q = view.q.trim().toLowerCase();
    const list = invOrders().filter(x => {
      if (view.from && (x.o.time || '').slice(0, 10) < view.from) return false;
      if (view.to && (x.o.time || '').slice(0, 10) > view.to) return false;
      return !q || (x.o.no + ' ' + x.o.shop + ' ' + x.lines.map(l => l.title).join(' ')).toLowerCase().includes(q);
    }).sort((a, b) => (b.o.time || '').localeCompare(a.o.time || ''));
    const st = new Map(list.map(x => [x.o.no, invStatus(x)]));
    // 五个按钮是发票这一步里的小流程：检查 → 平台申请 → 按卖家的开票入口申请 → 向卖家索要 → 请淘宝客服督促；当前该点的那个是主按钮
    const nApply = applyList().length, nCard = cardList().length, al = askList(), nAsk = al.items.length + al.noNick.length, nVip = vipList().length;   // 不知道旺旺名的也算：点了会先去订单详情页找
    const set = (id, label, n, unit) => { const b = $(id); b.textContent = label + '（' + n + ' ' + unit + '）'; b.disabled = !n; };
    set('inv-apply', '申请平台开票', nApply, '单');
    set('inv-card', '按卖家的开票入口申请', nCard, '单');
    set('inv-ask', '向卖家索要发票', nAsk, '家');
    set('inv-vip', '请淘宝客服督促', nVip, '单');
    const main = !X.invSync ? 'inv-auto' : nApply ? 'inv-apply' : nCard ? 'inv-card' : nAsk ? 'inv-ask' : nVip ? 'inv-vip' : 'inv-auto';
    for (const id of ['inv-auto', 'inv-apply', 'inv-card', 'inv-ask', 'inv-vip']) $(id).classList.toggle('primary', id === main);
    $('inv-note').innerHTML = (S.invoice.title && S.invoice.taxId ? '' : '<span class="warn">请先在「设置」中填写发票抬头和税号。</span>')
      + (X.invSync ? '上次同步 ' + esc(new Date(X.invSync.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : '尚未同步开票状态');
    if (!list.length) { $('list').innerHTML = '<div class="none">没有需报销的实验室订单</div>'; return; }
    // 几张表列宽一样，上下对得齐；订单号 19 位一行放下
    const HEAD = '<div class="tbl-wrap"><table class="inv-table"><colgroup><col style="width:72px"><col style="width:104px"><col style="width:200px"><col>'
      + '<col style="width:92px"><col style="width:250px"><col style="width:180px"></colgroup><thead><tr><th></th><th>下单日期</th><th>店铺 / 订单号</th><th>实验室商品</th><th style="text-align:right">实付</th><th>发票</th><th>操作</th></tr></thead><tbody>';
    const rowHtml = x => {
        const o = x.o, s = st.get(o.no), c = chatOf(o);
        const acts = [];
        if (s.key === 'ready') acts.push('<button class="btn sm" data-inv="dl-plat" data-no="' + esc(o.no) + '" title="从淘宝「我的发票」下载此发票，存入「订单分拣-发票」">下载发票</button>');
        if (s.key === 'replied' && c && c.files.length) acts.push('<button class="btn sm" data-inv="dl-chat" data-no="' + esc(o.no) + '" title="从旺旺下载卖家发送的文件，按本单命名存入「订单分拣-发票」">下载卖家文件（' + c.files.length + ' 个）</button>');
        acts.push('<label class="btn sm" title="选择 PDF 文件（如卖家发送到邮箱的发票），按本单命名复制到下载文件夹的「订单分拣-发票」">手动添加发票<input type="file" accept=".pdf,.ofd,.xml" data-inv="attach" data-no="' + esc(o.no) + '" hidden></label>');
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
          + '<td class="st-cell">' + stPill(o, s) + stDetail(s) + imgs + '</td>'
          + '<td><div class="acts">' + acts.join('') + '</div></td></tr>';
    };
    const SECT = [['todo', '未开票'], ['ready', '已开票，待下载'], ['done', '已下载']];
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
    return Object.assign(I.parseInvoiceText(t, S.invoice.title), { file: file.webkitRelativePath || file.name });
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
    persist(); derive(); render();
    toast('已读取 ' + total + ' 个 PDF：识别发票 ' + got.length + ' 张（' + notInv.length + ' 个非发票文件，如扫描件或说明文档），已整理的发票共 ' + S.haveIdx.length + ' 张');
  }
  // 核对下载的发票：① 按 PDF 上的金额、开票日期核对是不是文件名那一单的（同店买过几次时常归错），能确定的自动改过来；
  // ② 和已整理的重复的、下载的里面自己重复的（按发票号码）。插件删不了、改不了用户的文件名，列清单给用户处理
  async function checkDownloadDir(files) {
    const { got, total } = await readPdfFolder(files, '下载的发票');
    const by = new Map((S.haveIdx || []).map(x => [x.invNo, x]));
    const dup = got.filter(r => by.has(r.invNo));
    const seen = new Map(), twice = [];
    got.forEach(r => { if (seen.has(r.invNo)) twice.push(r.file + '（与 ' + seen.get(r.invNo) + ' 为同一张）'); else seen.set(r.invNo, r.file); });
    const res = I.checkFiles(got, S.orders.map(o => ({ no: o.no, shop: o.shop, time: o.time, amount: o.pay })));
    const moved = await applyFileCheck(res);
    const ord = no => { const o = S.orders.find(x => x.no === no); return o ? (o.time || '').slice(0, 10) + ' ' + o.shop + ' ' + yuan(+o.pay) + '（' + no + '）' : no; };
    const what = r => yuan(r.amount) + '，开票日期 ' + (r.date || '未读取');
    const KIND = {
      move: r => '不属于文件名中的订单。票面 ' + what(r) + '，属于 ' + ord(r.to) + '（已更正）',
      merged: r => '票面 ' + what(r) + '，为同店多单合开：' + r.nos.map(ord).join(' + '),
      many: r => '票面 ' + what(r) + '，同店多单均可匹配：' + r.nos.map(ord).join('、') + '。需核对',
      old: r => '开票日期 ' + r.date + ' 早于下单日期：属于以往其他订单，已从本单移除',
      more: r => '票面 ' + what(r) + '，略高于本单实付：通常按用券前价格开具，计入本单（报销金额以报销规定为准）',
      amount: r => '票面 ' + what(r) + '，与本单 ' + ord(r.no) + ' 不符，同店也无匹配订单。需核对',
      title: () => '抬头不是 ' + (S.invoice.title || '设置中的单位') + '，需联系卖家重开',
    };
    const bad = res.filter(r => r.kind !== 'ok' && r.kind !== 'none');        // 文件名里没订单号的（自己放进来的）不核对，只计数
    const none = res.length - bad.length - res.filter(r => r.kind === 'ok').length;
    $('dup-note').textContent = '已读取 ' + total + ' 个 PDF，识别发票 ' + got.length + ' 张：金额和开票日期相符 ' + (res.length - bad.length) + ' 张，'
      + '需核对 ' + bad.length + ' 张（已自动更正 ' + moved + ' 张）' + (none ? '，文件名无订单号、未核对 ' + none + ' 张' : '') + '；与已整理发票重复 ' + dup.length + ' 张，下载文件之间重复 ' + twice.length + ' 张。';
    const sec = (t, xs) => xs.length ? ['【' + t + '】'].concat(xs, ['']) : [];
    $('dup-list').value = sec('金额、开票日期核对', bad.map(r => r.file + '\n    ' + KIND[r.kind](r)))
      .concat(sec('与已整理发票重复（可删除）', dup.map(r => r.file + '\n    与已整理的 ' + by.get(r.invNo).file + ' 为同一张（号码 ' + r.invNo + '）')))
      .concat(sec('下载文件之间重复（可删除）', twice)).join('\n') || '全部相符，无重复';
    $('dlg-dup').showModal();
  }
  // 能确定的改过来：归错单的挪到对的那单名下；比下单还早的票从这单拿掉（这单又会出现在「还没开发票」里）
  async function applyFileCheck(res) {
    const fix = res.filter(r => r.kind === 'move' || r.kind === 'old' || r.kind === 'dup');
    if (!fix.length) return 0;
    const baseName = p => String(p || '').split(/[\\/]/).pop();
    const dl = EXT ? Object.assign({}, (await chrome.storage.local.get('dlDone')).dlDone) : {};
    let n = 0;
    for (const r of fix) {
      const name = baseName(r.file);
      for (const store of [dl, S.invFiles]) {
        const list = store[r.no] || [];
        const i = list.findIndex(g => baseName(g.path) === name || g.file === name);
        if (i < 0) continue;
        const [g] = list.splice(i, 1);
        if (!list.length) delete store[r.no];
        // 不是这单的（比下单还早、和报销过的重复）：记下卖家发来时的原文件名，以后不再当成这单的票去下载
        if (r.kind !== 'move' && g.src) (S.rejectedSrc = S.rejectedSrc || {})[g.src] = { kind: r.kind, no: r.no, at: Date.now() };
        if (r.kind === 'move') (store[r.to] = store[r.to] || []).push(Object.assign({}, g, { movedFrom: r.no }));
        n++;
      }
    }
    if (EXT) { await chrome.storage.local.set({ dlDone: dl }); X.dlDone = dl; }
    persist(); derive(); render();
    return n;
  }

  // ── 整理成报销文件（用户 2026-10-05）：这一批实验室订单的发票，复制一份按报销格式改名
  //   「序号_开票日期_金额-商品摘要-数量件.pdf」（和用户以前几批的命名一样，如 170_260713_22.54-K16P4芯插头加C4连接座-1套.pdf），
  //   放进下载文件夹的「订单分拣-报销/批次名_今天_合计金额/」，附汇总表（含还没有发票的实验室订单），再打一个同样内容的压缩包。
  //   插件读不了电脑上的文件，所以要用户选一下下载好的发票文件夹；原文件不动。序号默认接着已整理发票里最大的那个往下编
  const baseOf = p => String(p || '').split(/[\\/]/).pop();
  function nextSeq() {
    let max = 0;
    for (const x of S.haveIdx || []) { const m = /(?:^|\/)(\d{1,4})(?:\+\d{1,4})*_\d{6}_/.exec(x.file || ''); if (m) max = Math.max(max, +m[1]); }
    return max + 1;
  }
  const yymmdd = d => String(d || '').replace(/-/g, '').slice(2, 8);
  const shortTitle = t => String(t || '').replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 14) || '商品';
  let packFiles = null;
  // 每张发票一行：同一张票（同一个文件）对着几单的，序号写成「261+262」
  function packPlan(seq0) {
    const byName = new Map(packFiles.map(f => [f.name, f]));
    const groups = new Map(), miss = [];
    for (const x of invOrders()) {
      const st = invStatus(x);
      if (st.key === 'have') continue;                         // 已经整理过（报销过）的不再放
      const got = (X.dlDone[x.o.no] || []).concat(S.invFiles[x.o.no] || []);
      const g = got.find(g => byName.has(baseOf(g.path)) || byName.has(g.file));
      if (!g) { miss.push({ x, st }); continue; }
      const f = byName.get(baseOf(g.path)) || byName.get(g.file);
      const k = f.name;
      if (!groups.has(k)) groups.set(k, { f, xs: [], chk: packRead.get(f.name) || (S.fileChecks || {})[g.file] || null });
      groups.get(k).xs.push(x);
    }
    const rows = [...groups.values()].sort((a, b) => (a.xs[0].o.time || '').localeCompare(b.xs[0].o.time || ''));
    let seq = seq0;
    for (const r of rows) {
      r.xs.sort((a, b) => (a.o.time || '').localeCompare(b.o.time || ''));
      const nos = r.xs.map(() => seq++);
      const good = r.chk && r.chk.amount != null && !['error', 'unread', 'old', 'dup', 'title'].includes(r.chk.kind);
      r.amount = good ? +r.chk.amount : r.xs.reduce((a, x) => a + (+x.o.pay || 0), 0);
      r.date = (good && r.chk.date) || (r.xs[0].o.time || '').slice(0, 10);
      const qty = r.xs.reduce((a, x) => a + x.lines.reduce((b, l) => b + (l.qty || 1), 0), 0);
      const ext = ((/\.(pdf|ofd|xml)$/i.exec(r.f.name) || [, 'pdf'])[1]).toLowerCase();
      r.seq = nos.join('+');
      const same = r.chk && r.chk.invNo && (S.haveIdx || []).find(h => h.invNo === r.chk.invNo);
      r.warn = same ? '与已整理的 ' + same.file + ' 为同一张发票' : (r.chk && r.chk.titleOk === false ? '抬头不是 ' + S.invoice.title : '');
      r.name = r.seq + '_' + yymmdd(r.date) + '_' + r.amount.toFixed(2) + '-' + shortTitle(r.xs[0].lines[0].title) + '-' + qty + '件.' + ext;
    }
    return { rows, miss, total: rows.reduce((a, r) => a + r.amount, 0) };
  }
  function renderPack() {
    const seq0 = Math.max(1, +$('pack-seq').value || nextSeq());
    const p = packPlan(seq0);
    $('pack-note').textContent = '找到发票 ' + p.rows.length + ' 张（' + p.rows.reduce((a, r) => a + r.xs.length, 0) + ' 单），合计 ' + yuan(p.total)
      + (p.miss.length ? '；另有 ' + p.miss.length + ' 单实验室订单尚无发票文件，将列在汇总表末尾' : '') + '。确认后存入下载文件夹的「订单分拣-报销」。';
    $('pack-list').value = p.rows.map(r => (r.amount > 200 ? '［低值品］' : '') + r.name + '    ← ' + r.f.name + (r.warn ? '    ⚠ ' + r.warn : '')).join('\n') + (p.miss.length ? '\n\n尚无发票：\n' + p.miss.map(m => '  ' + (m.x.o.time || '').slice(0, 10) + ' ' + m.x.o.shop + ' ' + yuan(m.x.o.pay) + ' ' + m.x.o.no + '（' + m.st.label + '）').join('\n') : '');
    $('pack-go').disabled = !p.rows.length;
    return p;
  }
  // 选好文件夹后，把要用到的每张 PDF 都读一遍：文件名里的金额、开票日期按票面写（有的票是加「读 PDF 核对」之前下的，没读过；
  // 2026-10-05 实测一张票面比实付多 3 元的，按实付写错了）
  const packRead = new Map();
  async function openPack(files) {
    packFiles = [...files].filter(f => /\.(pdf|ofd|xml)$/i.test(f.name));
    if (!$('pack-seq').value) $('pack-seq').value = nextSeq();
    const need = packPlan(1).rows.map(r => r.f).filter(f => /\.pdf$/i.test(f.name) && !packRead.has(f.name));
    for (let i = 0; i < need.length; i++) {
      if (i % 10 === 0) toast('正在读取发票 PDF：' + i + ' / ' + need.length);
      try { const r = await readInvoicePdf(need[i]); if (r.isInvoice && r.amount != null) packRead.set(need[i].name, { kind: 'ok', amount: r.amount, date: r.date, invNo: r.invNo, titleOk: r.titleOk }); }
      catch (e) { /* 读不了的按订单实付写 */ }
    }
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
  async function makePack() {
    const p = renderPack();
    if (!p.rows.length) return;
    const today = new Date(), td = String(today.getFullYear()).slice(2) + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
    const batch = ($('pack-name').value.trim() || '报销').replace(/[\\/:*?"<>|]+/g, '');
    const dir = batch + '_' + td + '_' + p.total.toFixed(2);
    const cell = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [['序号', '报销文件名', '原文件名', '下单日期', '店铺', '商品', '数量', '实付', '发票金额', '开票日期', '订单号', '备注', '类别'].join(',')];
    for (const r of p.rows) for (const x of r.xs)
      lines.push([r.seq, r.name, r.f.name, (x.o.time || '').slice(0, 10), x.o.shop, x.lines.map(l => l.title).join('；'), x.lines.reduce((a, l) => a + (l.qty || 1), 0), x.o.pay, r.amount.toFixed(2), r.date, x.o.no, r.warn || '', r.amount > 200 ? '低值品（超过200元）' : ''].map(cell).join(','));
    lines.push(['合计', '', '', '', '', '', '', '', p.total.toFixed(2)].map(cell).join(','));
    if (p.miss.length) {
      lines.push('', '尚无发票的实验室订单');
      for (const m of p.miss) lines.push(['', '', '', (m.x.o.time || '').slice(0, 10), m.x.o.shop, m.x.lines.map(l => l.title).join('；'), '', m.x.o.pay, '', '', m.x.o.no, m.st.label].map(cell).join(','));
    }
    const csv = new TextEncoder().encode('﻿' + lines.join('\r\n') + '\r\n');
    $('pack-go').disabled = true;
    toast('正在整理：' + p.rows.length + ' 张发票…');
    const entries = [];
    // 单张发票超过 200 元算低值品，单独放一个文件夹（用户 2026-10-05）
    for (const r of p.rows) entries.push({ name: dir + '/' + (r.amount > 200 ? '低值品（单张超过200元）/' : '') + r.name, data: new Uint8Array(await r.f.arrayBuffer()) });
    entries.push({ name: dir + '/汇总.csv', data: csv });
    // 要写明文件类型：不写的话浏览器按内容猜，可能把 .pdf 存成 .txt（2026-10-05 测试里出现过）
    const mime = n => /\.pdf$/i.test(n) ? 'application/pdf' : /\.csv$/i.test(n) ? 'text/csv' : /\.xml$/i.test(n) ? 'application/xml' : 'application/octet-stream';
    for (const e of entries) { await saveBlob(new Blob([e.data], { type: mime(e.name) }), '订单分拣-报销/' + e.name); await sleepMs(300); }
    await saveBlob(new Blob([Z.makeZip(entries)], { type: 'application/zip' }), '订单分拣-报销/' + dir + '.zip');
    S.lastPack = { at: Date.now(), dir, n: p.rows.length, nos: p.rows.flatMap(r => r.xs.map(x => x.o.no)) };
    persist(); render();
    $('dlg-pack').close();
    toast('整理完成：下载文件夹「订单分拣-报销/' + dir + '」中已生成 ' + p.rows.length + ' 张发票及汇总表，并附同名压缩包', true);
  }

  // 排活给淘宝页，并打开那个页面（已开着的页面也会领到活）
  // 连着排两份活时，两次「读出再写回」要一个接一个，不然后一次会把前一次盖掉
  let jobChain = Promise.resolve();
  function invJob(kind, url) {
    jobChain = jobChain.then(() => chrome.storage.local.get('invJobs'))
      .then(r => chrome.storage.local.set({ invJobs: Object.assign({}, r.invJobs, { [kind]: Date.now() }) }));
    // 扩展自己开标签页，不受弹窗拦截影响（window.open 点一下只放行一个）；上一份活开的标签页这时已经干完，交给后台关掉
    chrome.runtime.sendMessage({ type: 'openJobTab', url });
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
      if (s.key !== 'replied' || !c) continue;
      // 分不清是哪单的（同店几单共用一个会话）也下：下完主页读 PDF 上的金额、开票日期，归错的自动挪到对的那单（用户 2026-10-04）
      c.files.forEach((f, i) => {
        const k = c.name + '|' + f.name + '|' + f.time;
        if (seen.has(k) || (S.rejectedSrc || {})[f.name]) return; seen.add(k);
        jobs.push(Object.assign({ id: 'c' + no + '_' + i, kind: 'chat', conv: c.name, file: f.name, time: f.time },
          base, { saveAs: c.files.length > 1 ? base.saveAs.replace(/\.pdf$/, '_' + (i + 1) + '.pdf') : base.saveAs }));
      });
      // 卖家发的二维码：是税务局电子发票地址（dppt.<省>.chinatax.gov.cn…2_<20 位发票号>_…）就打开它下载 PDF
      for (const im of c.images || []) {
        const url = await qrUrl(im.src);
        const m = url && /^https:\/\/dppt\.[a-z]+\.chinatax\.gov\.cn(?::\d+)?\/.*?2_(\d{20})_/.exec(url);
        if (!m || seen.has('q' + m[1])) continue;
        seen.add('q' + m[1]);
        const alts = invOrders().filter(y => y.o.shop === o.shop && y.o.no !== no && !settled(y.o))
          .map(y => ({ no: y.o.no, amount: y.o.pay, saveAs: I.saveName({ time: y.o.time, amount: y.o.pay, shop: y.o.shop, no: y.o.no }) }));
        jobs.push(Object.assign({ id: 'q' + m[1], kind: 'qr', url, invNo: m[1], amount: o.pay, title: S.invoice.title, taxId: S.invoice.taxId, alts }, base));
      }
    }
    const { dlJobs } = await chrome.storage.local.get('dlJobs'), now = Date.now();
    // 旧活只留「半小时内排的、这单也还要下」的（淘宝页正在下）：连点两次不再派第二个页面重复下；
    // 没找到的、已挂上 PDF / 已整理的旧活清掉，免得以后下别的单时被顺带再下一遍（2026-09 离线复现）
    const still = j => { const x = byNo.get(j.no), k = x && invStatus(x).key; return j.kind === 'platform' ? k === 'ready' : k === 'replied'; };   // chat、qr 都是「卖家已回」
    const keep = (dlJobs || []).filter(j => now - (j.at || 0) < 1800e3 && still(j));
    const busy = new Set(keep.map(j => j.id));
    const add = jobs.filter(j => !busy.has(j.id)).map(j => Object.assign(j, { at: now }));
    await chrome.storage.local.set({ dlJobs: keep.concat(add) });
    return { add, busy: jobs.length - add.length };
  }
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  // 卖家发的图片 → 二维码里的地址（认不出就是空）
  async function qrUrl(src) {
    try { const { data } = await imgData(src); const q = window.jsQR && window.jsQR(data.data, data.width, data.height); return q ? q.data : ''; }
    catch (e) { return ''; }
  }

  // 每张新下载的发票：插件按下载地址把 PDF 取回来读（阿里云上的文件，扩展有权限），用价税合计、开票日期核对是不是这单的；
  // 不是的挪到对的那单、比下单还早的从这单拿掉（用户 2026-10-04：分不清几单就下下来，读金额和日期核对）。结果记在 S.fileChecks
  let verifying = false;
  async function verifyDownloads() {
    if (verifying || !EXT || !S.orders.length) return;
    verifying = true;
    try {
      const done = S.fileChecks || (S.fileChecks = {});
      const todo = [];
      for (const list of Object.values(X.dlDone || {})) for (const g of list) if (g.url && !done[g.file]) todo.push(g);
      if (!todo.length) return;
      // 应报金额 = 实付 − 部分退款的退款金额
      const ra = S.refundAmt || {};
      const orders = S.orders.map(o => ({ no: o.no, shop: o.shop, time: o.time, amount: Math.round((o.pay - o.lines.reduce((a, l) => a + (ra[l.key] || 0), 0)) * 100) / 100 }));
      const have = new Map((S.haveIdx || []).map(x => [x.invNo, x]));
      const res = [];
      for (const g of todo) {
        try {
          const r = await readInvoicePdf(new File([await (await fetch(g.url)).blob()], g.file));
          if (!r.isInvoice || r.amount == null) { done[g.file] = { kind: 'unread' }; continue; }
          const [c0] = I.checkFiles([Object.assign(r, { file: g.file })], orders);
          // 发票号和已整理（已报销）的一样：是那一单的票，不是这单的（2026-10-04 实测：一张票被「多一点」规则算到同店另一单，其实是以前已报销过的票）
          const c = have.has(r.invNo) ? Object.assign({}, c0, { kind: 'dup' }) : c0;
          done[g.file] = { kind: c.kind, amount: c.amount, date: c.date, invNo: c.invNo, to: c.to || '', nos: c.nos || [], short: c.short || 0, dup: have.has(r.invNo) ? have.get(r.invNo).file : '' };
          res.push(c);
        } catch (e) { done[g.file] = { kind: 'error', err: String(e.message || e) }; }    // 下载链接过期等：到「核对下载的发票」里手动核
      }
      persist();
      await applyFileCheck(res);
      const n = k => res.filter(c => k.includes(c.kind)).length;
      const good = n(['ok', 'more', 'merged', 'less']), moved = n(['move']), gone = n(['old', 'dup']), bad = res.length - good - moved - gone;
      toast('已核对 ' + todo.length + ' 张新下载的发票（按金额和开票日期）：相符 ' + good + ' 张'
        + (moved ? '，' + moved + ' 张归属有误、已移至正确订单' : '') + (gone ? '，' + gone + ' 张不属于本单（以往或已报销的发票），已移除' : '')
        + (bad > 0 ? '，' + bad + ' 张需核对（发票栏中已标出）' : ''), true);
      render();
    } finally { verifying = false; }
  }
  const CHECK_NOTE = { ok: '✓ PDF 金额、日期相符', more: '✓ 票面略高于实付（按用券前价格开具）', merged: '✓ 同店多单合开', less: '✓ 票面低于实付不足 1 元',
    short: '⚠ 票面低于应报金额 1 元以上，请联系卖家核对',
    move: '已移至正确订单', old: '⚠ 开票日期早于下单日期：属于以往其他订单', dup: '⚠ 与已整理（已报销）的发票为同一张，不属于本单', amount: '⚠ PDF 金额不符', many: '⚠ 同店多单均可匹配，请核对',
    title: '⚠ 抬头不符', unread: '⚠ 无法读取 PDF 金额', error: '（未能取回 PDF 核对）' };
  function rejectedOnly(o, st) {
    if (st.key !== 'replied') return st;
    const c = chatOf(o), rej = S.rejectedSrc || {};
    if (!c || !c.files.length || (c.images || []).length || (c.email || []).length || !c.files.every(f => rej[f.name])) return st;
    return { key: 'ask', label: I.LABEL.ask, detail: '卖家发送的 ' + c.files.length + ' 个文件经核对均不属于本单（' + c.files.map(f => rej[f.name].kind === 'dup' ? '已报销的发票' : '以往的发票').join('、') + '）' };
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
  function withCheck(o, st) {
    if (st.key !== 'done') return st;
    const got = (X.dlDone[o.no] || []).concat(S.invFiles[o.no] || []);
    const notes = got.map(g => (S.fileChecks || {})[g.file]).filter(Boolean)
      .map(c => (CHECK_NOTE[c.kind] || '') + (c.kind === 'short' ? '（少 ' + yuan(+c.short) + '）' : '') + (c.amount != null && c.kind !== 'error' ? '（' + yuan(+c.amount) + '，' + (c.date || '日期未读取') + '）' : '') + (c.dup ? '；与已整理的 ' + c.dup + ' 为同一张' : ''));
    return notes.length ? Object.assign({}, st, { detail: st.detail + ' · ' + notes.join('；'), checks: notes.join('；') }) : st;
  }

  // 打开每一单的订单详情页（extension/detail.js）：读旺旺图标上的卖家旺旺名，并看商品是不是已经退款成功了。
  // 用户 2026-10-04：「不用猜旺旺名，订单边上的旺旺图标点进去就是他」；同一天发现有一单热缩管在订单表里是交易成功、
  // 其实已经整单退款——给卖家发消息要发票之前先看一眼。整单退款的标成退款（不再要发票），返回被标退款的单数
  async function inspectOrders(os) {
    if (!os.length) return 0;
    await chrome.storage.local.set({ nickWant: Object.fromEntries(os.map(o => [o.no, Date.now()])), detailFound: {} });
    let refunded = 0, partial = 0;
    for (const o of os) {
      toast('正在读取订单详情：' + o.shop + '（' + (o.time || '').slice(0, 10) + '，' + yuan(+o.pay) + '）');
      const tab = await chrome.tabs.create({ url: detailUrl(o.no), active: true });
      for (let t = 0; t < 25000; t += 800) {
        await sleepMs(800);
        const { detailFound } = await chrome.storage.local.get('detailFound');
        const d = detailFound && detailFound[o.no];
        if (!d) continue;
        if (d.nick) o.nick = d.nick;
        // 整单退款：每件都退了，或者各件退款加起来 ≥ 本单实付（退货退款时详情页上的件数、单价可能和订单表对不上，
        // 之前件数不一样就什么都不记，整单退了的单还被当成要开票，2026-10-05 排查一单退货退款后仍被督促的问题时补上）
        const refundSum = (d.lines || []).reduce((a, x) => a + (x.refund || 0), 0);
        if (d.refunded || (o.pay > 0 && refundSum + 0.005 >= o.pay)) {
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
        break;
      }
      try { await chrome.tabs.remove(tab.id); } catch (e) { /* 已经关了 */ }
    }
    await chrome.storage.local.remove('nickWant');
    persist(); derive(); render();
    if (refunded || partial) toast((refunded ? refunded + ' 单在订单详情页显示整单退款成功，已标为退款，不再索要发票' : '')
      + (refunded && partial ? '；' : '') + (partial ? partial + ' 件为部分退款，已记录退款金额，报销金额按实付减退款计算' : ''));
    return refunded;
  }
  const resolveNicks = os => inspectOrders(os.filter(o => !o.nick));

  async function startDownloads(nos, all) {
    const { add: jobs, busy } = await queueDownloads(nos, all);
    if (!jobs.length) { toast(busy ? '这些发票正在下载中，请等待完成' : all ? '没有可下载的发票（归属不明的聊天文件，请在对应行单独下载）' : '没有可下载的发票'); return; }
    // 二维码发票：逐张打开税务局页面（各自核对后下载、下完自己关掉）
    const qrs = jobs.filter(j => j.kind === 'qr');
    for (const j of qrs) { chrome.runtime.sendMessage({ type: 'openWorkTab', url: j.url }); await sleepMs(6000); }
    const plat = jobs.some(j => j.kind === 'platform'), chat = jobs.some(j => j.kind === 'chat');
    // 淘宝页面在后台标签里不干活（常常一片空白），两个页面同时开只有前台那个在下：
    // 两种都有时先开「全部发票」页，它下完平台票后由后台再打开旺旺页（extension/background.js 看 chatAfter）
    if (plat && chat) await chrome.storage.local.set({ chatAfter: Date.now() });
    if (plat) invJob('download', INV_URL);
    else if (chat) invJob('chatDownload', CHAT_URL);
    toast('已安排 ' + jobs.length + ' 个下载，淘宝页面将依次下载并存入下载文件夹的「订单分拣-发票」'
      + (plat && chat ? '；平台发票下载完成后自动打开旺旺页，下载卖家发送的文件' : ''));
  }
  // ── 一键平台申请：交给批量开票页（extension/batch.js），它勾好、核对完停在淘宝的确认页，由用户点「确认提交」──
  const BATCH_URL = 'https://i.taobao.com/my_itaobao/pricelist/batchInvoice';
  const applyList = () => invOrders().filter(x => invStatus(x).key === 'apply');
  async function startApply() {
    const list = applyList();
    if (!list.length) { toast('没有可在淘宝平台申请的订单'); return; }
    if (needInvoiceInfo()) return;
    const days = list.map(x => (x.o.time || '').slice(0, 10)).filter(Boolean).sort();
    await chrome.storage.local.set({ applyResult: null, applyJob: { nos: list.map(x => x.o.no), from: days[0], to: days[days.length - 1],
      title: S.invoice.title, taxId: S.invoice.taxId, at: Date.now() } });
    chrome.runtime.sendMessage({ type: 'openWorkTab', url: BATCH_URL });         // 插件开的干活页：申请提交（或停下）后自己关掉
    toast('已打开淘宝「批量开票」页：将自动勾选 ' + list.length + ' 单并核对抬头、税号，停在确认页，请核对后点击「确认提交」');
  }
  function onApplyResult(r) {
    if (!r) return;
    if ((r.missing || []).length) {
      S.noPlatform = S.noPlatform || {};
      r.missing.forEach(no => { S.noPlatform[no] = r.at; });
      persist(); derive(); render();
    }
    if (r.error) toast('平台申请已停止：' + r.error);
    else if (r.stage === 'confirm') toast('淘宝页面已勾选 ' + r.found.length + ' 单，请在「批量开票确认」中核对后点击「确认提交」'
      + (r.missing.length ? '；' + r.missing.length + ' 单无法在平台开票，已改为「' + I.LABEL.ask + '」' : ''));
    else if (r.stage === 'submitted') { toast('检测到已提交，正在同步开票状态以确认'); invJob('sync', INV_URL); }
    else if (r.stage === 'none') toast('批量开票页中没有这些订单，无法在平台开票，已改为「' + I.LABEL.ask + '」');
  }
  // 检查开票情况：同步「全部发票」→ 扫旺旺里卖家的回复 → 下载全部开好的。每一步等上一步的结果写回扩展存储再走
  let chain = null;
  async function startAuto() {
    // 要看卖家回复、却不知道卖家旺旺名的，先去订单详情页把旺旺名找出来（不然旺旺里找不到会话）
    const miss = invOrders().filter(x => !x.o.nick && needsChat(invStatus(x))).map(x => x.o);
    if (miss.length) await resolveNicks(miss);
    const part = [...new Set(derived.rows.filter(x => !x.past && N.refundState(x.l, x.o) === 'refunded' && S.refunds[x.l.key] === undefined
      && (S.refundAmt || {})[x.l.key] == null && (S.decisions[x.l.key] || x.r.cat) === 'lab').map(x => x.o))];
    if (part.length) await inspectOrders(part);
    chain = 'sync';
    invJob('sync', INV_URL);
    toast('检查开票情况：① 同步开票状态…');
  }
  function chainNext(kind) {
    if (chain === 'sync' && kind === 'invSync') {
      const w = invWant();
      if (w && w.chat.length) { chain = 'scan'; invJob('scan', CHAT_URL); toast('检查开票情况：② 读取 ' + new Set(w.chat.map(x => x.shop)).size + ' 家店的旺旺回复…'); return; }
      chain = 'dl';
    }
    if ((chain === 'scan' && kind === 'chatScan') || chain === 'dl') {
      chain = null;
      toast('检查开票情况：③ 下载已开具的发票…');
      startDownloads(invOrders().map(x => x.o.no), true);
    }
  }

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
    $('img-copy').disabled = $('img-open').disabled = !m.nos.length && !r;
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
  function openSettings() {
    $('inv-title').value = S.invoice.title || '';
    $('inv-tax').value = S.invoice.taxId || '';
    $('inv-tpl').value = S.invoice.template || I.DEFAULT_TEMPLATE;
    $('inv-email').value = S.invoice.email || '';
    $('remind-days').value = remindDays();
    const ad = S.prefs.autoDaily || {};
    $('auto-daily').checked = !!ad.on; $('auto-hour').value = ad.hour || 10;
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
    S.prefs.remindDays = Math.max(1, Math.min(60, +$('remind-days').value || 7));
    S.prefs.autoDaily = { on: $('auto-daily').checked, hour: Math.max(0, Math.min(23, +$('auto-hour').value || 10)) };
    if (EXT) chrome.storage.local.set({ autoDaily: S.prefs.autoDaily });
    persist(); derive(); render();
    $('dlg-settings').close(); toast('设置已保存');
  }

  // ── 备份数据 / 从备份恢复（用户 2026-10-05）：全部数据只在本机浏览器里，删掉扩展或清浏览器数据就没了 ──
  // 备份文件：{ app: 'orderTriage', kind: 'backup', format: 1, version, at, localStorage: { 'orderTriage.*': 原样字符串 }, storage: chrome.storage.local 全部 }
  // 格式有不兼容的改动时 format 加一；旧插件见到不认识的 format 就拒绝，不去猜
  const VERSION = EXT ? chrome.runtime.getManifest().version : '0.13.0';     // 网页版读不到 manifest，selftest 核对两处一致
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
  const BACKUP_SKIP = ['applyJob', 'applyResult', 'cardJobs', 'cardRun', 'chatQueue', 'chatAfter', 'dlJobs', 'invJobs', 'jobTabs', 'nickWant', 'vipJob', 'olderDone', 'autoLast'];
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
    $('file').onchange = e => { if (e.target.files.length) importFiles([...e.target.files]); e.target.value = ''; };
    $('btn-sample').onclick = async () => {
      S.orders = N.rowsToOrders(window.SAMPLE_ROWS);
      persist(); derive(); render(); toast('已载入 8 单示例数据（全部虚构）');
    };
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
    $('inv-sync').onclick = () => invJob('sync', INV_URL);
    $('inv-auto').onclick = () => startAuto().catch(e => toast('出错：' + e.message));
    $('inv-vip').onclick = () => startVip().catch(e => toast('出错：' + e.message));
    $('inv-card').onclick = () => startCard().catch(e => { cardBusy = false; toast('出错：' + e.message); });
    $('inv-pack-dir').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) openPack(f).catch(err => toast('读取发票出错：' + err.message)); };
    $('pack-seq').oninput = () => renderPack();
    $('pack-go').onclick = () => makePack().catch(e => { toast('整理出错：' + e.message); $('pack-go').disabled = false; });
    $('pack-cancel').onclick = () => $('dlg-pack').close();
    $('inv-apply').onclick = startApply;
    $('inv-ask').onclick = () => startAsk().catch(e => toast('出错：' + e.message));
    $('inv-scan').onclick = () => invJob('scan', CHAT_URL);
    $('inv-dl-all').onclick = () => startDownloads(invOrders().map(x => x.o.no), true);
    $('inv-have-dir').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importHaveDir(f).catch(err => toast('读取 PDF 出错：' + err.message)); };
    $('inv-check-dir').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) checkDownloadDir(f).catch(err => toast('读取 PDF 出错：' + err.message)); };
    $('dup-close').onclick = () => $('dlg-dup').close();
    $('list').addEventListener('change', e => { const f = e.target.closest('input[data-inv="attach"]'); if (f && f.files[0]) attachFile(f.dataset.no, f.files[0]); });
    $('img-copy').onclick = copyScraper;
    $('img-older').onchange = e => { S.older = e.target.value || ''; persist(); renderImages(); };
    $('img-open').onclick = () => window.open(TAOBAO, '_blank', 'noopener');
    $('img-close').onclick = () => $('dlg-img').close();
    $('btn-settings').onclick = openSettings;
    $('rules-save').onclick = saveSettings;
    $('rules-cancel').onclick = () => $('dlg-settings').close();
    $('data-backup').onclick = () => backupData().catch(e => toast('备份出错：' + e.message));
    $('backup-file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreData(f).catch(err => alert('恢复出错：' + err.message)); };
    $('data-clear').onclick = () => {
      if (!confirm('清除本浏览器中保存的全部订单、判断和发票记录？下载文件夹中的发票不受影响。\n\n清除后无法找回，建议先备份数据（更多 → 备份数据）。')) return;
      try { localStorage.removeItem(STORE); } catch (e) { /* 忽略 */ }
      if (EXT) chrome.storage.local.clear();
      S = { orders: [], decisions: {}, refunds: {}, rules: null, prefs: S.prefs, invoice: { title: I.DEFAULT_TITLE, taxId: I.DEFAULT_TAX, template: '', email: '' }, invFiles: {}, haveIdx: [] };
      $('dlg-settings').close(); derive(); render();
    };

    const setSince = v => { S.since = v; persist(); derive(); render(); };
    $('remind').addEventListener('click', e => { const go = e.target.closest('[data-goto]'); if (go) goCat(go.dataset.goto); });
    $('remind').addEventListener('keydown', e => { const go = e.target.closest('[data-goto]'); if (go && e.key === 'Enter') goCat(go.dataset.goto); });
    $('summary').addEventListener('click', e => {
      const go = e.target.closest('[data-goto]');
      if (go) { goCat(go.dataset.goto); return; }
      const f = e.target.closest('button[data-flow]');
      if (f) {
        const k = f.dataset.flow;
        if (k === 'import') $('file').click();
        else if (k === 'taobao') window.open(TAOBAO, '_blank', 'noopener');
        else if (k === 'img-dlg') openImages();
        else if (k === 'have-dir') $('inv-have-dir').click();
        else if (k === 'since-none') setSince('none');
        else if (k === 'since-auto') setSince('');
        return;
      }
      const li = e.target.closest('[data-step]');
      if (li) { const st = flowSteps()[+li.dataset.step]; view.step = +li.dataset.step; if (st.cat) view.cat = st.cat; render(); }
    });
    $('summary').addEventListener('keydown', e => { if (e.key === 'Enter') { const li = e.target.closest('[data-step]'); if (li) li.click(); } });
    $('summary').addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.flow === 'since-date') setSince(t.value || '');
    });
    $('seg-cat').onclick = e => { const b = e.target.closest('button'); if (b) goCat(b.dataset.cat); };
    let qt = null;
    $('q').oninput = e => { clearTimeout(qt); qt = setTimeout(() => { view.q = e.target.value; renderList(); }, 120); };
    $('d-from').onchange = e => { view.from = e.target.value; render(); };
    $('d-to').onchange = e => { view.to = e.target.value; render(); };
    $('sort').value = S.prefs.sort;
    $('sort').onchange = e => { S.prefs.sort = e.target.value; persist(); renderList(); };
    $('auto-next').checked = S.prefs.autoNext;
    $('auto-next').onchange = e => { S.prefs.autoNext = e.target.checked; persist(); };

    $('list').addEventListener('click', e => {
      const bulk = e.target.closest('[data-bulk]');
      if (bulk) { bulkConfirm(bulk.dataset.bulk); return; }
      const go = e.target.closest('[data-goto]');
      if (go) { goCat(go.dataset.goto); return; }
      const ww = e.target.closest('[data-ww]');
      if (ww) { openChat(ww.dataset.ww).catch(err => toast('出错：' + err.message)); return; }
      const sg = e.target.closest('[data-go]');
      if (sg) { goStatus(sg.dataset.go, sg.dataset.no); return; }
      const ib = e.target.closest('button[data-inv]');
      if (ib) { startDownloads([ib.dataset.no]); return; }
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
      if (!S.orders.length || view.cat === 'invoice') return;      // 发票栏里没有选中的商品，别改到看不见的那件
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
  if (EXT) {
    document.body.classList.add('is-ext');
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || restoring) return;
      if (ch.scraped) mergeFromExt(ch.scraped.newValue);
      if (ch.olderDone) olderFinished(ch.olderDone.newValue);
    });
    chrome.storage.local.get(['scraped', 'olderDone']).then(r => { mergeFromExt(r.scraped); olderFinished(r.olderDone); });
    chrome.storage.local.set({ want: wantList() });
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
        toast('每日自动处理：开始检查开票情况');
        startAuto().catch(e => toast('自动处理出错：' + e.message));
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
        if (ch.invSync) chainNext('invSync'); else if (ch.chatScan) chainNext('chatScan');
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
})();
