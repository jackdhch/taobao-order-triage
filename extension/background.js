// 点工具栏上的扩展图标：打开分拣主页
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }));

// ── 发票下载改名 ──
// 页面脚本点「下载到本地 / 下载文件」之前先发来 job = { no, saveAs, kind, file }。
// Chrome 决定文件名时按「文件名」对号，对上了才改成「订单分拣-发票/日期_金额_店铺_订单号.pdf」，完成后记进 dlDone：
//   - 平台（全部发票）：淘宝给的文件名是「抬头_订单号.pdf」，看里面有没有这单的订单号
//   - 旺旺：聊天里卖家发的文件名事先知道，要一模一样
// 对不上的下载（点了却没下成、用户自己下的别的东西、同时下的另一单）一律不动，免得把发票记到别的订单上。
// 后台随时可能被浏览器休眠，待改名清单和进行中的下载都放一份在 session 存储里
const INVOICE_EXT = /\.(pdf|ofd|xml|zip)$/i;
let expect = [], pending = {};
// 读失败也要放行（2026-09 真实窗口：这里报「No SW」后 ready 一直是失败状态，所有等它的消息都不回话，下载全卡住）
const ready = chrome.storage.session.get(['expect', 'pending'])
  .then(r => { expect = (r.expect || []).concat(expect); pending = Object.assign(r.pending || {}, pending); }, e => console.warn('[订单分拣] 读暂存失败', e));
const keep = () => chrome.storage.session.set({ expect, pending }).catch(e => console.warn('[订单分拣] 写暂存失败', e));

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m && m.type === 'expectDownload' && m.job) {
    ready.then(() => { expect.push(Object.assign({}, m.job, { at: Date.now(), tab: sender.tab && sender.tab.id })); keep(); reply(true); });
    return true;
  }
});

// 有的发票点「下载到本地」不下载，而是新开一个标签页直接显示 PDF（einvoice-file.oss-cn-*.aliyuncs.com/…pdf，2026-09 实测）。
// 是我们刚点的那个「全部发票」页开出来的 PDF 标签页：用下载管理按订单改好名存下，再把这个标签页关掉。
// 这要看得到那个标签页的地址，所以 manifest 的 host_permissions 里只加了这两个发票网站
const PDF_TAB = /^https:\/\/([\w-]+\.)*(aliyuncs\.com|invoice-ua\.taobao\.com)\/.+\.(pdf|ofd)(\?|$)/i;
const PDF_HOST = /^https:\/\/([\w-]+\.)*(aliyuncs\.com|invoice-ua\.taobao\.com)\//i;
const byUs = {};                                               // 下载 id → job（我们自己发起的下载，不走上面的改名）
// 本扩展自己发起的下载也会经过 onDeterminingFilename，不给名字 Chrome 就用网站给的原名（会丢掉 downloads.download 里写的名字）。
// 所以发起前先记下「这个地址存成什么名字」，在那里按地址填回去
const ownName = {};
async function saveUrl(j, url) {
  if (!PDF_HOST.test(url)) return;
  const i = expect.findIndex(e => e.kind === 'platform' && e.no === j.no);
  if (i >= 0) { expect.splice(i, 1); keep(); }
  const ext = (/\.(pdf|ofd)(\?|$)/i.exec(url) || [, 'pdf'])[1].toLowerCase();
  const name = j.saveAs.replace(/\.\w+$/, '') + '.' + ext;
  ownName[url] = name;
  const id = await chrome.downloads.download({ url, filename: '订单分拣-发票/' + name, conflictAction: 'uniquify' });
  byUs[id] = pending[id] = Object.assign({}, j, { name }); keep();
}
// 发票页、旺旺页做完的下载活统一交给这里删：两个页面各自「读出清单 → 删掉自己的 → 写回」会互相盖掉（2026-09 实测，导致重复下载）
let jobsChain = Promise.resolve();
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!(m && m.type === 'jobsDone' && Array.isArray(m.ids))) return;
  jobsChain = jobsChain.then(async () => {
    const cur = (await chrome.storage.local.get('dlJobs')).dlJobs || [];
    const left = cur.filter(j => !m.ids.includes(j.id));
    await chrome.storage.local.set({ dlJobs: left });
    // 主页「全部下载」两种都有时只先开了全部发票页（淘宝页面在后台标签里不干活）：它下完平台票，这里再开旺旺页下卖家发的文件
    if (/\/my_itaobao\/invoice/.test((sender && sender.url) || '')) {
      const { chatAfter, invJobs } = await chrome.storage.local.get(['chatAfter', 'invJobs']);
      if (chatAfter) {
        await chrome.storage.local.remove('chatAfter');
        if (Date.now() - chatAfter < 2 * 3600e3 && left.some(j => j.kind === 'chat')) {
          await chrome.storage.local.set({ invJobs: Object.assign({}, invJobs, { chatDownload: Date.now() }) });
          await chrome.tabs.create({ url: 'https://market.m.taobao.com/app/im/chat/index.html' });
        }
      }
    }
  }).then(() => reply(true), e => reply(String(e)));
  return true;
});

// ── 插件自己开出来干活的标签页（workTabs，按 tab.id 记在 session 存储里）：活干完（或停下）后页面发 closeMe，只关这些页。
// 用户自己点开的页面（点商品名、状态标签、旺旺图标）不记，也就不会被关；旺旺聊天页始终只复用一个，不算干活页（用户 2026-10-05：标签页太多）
let workChain = Promise.resolve();
const workTabs = fn => (workChain = workChain.then(async () => {
  const { workTabs: ids = [] } = await chrome.storage.session.get('workTabs');
  const next = fn(ids.slice());
  if (next) await chrome.storage.session.set({ workTabs: next });
  return ids;
}));
const trackTab = id => workTabs(ids => ids.includes(id) ? null : ids.concat(id));
chrome.tabs.onRemoved.addListener(id => workTabs(ids => ids.includes(id) ? ids.filter(x => x !== id) : null));
// 主页要开一个干活页（批量开票页、官方客服页、二维码发票页）：照常打开，并记成干活页
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!(m && m.type === 'openWorkTab' && /^https:\/\/[\w.-]+\.(taobao\.com|tmall\.com|chinatax\.gov\.cn(:\d+)?)\//.test(m.url || ''))) return;
  chrome.tabs.create({ url: m.url, active: m.active !== false }).then(t => trackTab(t.id).then(() => reply(t.id)), e => reply(String(e)));
  return true;
});

// 主页派活开的标签页：同一个网址上次派活开的那页先关掉（之前一次「一键处理」留下十几个「全部发票」页）。
// 只关同网址的：别的页面可能还在干活；用户自己开的标签页不动
let jobTabChain = Promise.resolve();
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!(m && m.type === 'openJobTab' && /^https:\/\/[\w.-]+\.taobao\.com\//.test(m.url || ''))) return;
  jobTabChain = jobTabChain.then(async () => {
    // 旺旺页只能有一个（见下面 chatHello）：已经开着就在它上面跳过去，不另开。另开的话，旧页先领走活、
    // 随后被「只留一个」关掉，活就丢了（2026-10-04 一键处理卡在「看卖家回复」）。跳转后旧页没了，清掉领取记录让新页重新领
    if (/^https:\/\/market\.m\.taobao\.com\/app\/im\//.test(m.url)) {
      const { chatTabs = [] } = await chrome.storage.session.get('chatTabs');
      const cid = chatTabs[chatTabs.length - 1];
      if (cid != null) {
        try {
          await chrome.tabs.update(cid, { url: m.url, active: true });
          await chrome.storage.local.remove(['invClaim_scan', 'invClaim_chatDownload']);
          return;
        } catch (e) { /* 那个页面已经关了：照常新开 */ }
      }
    }
    const { jobTabs } = await chrome.storage.local.get('jobTabs');
    const map = Object.assign({}, jobTabs && !Array.isArray(jobTabs) ? jobTabs : {});
    if (map[m.url] != null) { try { await chrome.tabs.remove(map[m.url]); } catch (e) { /* 用户已经关了 */ } }
    const t = await chrome.tabs.create({ url: m.url });
    // 旺旺页（还没开着时新开的）不算干活页：它始终只留一个、反复复用，不关
    if (!/^https:\/\/market\.m\.taobao\.com\/app\/im\//.test(m.url)) await trackTab(t.id);
    map[m.url] = t.id;
    await chrome.storage.local.set({ jobTabs: map });
  }).then(() => reply(true), e => reply(String(e)));
  return true;
});

// 淘宝网页版旺旺同一时间只能连一个聊天页：新开（或刷新）一个，别的就弹「连接断开」（2026-10-03 实测）。
// 所以只留最新的那个：聊天页一打开就来报到，之前的聊天页关掉；剩下这个断开了（网络抖动）就刷新，每分钟最多一次
let chatChain = Promise.resolve();
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!(m && (m.type === 'chatHello' || m.type === 'chatDisconnected') && sender.tab)) return;
  const id = sender.tab.id;
  chatChain = chatChain.then(async () => {
    const { chatTabs = [], chatReload = {} } = await chrome.storage.session.get(['chatTabs', 'chatReload']);
    if (m.type === 'chatHello') {
      for (const old of chatTabs) if (old !== id) { try { await chrome.tabs.remove(old); } catch (e) { /* 已经关了 */ } }
      await chrome.storage.session.set({ chatTabs: [id] });
      return;
    }
    if (chatTabs.length && chatTabs[chatTabs.length - 1] !== id) { try { await chrome.tabs.remove(id); } catch (e) { /* 同上 */ } return; }
    if (Date.now() - (chatReload[id] || 0) < 60000) return;
    await chrome.storage.session.set({ chatReload: Object.assign({}, chatReload, { [id]: Date.now() }) });
    await chrome.tabs.reload(id);
  }).then(() => reply(true), e => reply(String(e)));
  return true;
});

// 干活页做完自己关掉：插件开的干活页（workTabs）；税务局二维码发票页、按开票卡片打开的淘宝「开具发票 / 发票详情」页
// （由旺旺页里的点击打开，不经过后台，按网址认；这两个脚本只在领到插件的活时才会发 closeMe）
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!(m && m.type === 'closeMe' && sender.tab)) return;
  const url = sender.tab.url || sender.url || '';
  workTabs(() => null).then(ids => {
    const ok = ids.includes(sender.tab.id) || /^https:\/\/[\w.-]+\.chinatax\.gov\.cn(:\d+)?\//.test(url)
      || /^https:\/\/invoice-ua\.taobao\.com\/e-invoice\//.test(url);
    return ok ? chrome.tabs.remove(sender.tab.id).then(() => reply(true)) : reply(false);
  }).catch(e => reply(String(e)));
  return true;
});

// 工具栏插件图标上的数字：还有几单没拿到发票（主页算好写进 invPending）；有超过设定天数还没开的，用红色
function showBadge(p) {
  const n = p && p.n || 0;
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: p && p.late ? '#d0021b' : '#1c6e8c' });
  chrome.action.setTitle({ title: n ? '订单分拣：' + n + ' 单尚未取得发票' + (p.late ? '，其中 ' + p.late + ' 单超过设定天数未开票' : '') : '打开订单分拣主页' });
}
chrome.storage.local.get('invPending').then(r => showBadge(r.invPending));
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.invPending) showBadge(ch.invPending.newValue); });

// 每天自动处理一次发票（设置里打开；浏览器开着时才会跑）：每小时看一眼，过了设定的钟点、今天还没跑过，
// 就打开分拣主页（已开着就在它上面）带 #auto，主页读完数据后自己点「一键处理发票」
chrome.alarms.create('daily', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'daily') return;
  const { autoDaily, autoLast } = await chrome.storage.local.get(['autoDaily', 'autoLast']);
  if (!autoDaily || !autoDaily.on) return;
  const now = new Date(), today = now.toDateString();
  if (now.getHours() < (autoDaily.hour || 10) || autoLast === today) return;
  await chrome.storage.local.set({ autoLast: today });
  const url = chrome.runtime.getURL('index.html');
  const ctxs = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['TAB'] }) : [];
  const tab = ctxs.find(c => (c.documentUrl || '').startsWith(url));
  if (tab) await chrome.tabs.update(tab.tabId, { url: url + '#auto' }).then(() => chrome.tabs.reload(tab.tabId));
  else await chrome.tabs.create({ url: url + '#auto', active: false });
});

// ── 从淘宝读取订单（用户 2026-10-07）：主页写 readJob = { at, until } 并开一个「已买到的宝贝」干活页 ──
// readClaim：订单页加载时来领活。只让一个页面干：第一个来领的记下 tab，别的页面（用户自己开着的订单页）不自动翻
// readDone：读完（或停下）后清掉 readJob，结果写进 readResult 给主页；读到了订单就关掉这个干活页、把主页切到前台
const READ_LIFE = 30 * 60e3;
let readChain = Promise.resolve();
async function focusHome() {
  const url = chrome.runtime.getURL('index.html');
  const ctxs = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['TAB'] }) : [];
  const c = ctxs.find(x => (x.documentUrl || '').startsWith(url));
  if (!c) { await chrome.tabs.create({ url }); return; }
  await chrome.tabs.update(c.tabId, { active: true });
  if (c.windowId != null && c.windowId >= 0) await chrome.windows.update(c.windowId, { focused: true }).catch(() => {});
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!(m && (m.type === 'readClaim' || m.type === 'readDone') && sender.tab)) return;
  readChain = readChain.then(async () => {
    const { readJob } = await chrome.storage.local.get('readJob');
    if (!readJob || readJob.at !== m.at) return false;
    if (m.type === 'readClaim') {
      if (Date.now() - readJob.at > READ_LIFE) return false;
      if (readJob.tab != null && readJob.tab !== sender.tab.id) {
        try { await chrome.tabs.get(readJob.tab); return false; } catch (e) { /* 领过活的页面已经关了：换这个页面接着干 */ }
      }
      await chrome.storage.local.set({ readJob: Object.assign({}, readJob, { tab: sender.tab.id }) });
      return true;
    }
    if (readJob.tab !== sender.tab.id) return false;
    await chrome.storage.local.remove(['readJob', 'readProgress']);
    await chrome.storage.local.set({ readResult: { at: readJob.at, until: readJob.until || '', why: m.why, nos: m.nos || [], pages: m.pages || 0, done: Date.now() } });
    // 停下的、一单都没读到的（可能没登录好、页面没出来）：页面留着给用户看；读到了就关掉干活页，回主页看结果
    if (m.why !== 'stopped' && m.why !== 'verify' && (m.nos || []).length) {
      await focusHome().catch(e => console.warn('[订单分拣] 切回主页失败', e));
      const ids = await workTabs(() => null);
      if (ids.includes(sender.tab.id)) await chrome.tabs.remove(sender.tab.id).catch(() => {});
    }
    return true;
  }).then(reply, e => reply(String(e)));
  return true;
});

// 订单页抓到的数据：几个订单页同时抓时统一在这里排队合并进 scraped
let scrapedChain = Promise.resolve();
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!(m && m.type === 'scrapedMerge' && m.m)) return;
  scrapedChain = scrapedChain.then(async () => {
    const r = await chrome.storage.local.get('scraped');
    await chrome.storage.local.set({ scraped: Object.assign(r.scraped || {}, m.m) });
  }).then(() => reply(true), e => reply(String(e)));
  return true;
});

// 「全部发票」页截下来的发票地址（只收阿里云发票文件、淘宝发票这两个网站）
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m && m.type === 'saveUrl' && m.job && m.url) { ready.then(() => saveUrl(m.job, m.url)).then(() => reply(true), e => reply(String(e))); return true; }
  if (m && m.type === 'ownName' && m.url && m.name) { ownName[m.url] = m.name; reply(true); }     // 主页「挂上 PDF」
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const url = info.url || '';
  if (!PDF_TAB.test(url) || tab.openerTabId == null) return;
  ready.then(async () => {
    const now = Date.now();
    const i = expect.findIndex(j => j.kind === 'platform' && j.tab === tab.openerTabId && now - j.at < 60000);
    if (i < 0) return;                                         // 不是我们点的：不管
    const j = expect.splice(i, 1)[0]; keep();
    const ext = (/\.(pdf|ofd)(\?|$)/i.exec(url) || [, 'pdf'])[1].toLowerCase();
    const name = j.saveAs.replace(/\.\w+$/, '') + '.' + ext;
    try {
      ownName[url] = name;
      const id = await chrome.downloads.download({ url, filename: '订单分拣-发票/' + name, conflictAction: 'uniquify' });
      byUs[id] = Object.assign({}, j, { name });
      pending[id] = byUs[id]; keep();
      chrome.tabs.remove(tabId);
    } catch (e) { console.warn('[订单分拣] 保存 PDF 失败', e); }
  });
});

const base = p => String(p || '').split(/[\\/]/).pop();
function pick(item) {
  const now = Date.now();
  expect = expect.filter(e => now - e.at < 60000);
  const name = base(item.filename);
  if (!INVOICE_EXT.test(name)) return null;
  // 二维码发票（税务局页面下的）文件名是 dzfp_<发票号>_<销售方>_<时间>.pdf：按发票号认
  const i = expect.findIndex(j => j.kind === 'chat' ? j.file === name : j.kind === 'qr' ? name.includes(j.invNo) : name.includes(j.no));
  return i < 0 ? null : expect.splice(i, 1)[0];
}
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id) {             // 本扩展自己发起的：按发起时记下的名字
    const name = ownName[item.url] || ownName[item.finalUrl];      // 不删：网络断了续传时 Chrome 会再问一次名字
    // 名字已经带了「订单分拣-xxx/」文件夹的（整理报销文件时存进「订单分拣-报销/…」）照原样用
    if (name) suggest({ filename: /^订单分拣-[^/]+\//.test(name) ? name : '订单分拣-发票/' + name, conflictAction: 'uniquify' }); else suggest();
    return;
  }
  ready.then(() => {
    const j = pick(item);
    if (!j) { suggest(); return; }                             // 不是我们点的那张发票：原样放行
    const ext = (INVOICE_EXT.exec(base(item.filename)) || [, 'pdf'])[1].toLowerCase();
    const name = j.saveAs.replace(/\.\w+$/, '') + '.' + ext;
    pending[item.id] = Object.assign({}, j, { name });
    keep();
    suggest({ filename: '订单分拣-发票/' + name, conflictAction: 'uniquify' });
  });
  return true;                                                 // 异步给出文件名
});

// 几个下载可能同时完成：写 dlDone 排队进行，免得读到同一份旧值互相覆盖
let chain = Promise.resolve();
chrome.downloads.onChanged.addListener(d => {
  if (!d.state || d.state.current !== 'complete') return;
  chain = chain.then(ready).then(async () => {
    const j = pending[d.id];
    if (!j) return;
    delete pending[d.id]; keep();
    const [item] = await chrome.downloads.search({ id: d.id });
    const { dlDone } = await chrome.storage.local.get('dlDone');
    const all = dlDone || {};
    // file：我们起的名字（主页显示用）；path：Chrome 实际存的位置（重名时会自动加序号）
    // url：阿里云上的发票文件（卖家在旺旺发的、平台开的），主页拿它把 PDF 取回来读金额、开票日期核对（扩展有这个网站的权限）
    const url = item && /^https:\/\/[\w.-]+\.aliyuncs\.com\//.test(item.finalUrl || item.url || '') ? (item.finalUrl || item.url) : '';
    (all[j.no] = all[j.no] || []).push({ file: j.name, path: item ? item.filename : '', at: Date.now(), from: j.kind, src: j.file || j.invNo || '', url });
    await chrome.storage.local.set({ dlDone: all });
  }).catch(e => console.warn('[订单分拣] 记录下载失败', e));
});
