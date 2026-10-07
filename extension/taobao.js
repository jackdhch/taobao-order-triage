// 淘宝订单页：拿分拣主页留下的缺图清单出面板；抓到的订单写回扩展存储，分拣主页会自动合并。
// 淘宝页面自己的存储里不留任何东西。
//
// 「从淘宝读取订单」（用户 2026-10-07）：主页写 readJob = { at, until }（30 分钟内有效）并打开本页。本页看到有效的 readJob、
// 并向后台领到这份活（同时开着几个订单页时只让一个干），就不等用户点按钮，自动从最新往前翻到 until 那天（空 = 全部），
// 订单、商品图片、逐件退款一起读；读完报给后台（readDone），后台清掉 readJob、关掉本页（插件开的干活页）、把主页切到前台。
// 没登录时淘宝会先跳到登录页（本脚本不在那里运行），登录后回到本页再接着走这里
const READ_LIFE = 30 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let reading = false;

chrome.storage.local.get(['want', 'scraped', 'readJob']).then(async ({ want, scraped, readJob }) => {
  const job = readJob && readJob.at && Date.now() - readJob.at < READ_LIFE ? readJob : null;
  const mine = job ? await chrome.runtime.sendMessage({ type: 'readClaim', at: job.at }).catch(() => false) : false;
  reading = !!mine;
  const progress = p => chrome.storage.local.set({ readProgress: Object.assign({ at: job.at, t: Date.now() }, p) });
  orderTriageScraper(reading ? { all: true, from: job.until || '' } : want, Object.assign({
    initial: scraped || {},
    // 可能同时开着好几个订单页：交给后台排队合并。各页自己「读出 → 合并 → 写回」会互相盖掉（2026-09 离线复现：两页同时抓，15 轮丢了 5 轮）
    sync: (m, replace) => replace ? chrome.storage.local.set({ scraped: m })
      : chrome.runtime.sendMessage({ type: 'scrapedMerge', m }),
    olderDone: from => chrome.storage.local.set({ olderDone: { from, at: Date.now() } }),
    gone: nos => chrome.storage.local.set({ goneNos: nos }),
  }, reading ? {
    resume: true,
    progress,
    finish: (why, r) => { reading = false; return chrome.runtime.sendMessage({ type: 'readDone', at: job.at, why, nos: r.nos, pages: r.pages }).catch(() => {}); },
  } : {}));
  if (!reading) return;
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
chrome.storage.onChanged.addListener(ch => {
  if (!window.orderTriage) return;
  // 主页才导入订单表 / 清单变短。读取订单期间主页一边合并一边改清单，不能把「全部读取」换掉
  if (ch.want && !reading) window.orderTriage.setWant(ch.want.newValue);
  if (ch.scraped) window.orderTriage.adopt(ch.scraped.newValue);   // 别的订单页抓到的、或主页清空了：内存跟着存储走，别把旧数据写回去
});
