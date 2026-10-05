// 淘宝订单页：拿分拣主页留下的缺图清单出面板；抓到的订单写回扩展存储，分拣主页会自动合并。
// 淘宝页面自己的存储里不留任何东西。
chrome.storage.local.get(['want', 'scraped']).then(({ want, scraped }) => {
  orderTriageScraper(want, {
    initial: scraped || {},
    // 可能同时开着好几个订单页：交给后台排队合并。各页自己「读出 → 合并 → 写回」会互相盖掉（2026-09 离线复现：两页同时抓，15 轮丢了 5 轮）
    sync: (m, replace) => replace ? chrome.storage.local.set({ scraped: m })
      : chrome.runtime.sendMessage({ type: 'scrapedMerge', m }),
    olderDone: from => chrome.storage.local.set({ olderDone: { from, at: Date.now() } }),
    gone: nos => chrome.storage.local.set({ goneNos: nos }),
  });
});
chrome.storage.onChanged.addListener(ch => {
  if (!window.orderTriage) return;
  if (ch.want) window.orderTriage.setWant(ch.want.newValue);       // 淘宝页开着时，主页才导入订单表 / 清单变短
  if (ch.scraped) window.orderTriage.adopt(ch.scraped.newValue);   // 别的订单页抓到的、或主页清空了：内存跟着存储走，别把旧数据写回去
});
