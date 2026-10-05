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
  const yuan = n => n == null ? '—' : '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── 状态 ──
  let S = { orders: [], decisions: {}, refunds: {}, rules: null, prefs: { autoNext: true, sort: 'desc' },
            invoice: { title: I.DEFAULT_TITLE, taxId: I.DEFAULT_TAX, template: '', email: '' }, invFiles: {}, haveIdx: [] };
  // 扩展存储里淘宝页读回来的发票数据：全部发票同步结果、旺旺扫描结果、已下载记录（只在扩展里有）
  const X = { invSync: null, chatScan: null, dlDone: {} };
  const view = { cat: 'unsure', q: '', from: '', to: '', focus: null, step: null };   // 打开先看「待定」：要你动手的在这里
  let derived = null;           // 每次数据/判断变化后重算
  let undoStack = [];

  function persist() {
    try { localStorage.setItem(STORE, JSON.stringify(S)); }
    catch (e) { toast('本机存储写入失败（可能空间不足），请用「导出 → 保存项目文件」备份'); }
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
    const noNick = derived ? invOrders().filter(x => !x.o.nick && ['ask', 'asked', 'replied'].includes(invStatus(x).key)).map(x => x.o) : [];
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
  function invWant() {
    if (!derived) return null;
    const list = invOrders();
    const pick = xs => xs.map(x => ({ no: x.o.no, shop: x.o.shop, nick: x.o.nick || '', time: x.o.time, amount: x.o.pay }));
    const first = xs => xs.map(x => (x.o.time || '').slice(0, 10)).filter(Boolean).sort()[0] || '';
    const chat = list.filter(x => ['ask', 'asked', 'replied'].includes(invStatus(x).key));
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
    if (r.filled || r.added) toast('从淘宝页补上图片 ' + r.filled + ' 件' + (r.added ? (none ? '（还没有订单表，按抓取数据建了 ' : '（订单表之前的订单，按订单页建了 ') + r.added + ' 单）' : ''));
  }
  // 淘宝页翻完了订单表之前的那段：过去的订单不会再变，清掉「提取到哪天」，以后补图找齐就停，不用每次翻回去（要刷新再填一次）
  function olderFinished(d) {
    if (!d) return;
    chrome.storage.local.remove('olderDone');         // 用过就删：留着的话，用户重新填同一天，主页一刷新又被这个旧信号清掉
    if (!S.older || d.from !== S.older) return;
    S.older = ''; persist();
    toast('订单表之前的订单已提取到 ' + d.from + '；以后补图不再翻回去，要重新提取就再填一次日期');
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.orders)) S = Object.assign(S, d);
    } catch (e) { /* 私密窗口等情况下读不到，当作空白开始 */ }
  }
  const rules = () => S.rules || C.DEFAULT_RULES;

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
    if (p && p.tab === 'issued' && (!S.invoice.title || !p.title || p.title.includes(S.invoice.title))) return '开过' + (S.invoice.title || '本单位') + '的发票';
    if (haveOf(o)) return '有发票（在你整理好的发票里）';
    if ((X.dlDone[o.no] || []).length || (S.invFiles[o.no] || []).length) return '下载过发票';
    if (p && p.tab === 'applying') return '申请过发票';
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
    const plain = C.classifyAll(S.orders, { compiled: ctx.compiled, norm: N.norm });   // 只看词表，用来找词表的错
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
            ? { cat: 'unsure', via: 'invoice', why: '词表判个人，但这单已经' + inv + '，请你确认' }
            : { cat: 'lab', via: 'invoice', why: '这单已经' + inv });
        const r = manual ? { cat: manual, via: 'manual', why: '你的判断', hits: a.hits } : a;
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
        rows.push({ o, l, share, r, ref, past, keep: keep != null && !ref && ra == null ? keep : null, refAmt: ra != null && !ref ? ra : null, refManual: mr !== undefined, auto: plain.get(l.id).cat });
      });
    }
    const ignored = new Set(S.prefs.ignored || []);
    const sg = C.suggest(rows.map(x => ({ title: x.l.title, text: x.l.title + ' ' + x.l.sku, manual: S.decisions[x.l.key], auto: x.auto })), rules());
    const sug = sg.remove.map(x => Object.assign({ kind: 'remove' }, x)).concat(sg.add.map(x => Object.assign({ kind: 'add', w: 2 }, x)))
      .filter(x => !ignored.has(sugId(x)));
    derived = { rows, byKey: new Map(rows.map(x => [x.l.key, x])), sug };
    if (EXT) chrome.storage.local.set({ invWant: invWant() });      // 判断一变，要报销的订单就跟着变
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
      if (st.key === 'applying') { kind = 'platform'; since = (platOf(o) || {}).date; }
      // 等卖家：从插件发消息的时间、或聊天里最后一次要发票的时间算（说明文字后面可能还接着「找客服督促过」，只取里面的日期）
      else if (st.key === 'asked') { kind = 'seller'; since = (X.askSent || {})[o.no] || ((/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.exec(st.detail || '') || [])[0]); }
      else kind = 'you';
      g[kind].push({ o, st, days: since ? daysSince(since) : null });
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
  async function startVip() {
    if (needInvoiceInfo()) return;
    const xs = vipList();
    if (!xs.length) { toast('没有超过 ' + remindDays() + ' 天还没开票、又还没督促过的单'); return; }
    await chrome.storage.local.set({ vipJob: { at: Date.now(), title: S.invoice.title, taxId: S.invoice.taxId, orders: xs.map(x => ({ no: x.o.no, days: x.days, shop: x.o.shop })) } });
    await chrome.tabs.create({ url: 'https://consumerservice.taobao.com/online-help', active: true });
    toast('打开淘宝官方客服：先发「人工」转到人工客服，再一单一句督促开票（共 ' + xs.length + ' 单）');
  }
  let lastBadge = '';
  function renderRemind() {
    const el = $('remind');
    const r = invReminder();
    if (!r) { el.hidden = true; return; }
    const badge = JSON.stringify([r.all, r.late.length]);
    if (badge !== lastBadge) { lastBadge = badge; chrome.storage.local.set({ invPending: { n: r.all, late: r.late.length, at: Date.now() } }); }
    if (!r.all) { el.hidden = false; el.className = 'remind ok'; el.innerHTML = '<b>实验室的订单发票都拿到了 ✓</b>'; return; }
    const who = r => esc(r.o.shop) + '（' + (r.o.time || '').slice(0, 10) + '，¥' + r.o.pay + (r.days != null ? '，等了 ' + r.days + ' 天' : '') + '）';
    const part = (name, xs, tip) => xs.length ? '<li><b>' + name + ' ' + xs.length + ' 单</b>' + (tip ? '：' + tip : '') + '</li>' : '';
    const oldest = xs => { const d = xs.map(x => x.days).filter(v => v != null); return d.length ? '最久的等了 ' + Math.max(...d) + ' 天' : ''; };
    el.hidden = false;
    el.className = 'remind' + (r.late.length || r.g.you.length ? ' warn' : '');
    el.innerHTML = '<div class="remind-head"><b>还有 ' + r.all + ' 单实验室订单没拿到发票</b>，合计 ' + yuan(r.sum)
      + ' <button class="linkbtn" data-goto="invoice">去发票栏看 →</button></div><ul>'
      + part('要你动手', r.g.you, r.g.you.slice(0, 4).map(x => esc(x.st.label.replace(/（.*/, '')) + '：' + who(x)).join('；') + (r.g.you.length > 4 ? ' 等' : ''))
      + part('等卖家回复', r.g.seller, oldest(r.g.seller))
      + part('等平台开票', r.g.platform, oldest(r.g.platform))
      + '</ul>'
      + (r.late.length ? '<div class="remind-late">超过 ' + remindDays() + ' 天还没开票的 ' + r.late.length + ' 单：' + r.late.map(who).join('、')
        + (vipList().length ? '。可以在发票栏点「找客服督促」，让淘宝官方人工客服催卖家' : '') + '</div>' : '');
  }

  function render() {
    const has = S.orders.length > 0;
    $('empty').hidden = has;
    $('main').hidden = !has;
    if (!has) return;
    renderRemind();
    renderSummary();
    renderSeg();
    renderList();
  }

  // 发票的三类：还没开 / 开好了还没下载 / 已开好并下载
  const INV_GROUP = { apply: 'todo', ask: 'todo', asked: 'todo', applying: 'todo', wrong: 'todo', check: 'todo',
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
    $('seg-cat').scrollIntoView({ block: 'start' });
  }

  // ── 一条线的步骤：导入订单表 → 上次报销到哪 → 补图片 → 待定 → 检查个人 → 检查实验室 → 开发票 ──
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
    const sinceText = since.mode === 'auto' ? '自动识别：上次报到 ' + since.date + ' ' + (since.shop || '') + ' 那一单，之前的 ' + past + ' 件不再判断'
      : since.mode === 'date' ? '你指定的：' + since.date + ' 及以前的 ' + past + ' 件不再判断'
      : since.mode === 'none' ? '从订单表第一单开始算（全部都要判断）' : '还不知道上次报销到哪一单';
    return [
      { id: 'import', title: '导入订单表', done: S.orders.length > 0,
        text: S.orders.length ? S.orders.length + ' 单，' + times[0] + ' 至 ' + times[times.length - 1] : '还没导入',
        help: '在淘宝「已买到的宝贝」点「导出订单」，把下载的 xlsx 导进来。以后有新订单，重新导出一份再导入就行，你的判断都会保留。',
        acts: '<button class="btn primary" data-flow="import">导入订单表…</button>' },
      { id: 'since', title: '上次报销到哪', done: ['auto', 'date', 'none'].includes(since.mode), text: sinceText,
        help: '上次已经报销过的那一单及以前的订单不再判断。导入你整理好的发票文件夹，插件会认出已经报过的订单，自动找到上次报到哪一单；也可以直接选日期。',
        acts: '<label class="btn' + (since.mode === 'unknown' ? ' primary' : '') + '">导入整理好的发票文件夹…<input type="file" data-flow="have-dir" webkitdirectory multiple hidden></label>'
          + '<label class="flow-date">或者手动指定：报到 <input type="date" data-flow="since-date" value="' + (since.mode === 'date' ? since.date : '') + '"> 为止</label>'
          + (since.mode !== 'none' ? '<button class="linkbtn" data-flow="since-none">从第一单开始算</button>' : '')
          + (since.mode === 'date' || since.mode === 'none' ? '<button class="linkbtn" data-flow="since-auto">改回自动识别</button>' : '') },
      { id: 'images', title: '补图片', done: live.length > 0 && img === live.length, text: '有图 ' + img + ' / ' + live.length + ' 件' + (img < live.length ? '，还差 ' + (live.length - img) + ' 件（列表里标了红色 ERROR）' : ''),
        help: EXT ? '打开淘宝订单页，点右下角的「开始补图片」，它会自己翻页，图片和每件商品的退款情况会自动回到这里。出现滑块验证请自己完成后再点一次。'
                  : '网页版需要复制抓取脚本到淘宝订单页的控制台运行；装成 Chrome 扩展会简单很多。',
        acts: (EXT ? '<button class="btn primary" data-flow="taobao">打开淘宝订单页</button>' : '<button class="btn primary" data-flow="img-dlg">补图片…</button>')
          + (EXT ? '<button class="linkbtn" data-flow="img-dlg">订单表之前的订单也要提取…</button>' : '') },
      { id: 'unsure', cat: 'unsure', title: '判断待定', done: n.unsure === 0, text: n.unsure ? '还剩 ' + n.unsure + ' 件' : '全部判完',
        help: '电脑拿不准的商品，每件按 1 实验室 / 2 个人，开一个少一个。退款的商品插件会自己排除，不用你管。',
        acts: '<button class="btn primary" data-goto="unsure">去判断待定</button>' },
      { id: 'personal', cat: 'personal', title: '检查个人', done: n.unsure === 0 && unconf.personal === 0, text: n.personal + ' 件' + (unconf.personal ? '，' + unconf.personal + ' 件待确认' : '，都已确认'),
        help: '从上到下看一遍判成个人的，判错的按 1 改成实验室；都没问题就点「全部确认为个人」。确认过的就是你的判断，以后不会再变。',
        acts: '<button class="btn primary" data-goto="personal">去检查个人</button>' },
      { id: 'lab', cat: 'lab', title: '检查实验室', done: n.unsure === 0 && unconf.lab === 0, text: n.lab + ' 件' + (unconf.lab ? '，' + unconf.lab + ' 件待确认' : '，都已确认'),
        help: '同样看一遍判成实验室的，判错的按 2 改成个人；都没问题就点「全部确认为实验室」。这些就是这次要报销的。',
        acts: '<button class="btn primary" data-goto="lab">去检查实验室</button>' },
      { id: 'invoice', cat: 'invoice', title: '开发票', done: !!ic && ic.todo === 0 && ic.ready === 0 && invOrders().length > 0,
        text: ic ? '还没开 ' + ic.todo + ' · 待下载 ' + ic.ready + ' · 已下载 ' + ic.done : '要装成 Chrome 扩展',
        help: '先点「一键处理发票」：自动同步淘宝的开票状态、看卖家在旺旺里发来的发票、把开好的全部下载到「订单分拣-发票」。'
          + '能在淘宝平台开的，点「平台申请」：插件勾好、核对抬头税号，停在淘宝的确认页，你点「确认提交」就行。',
        acts: '<button class="btn primary" data-goto="invoice">去开发票</button>' },
    ];
  }
  function renderSummary() {
    const steps = flowSteps();
    const cur = steps.findIndex(x => !x.done);
    const sel = view.step != null ? view.step : steps.findIndex(x => x.cat && x.cat === view.cat);
    const show = sel >= 0 ? sel : (cur >= 0 ? cur : steps.length - 1);
    const d = steps[show];
    $('summary').innerHTML = '<ol class="flow">' + steps.map((x, i) =>
        '<li class="' + (x.done ? 'is-done' : i === cur ? 'is-cur' : '') + (i === show ? ' is-sel' : '') + '" data-step="' + i + '" role="button" tabindex="0">'
        + '<span class="flow-n">' + (x.done ? '✓' : i + 1) + '</span><span class="flow-t">' + x.title + '</span>'
        + '<span class="flow-s">' + esc(x.text) + '</span></li>').join('') + '</ol>'
      + '<div class="flow-detail"><div><b>第 ' + (show + 1) + ' 步 · ' + d.title + '</b>'
      + (show !== cur && cur >= 0 ? '<span class="flow-hint">（现在该做的是第 ' + (cur + 1) + ' 步：' + steps[cur].title + '）</span>' : cur < 0 ? '<span class="flow-hint">全部做完了 ✓</span>' : '')
      + '<p>' + d.help + '</p></div><div class="flow-acts">' + d.acts + '</div></div>';
  }

  function renderSeg() {
    const c = { all: 0, unsure: 0, lab: 0, personal: 0, refund: 0 };
    for (const x of derived.rows) { if (x.past) continue; c.all++; if (x.ref) c.refund++; else c[effCat(x)]++; }
    const items = [['all', '全部'], ['unsure', '待定'], ['lab', '实验室'], ['personal', '个人'], ['refund', '退款/关闭'], ['invoice', '发票']];
    c.invoice = invOrders().filter(x => !['done', 'none', 'applying', 'have', 'paper'].includes(invStatus(x).key)).length;   // 还要你动手的（纸质发票在快递里，插件帮不上）
    $('seg-cat').innerHTML = items.map(([k, lab]) =>
      '<button data-cat="' + k + '" aria-pressed="' + (view.cat === k) + '">' + lab + ' <span class="c">' + c[k] + '</span></button>').join('');
  }

  function statusClass(s) {
    if (/交易成功|交易完成/.test(s)) return 'st-ok';
    if (/关闭|退款/.test(s)) return 'st-closed';
    return 'st-other';
  }

  function renderList() {
    $('inv-bar').hidden = view.cat !== 'invoice' || !EXT;
    $('bar').querySelector('.chk').hidden = view.cat === 'invoice';
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
        + '<span class="shop">' + esc(o.shop || '未知店铺') + '</span>'
        + (o.source === 'scrape' ? '<span class="src">来自抓取</span>' : '')
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
  function nextBtn(cat, label) { return '<button class="btn primary" data-goto="' + cat + '">' + label + ' →</button>'; }
  function listHead(rows) {
    const filtered = view.q || view.from || view.to;
    if (view.cat === 'unsure') {
      if (!rows.length && !filtered) return '<div class="page-bar done"><span><b>待定全部判完了 ✓</b>　下一步：把「个人」从头到尾看一遍</span>' + nextBtn('personal', '去检查个人') + '</div>';
      return rows.length ? '<div class="page-bar"><span>还有 <b>' + rows.length + '</b> 件电脑拿不准。每件按 <kbd>1</kbd> 实验室 / <kbd>2</kbd> 个人，判完自动跳下一件，开一个少一个。</span></div>' : '';
    }
    if (view.cat === 'lab' || view.cat === 'personal') {
      const cat = view.cat, name = CAT_NAME[cat], todo = rows.filter(x => S.decisions[x.l.key] !== cat).length;
      const next = cat === 'personal' ? nextBtn('lab', '去检查实验室') : nextBtn('invoice', '去开发票');
      if (!rows.length) return '';
      if (!todo) return '<div class="page-bar done"><span><b>这一页 ' + rows.length + ' 件都确认为' + name + '了 ✓</b>' + (filtered ? '（当前有筛选条件）' : '') + '</span>' + (filtered ? '' : next) + '</div>';
      return '<div class="page-bar"><span>共 ' + rows.length + ' 件，其中 <b>' + todo + '</b> 件是电脑判的、你还没确认，<b>排在最上面</b>、标着「待你确认」。看一遍，判错的按 '
        + (cat === 'lab' ? '<kbd>2</kbd> 改成个人' : '<kbd>1</kbd> 改成实验室') + '；都没问题就点右边，全部变成你的判断。</span>'
        + '<button class="btn primary" data-bulk="' + cat + '">全部确认为' + name + '（' + todo + ' 件）</button></div>';
    }
    if (view.cat === 'refund') return '<div class="page-bar"><span>这些是插件按订单页上每件商品旁边的「退款成功」和订单的「交易关闭」判的：不计金额、不进报销，不用你处理。'
      + '一单里只退了几件的，只有退了的那几件在这里。</span></div>';
    return '';
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
    if (!src) return '<div class="' + cls + ' ph err" title="订单页上没抓到这件的图片">ERROR<br>没抓到图</div>';
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
    d.className = im.className + ' ph err'; d.title = '图片加载失败：' + im.src; d.innerHTML = 'ERROR<br>图片打不开';
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
    toast((fixed ? '换好了 ' + fixed + ' 张打不开的商品图' : '') + (fixed && dead.size ? '；' : '')
      + (dead.size ? dead.size + ' 单的图怎么都打不开，已标红 ERROR，补图时会重新抓' : ''), true);
  }

  function lineHtml(x) {
    const { l, r } = x;
    const cat = r.cat, manual = r.via === 'manual';
    const img = thumbHtml(l.img, 'thumb');
    const title = l.link && /^https?:\/\//.test(l.link)
      ? '<a href="' + esc(l.link) + '" target="_blank" rel="noopener noreferrer">' + esc(l.title) + '</a>' : esc(l.title);
    const viaLabel = { manual: '手动', rule: '自动', shop: '店铺记忆', title: '同商品记忆', invoice: '已开发票', surcharge: '补差价' }[r.via] || '自动';
    const labCls = manual && cat === 'lab' ? 'on-lab' : (!manual && cat === 'lab' ? 'sug-lab' : '');
    const perCls = manual && cat === 'personal' ? 'on-per' : (!manual && cat === 'personal' ? 'sug-per' : '');
    const unconf = (view.cat === 'lab' || view.cat === 'personal') && !manual && !x.ref;
    const pill = unconf ? '<span class="pill p-uns">待你确认</span>'
               : cat === 'lab' ? '<span class="pill p-lab">实验室</span>'
               : cat === 'personal' ? '<span class="pill p-per">个人</span>' : '<span class="pill p-uns">待定</span>';
    const refPill = x.ref === 'refunded' ? '<span class="pill p-ref">已退款</span>'
                  : x.ref === 'refunding' ? '<span class="pill p-ref">退款中</span>'
                  : x.ref === 'closed' ? '<span class="pill p-ref">交易关闭</span>'
                  : x.refAmt != null ? '<span class="pill p-ref">部分退款：退了 ' + yuan(x.refAmt) + '，按 ' + yuan(x.share) + ' 报</span>'
                  : x.keep != null ? '<span class="pill p-ref">退了 ' + (x.l.qty - x.keep) + ' 个，留下 ' + x.keep + ' 个</span>' : '';
    return '<div class="line' + (x.ref ? ' is-ref' : '') + (view.focus === l.key ? ' focus' : '') + '" data-key="' + esc(l.key) + '">'
      + img
      + '<div><div class="title">' + title + '</div>'
      + (l.sku ? '<div class="sku">' + esc(l.sku) + '</div>' : '')
      + '<div class="why"><span class="via">' + viaLabel + '</span>' + esc(r.why || '') + (refPill ? ' ' + refPill : '') + '</div>'
 + '</div>'
      + '<div class="price num">' + yuan(l.price) + '<span class="q">× ' + (l.qty || 1) + '</span></div>'
      + '<div class="share num">' + yuan(x.share) + '<span class="l">实付估算</span></div>'
      + '<div class="cls"><div class="pick">'
      + '<button data-set="lab" class="' + labCls + '" title="按 1">实验室</button>'
      + '<button data-set="personal" class="' + perCls + '" title="按 2">个人</button></div>'
      + '<div class="meta">' + pill
      + (manual ? '<button class="linkbtn" data-set="auto" title="按 0">撤回</button>' : '')
      + ((x.ref === 'refunded' && x.l.qty > 1) || x.keep != null ? '<button class="linkbtn" data-keep="1" title="同一件买了 ' + x.l.qty + ' 个，订单页上看不出退了几个">' + (x.keep != null ? '改留下的个数' : '只退了一部分？') + '</button>' : '')
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
    toast((cat === 'auto' ? '已撤回为自动判断' : '已标为' + (cat === 'lab' ? '实验室' : '个人')) + (x ? '：' + x.l.title.slice(0, 18) : ''), true);
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
  // 一件买了几个、只退了其中几个：订单列表上只写「退款成功」看不出数量，用户说留下几个（0 = 全退了）
  function setKeep(key) {
    const x = derived.byKey.get(key);
    if (!x) return;
    const cur = S.partial && S.partial[key];
    const v = prompt('「' + x.l.title.slice(0, 20) + '」买了 ' + x.l.qty + ' 个，退款后实际留下几个？（全退了填 0）', cur != null ? cur : '');
    if (v === null) return;
    const n = parseInt(v, 10);
    if (!(n >= 0 && n < x.l.qty)) { toast('要填 0 到 ' + (x.l.qty - 1) + ' 之间的整数'); return; }
    S.partial = S.partial || {};
    if (n === 0) delete S.partial[key]; else S.partial[key] = n;
    persist(); derive(); render();
    toast(n ? '已记下：留下 ' + n + ' 个，按 ' + n + ' 个的金额算' : '已记下：全部退了');
  }
  // 个人 / 实验室页从头看到尾都没问题：一次把这一页电脑判的也全部写成「你的判断」，以后改词表也不会再变
  function bulkConfirm(cat) {
    const rows = visibleRows().filter(x => effCat(x) === cat && !x.ref && S.decisions[x.l.key] !== cat);
    if (!rows.length) return;
    const prev = rows.map(x => [x.l.key, S.decisions[x.l.key]]);
    rows.forEach(x => { S.decisions[x.l.key] = cat; });
    undoStack.push({ type: 'bulk', prev });
    persist(); derive(); render();
    toast('已把这一页 ' + rows.length + ' 件确认为' + (cat === 'lab' ? '实验室' : '个人'), true);
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
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (withUndo ? '<button id="toast-undo">撤销</button>' : '');
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
        msgs.push(f.name + '：读取失败 —— ' + e.message);
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
        if (S.orders.length && !confirm('载入项目文件会替换当前页面里的全部订单和判断，继续？')) return name + '：已取消';
        S = Object.assign({ orders: [], decisions: {}, refunds: {}, rules: null, prefs: S.prefs, invoice: S.invoice, invFiles: {}, haveIdx: S.haveIdx || [] }, d.state);
        return name + '：已载入项目（' + S.orders.length + ' 单）';
      }
      const list = d && d.format === 'order-triage-scrape' ? d.orders : Array.isArray(d) ? d : null;
      if (!list) throw new Error('不认识的 JSON 格式');
      const none = !S.orders.length;
      const r = N.mergeScraped(S.orders, list, { addNew: none, addRange: olderRange() });
      if (r.added && none) return name + '：还没有订单表，按抓取数据建了 ' + r.added + ' 单';
      return name + '：对上订单表 ' + r.matched + ' 单，补上图片 ' + r.filled + ' 件' + (r.added ? '，订单表之前的订单建了 ' + r.added + ' 单' : '')
        + (r.unmatched ? '，' + r.unmatched + ' 件在抓取数据里没找到对应商品' : '')
        + (r.skipped ? '；' + r.skipped + ' 单不在订单表里，已忽略' : '');
    }
    const rows = await T.read(buf, name);
    const incoming = N.rowsToOrders(rows);
    incoming.forEach(o => tableNos.add(o.no));
    const lost = incoming.dropped && incoming.dropped.length
      ? '。⚠ 有 ' + incoming.dropped.length + ' 单读不出商品，没有导入：' + incoming.dropped.join('、') + '（请把订单表发给维护者）' : '';
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

  // ── 导出 ──
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const csvCell = v => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

  function exportCsv(onlyLab) {
    const head = ['日期', '订单号', '店铺', '商品', '规格', '数量', '单价', '实付估算', '本单实付', '订单状态', '退款', '类别', '判断来源', '依据'];
    const catName = { lab: '实验室', personal: '个人', unsure: '待定' };
    const refName = { refunded: '已退款', refunding: '退款中', closed: '交易关闭', '': '' };
    const viaName = { manual: '手动', rule: '自动', shop: '店铺记忆', title: '同商品记忆', invoice: '已开发票', surcharge: '补差价' };
    const rows = derived.rows.filter(x => !x.past && (!onlyLab || (effCat(x) === 'lab' && !x.ref)))
      .sort((a, b) => (a.o.time || '').localeCompare(b.o.time || ''));
    const lines = [head.join(',')].concat(rows.map(x => [
      (x.o.time || '').slice(0, 10), '\t' + x.o.no, x.o.shop, x.l.title, x.l.sku, x.l.qty, x.l.price, x.share, x.o.pay,
      x.o.statusLive || x.o.status, x.keep != null ? '部分退款：留下 ' + x.keep + ' 个' : refName[x.ref], catName[effCat(x)], viaName[x.r.via], x.r.why].map(csvCell).join(',')));
    download((onlyLab ? '实验室物品清单-' : '分拣结果-') + stamp() + '.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }
  // 发票清单：发票页上的每一单和它在哪一类，给用户核对、也方便发给别人看
  function exportInvoiceCsv() {
    const GN = { todo: '还没开发票', ready: '开好了还没下载', done: '已开好并下载' };
    const head = ['分类', '发票状态', '详情', '日期', '订单号', '店铺', '本单实付', '实验室商品'];
    const rows = invOrders().map(x => ({ x, s: invStatus(x) })).filter(r => INV_GROUP[r.s.key])
      .sort((a, b) => Object.keys(GN).indexOf(INV_GROUP[a.s.key]) - Object.keys(GN).indexOf(INV_GROUP[b.s.key]) || (a.x.o.time || '').localeCompare(b.x.o.time || ''));
    const lines = [head.join(',')].concat(rows.map(({ x, s }) => [GN[INV_GROUP[s.key]], s.label, s.detail || '', (x.o.time || '').slice(0, 10), '\t' + x.o.no,
      x.o.shop, x.o.pay, x.lines.map(l => l.title).join(' / ')].map(csvCell).join(',')));
    download('发票清单-' + stamp() + '.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }
  function exportProject() {
    download('triage-project-' + stamp() + '.json',
      JSON.stringify({ format: 'order-triage-project', version: 1, savedAt: new Date().toISOString(), state: S }), 'application/json');
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
    const same = invOrders().filter(x => (shopKey(x.o.shop) === shopKey(o.shop) || (hit[1].orders || []).includes(x.o.no)) && !settled(x.o)).length || 1;
    // 按旺旺名打开的老会话：右侧「我的订单」里看不到这一单时，不确定是不是这单的卖家，交给用户核对
    const unsure = hit[1].byNick && hit[1].matched === false ? { shared: true } : {};
    return Object.assign({ name: hit[0] }, I.chatForOrder(hit[1], o.no, same, o.time), unsure);
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
    const st = I.status({ plat, chat: chatOf(o), got, have, canApply: o.inv === '申请开票' }, { title: S.invoice.title });
    // 「全部发票 → 未申请」里有、批量开票页上却没有的单：平台开不了（2026-10 实测），要找卖家
    const cs = !have && haveMatch().contested.get(o.no);
    if (cs && ['ask', 'apply', 'asked'].includes(st.key))
      return { key: 'check', label: '可能已整理过，请你核对', detail: '已整理的发票里有同金额的：' + cs.map(x => x.file).join('、') + '（同金额的几单抢一张，或对上了几张，插件不猜）' };
    if (st.key === 'apply' && (S.noPlatform || {})[o.no]) return askedOr(o, { key: 'ask', label: '需找卖家', detail: '批量开票页里没有这单，平台开不了' });
    return withVip(o, withCheck(o, askedOr(o, rejectedOnly(o, st))));
  }
  // 插件帮着发过要发票的消息（askSent，旺旺页记的）：还在「需找卖家」或「卖家要邮箱」的，改成「已发消息，等回复」。
  // 下次扫描旺旺时这条消息会被认成「要过发票」，之后卖家发来的文件照常认
  const needsMsg = st => st.key === 'ask' || (st.key === 'replied' && /^卖家提到邮箱/.test(st.label));
  function askedOr(o, st) {
    const t = (X.askSent || {})[o.no];
    if (!t || !needsMsg(st)) return st;
    // 扫描没认出这条消息也不推翻（2026-10-04 扫描读漏过一次，几家店变回「需找卖家」，差点重复去问）
    return { key: 'asked', label: '已发消息要发票，等回复', detail: new Date(t).toLocaleString() };
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
    toast('先在「设置 → 发票信息」里填好发票抬头和税号');
    openSettings();
    return true;
  }
  async function startAsk() {
    if (needInvoiceInfo()) return;
    // 名单上的每一单都先去订单详情页看一眼：卖家旺旺名、是不是已经退款了
    const pre = askList();
    await inspectOrders(pre.items.flatMap(g => g.nos).concat(pre.noNickOrders.map(o => o.no)).map(no => S.orders.find(o => o.no === no)).filter(Boolean));
    const { items, noNick } = askList();
    if (!items.length) { toast(noNick.length ? noNick.length + ' 家店还不知道卖家旺旺名：先去淘宝订单页补一次图片' : '没有要找卖家的订单'); return; }
    // 先列清单给用户确认（发给哪几家、每家发什么），确认后插件逐家自动发；也可以选「我自己逐家点发送」（用户 2026-10-05）
    const pick = await confirmAsk(items, noNick);
    if (!pick) return;
    const sel = items.filter((g, i) => pick.keep[i]);
    if (!sel.length) { toast('一家都没勾，没有发'); return; }
    await chrome.storage.local.set({ chatQueue: { at: Date.now(), kind: 'compose', auto: pick.auto, items: sel, done: 0, sent: [], skipped: [], taxId: S.invoice.taxId } });
    chrome.runtime.sendMessage({ type: 'openJobTab', url: 'https://market.m.taobao.com/app/im/chat/index.html?&uid=' + encodeURIComponent('cntaobao' + sel[0].nick) + '&gid=&type=web' });
    toast((pick.auto ? '开始自动发送（共 ' + sel.length + ' 家）' : '打开第 1 家（共 ' + sel.length + ' 家）：消息已填好，请核对后自己点「发送」') + '：' + sel[0].shop);
  }
  // 确认窗口：每家一行（勾选框、店铺、订单、要发的话），返回 { auto, keep: [是否发] } 或 null（取消）
  function confirmAsk(items, noNick) {
    $('ask-note').textContent = '共 ' + items.length + ' 家。确认后插件逐家打开旺旺，核对会话是这家店后发出下面的消息，每家之间隔几秒。'
      + (noNick.length ? ' 另有 ' + noNick.length + ' 家不知道卖家旺旺名，这次不发。' : '');
    $('ask-list').innerHTML = items.map((g, i) => '<label class="ask-row"><input type="checkbox" data-ask="' + i + '" checked> <b>' + esc(g.shop) + '</b>'
      + '<span class="detail">' + g.orders.map(o => esc(o.date) + ' ¥' + esc(o.amount) + ' ' + esc(o.no)).join('；') + '</span>'
      + '<span class="ask-msg">' + esc(g.msg) + '</span></label>').join('');
    $('dlg-ask').showModal();
    return new Promise(res => {
      const done = auto => { $('dlg-ask').close(); res(auto == null ? null : { auto, keep: items.map((g, i) => $('ask-list').querySelector('[data-ask="' + i + '"]').checked) }); };
      $('ask-auto').onclick = () => done(true);
      $('ask-manual').onclick = () => done(false);
      $('ask-cancel').onclick = () => done(null);
    });
  }
  function renderInvoice() {
    if (!EXT) {
      $('list').innerHTML = '<div class="none">发票功能要装成 Chrome 扩展使用：扩展会去淘宝「全部发票」和旺旺里读开票情况、下载发票。见 README。</div>';
      return;
    }
    const q = view.q.trim().toLowerCase();
    const list = invOrders().filter(x => {
      if (view.from && (x.o.time || '').slice(0, 10) < view.from) return false;
      if (view.to && (x.o.time || '').slice(0, 10) > view.to) return false;
      return !q || (x.o.no + ' ' + x.o.shop + ' ' + x.lines.map(l => l.title).join(' ')).toLowerCase().includes(q);
    }).sort((a, b) => (b.o.time || '').localeCompare(a.o.time || ''));
    const st = new Map(list.map(x => [x.o.no, invStatus(x)]));
    const count = {};
    for (const v of st.values()) count[v.label.replace(/（.*/, '')] = (count[v.label.replace(/（.*/, '')] || 0) + 1;
    const vip = vipList().length;
    $('inv-vip').textContent = '找客服督促（' + vip + ' 单）';
    $('inv-vip').disabled = !vip;
    $('inv-apply').textContent = '平台申请（' + applyList().length + ' 单）';
    $('inv-apply').disabled = !applyList().length;
    const al = askList(), ask = al.items.length + al.noNick.length;          // 不知道旺旺名的也算：点了会先去订单详情页找
    $('inv-ask').textContent = '给卖家发消息（' + ask + ' 家）';
    $('inv-ask').disabled = !ask;
    $('inv-note').textContent = (S.invoice.title ? '' : '先在「设置」里填抬头和税号。')
      + (X.invSync ? '上次同步：' + new Date(X.invSync.at).toLocaleString('zh-CN') + '。' : '还没同步过发票状态。')
      + Object.entries(count).map(([k, n]) => k + ' ' + n).join('，');
    if (!list.length) { $('list').innerHTML = '<div class="none">没有要报销的实验室订单</div>'; return; }
    const TODO = { apply: '点上面「平台申请」一键勾好，停在淘宝的确认页等你提交', ask: '要给卖家发消息', asked: '' };
    const HEAD = '<table class="inv-table"><thead><tr><th></th><th>日期</th><th>店铺 / 订单号</th><th>实验室商品</th><th>本单实付</th><th>发票</th><th>操作</th></tr></thead><tbody>';
    const rowHtml = x => {
        const o = x.o, s = st.get(o.no), c = chatOf(o);
        const acts = [];
        if (s.key === 'ready') acts.push('<button class="btn" data-inv="dl-plat" data-no="' + esc(o.no) + '">下载</button>');
        if (s.key === 'replied' && c && c.files.length) acts.push('<button class="btn" data-inv="dl-chat" data-no="' + esc(o.no) + '">下载 ' + c.files.length + ' 个文件</button>');
        acts.push('<label class="btn" title="把邮件里收到的 PDF 挂到这单上，存进「订单分拣-发票」文件夹">挂上 PDF<input type="file" accept=".pdf,.ofd,.xml" data-inv="attach" data-no="' + esc(o.no) + '" hidden></label>');
        const okImg = u => /^https:\/\/([\w-]+\.)*(alicdn|taobao|tbcdn|tmall)\.com\//.test(u);
        const imgs = s.key === 'replied' && c && !c.files.length && c.images.length
          ? c.images.slice(-2).filter(im => okImg(im.src)).map(im => '<div><img class="qr" alt="卖家发来的图片" referrerpolicy="no-referrer" crossorigin="anonymous" data-qr="1" src="' + esc(im.src) + '"><div class="detail" data-qr-out></div></div>').join('') : '';
        const pic = x.lines.find(l => l.img);
        return '<tr><td>' + thumbHtml(pic && pic.img, 'inv-thumb') + '</td>'
          + '<td class="num">' + esc((o.time || '').slice(0, 10)) + '</td>'
          + '<td>' + esc(o.shop || '未知店铺') + '<div class="detail num">' + esc(o.no) + '</div></td>'
          + '<td>' + esc(x.lines[0].title.slice(0, 26)) + (x.lines.length > 1 ? ' 等 ' + x.lines.length + ' 件' : '') + '</td>'
          + '<td class="num">' + yuan(o.pay) + '</td>'
          + '<td><span class="st st-' + s.key + '">' + esc(s.label) + '</span>'
          + (s.detail ? '<div class="detail">' + esc(s.detail) + '</div>' : '') + (TODO[s.key] ? '<div class="detail">' + TODO[s.key] + '</div>' : '') + imgs + '</td>'
          + '<td><div class="acts">' + acts.join('') + '</div></td></tr>';
};
    const SECT = [
      ['todo', '还没开发票', '可平台申请的，在淘宝「我的发票 → 批量开票」里申请；需找卖家的要给卖家发消息。申请完回来点「同步发票状态」，开好的会移到下一类。'],
      ['ready', '开好了，还没下载', '点上面「下载全部已开好的发票」，存进下载文件夹的「订单分拣-发票」，下好的会移到下一类。纸质发票在快递里，下载不了。'],
      ['done', '已开好并下载', '这些不用再管了。'],
    ];
    $('list').innerHTML = SECT.map(([g, name, tip]) => {
      const xs = list.filter(x => INV_GROUP[st.get(x.o.no).key] === g);
      return '<section class="inv-sect"><h3>' + name + ' <span class="c">' + xs.length + ' 单</span></h3><p class="detail">' + tip + '</p>'
        + (xs.length ? HEAD + xs.map(rowHtml).join('') + '</tbody></table>' : '<div class="none">没有</div>') + '</section>';
    }).join('');
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
        if (q && q.data) { out.textContent = '是二维码，内容：' + q.data + '（请自己核对后再打开）'; return; }
        out.textContent = '不是二维码';
      }).catch(() => { out.textContent = '读不了这张图的像素，请用手机扫'; });
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
      if (i % 10 === 0) toast('正在读' + what + '：' + i + ' / ' + pdfs.length + ' 个 PDF');
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
    toast('读了 ' + total + ' 个 PDF：认出 ' + got.length + ' 张发票（' + notInv.length + ' 个不像发票，比如扫描件或说明文档），已整理的发票现在共 ' + S.haveIdx.length + ' 张');
  }
  // 核对下载的发票：① 按 PDF 上的金额、开票日期核对是不是文件名那一单的（同店买过几次时常归错），能确定的自动改过来；
  // ② 和已整理的重复的、下载的里面自己重复的（按发票号码）。插件删不了、改不了用户的文件名，列清单给用户处理
  async function checkDownloadDir(files) {
    const { got, total } = await readPdfFolder(files, '下载的发票');
    const by = new Map((S.haveIdx || []).map(x => [x.invNo, x]));
    const dup = got.filter(r => by.has(r.invNo));
    const seen = new Map(), twice = [];
    got.forEach(r => { if (seen.has(r.invNo)) twice.push(r.file + '（和 ' + seen.get(r.invNo) + ' 是同一张）'); else seen.set(r.invNo, r.file); });
    const res = I.checkFiles(got, S.orders.map(o => ({ no: o.no, shop: o.shop, time: o.time, amount: o.pay })));
    const moved = await applyFileCheck(res);
    const ord = no => { const o = S.orders.find(x => x.no === no); return o ? (o.time || '').slice(0, 10) + ' ' + o.shop + ' ¥' + o.pay + '（' + no + '）' : no; };
    const what = r => '¥' + r.amount + '，开票 ' + (r.date || '日期没读到');
    const KIND = {
      move: r => '不是文件名那单的。票面 ' + what(r) + ' → 是 ' + ord(r.to) + '（已改过来）',
      merged: r => '票面 ' + what(r) + '，是同店几单合开的：' + r.nos.map(ord).join(' + '),
      many: r => '票面 ' + what(r) + '，同店好几单都对得上，分不清：' + r.nos.map(ord).join('、') + '。请你看一下',
      old: r => '开票 ' + r.date + '，比下单还早：是以前别的单的票，不是这单的（已从这单拿掉）',
      more: r => '票面 ' + what(r) + '，比这单实付多一点：多半是按用券前的价开的，算这单的（报销按哪个金额请你定）',
      amount: r => '票面 ' + what(r) + '，和这单 ' + ord(r.no) + ' 对不上，同店也找不到对得上的。请你看一下',
      title: () => '抬头不是 ' + (S.invoice.title || '你的单位') + '，要找卖家重开',
    };
    const bad = res.filter(r => r.kind !== 'ok' && r.kind !== 'none');        // 文件名里没订单号的（自己放进来的）不核对，只计数
    const none = res.length - bad.length - res.filter(r => r.kind === 'ok').length;
    $('dup-note').textContent = '读了 ' + total + ' 个 PDF，认出 ' + got.length + ' 张发票：金额和开票日期对得上的 ' + (res.length - bad.length) + ' 张，'
      + '要看一下的 ' + bad.length + ' 张（自动改过来 ' + moved + ' 张）' + (none ? '，文件名里没订单号、没核对的 ' + none + ' 张' : '') + '；和已整理的重复 ' + dup.length + ' 张，下载的里面自己重复 ' + twice.length + ' 张。';
    const sec = (t, xs) => xs.length ? ['【' + t + '】'].concat(xs, ['']) : [];
    $('dup-list').value = sec('金额、开票日期核对', bad.map(r => r.file + '\n    ' + KIND[r.kind](r)))
      .concat(sec('和已整理的重复（可以删）', dup.map(r => r.file + '\n    和已整理的 ' + by.get(r.invNo).file + ' 是同一张（号码 ' + r.invNo + '）')))
      .concat(sec('下载的里面自己重复（可以删）', twice)).join('\n') || '都对得上，也没有重复';
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
      r.warn = same ? '和已整理的 ' + same.file + ' 是同一张发票' : (r.chk && r.chk.titleOk === false ? '抬头不是 ' + S.invoice.title : '');
      r.name = r.seq + '_' + yymmdd(r.date) + '_' + r.amount.toFixed(2) + '-' + shortTitle(r.xs[0].lines[0].title) + '-' + qty + '件.' + ext;
    }
    return { rows, miss, total: rows.reduce((a, r) => a + r.amount, 0) };
  }
  function renderPack() {
    const seq0 = Math.max(1, +$('pack-seq').value || nextSeq());
    const p = packPlan(seq0);
    $('pack-note').textContent = '找到 ' + p.rows.length + ' 张发票（' + p.rows.reduce((a, r) => a + r.xs.length, 0) + ' 单），合计 ' + yuan(p.total)
      + (p.miss.length ? '；还有 ' + p.miss.length + ' 单实验室订单没有发票文件，会列在汇总表最后' : '') + '。确认后存进下载文件夹的「订单分拣-报销」。';
    $('pack-list').value = p.rows.map(r => (r.amount > 200 ? '［低值品］' : '') + r.name + '    ← ' + r.f.name + (r.warn ? '    ⚠ ' + r.warn : '')).join('\n') + (p.miss.length ? '\n\n还没有发票：\n' + p.miss.map(m => '  ' + (m.x.o.time || '').slice(0, 10) + ' ' + m.x.o.shop + ' ¥' + m.x.o.pay + ' ' + m.x.o.no + '（' + m.st.label + '）').join('\n') : '');
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
      if (i % 10 === 0) toast('正在读发票 PDF：' + i + ' / ' + need.length);
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
      lines.push('', '还没有发票的实验室订单');
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
    $('dlg-pack').close();
    toast('整理好了：下载文件夹「订单分拣-报销/' + dir + '」里 ' + p.rows.length + ' 张发票 + 汇总表，另有同名压缩包', true);
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
      const orders = S.orders.map(o => ({ no: o.no, shop: o.shop, time: o.time, amount: o.pay }));
      const have = new Map((S.haveIdx || []).map(x => [x.invNo, x]));
      const res = [];
      for (const g of todo) {
        try {
          const r = await readInvoicePdf(new File([await (await fetch(g.url)).blob()], g.file));
          if (!r.isInvoice || r.amount == null) { done[g.file] = { kind: 'unread' }; continue; }
          const [c0] = I.checkFiles([Object.assign(r, { file: g.file })], orders);
          // 发票号和已整理（已报销）的一样：是那一单的票，不是这单的（2026-10-04 实测：一张票被「多一点」规则算到同店另一单，其实是以前已报销过的票）
          const c = have.has(r.invNo) ? Object.assign({}, c0, { kind: 'dup' }) : c0;
          done[g.file] = { kind: c.kind, amount: c.amount, date: c.date, invNo: c.invNo, to: c.to || '', nos: c.nos || [], dup: have.has(r.invNo) ? have.get(r.invNo).file : '' };
          res.push(c);
        } catch (e) { done[g.file] = { kind: 'error', err: String(e.message || e) }; }    // 下载链接过期等：到「核对下载的发票」里手动核
      }
      persist();
      await applyFileCheck(res);
      const n = k => res.filter(c => k.includes(c.kind)).length;
      const good = n(['ok', 'more', 'merged']), moved = n(['move']), gone = n(['old', 'dup']), bad = res.length - good - moved - gone;
      toast('读了 ' + todo.length + ' 张新下载的发票，按金额和开票日期核对：对得上 ' + good + ' 张'
        + (moved ? '，' + moved + ' 张归错了单、已挪到对的那单' : '') + (gone ? '，' + gone + ' 张不是这单的（以前的票或报销过的票），已从这单拿掉' : '')
        + (bad > 0 ? '，' + bad + ' 张要你看一下（发票栏里标着）' : ''), true);
      render();
    } finally { verifying = false; }
  }
  const CHECK_NOTE = { ok: '✓ PDF 金额、日期对得上', more: '✓ 票面比实付多一点（按用券前的价开）', merged: '✓ 和同店几单合开',
    move: '已挪到对的那单', old: '⚠ 开票日期比下单还早：是以前别的单的票', dup: '⚠ 和已整理（报销过）的发票是同一张，不是这单的', amount: '⚠ PDF 金额对不上', many: '⚠ 同店好几单都对得上，请你看',
    title: '⚠ 抬头不对', unread: '⚠ 读不出 PDF 里的金额', error: '（没能取回 PDF 核对）' };
  function rejectedOnly(o, st) {
    if (st.key !== 'replied') return st;
    const c = chatOf(o), rej = S.rejectedSrc || {};
    if (!c || !c.files.length || (c.images || []).length || (c.email || []).length || !c.files.every(f => rej[f.name])) return st;
    return { key: 'ask', label: '需找卖家', detail: '卖家发来的 ' + c.files.length + ' 个文件读过了，都不是这单的（' + c.files.map(f => rej[f.name].kind === 'dup' ? '报销过的票' : '以前的票').join('、') + '）' };
  }
  function withVip(o, st) {
    const t = (X.vipSent || {})[o.no];
    return t && INV_GROUP[st.key] !== 'done' ? Object.assign({}, st, { detail: (st.detail ? st.detail + ' · ' : '') + new Date(t).toLocaleDateString() + ' 找客服督促过' }) : st;
  }
  function withCheck(o, st) {
    if (st.key !== 'done') return st;
    const got = (X.dlDone[o.no] || []).concat(S.invFiles[o.no] || []);
    const notes = got.map(g => (S.fileChecks || {})[g.file]).filter(Boolean)
      .map(c => (CHECK_NOTE[c.kind] || '') + (c.amount != null && c.kind !== 'error' ? '（¥' + c.amount + '，' + (c.date || '日期没读到') + '）' : '') + (c.dup ? '；和已整理的 ' + c.dup + ' 是同一张' : ''));
    return notes.length ? Object.assign({}, st, { detail: st.detail + ' · ' + notes.join('；') }) : st;
  }

  // 打开每一单的订单详情页（extension/detail.js）：读旺旺图标上的卖家旺旺名，并看商品是不是已经退款成功了。
  // 用户 2026-10-04：「不用猜旺旺名，订单边上的旺旺图标点进去就是他」；同一天发现有一单热缩管在订单表里是交易成功、
  // 其实已经整单退款——给卖家发消息要发票之前先看一眼。整单退款的标成退款（不再要发票），返回被标退款的单数
  async function inspectOrders(os) {
    if (!os.length) return 0;
    await chrome.storage.local.set({ nickWant: Object.fromEntries(os.map(o => [o.no, Date.now()])), detailFound: {} });
    let refunded = 0, partial = 0;
    for (const o of os) {
      toast('打开订单详情页看一眼：' + o.shop + '（' + (o.time || '').slice(0, 10) + '，¥' + o.pay + '）');
      const tab = await chrome.tabs.create({ url: 'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=' + o.no, active: true });
      for (let t = 0; t < 25000; t += 800) {
        await sleepMs(800);
        const { detailFound } = await chrome.storage.local.get('detailFound');
        const d = detailFound && detailFound[o.no];
        if (!d) continue;
        if (d.nick) o.nick = d.nick;
        if (d.refunded) {
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
    if (refunded || partial) toast((refunded ? refunded + ' 单在订单详情页上是整单退款成功的，已标成退款，不再要发票' : '')
      + (refunded && partial ? '；' : '') + (partial ? partial + ' 件是部分退款，记下了退款金额，报销按实付减退款算' : ''));
    return refunded;
  }
  const resolveNicks = os => inspectOrders(os.filter(o => !o.nick));

  async function startDownloads(nos, all) {
    const { add: jobs, busy } = await queueDownloads(nos, all);
    if (!jobs.length) { toast(busy ? '这些发票淘宝页面正在下载，等它下完就好' : all ? '没有能下载的发票（分不清是哪单的聊天文件，要在那一行单独点下载）' : '没有能下载的发票'); return; }
    // 二维码发票：逐张打开税务局页面（各自核对后下载、下完自己关掉）
    const qrs = jobs.filter(j => j.kind === 'qr');
    for (const j of qrs) { await chrome.tabs.create({ url: j.url, active: true }); await sleepMs(6000); }
    const plat = jobs.some(j => j.kind === 'platform'), chat = jobs.some(j => j.kind === 'chat');
    // 淘宝页面在后台标签里不干活（常常一片空白），两个页面同时开只有前台那个在下：
    // 两种都有时先开「全部发票」页，它下完平台票后由后台再打开旺旺页（extension/background.js 看 chatAfter）
    if (plat && chat) await chrome.storage.local.set({ chatAfter: Date.now() });
    if (plat) invJob('download', INV_URL);
    else if (chat) invJob('chatDownload', CHAT_URL);
    toast('已排好 ' + jobs.length + ' 个下载，淘宝页面会依次点下载，存进下载文件夹的「订单分拣-发票」'
      + (plat && chat ? '；平台发票下完会自动打开旺旺页，下卖家发来的文件' : ''));
  }
  // ── 一键平台申请：交给批量开票页（extension/batch.js），它勾好、核对完停在淘宝的确认页，由用户点「确认提交」──
  const BATCH_URL = 'https://i.taobao.com/my_itaobao/pricelist/batchInvoice';
  const applyList = () => invOrders().filter(x => invStatus(x).key === 'apply');
  async function startApply() {
    const list = applyList();
    if (!list.length) { toast('没有能在淘宝平台申请的单'); return; }
    if (needInvoiceInfo()) return;
    const days = list.map(x => (x.o.time || '').slice(0, 10)).filter(Boolean).sort();
    await chrome.storage.local.set({ applyResult: null, applyJob: { nos: list.map(x => x.o.no), from: days[0], to: days[days.length - 1],
      title: S.invoice.title, taxId: S.invoice.taxId, at: Date.now() } });
    chrome.tabs.create({ url: BATCH_URL });
    toast('已打开淘宝「批量开票」页：会自动勾好 ' + list.length + ' 单、核对抬头税号，停在确认页等你点「确认提交」');
  }
  function onApplyResult(r) {
    if (!r) return;
    if ((r.missing || []).length) {
      S.noPlatform = S.noPlatform || {};
      r.missing.forEach(no => { S.noPlatform[no] = r.at; });
      persist(); derive(); render();
    }
    if (r.error) toast('平台申请停下了：' + r.error);
    else if (r.stage === 'confirm') toast('淘宝页上已勾好 ' + r.found.length + ' 单，请在淘宝的「批量开票确认」里核对后点「确认提交」'
      + (r.missing.length ? '；' + r.missing.length + ' 单平台开不了，已改成「需找卖家」' : ''));
    else if (r.stage === 'submitted') { toast('看起来已经提交了，正在同步发票状态确认'); invJob('sync', INV_URL); }
    else if (r.stage === 'none') toast('这些单批量开票页里都没有，平台开不了，已改成「需找卖家」');
  }
  // 一键处理：同步「全部发票」→ 扫旺旺里卖家的回复 → 下载全部开好的。每一步等上一步的结果写回扩展存储再走
  let chain = null;
  async function startAuto() {
    // 要看卖家回复、却不知道卖家旺旺名的，先去订单详情页把旺旺名找出来（不然旺旺里找不到会话）
    const miss = invOrders().filter(x => !x.o.nick && ['ask', 'asked', 'replied'].includes(invStatus(x).key)).map(x => x.o);
    if (miss.length) await resolveNicks(miss);
    const part = [...new Set(derived.rows.filter(x => !x.past && N.refundState(x.l, x.o) === 'refunded' && S.refunds[x.l.key] === undefined
      && (S.refundAmt || {})[x.l.key] == null && (S.decisions[x.l.key] || x.r.cat) === 'lab').map(x => x.o))];
    if (part.length) await inspectOrders(part);
    chain = 'sync';
    invJob('sync', INV_URL);
    toast('一键处理：① 同步发票状态…');
  }
  function chainNext(kind) {
    if (chain === 'sync' && kind === 'invSync') {
      const w = invWant();
      if (w && w.chat.length) { chain = 'scan'; invJob('scan', CHAT_URL); toast('一键处理：② 看 ' + new Set(w.chat.map(x => x.shop)).size + ' 家店在旺旺里的回复…'); return; }
      chain = 'dl';
    }
    if ((chain === 'scan' && kind === 'chatScan') || chain === 'dl') {
      chain = null;
      toast('一键处理：③ 下载开好的发票…');
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
      persist(); renderSeg(); renderList(); toast('已挂上：' + name);
    } catch (e) { toast('保存失败：' + e.message); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
  }

  // ── 补图片 ──
  function openImages() {
    if (!S.orders.length) { toast('先导入订单表，再补图片'); return; }
    $('img-older').value = S.older || '';
    renderImages();
    $('dlg-img').showModal();
  }
  function renderImages() {
    const m = N.missingImages(S.orders), r = olderRange();
    let lines = 0, withImg = 0;
    for (const o of S.orders) for (const l of o.lines) { lines++; if (l.img) withImg++; }
    $('img-cov').textContent = S.orders.length + ' 单里有图 ' + (S.orders.length - m.nos.length) + ' 单，'
      + lines + ' 件里有图 ' + withImg + ' 件。'
      + (m.nos.length ? '还缺图的 ' + m.nos.length + ' 单（最早 ' + (m.from || '日期未知') + '）。' : '全部有图了。');
    const first = tableFirst();
    $('img-older-note').textContent = r ? '会一直翻到 ' + r.from + '，' + r.from + ' 至 ' + first + ' 前一天的订单按订单页上的内容建单'
      : S.older ? '要早于订单表最早的一天（' + first + '）才有用' : '订单表最早是 ' + (first || '—') + '，更早的订单要提取就填这里';
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
    $('img-msg').textContent = ok ? '已复制（清单 ' + (m ? m.nos.length + ' 单' : '：全部订单') + '），去淘宝订单页的控制台粘贴' : '复制失败，请换个浏览器再试';
  }


  // ── 设置：词表 + 建议 ──
  const FIELDS = [['lab', 2], ['lab', 1], ['personal', 2], ['personal', 1]];
  const SIDE = { lab: '实验室', personal: '个人' }, WN = { 2: '强词', 1: '弱词' };
  const words = v => [...new Set(v.split(/[\s,，、;；]+/).map(w => w.trim()).filter(Boolean))];
  function fillRules(r) {
    for (const [side, w] of FIELDS) $('r-' + side + '-' + w).value = ((r[side] && r[side][w]) || []).join('、');
    $('r-unsure').value = (r.unsure || []).join('、');
  }
  function sugId(x) { return x.kind + ':' + x.side + ':' + x.word; }
  function renderSuggest() {
    const list = derived.sug;
    $('suggest').innerHTML = !list.length ? '' : '<div class="sug"><b>根据你的手动判断，建议这样改词表</b>' + list.map((x, i) =>
      '<div class="it"><span>' + (x.kind === 'add'
        ? '加入「' + SIDE[x.side] + ' · 强词」：<b>' + esc(x.word) + '</b> —— 你判为' + SIDE[x.side] + '、词表没认出的 ' + x.n + ' 件都含这个词（如「' + esc(x.examples[0].slice(0, 20)) + '」），另一类里没出现过'
        : '移出「' + SIDE[x.side] + ' · ' + WN[x.w] + '」：<b>' + esc(x.word) + '</b> —— 命中的商品里你判为' + SIDE[x.side === 'lab' ? 'personal' : 'lab'] + ' ' + x.wrong + ' 件、' + SIDE[x.side] + ' ' + x.right + ' 件')
      + '</span><button class="linkbtn" data-sug="' + i + '">' + (x.kind === 'add' ? '加入' : '移出') + '</button>'
      + '<button class="linkbtn" data-sug-ignore="' + i + '">忽略</button></div>').join('') + '</div>';
  }
  function applySuggest(i, ignore) {
    const x = derived.sug[i];
    if (!x) return;
    if (ignore) S.prefs.ignored = (S.prefs.ignored || []).concat(sugId(x));
    else {
      const r = JSON.parse(JSON.stringify(rules()));
      if (x.kind === 'add') (r[x.side][2] = r[x.side][2] || []).push(x.word);
      else r[x.side][x.w] = r[x.side][x.w].filter(w => w !== x.word);
      S.rules = r;
    }
    persist(); derive(); render();
    fillRules(rules()); renderSuggest();
    if (!ignore) toast((x.kind === 'add' ? '已加入「' : '已移出「') + x.word + '」，已重新判断');
  }
  function openSettings() {
    $('inv-title').value = S.invoice.title || '';
    $('inv-tax').value = S.invoice.taxId || '';
    $('inv-tpl').value = S.invoice.template || I.DEFAULT_TEMPLATE;
    $('inv-email').value = S.invoice.email || '';
    $('remind-days').value = remindDays();
    const ad = S.prefs.autoDaily || {};
    $('auto-daily').checked = !!ad.on; $('auto-hour').value = ad.hour || 10;
    $('inv-tax-err').textContent = '';
    fillRules(rules());
    renderSuggest();
    $('rules-err').textContent = '';
    $('dlg-settings').showModal();
  }
  function saveRules() {
    const r = { lab: {}, personal: {}, unsure: words($('r-unsure').value) };
    for (const [side, w] of FIELDS) r[side][w] = words($('r-' + side + '-' + w).value);
    if (!r.lab[2].length && !r.lab[1].length) { $('rules-err').textContent = '实验室词表不能是空的'; return; }
    const tax = $('inv-tax').value.trim().toUpperCase();
    if (tax && !I.taxIdOk(tax)) { $('inv-tax-err').textContent = '税号校验不通过，请核对（18 位，最后一位是校验位）'; return; }
    S.invoice = { title: $('inv-title').value.trim(), taxId: tax,
                  template: $('inv-tpl').value.trim() === I.DEFAULT_TEMPLATE ? '' : $('inv-tpl').value.trim(),
                  email: $('inv-email').value.trim() };
    S.prefs.remindDays = Math.max(1, Math.min(60, +$('remind-days').value || 7));
    S.prefs.autoDaily = { on: $('auto-daily').checked, hour: Math.max(0, Math.min(23, +$('auto-hour').value || 10)) };
    if (EXT) chrome.storage.local.set({ autoDaily: S.prefs.autoDaily });
    S.rules = r;
    persist(); derive(); render();
    $('dlg-settings').close(); toast('设置已保存，已重新判断');
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

    const pop = $('menu-export');
    $('btn-export').onclick = e => { e.stopPropagation(); pop.hidden = !pop.hidden; $('btn-export').setAttribute('aria-expanded', String(!pop.hidden)); };
    document.addEventListener('click', () => { pop.hidden = true; $('btn-export').setAttribute('aria-expanded', 'false'); });
    pop.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (!S.orders.length) { toast('还没有导入订单'); return; }
      if (b.dataset.act === 'csv-lab') exportCsv(true);
      if (b.dataset.act === 'csv-all') exportCsv(false);
      if (b.dataset.act === 'project') exportProject();
      if (b.dataset.act === 'csv-inv') { if (EXT) exportInvoiceCsv(); else toast('发票清单要装成 Chrome 扩展才有'); }
    };

    $('inv-tax').oninput = e => { const v = e.target.value.trim(); $('inv-tax-err').textContent = v && !I.taxIdOk(v) ? '校验不通过' : v ? '✓ 校验通过' : ''; };
    $('inv-sync').onclick = () => invJob('sync', INV_URL);
    $('inv-auto').onclick = () => startAuto().catch(e => toast('出错：' + e.message));
    $('inv-vip').onclick = () => startVip().catch(e => toast('出错：' + e.message));
    $('inv-pack-dir').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) openPack(f).catch(err => toast('读发票出错：' + err.message)); };
    $('pack-seq').oninput = () => renderPack();
    $('pack-go').onclick = () => makePack().catch(e => { toast('整理出错：' + e.message); $('pack-go').disabled = false; });
    $('pack-cancel').onclick = () => $('dlg-pack').close();
    $('inv-apply').onclick = startApply;
    $('inv-ask').onclick = () => startAsk().catch(e => toast('出错：' + e.message));
    $('inv-scan').onclick = () => invJob('scan', CHAT_URL);
    $('inv-dl-all').onclick = () => startDownloads(invOrders().map(x => x.o.no), true);
    $('inv-have-dir').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importHaveDir(f).catch(err => toast('读 PDF 出错：' + err.message)); };
    $('inv-check-dir').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) checkDownloadDir(f).catch(err => toast('读 PDF 出错：' + err.message)); };
    $('dup-close').onclick = () => $('dlg-dup').close();
    $('inv-have').onchange = async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        // 两种都认：tools/index-invoices.py 的发票索引；或者已报销的订单号清单 { lab: [...] } / { orders: [...] } / [...]
        const nos = Array.isArray(d) ? d : d && (d.orders || d.lab);
        if (Array.isArray(nos)) {
          S.haveNos = [...new Set((S.haveNos || []).concat(nos.map(String).filter(n => /^\d{15,20}$/.test(n))))];
          persist(); derive(); render();
          toast('已导入 ' + S.haveNos.length + ' 个已报销的订单号，这些单不会再下载、也不会去找卖家');
          return;
        }
        if (!d || d.format !== 'order-triage-invoice-index' || !Array.isArray(d.invoices)) throw new Error('不是发票索引，也不是订单号清单');
        S.haveIdx = d.invoices.filter(x => x && x.date && x.amount != null).map(x => ({ invNo: x.invNo, date: x.date, amount: +x.amount, file: x.file }));
        persist(); derive(); render();
        toast('已导入 ' + S.haveIdx.length + ' 张已整理的发票，对上的订单不会再下载、也不会去找卖家');
      } catch (err) { toast('导入失败：' + err.message); }
    };
    $('list').addEventListener('change', e => { const f = e.target.closest('input[data-inv="attach"]'); if (f && f.files[0]) attachFile(f.dataset.no, f.files[0]); });
    $('img-copy').onclick = copyScraper;
    $('img-older').onchange = e => { S.older = e.target.value || ''; persist(); renderImages(); };
    $('img-open').onclick = () => window.open(TAOBAO, '_blank', 'noopener');
    $('img-close').onclick = () => $('dlg-img').close();
    $('btn-settings').onclick = openSettings;
    $('rules-save').onclick = saveRules;
    $('rules-cancel').onclick = () => $('dlg-settings').close();
    $('rules-reset').onclick = () => fillRules(C.DEFAULT_RULES);
    $('suggest').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.sug) applySuggest(+b.dataset.sug, false);
      else if (b.dataset.sugIgnore) applySuggest(+b.dataset.sugIgnore, true);
    };
    $('data-clear').onclick = () => {
      if (!confirm('清除这个浏览器里保存的全部订单和判断？已导出的文件不受影响。')) return;
      try { localStorage.removeItem(STORE); } catch (e) { /* 忽略 */ }
      if (EXT) chrome.storage.local.clear();
      S = { orders: [], decisions: {}, refunds: {}, rules: null, prefs: S.prefs, invoice: { title: I.DEFAULT_TITLE, taxId: I.DEFAULT_TAX, template: '', email: '' }, invFiles: {}, haveIdx: [] };
      $('dlg-settings').close(); derive(); render();
    };

    const setSince = v => { S.since = v; persist(); derive(); render(); };
    $('remind').addEventListener('click', e => { const go = e.target.closest('[data-goto]'); if (go) goCat(go.dataset.goto); });
    $('summary').addEventListener('click', e => {
      const go = e.target.closest('[data-goto]');
      if (go) { goCat(go.dataset.goto); return; }
      const f = e.target.closest('button[data-flow]');
      if (f) {
        const k = f.dataset.flow;
        if (k === 'import') $('file').click();
        else if (k === 'taobao') window.open(TAOBAO, '_blank', 'noopener');
        else if (k === 'img-dlg') openImages();
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
      if (t.dataset.flow === 'have-dir') { const fs = [...t.files]; t.value = ''; if (fs.length) importHaveDir(fs).catch(err => toast('读 PDF 出错：' + err.message)); }
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
      else if (view.focus && (k === '0' || e.key === 'Backspace')) { e.preventDefault(); setDecision(view.focus, 'auto', { stay: true }); }
    });
  }

  restore();
  if (EXT) {
    document.body.classList.add('is-ext');
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.scraped) mergeFromExt(ch.scraped.newValue);
      if (ch.olderDone) olderFinished(ch.olderDone.newValue);
    });
    chrome.storage.local.get(['scraped', 'olderDone']).then(r => { mergeFromExt(r.scraped); olderFinished(r.olderDone); });
    chrome.storage.local.set({ want: wantList() });
    // 读回同步结果后再写一次 invWant：刚打开时还没读回来，所有单都算「需找卖家」，旺旺要看的店会多出一大堆
    chrome.storage.local.get(['invSync', 'chatScan', 'dlDone', 'askSent', 'vipSent', 'goneNos']).then(r => {
      Object.assign(X, r, { dlDone: r.dlDone || {}, askSent: r.askSent || {}, vipSent: r.vipSent || {}, goneNos: r.goneNos || [] });
      derive();                                       // 「已开过发票」会影响分类，读回来要重算
      chrome.storage.local.set({ invWant: invWant() });
      render();
      checkImages();
      verifyDownloads();
      // 后台每天定时打开的（#auto）：数据读回来后自己跑一次「一键处理发票」
      if (location.hash === '#auto' && S.orders.length) {
        history.replaceState(null, '', location.pathname);
        toast('每天自动处理：开始一键处理发票');
        startAuto().catch(e => toast('自动处理出错：' + e.message));
      }
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      let hit = false;
      for (const k of ['invSync', 'chatScan', 'dlDone', 'askSent', 'vipSent', 'goneNos']) if (ch[k]) { X[k] = ch[k].newValue || (['dlDone', 'askSent', 'vipSent'].includes(k) ? {} : k === 'goneNos' ? [] : null); hit = true; }
      if (ch.applyResult && ch.applyResult.newValue) onApplyResult(ch.applyResult.newValue);
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
