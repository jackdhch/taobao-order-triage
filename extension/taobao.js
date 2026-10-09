// 淘宝「已买到的宝贝」：只在分拣主页发起「读取订单」时干活（用户 2026-10-07：读取只从主页发起，自己逛淘宝时不出面板）。
// 读到的订单写回扩展存储（scraped），分拣主页会自动合并；淘宝页面自己的存储里不留任何东西。
//
// 主页写 readJob = { at, from }（30 分钟内有效）并打开本页。本页看到有效的 readJob、并向后台领到这份活（同时开着几个订单页时只让一个干），
// 就自动从最新往前翻到 from 那天（上次报销那天的后一天），订单、商品图片、逐件退款一起读；
// 读完报给后台（readDone），后台清掉 readJob、关掉本页（插件开的干活页）、把主页切到前台。
// 没登录时淘宝会先跳到登录页（本脚本不在那里运行），登录后回到本页再接着走这里
const READ_LIFE = 30 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

chrome.storage.local.get(['scraped', 'readJob']).then(async ({ scraped, readJob }) => {
  const job = readJob && readJob.at && Date.now() - readJob.at < READ_LIFE ? readJob : null;
  if (!job || !await chrome.runtime.sendMessage({ type: 'readClaim', at: job.at }).catch(() => false)) return;
  const progress = p => chrome.storage.local.set({ readProgress: Object.assign({ at: job.at, t: Date.now() }, p) });
  orderTriageScraper({ all: true, from: job.from || '' }, {
    initial: scraped || {},
    // 可能同时开着好几个订单页：交给后台排队合并。各页自己「读出 → 合并 → 写回」会互相盖掉（2026-09 离线复现：两页同时抓，15 轮丢了 5 轮）
    sync: (m, replace) => replace ? chrome.storage.local.set({ scraped: m })
      : chrome.runtime.sendMessage({ type: 'scrapedMerge', m }),
    resume: true,
    progress,
    finish: (why, r) => chrome.runtime.sendMessage({ type: 'readDone', at: job.at, why, nos: r.nos, seen: r.seen, pages: r.pages }).catch(() => {}),
  });
  chrome.storage.onChanged.addListener(ch => {
    if (ch.scraped && window.orderTriage) window.orderTriage.adopt(ch.scraped.newValue);   // 主页清空了：内存跟着存储走，别把旧数据写回去
  });
  // 页面是前端慢慢渲染出来的：等订单列表出来再翻（刚从登录页跳回来时尤其慢）。
  // 等了 20 秒还没有订单、页面上也没有登录框，就照常开始（可能这个账号确实没有订单，交给读取结果说明）
  progress({ state: 'login' });
  const t0 = Date.now();
  const loginBox = () => [...document.querySelectorAll('input[type="password"],iframe[src*="login"]')].some(e => e.getBoundingClientRect().width > 0);
  while (!window.orderTriage.count() && !window.orderTriage.needsVerify() && Date.now() - t0 < READ_LIFE) {
    if (Date.now() - t0 > 20000 && !loginBox()) break;
    await sleep(500);
  }
  progress({ state: 'reading', page: 0, stored: 0 });
  window.orderTriage.auto();
});
