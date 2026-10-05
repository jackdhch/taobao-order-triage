/*
 * 淘宝「已买到的宝贝」订单抓取脚本 —— 实验版
 *
 * 用法：在已登录的 https://buyertrade.taobao.com/ 订单列表页，按 F12 打开控制台，
 *       把本文件全部内容粘贴进去回车（Chrome 首次粘贴需要先输入 allow pasting）。
 *       页面右下角会出现一个小面板：抓取本页 / 自动翻页 / 保存 JSON / 清空。
 *
 *       已经导入了订单表的话，更推荐在分拣页点「补图片 → 复制抓取脚本」：复制出来的脚本带着
 *       还缺图的订单号清单，只保存清单里的订单，找齐了、或翻到比清单最早日期还早的页就自动停。
 *
 * 它做什么：
 *   - 只读取你当前页面上已经显示的订单：订单号、时间、店铺、状态、实付、运费，
 *     以及每件商品的标题、规格、单价、数量、商品图地址、退款/售后文字
 *   - 抓到的数据暂存在本页面的 localStorage，点「保存 JSON」下载为本地文件，
 *     再拖进 index.html 与导出表合并
 *
 * 它不做什么：
 *   - 不向任何服务器发送数据，不调用淘宝接口，不读取 cookie
 *   - 遇到滑块/安全验证会立刻停下，请你手动完成后再继续
 *
 * 页面结构没有公开文档，本脚本靠文字特征（「订单号」「实付款」「退款成功」等）定位元素，
 * 淘宝改版后可能需要调整。抓不到时请先用「抓取本页」看控制台输出。
 */
// want = { nos: [订单号...], from: 'YYYY-MM-DD', refresh?: [订单号...], older?: { from, before } }，可省略（省略时抓看到的全部订单）
// refresh：已经抓过、但还没到终态的订单（还没确认收货、有件在退款中），过后还可能退款，要回来再看；6 小时内看过的不再为它翻页
// older：淘宝只能导出最近几个月的订单表，更早的月份从订单页上读 —— before（订单表最早日期）之前、from 当天及以后的订单也存下来
// opts = { initial, sync(m, replace), olderDone(from) }：Chrome 扩展里用，抓到的数据交给扩展存储，不写进淘宝页面自己的 localStorage。
// sync 默认是「合并进去」（可能同时开着几个订单页），replace 为 true 时才整份替换（清空）；
// olderDone：订单表之前的那段翻完了（主页据此清掉「提取到哪天」，以后补图不用再翻回去）
function orderTriageScraper(want, opts) {
  'use strict';
  if (window.orderTriage && window.orderTriage.setWant) {
    if (want) window.orderTriage.setWant(want);
    console.log('[订单分拣] 已经加载过了，面板在右下角' + (want ? '；已换成新的订单号清单' : ''));
    return;
  }

  const KEY = 'orderTriage.scraped.v1';
  const NO_RE = /订单号[:：]?\s*(\d{15,20})/;
  const NO_RE_G = /订单号[:：]?\s*(\d{15,20})/g;
  const STATUS = ['交易成功', '交易关闭', '卖家已发货', '买家已付款', '等待买家付款', '等待卖家发货',
                  '等待买家确认收货', '已发货', '待收货', '待发货', '交易完成'];   // 不放「退款成功」这类逐件退款词：旧版页面上它们排在状态栏前面，会被当成整单状态
  // 长的写法放前面：同一位置先试前面的，「退货退款成功」不能被截成「退货退款」（截了 refundState 就认不出来）
  const REFUND_RE = /(退货退款成功|退货退款中|仅退款成功|仅退款中|退款成功|退款中|已退款|退款关闭|售后中|售后成功|退货退款|仅退款|退款完成|待商家处理|待买家退货)/;
  const JUNK_RE = /^(加入购物车|申请售后|再买一单|查看物流|追加评价|手机订单|申请开票|订单详情|确认收货|延长收货|删除订单|联系卖家|和我联系|退货宝|假一赔四|极速退款|该订单使用|采购订单|\[交易快照\]|交易快照|运费险|7天|不支持)/;

  let W = null;                                     // 订单号清单；null 表示抓全部
  function setWant(w) {
    // 空清单 = 订单表里的都有图了，仍然只认清单；只有 null（没有订单表）才抓看到的全部订单
    const rf = new Set(((w && w.refresh) || []).map(String));
    W = w && Array.isArray(w.nos) ? { set: new Set([...w.nos.map(String), ...rf]), nos: new Set(w.nos.map(String)), imgN: w.nos.length, refresh: rf, from: w.from || '', older: w.older && w.older.from && w.older.before ? w.older : null } : null;
    if (panel) render();
  }
  const fresh = o => o && Date.now() - new Date(o.scrapedAt || 0).getTime() < 6 * 3600e3;
  const missing = () => { if (!W) return []; const s = load(); return [...W.set].filter(no => !s[no] || (W.refresh.has(no) && !fresh(s[no]))); };
  const isOlder = day => !!(W && W.older && day && day >= W.older.from && day < W.older.before);
  const olderCount = () => Object.values(load()).filter(o => isOlder((o.time || '').slice(0, 10))).length;
  let pageNewest = '';                              // 本页最新的订单日期，用来判断是否已翻过清单范围

  opts = opts || {};
  const ext = typeof opts.sync === 'function';
  let mem = ext ? (opts.initial || {}) : null;
  const load = () => {
    if (ext) return mem;
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
  };
  const save = m => {
    if (ext) { mem = m; return opts.sync(m); }
    try { localStorage.setItem(KEY, JSON.stringify(m)); } catch (e) { console.warn('[订单分拣] 暂存失败（页面存储满了？）', e); }
  };
  const text = el => ((el && (el.innerText || el.textContent)) || '').replace(/[ \t ]+/g, ' ').trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const money = s => { const m = /([\d,]+\.\d{1,2})/.exec(s || ''); return m ? +m[1].replace(/,/g, '') : null; };

  function imgSrc(i) {
    return i.currentSrc || i.getAttribute('data-src') || i.getAttribute('data-ks-lazyload') || i.src || '';
  }
  const isProductImg = i => {
    const src = imgSrc(i);
    if (!/alicdn|taobaocdn|tbcdn|aliimg|tmall/i.test(src)) return false;
    const w = i.getBoundingClientRect().width || i.width || +i.getAttribute('width') || 0;
    return w >= 48;                                  // 过滤掉店铺小图标、旺旺图标
  };

  // 找每个订单的整块容器：从「订单号」文字往上爬，直到再往上就会包含第二个订单号
  function orderBlocks() {
    const heads = [...document.querySelectorAll('body *')].filter(el =>
      el.childElementCount <= 8 && el.textContent.length < 240 && NO_RE.test(el.textContent));
    const minimal = heads.filter(h => !heads.some(o => o !== h && h.contains(o)));
    const seen = new Set(), out = [];
    for (const h of minimal) {
      const no = h.textContent.match(NO_RE)[1];
      if (seen.has(no)) continue;
      let el = h, best = null;
      while (el && el !== document.body) {
        const nos = new Set([...el.textContent.matchAll(NO_RE_G)].map(m => m[1]));
        if (nos.size > 1) break;
        if ([...el.querySelectorAll('img')].some(isProductImg)) best = el;
        el = el.parentElement;
      }
      if (best) { seen.add(no); out.push({ no, el: best, head: h }); }
    }
    return out;
  }

  // 订单里的每件商品：从商品图往上爬到「只含这一张商品图」的最大容器
  function itemRows(block, head) {
    const imgs = [...block.querySelectorAll('img')].filter(isProductImg);
    return imgs.map(img => {
      let row = img;
      while (row.parentElement && row.parentElement !== block) {
        const p = row.parentElement;
        if (p.contains(head)) break;
        if ([...p.querySelectorAll('img')].filter(i => imgs.includes(i)).length > 1) break;
        row = p;
      }
      return { img, row };
    });
  }

  function parseItem({ img, row }) {
    const links = [...row.querySelectorAll('a')].filter(a => text(a).length >= 6 && !JUNK_RE.test(text(a)));
    const titleA = links.sort((a, b) => text(b).length - text(a).length)[0];
    const lines = text(row).split('\n').map(s => s.trim()).filter(Boolean);
    let title = titleA ? text(titleA) : (lines.find(l => l.length >= 8 && !/[¥￥]/.test(l)) || '');
    const stripSnap = s => s.replace(/\s*\[?交易快照\]?\s*$/, '').trim();
    title = stripSnap(title);
    const sku = lines.map(stripSnap).find(l => l && l !== title && !l.includes(title)
                  && !(title.includes(l) && l.length > title.length * 0.6)
                  && l.length <= 60 && !/[¥￥]/.test(l) && !JUNK_RE.test(l) && !/^[x×]\s*\d+$/.test(l)
                  && !REFUND_RE.test(l) && !/实付款|含运费/.test(l)) || '';
    const rowText = text(row);
    const price = money((rowText.match(/[¥￥]\s*[\d,]+\.\d{1,2}/) || [''])[0]);
    const qty = +((/(?:^|\s)[x×]\s*(\d+)/.exec(rowText) || [])[1] || 1);
    const refund = (REFUND_RE.exec(rowText) || [])[1] || '';
    let src = imgSrc(img);
    if (src.startsWith('//')) src = 'https:' + src;
    return { title, sku, price, qty, img: src, refund, link: titleA ? titleA.href : '' };
  }

  function parseOrder({ no, el, head }) {
    const t = text(el);
    const date = (/(\d{4}-\d{2}-\d{2}(?:\s\d{2}:\d{2}(?::\d{2})?)?)/.exec(t) || [])[1] || '';
    let status = '', pos = Infinity;
    for (const s of STATUS) { const i = t.indexOf(s); if (i >= 0 && i < pos) { pos = i; status = s; } }
    const rows = itemRows(el, head);
    const rowEls = rows.map(r => r.row);
    const shopA = [...el.querySelectorAll('a')].find(a =>
      /store\.taobao\.com|shop\d*\.taobao\.com|\.tmall\.com(?!\/item)|\.taobao\.com\/shop/i.test(a.href)
      && !rowEls.some(r => r.contains(a)) && text(a).length >= 2 && text(a).length <= 40);
    const pay = money((/实付款\s*[¥￥]\s*[\d,]+\.\d{1,2}/.exec(t) || [''])[0]);
    const ship = money((/含运费[:：]?\s*[¥￥]\s*[\d,]+\.\d{1,2}/.exec(t) || [''])[0]);
    return { no, time: date, status, shop: shopA ? text(shopA) : '', nick: nickOf(el), pay, ship, lines: rows.map(parseItem) };
  }

  // 新版「已买到的宝贝」（2026-09 在真实页面上核对过）：每单一个 #shopOrderContainer_订单号；
  // 商品图是链接的内联背景图，不是 <img>；价格拆成「￥」「8」「.」「27」几段；单里还夹着「常买常逛」推荐栏。
  // class 名后缀是打包时生成的（如 title--pLEC2yiw），会随淘宝发版变，所以只按前缀匹配
  const BOX_ID = 'shopOrderContainer_';
  const SERVICE_RE = /价保|无理由|假一赔|极速退款|退货宝|运费险|先用后付|包退|包换|破损|必赔|正品/;
  const isService = t => t.split(/\s+/).every(w => SERVICE_RE.test(w));     // 「15天价保 假一赔四」是服务说明，不是规格
  const priceOf = el => {
    const m = el && /[¥￥]([\d,]+(?:\.\d+)?)/.exec(el.textContent.replace(/\s+/g, ''));
    return m ? +m[1].replace(/,/g, '') : null;
  };
  const bgUrl = el => {
    const m = el && /url\(["']?([^"')]+)/.exec(el.style.backgroundImage || getComputedStyle(el).backgroundImage || '');
    if (!m) return '';
    const bad = /\/imgextra\/\/((?:gw|img)\.alicdn\.com\/.*)$/.exec(m[1]);      // 订单页偶尔给出拼坏的地址
    if (bad) return 'https://' + bad[1];
    return m[1].startsWith('//') ? 'https:' + m[1] : m[1];
  };
  // 卖家旺旺名：旺旺里的会话名、聊天页地址用的是它，常常和店名对不上（个人卖家多是自己的名字，2026-10 实测：有家店的会话名是卖家本人的名字）。
  // 订单头上的旺旺图标带 data-nick，旁边的链接是 amos.alicdn.com/getcid.aw?…&uid=旺旺名
  function nickOf(box) {
    const d = box.querySelector('[data-nick]');
    if (d && d.getAttribute('data-nick')) return d.getAttribute('data-nick').trim();
    const a = [...box.querySelectorAll('a[href*="uid="]')].find(x => /amos|\/app\/im\//.test(x.href));
    const m = a && /[?&]uid=([^&]+)/.exec(a.getAttribute('href'));
    if (!m) return '';
    try { return decodeURIComponent(m[1]).replace(/^cntaobao/, '').trim(); } catch (e) { return ''; }
  }
  function parseBox(box) {
    const pick = sel => text(box.querySelector(sel));
    const payField = re => priceOf([...box.querySelectorAll('[class*="payment--"] .trade-price-container')].find(c => re.test(c.textContent)));
    const lines = [...box.querySelectorAll('.trade-bought-list-order-info')].filter(r => !r.closest('[class*="extBlank"]')).map(row => {
      const imgA = row.querySelector('a[class*="image--"]');
      const titleA = row.querySelector('a[class*="title--"]');
      const infos = [...row.querySelectorAll('[class*="content--"] > [class*="info--"]')].map(text).filter(Boolean);
      const priceCol = row.querySelector('[class*="itemInfoColPrice"]');
      return {
        title: text(row.querySelector('[class*="titleText"]')) || text(titleA).replace(/\s*\[?交易快照\]?\s*$/, ''),
        sku: infos.length > 1 ? infos[0] : infos[0] && !isService(infos[0]) ? infos[0] : '',   // 有两行时第一行就是规格
        price: priceOf(priceCol && priceCol.querySelector('.trade-price-container')),   // 第一个是成交价，第二个是划线原价
        qty: +((/[x×]\s*(\d+)/.exec(text(row.querySelector('[class*="quantity--"]'))) || [])[1] || 1),
        img: bgUrl(imgA),
        refund: text(row.querySelector('[class*="refundStatus"]')) || (REFUND_RE.exec(text(priceCol)) || [])[1] || '',
        link: [titleA, imgA].map(a => a && a.getAttribute('href') ? a.href : '').find(Boolean) || '',   // 空 href 会被补成当前页地址
      };
    });
    // 操作栏里的开票按钮：「申请开票」= 能在淘宝平台开票；「查看发票」= 已经开过；没有 = 多半是个人卖家，要发消息要
    const inv = [...box.querySelectorAll('[class*="operations--"] .trade-button')].map(text).find(t => /开票|发票/.test(t)) || '';
    return { no: box.id.slice(BOX_ID.length), time: pick('[class*="shopInfoOrderTime"]'), status: pick('[class*="shopInfoStatus"]'),
             shop: pick('a[class*="shopInfoName"]'), nick: nickOf(box), pay: payField(/实付款/), ship: payField(/运费/), inv, lines };
  }
  // 能认出新版结构就精确解析；认不出（旧版页面、以后改版）再退回按文字特征猜
  function pageOrders() {
    const boxes = [...document.querySelectorAll('[id^="' + BOX_ID + '"]')].filter(b => /^\d{15,20}$/.test(b.id.slice(BOX_ID.length)));
    if (boxes.length) return boxes.map(el => ({ no: el.id.slice(BOX_ID.length), parse: () => parseBox(el) }));
    return orderBlocks().map(b => ({ no: b.no, parse: () => parseOrder(b) }));
  }

  // 懒加载图片：先把页面从上到下滚一遍
  async function scrollThrough() {
    const y0 = window.scrollY, step = Math.max(400, window.innerHeight * 0.8);
    // 页面底部「猜你喜欢」越滚越长，终点只算到最后一单下面；认不出订单块的旧版页面封顶 3 万像素
    const end = () => {
      const b = document.querySelectorAll('[id^="' + BOX_ID + '"]');
      return b.length ? b[b.length - 1].getBoundingClientRect().bottom + window.scrollY : Math.min(document.body.scrollHeight, 30000);
    };
    for (let y = 0; y < end(); y += step) { window.scrollTo(0, y); await sleep(160); }
    window.scrollTo(0, y0);
    await sleep(300);
  }

  function needsVerify() {
    if (/punish|captcha|_____tmd_____/i.test(location.href)) return true;
    if (document.querySelector('iframe[src*="captcha"],iframe[src*="punish"],#nc_1_wrapper,.nc-container,#baxia-dialog-content,[id^="baxia-dialog"]')) return true;
    const dlgText = [...document.querySelectorAll('[role=dialog],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]')]
      .filter(e => e.getBoundingClientRect().width > 0).map(e => e.innerText).join(' ');
    if (/拖动.{0,6}滑块|滑动验证|安全验证|请完成验证/.test(dlgText)) return true;
    if (pageOrders().length) return false;             // 订单列表好好显示着；商品标题里本来就可能有「滑块」「验证码」
    return /滑块|拖动.{0,6}验证|安全验证|请完成验证|验证码/.test(document.body.innerText.slice(0, 6000));
  }

  // 分拣主页看图时不带淘宝的 Referer：有的 _200x200 小图这样只拿到一张 1×1 灰点（订单页上却正常，2026-10 实测几件商品是这样）。
  // 存之前按主页的方式试一遍，坏了换 _.webp、原图；都不行就不存地址、记下 imgBad，面板和主页都标红
  const tryImg = u => new Promise(ok => {
    const i = new Image(); i.referrerPolicy = 'no-referrer';
    const t = setTimeout(() => ok(false), 8000);
    i.onload = () => { clearTimeout(t); ok(i.naturalWidth > 1); };
    i.onerror = () => { clearTimeout(t); ok(false); };
    i.src = u;
  });
  const imgOk = new Map();
  async function goodImg(u) {
    if (!u) return '';
    const b = u.replace(/(\.(?:jpe?g|png|gif|webp))_[^/]*$/i, '$1');
    for (const v of new Set([u, b + '_.webp', b])) {
      if (!imgOk.has(v)) imgOk.set(v, tryImg(v));
      if (await imgOk.get(v)) return v;
    }
    return '';
  }
  async function checkImgs(o) {
    await Promise.all(o.lines.map(async l => {
      const g = await goodImg(l.img);
      if (!g && l.img) l.imgBad = l.img;
      l.img = g;
    }));
  }
  // 清单里已经找到、但有图打不开的单
  const badImgs = () => { if (!W) return 0; const s = load(); return [...W.set].filter(no => s[no] && s[no].lines.some(l => l.imgBad)).length; };

  async function grab(quiet) {
    if (needsVerify()) { if (!quiet) alert('页面出现了安全验证，请手动完成后再继续。'); return -1; }   // 自动翻页时由 auto 统一提示
    await scrollThrough();
    const blocks = pageOrders();
    seen += blocks.length;
    const store = load();
    let n = 0;
    pageNewest = '';
    for (const b of blocks) {
      try {
        const o = b.parse();
        if (o.time.slice(0, 10) > pageNewest) pageNewest = o.time.slice(0, 10);
        if (!o.lines.length || (W && !W.set.has(o.no) && !isOlder(o.time.slice(0, 10)))) continue;
        await checkImgs(o);
        store[o.no] = Object.assign(o, { scrapedAt: new Date().toISOString() });
        n++;
      } catch (e) { console.warn('[订单分拣] 解析失败', b.no, e); }
    }
    await save(store);                                // 等存进去：翻完后的「提取完了」信号不能跑到最后一页数据前面
    if (!quiet) {
      console.log('[订单分拣] 本页抓到 ' + n + ' 单，累计 ' + Object.keys(store).length + ' 单。示例：', Object.values(store).slice(-1)[0]);
      if (W) console.log('[订单分拣] 清单还差 ' + missing().length + ' 单');
      if (!n && !W) console.warn('[订单分拣] 本页一单都没认出来 —— 可能是页面结构变了，请把这句话和页面截图发给维护者');
    }
    render();
    return n;
  }

  function nextButton() {
    const c = [...document.querySelectorAll('button,a,li,span,div')].filter(e => /^下一页/.test(text(e)) && text(e).length <= 6);
    const b = c.filter(x => !c.some(o => o !== x && x.contains(o)))[0];
    if (!b) return null;
    const off = b.disabled || /disabled/i.test(b.className) || b.getAttribute('aria-disabled') === 'true'
             || (b.closest('[class*="disabled"]') !== null);
    return off ? null : b;
  }

  // runId：每次开始自动翻页换一个号，点「停止」也换号。旧循环看到号变了就退出，
  // 不会出现「停止后马上再点开始」两个循环同时翻页
  let running = false, runId = 0, seen = 0;
  const pageKey = () => pageOrders().map(b => b.no).join(',');
  // 点了翻页之后等列表换掉；返回 'ok' | 'verify' | 'same'
  async function waitChange(before) {
    for (let i = 0; i < 60; i++) {                     // 最多等 18 秒
      await sleep(300);
      if (needsVerify()) return 'verify';
      const k = pageKey();
      if (k && k !== before) return 'ok';            // 有的页面翻页时先清空列表再慢慢出新页：空的不算翻好（不然会当成最后一页）
    }
    return 'same';
  }
  // 从当前页一直往后翻；返回停下的原因
  async function walk(maxPages, id) {
    for (let p = 0; p < maxPages; p++) {
      if (id !== runId) return 'stopped';
      const got = await grab(true);
      if (id !== runId) return 'stopped';
      if (got < 0) return 'verify';
      if (W && !W.older && !missing().length) { console.log('[订单分拣] 清单里的订单全部找齐了'); return 'done'; }
      const stopAt = W && (W.older ? W.older.from : W.from);   // 要订单表之前的订单时，翻到那天为止
      if (stopAt && pageNewest && pageNewest < stopAt) {    // 列表从新到旧，再往后只会更早
        console.log('[订单分拣] 本页已早于 ' + stopAt + '，停止');
        return 'past';
      }
      const btn = nextButton();
      if (!btn) { console.log('[订单分拣] 没有下一页了'); return 'end'; }
      const before = pageKey();
      btn.click();
      const r = await waitChange(before);
      if (r === 'verify') return 'verify';
      if (r === 'same') { console.warn('[订单分拣] 翻页后订单没变化，停止'); return 'stuck'; }
      await sleep(2500 + Math.random() * 2500);        // 放慢节奏，别给服务器添压力
    }
    return 'max';
  }
  async function auto(maxPages) {
    const id = ++runId;
    running = true; seen = 0; render();
    try {
      const why = await walk(maxPages || (W && W.older ? 300 : 50), id);
      if (id !== runId) return;
      if (why === 'verify') alert('页面出现了安全验证，请手动完成后再点「开始补图片」继续。');
      else if (!seen) console.warn('[订单分拣] 翻过的页一单都没认出来 —— 可能是淘宝改版了，请把这句话和页面截图发给维护者');
      // 实测漏掉的都是用户自己删掉的订单（删掉的连按订单号都搜不到），所以不再换列表重翻
      else if (W && missing().length) {
        console.log('[订单分拣] 翻完了，还差 ' + missing().length + ' 单没在订单列表里出现（多半是已删除的订单）：', missing());
        // 翻完整个列表都没出现的：用户删进回收站的订单（没有交易争议），主页不再为它要发票
        if (why !== 'verify' && opts.gone) opts.gone(missing().filter(no => !W.refresh.has(no)));
      }
      if (W && W.older && seen && (why === 'past' || why === 'end') && opts.olderDone) await opts.olderDone(W.older.from);
    } finally { if (id === runId) { running = false; render(); } }
  }

  function download() {
    const orders = Object.values(load());
    if (!orders.length) { alert('还没有抓到任何订单'); return; }
    const payload = { format: 'order-triage-scrape', version: 1, source: location.host,
                      scrapedAt: new Date().toISOString(), orders };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' }));
    a.download = 'taobao-orders-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function clear() {
    if (confirm('清空暂存的抓取数据？（已下载的 JSON 文件、分拣页里已补上的图片都不受影响）')) {
      if (ext) { mem = {}; opts.sync({}, true); } else localStorage.removeItem(KEY);
      render();
    }
  }

  // —— 右下角小面板 ——
  let panel = null;
  setWant(want);
  panel = document.createElement('div');
  panel.setAttribute('style', 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;color:#1f2a2e;'
    + 'border:1px solid #cfd6d3;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:12px 14px;'
    + 'font:13px/1.5 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;width:230px');
  document.body.appendChild(panel);
  let mini = false;                                    // 收起成一个小条，免得挡住淘宝页右下角的按钮
  function render() {
    const n = Object.keys(load()).length, left = missing().length, bad = badImgs();
    const leftImg = () => missing().filter(no => W && W.nos.has(no)).length;
    if (mini) {
      panel.innerHTML = '<button data-ot="mini" style="font:inherit;font-weight:600;border:0;background:none;cursor:pointer;color:#1c6e8c;padding:0">订单分拣' + (running ? ' · 补图中…' : '') + ' ▴</button>';
      return;
    }
    const status = !W ? '已暂存 <b style="color:#1c6e8c">' + n + '</b> 单'
      // 「还差」分开说：缺图的，和近期订单要回看退款的（图早就有了，只是退款可能还会变；2026-10-05 用户看到「清单还差 27 单」以为是缺图）
      : left && leftImg() ? '已找到 ' + n + ' 单，清单还差 <b style="color:#1c6e8c">' + leftImg() + '</b> 单' + (left > leftImg() ? '；另有 ' + (left - leftImg()) + ' 单近期订单要回看退款' : '')
      : left ? '图片都补齐了；还有 <b style="color:#1c6e8c">' + left + '</b> 单近期订单要回看退款状态（点「开始补图片」会顺便看）'
      : bad ? '清单里的单都找到了，但 <b style="color:#d0021b">' + bad + ' 单有图片打不开</b>（淘宝那边的图坏了，主页上标了红色 ERROR，<b style="color:#d0021b">图片没补完</b>）'
      : !W.imgN ? '订单表里的订单<b style="color:#1c6e8c">都已有图</b>'
      : '清单 ' + W.set.size + ' 单<b style="color:#1c6e8c">全部找齐</b>' + (ext ? '，已送回分拣主页' : '，请保存 JSON');
    const older = W && W.older ? '<br>订单表之前（' + W.older.from + ' 起）：已提取 <b style="color:#1c6e8c">' + olderCount() + '</b> 单' : '';
    const note = ext ? (W ? '找到的图片会自动出现在分拣主页，' : '分拣主页还没有订单表，会提取看到的全部订单，') : '数据';
    // 扩展里只需要一个大按钮；控制台用法保留原来的四个按钮
    panel.innerHTML = '<div style="font-weight:600;margin-bottom:4px;display:flex;justify-content:space-between">订单分拣 · ' + (ext ? '补图片' : '抓取')
      + '<button data-ot="mini" title="收起" style="font:inherit;border:0;background:none;cursor:pointer;color:#66727a;padding:0 2px">—</button></div>'
      + '<div style="color:#66727a;font-size:12px;margin-bottom:10px">' + status + older
      + (running ? ' · 自动翻页中…' : '') + '</div>'
      + (ext ? btn('auto', running ? '停止' : '开始补图片', true, 'width:100%;padding:9px 0;font-weight:600') + '<div>'
             : '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">'
             + btn('grab', '抓取本页') + btn('auto', running ? '停止' : '自动翻页') + btn('dl', '保存 JSON', true) + btn('clr', '清空'))
      + '</div><div style="color:#8a949a;font-size:11px;margin-top:8px">' + note + '只在本机，不上传。</div>';
  }
  function btn(id, label, primary, extra) {
    return '<button data-ot="' + id + '" style="font:inherit;padding:6px 0;border-radius:6px;border:1px solid #cfd6d3;'
      + 'background:' + (primary ? '#1c6e8c;color:#fff;border-color:#1c6e8c' : '#f5f6f4') + ';cursor:pointer;' + (extra || '') + '">' + label + '</button>';
  }
  panel.addEventListener('click', e => {
    const id = e.target && e.target.getAttribute('data-ot');
    if (id === 'grab') grab();
    else if (id === 'auto') { if (running) window.orderTriage.stop(); else auto(); }
    else if (id === 'dl') download();
    else if (id === 'clr') clear();
    else if (id === 'mini') { mini = !mini; panel.style.width = mini ? 'auto' : '230px'; panel.style.padding = mini ? '7px 12px' : '12px 14px'; render(); }
  });
  render();

  window.orderTriage = { __v: 2, grab, auto, download, clear, setWant, missing,
                         adopt: m => { if (ext) mem = m || {}; render(); },   // 扩展存储被别处改了（别的订单页、主页清空）
                         peek: () => Object.values(load()), stop: () => { running = false; runId++; render(); } };
  console.log('[订单分拣] 已加载' + (W ? '，清单 ' + W.set.size + ' 单' : '') + '。右下角面板可用；也可以在控制台用 orderTriage.grab() / .auto(页数) / .download() / .missing()');
}

// 直接粘贴进控制台时立即运行。分拣页（<script data-no-run>，只借函数生成「带清单的脚本」）
// 和 Chrome 扩展（由 extension/taobao.js 带着清单调用）里不在这里运行
if (typeof document !== 'undefined'
    && !(document.currentScript && document.currentScript.hasAttribute('data-no-run'))
    && !(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)) orderTriageScraper();
