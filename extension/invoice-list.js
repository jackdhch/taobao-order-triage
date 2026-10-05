// 淘宝「我的发票 → 全部发票」页（i.taobao.com/my_itaobao/invoice）
//
// 同步：依次读「已开具发票 / 申请中发票 / 未申请」三个标签里每单的抬头、类型、日期、进度，存进扩展存储 invSync，
//       主页据此算每单发票状态。只点标签、页码和翻页按钮。
// 下载：主页里点了「下载」的订单排在 dlJobs 里，这里找到那一单点「下载到本地」；下载前告诉后台存成什么名字。
//
// 页面结构（2026-09 实测）：表格每单一个 tbody，分组头 tr 里 [class*="group-header-title-number"] 是订单号；
// 两个标签的列不一样（已开具：抬头、类型分两列、有「开票日期」；申请中：「发票抬头/类型」一列、申请时间在分组头），所以按表头找列。
// 页面是前端慢慢渲染的，在后台标签里常常是一片空白；「下载到本地」直接下一个「抬头_订单号.pdf」
(() => {
  if (window.__otInvoiceList) return;
  window.__otInvoiceList = 1;
  const TABS = [['issued', /已开具/], ['applying', /申请中/], ['unapplied', /未申请/]];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const text = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const day = s => { const m = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(s || ''); return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : ''; };
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // 只看当前显示着的表格：切标签后旧标签的表可能还留在网页里、只是藏起来了
  const tables = () => [...document.querySelectorAll('table')].filter(shown);
  const bodies = () => tables().flatMap(t => [...t.querySelectorAll('tbody')]);
  const noOf = tb => text(tb.querySelector('[class*="group-header-title-number"]'));
  const pageKey = () => bodies().map(noOf).filter(Boolean).join(',');
  const emptyShown = () => tables().some(t => /暂无|没有.{0,6}(发票|数据|记录)/.test(text(t)));
  const tabEls = () => [...document.querySelectorAll('li.next-tabs-tab')];

  function readRows(tab) {
    const t = tables().find(x => x.querySelector('thead th')) || document;
    const heads = [...t.querySelectorAll('thead th')].map(text);
    const col = re => heads.findIndex(h => re.test(h));
    const cAmt = col(/金额/), cTitle = col(/抬头/), cType = col(/类型/), cDate = col(/日期/), cProg = col(/进度/);
    return bodies().map(tb => {
      const no = noOf(tb);
      if (!/^\d{15,20}$/.test(no)) return null;
      const head = tb.querySelector('tr[class*="group-header"]');
      // 一单多件时后面几行的单元格会少（合并单元格），列号只在第一行上对得上
      const first = [...tb.querySelectorAll('tr')].find(tr => tr !== head);
      const tds = first ? [...first.children] : [];
      const cell = i => (i >= 0 && tds[i]) ? tds[i] : null;
      const lines = el => el ? [...el.querySelectorAll('div,span')].filter(e => !e.childElementCount).map(text).filter(Boolean) : [];
      const tt = lines(cell(cTitle));                  // 「发票抬头/类型」合在一列时是两行
      const prog = text(tb.querySelector('[class*="progress--"]')) || lines(cell(cProg))[0] || '';
      return {
        no, tab, shop: text(head && head.querySelector('[class*="group-header-logo"]')),
        amount: +((/[\d.]+/.exec(text(cell(cAmt)).replace(/,/g, '')) || [])[0]) || null,
        title: tt.find(t => /企业|个人|-/.test(t)) || tt[0] || '',
        type: (cType !== cTitle ? lines(cell(cType))[0] : tt.find(t => /发票/.test(t))) || '',
        date: day(cDate >= 0 ? text(cell(cDate)) : text(head)),          // 已开具：开票日期；申请中：申请时间
        progress: prog.replace(/下载到本地.*/, '').trim(),
        // 申请中的单：页面上写着「商家还有8天57分37秒处理时间」时一并记下（2026-10-05 在发票详情页上见过，列表上不一定有）
        remain: (/商家还有[^，,。；;\s]{1,20}处理时间/.exec(text(tb)) || [])[0] || '',
        canDownload: [...tb.querySelectorAll('button')].some(b => /下载到本地/.test(text(b))),
      };
    }).filter(Boolean);
  }
  async function waitChange(before, ms) {
    return window.otWaitFor(() => (pageKey() && pageKey() !== before) || (emptyShown() && !pageKey()), ms);
  }
  const pagerBtns = () => [...document.querySelectorAll('.next-pagination button')].filter(shown);
  const off = b => b.disabled || /disabled/.test(b.className);
  function nextBtn() { const b = pagerBtns().find(x => /下一页/.test(text(x))); return b && !off(b) ? b : null; }
  // 回到第 1 页：这个标签之前可能被人翻到了后面
  async function toFirstPage() {
    const one = pagerBtns().find(x => text(x) === '1');
    if (!one || /current|active/.test(one.className) || off(one)) return;
    const before = pageKey();
    one.click();
    await waitChange(before, 10000);
  }
  // 打开标签并等数据出来；返回 true = 这个标签读得了
  async function openTab(re) {
    const li = tabEls().find(x => re.test(text(x)));
    if (!li) return false;
    if (!/active/.test(li.className)) {
      const before = pageKey();
      li.click();
      await waitChange(before, 10000);
    }
    if (!await window.otWaitFor(() => pageKey() || emptyShown(), 15000)) return false;
    await toFirstPage();
    await sleep(600);
    return true;
  }
  // 页面刚打开时标签和表格都还没渲染出来
  const pageReady = () => window.otWaitFor(() => tabEls().length && (pageKey() || emptyShown()), 20000);

  const one = window.otQueue();
  const sync = (kind, fromJob) => one('sync', async () => {
    try {
      if (!await pageReady()) {
        if (fromJob && await window.otRetryBlank('sync')) return;
        panel.set('页面未加载完成（淘宝页面偶尔整页空白），请刷新本页后点击「同步开票状态」'); return;
      }
      const { invWant, invSync } = await chrome.storage.local.get(['invWant', 'invSync']);
      const since = ((invWant && invWant.since) || '').slice(0, 10);
      const got = {}, okTabs = [];
      for (const [tab, re] of TABS) {
        if (!await openTab(re)) continue;
        let ok = true;
        for (let p = 0; p < 60; p++) {
          if (window.otNeedsVerify()) { alert('页面出现安全验证，请手动完成后在分拣主页重新操作。'); ok = false; break; }
          const rs = readRows(tab);
          rs.forEach(r => { got[r.no] = got[r.no] || r; });    // 同一单在前一个标签里出现过就以前一个为准（已开具优先）
          panel.set('正在读取「' + re.source + '」第 ' + (p + 1) + ' 页，已读取 ' + Object.keys(got).length + ' 单');
          // 列表从新到旧：整页都早于订单表最早日期，后面只会更早（开票、申请日期不会早于下单日期）
          if (since && rs.length && rs.every(r => r.date && r.date < since)) break;
          const b = nextBtn();
          if (!b) break;
          const before = pageKey();
          b.click();
          if (!await waitChange(before, 15000)) { ok = false; break; }
          await sleep(1200 + Math.random() * 1200);       // 放慢，别给服务器添压力
        }
        if (ok) okTabs.push(tab);
      }
      if (!okTabs.length) { panel.set('未能读取任何标签，保留上次同步结果'); if (fromJob) window.otCloseLater(10000); return; }
      // 三个标签都读完才整份替换；有标签没读成，就只补新读到的，别把上次的好数据清掉
      const full = okTabs.length === TABS.length;
      const rows = full ? got : Object.assign({}, invSync && invSync.rows, got);
      await chrome.storage.local.set({ invSync: { at: Date.now(), rows, partial: !full } });
      panel.set((full ? '同步完成' : '仅读取 ' + okTabs.length + ' 个标签，其余保留上次结果') + '：共 ' + Object.keys(rows).length + ' 单开票记录，已送回分拣主页'
        + (fromJob ? '。本页 3 秒后关闭。' : ''));
      if (fromJob) { window.otCloseLater(3000); return; }               // 主页派活开的页：干完就关（用户 2026-10-05：标签页太多）
      await openTab(TABS[0][1]);
    } catch (e) {
      panel.set('同步出错：' + e.message);
    }
  });

  // 下载：翻「已开具」标签找到那一单，点「下载到本地」
  const download = (kind, fromJob) => one('download', async () => { try {
    const { dlJobs } = await chrome.storage.local.get('dlJobs');
    const jobs = (dlJobs || []).filter(j => j.kind === 'platform');
    if (!jobs.length) { panel.set('没有待下载的发票'); if (fromJob) window.otCloseLater(5000); return; }
    if (!await pageReady() || !await openTab(TABS[0][1])) {
      if (fromJob && await window.otRetryBlank('download')) return;
      panel.set('页面未加载完成（淘宝页面偶尔整页空白），请刷新本页后点击「下载已开具的发票」'); return;
    }
    const left = new Map(jobs.map(j => [j.no, j])), done = [];
    for (let p = 0; p < 60 && left.size; p++) {
      if (window.otNeedsVerify()) { alert('页面出现安全验证，请手动完成后在分拣主页重新操作。'); break; }
      for (const tb of bodies()) {
        const j = left.get(noOf(tb));
        const btn = j && [...tb.querySelectorAll('button')].find(b => /下载到本地/.test(text(b)));
        if (!btn) continue;
        await window.otSend({ type: 'expectDownload', job: j });
        // 淘宝点下载时造的是指向阿里云的链接，扩展代点浏览器不认：invoice-main.js 在页面里把地址截下来发给这里，交给后台去存
        document.documentElement.dataset.otDl = j.no;
        const got = new Promise(res => {
          const on = e => { if (e.source === window && e.data && e.data.otInvoiceUrl && e.data.no === j.no) { removeEventListener('message', on); res(e.data.otInvoiceUrl); } };
          addEventListener('message', on);
          setTimeout(() => { removeEventListener('message', on); res(''); }, 8000);
        });
        btn.click();
        const url = await got;
        delete document.documentElement.dataset.otDl;
        if (url) await window.otSend({ type: 'saveUrl', job: j, url }, 60000);
        left.delete(j.no); done.push(j.id);
        panel.set('已下载 ' + done.length + ' / ' + jobs.length + ' 单');
        await sleep(2500);
      }
      const b = left.size && nextBtn();
      if (!b) break;
      const before = pageKey();
      b.click();
      if (!await waitChange(before, 15000)) break;
      await sleep(1200);
    }
    await window.otSend({ type: 'jobsDone', ids: done });   // 交给后台统一删，别和旺旺页互相盖
    panel.set('已下载 ' + done.length + ' 单' + (left.size ? '，' + left.size + ' 单在已开具发票中未找到' : '') + (fromJob ? '。本页 8 秒后关闭。' : ''));
    if (fromJob) window.otCloseLater(8000);                        // 留几秒让最后一张下完（下载归浏览器管，关页面不影响已开始的下载）
  } catch (e) { delete document.documentElement.dataset.otDl; panel.set('下载出错：' + e.message); } });

  const panel = window.otPanel('我的发票', [['sync', '同步开票状态', '读取已开具、申请中、未申请三类开票记录，送回分拣主页'],
    ['dl', '下载已开具的发票', '下载分拣主页中已排队的平台发票，按订单命名存入「订单分拣-发票」']], id => id === 'sync' ? sync() : download());
  panel.set('等待分拣主页分配任务；也可点击「同步开票状态」读取开票记录');
  window.otTakeJob(['sync', 'download'], (kind, fromJob) => kind === 'sync' ? sync(kind, fromJob) : download(kind, fromJob));
})();
