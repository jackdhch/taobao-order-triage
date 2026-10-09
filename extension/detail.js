// 订单详情页（trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=订单号）。天猫店的订单打开这个地址会被淘宝
// 重定向到 trade.tmall.com/detail/orderDetail.htm?biz_order_id=订单号&forward_action=（2026-10-05 实测），manifest 两个地址都匹配；
// 天猫页上同样有 span.ww-light[data-nick] 和 amos…uid= 链接，下面的读法通用。主页按标签页 id 关页面，重定向不影响。
// 主页要联系某单的卖家、却不知道他的旺旺名时（旺旺名和店名常常对不上），打开这单的详情页，读旺旺图标上的名字
// （[data-nick]，或 amos…getcid.aw?…uid=旺旺名；2026-10-04 实测）；顺便看每件商品是不是退款成功了
// （订单状态还是「交易成功」、订单表里看不出来，2026-10-04 实测有一单就是这样）。
// 写进 detailFound 送回主页。
// 只在主页排了这单（nickWant）时才读；读完由主页关掉本页
// 截图（用户 2026-10-09，报销手册：价税合计超过 1000 元要附订单页面和支付记录）：主页逐段发 otShot { y }，这里滚到那个位置、
// 从第二段起把固定在屏幕上的顶栏 / 侧栏藏起来（不然每段截图里都有一份），回报实际滚到哪、可视区多高、整页多高；
// 截图本身由主页 chrome.tabs.captureVisibleTab 截、拼接。另外读出「支付宝交易号」「付款时间」（在订单信息区，会截进图里）
(async () => {
  if (window.top !== window || window.__otDetail) return;
  window.__otDetail = 1;
  const no = (/[?&]biz_order_id=(\d{15,20})/.exec(location.href) || [])[1];
  if (!no) return;
  const { nickWant } = await chrome.storage.local.get('nickWant');
  if (!nickWant || !nickWant[no] || Date.now() - nickWant[no] > 10 * 60000) return;
  let hid = false;
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (!(m && m.type === 'otShot' && m.no === no)) return;
    if (m.y > 0 && !hid) {
      hid = true;
      for (const el of document.querySelectorAll('body *')) { const p = getComputedStyle(el).position; if (p === 'fixed' || p === 'sticky') el.style.setProperty('visibility', 'hidden', 'important'); }
    }
    window.scrollTo(0, m.y || 0);
    setTimeout(() => reply({ y: Math.round(window.scrollY), vh: window.innerHeight, vw: window.innerWidth,
      h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) }), 350);
    return true;
  });
  const read = () => {
    const e = [...document.querySelectorAll('[data-nick]')].find(x => x.getAttribute('data-nick'));
    if (e) return e.getAttribute('data-nick').trim();
    const a = [...document.querySelectorAll('a[href*="amos"][href*="uid="]')][0];
    const m = a && /[?&]uid=([^&]+)/.exec(a.href);
    try { return m ? decodeURIComponent(m[1]).trim() : ''; } catch (err) { return ''; }
  };
  for (let t = 0; t < 20000 && !read(); t += 400) await new Promise(r => setTimeout(r, 400));
  await new Promise(r => setTimeout(r, 800));                 // 商品那一栏比旺旺图标晚一点出来
  const nick = read();
  const txt = document.body.innerText;
  const r = window.Invoice.detailRefund(txt);
  // 支付记录的线索（待真实页面核对写法）：「支付宝交易号：2026…」「付款时间：2026-08-14 10:00:00」
  const flat = txt.replace(/\s+/g, ' ');
  const pay = { alipay: (/支付宝交易号[:：]?\s*(\d{16,32})/.exec(flat) || [])[1] || '', paidAt: (/付款时间[:：]?\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)/.exec(flat) || [])[1] || '' };
  const { detailFound } = await chrome.storage.local.get('detailFound');
  await chrome.storage.local.set({ detailFound: Object.assign({}, detailFound, { [no]: Object.assign({ nick, pay, at: Date.now() }, r) }) });
})().catch(e => console.warn('[订单分拣] 订单详情页', e));
