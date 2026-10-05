// 税务局电子发票服务平台（卖家在旺旺里发来的发票二维码，打开就是这里；2026-10-04 实测浙江
// dppt.zhejiang.chinatax.gov.cn:8443/v/2_<20 位发票号>_… → 跳到 /qrcode?cs=2_<发票号>_…）。
// 页面上直接写着购买方名称、税号、价税合计、开票日期，有「PDF下载」「OFD下载」「XML下载」三个按钮。
// 主页排了这张票的下载活（dlJobs 里 kind=qr、发票号对得上）才动：抬头、税号、金额核对过再点「PDF下载」，下完关掉本页。
// 金额不是这单的、但正好是同店另一单的（同一家店几单共用一个会话，分不清二维码是哪单的）：按那一单存
(() => {
  if (window.top !== window || window.__otQr) return;
  window.__otQr = 1;
  const invNo = (/2_(\d{20})_/.exec(decodeURIComponent(location.href)) || [])[1];
  if (!invNo) return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const squash = s => String(s || '').replace(/\s+/g, '');
  (async () => {
    const { dlJobs } = await chrome.storage.local.get('dlJobs');
    const j = (dlJobs || []).find(x => x.kind === 'qr' && x.invNo === invNo);
    if (!j) return;                                       // 不是插件打开的：不动，也不显示卡片
    const panel = window.otPanel('二维码发票', [], () => {});
    panel.set('核对发票号 ' + invNo + '…');
    const btnOf = () => [...document.querySelectorAll('button')].find(b => /PDF\s*下载/.test(b.innerText));
    await window.otWaitFor(() => btnOf() && /价税合计/.test(document.body.innerText), 20000);
    const t = squash(document.body.innerText);
    const amt = +(((/价税合计[^￥¥\d]*[￥¥]?([\d,]+\.\d{2})/.exec(t) || [])[1]) || 'NaN').replace(/,/g, '');
    const buyerOk = !j.title || t.includes(squash(j.title));
    const taxOk = !j.taxId || t.toUpperCase().includes(String(j.taxId).toUpperCase());
    const eq = (a, b) => a != null && Math.abs(a - b) < 0.005;
    // 金额：这一单 → 同店另一单 → 比这单实付多一点（不超过 3 成，平台常按用券前的价开）
    const target = eq(amt, j.amount) ? j : (j.alts || []).find(a => eq(amt, a.amount)) || (amt > j.amount && amt <= j.amount * 1.3 ? j : null);
    const why = !btnOf() ? '页面上没找到「PDF下载」' : !buyerOk ? '购买方不是 ' + j.title : !taxOk ? '税号不是 ' + j.taxId
      : !target ? '价税合计 ¥' + amt + '，和这家店要发票的订单都对不上' : '';
    if (why) {
      panel.set('未下载：' + why + '。请手动核对这张发票。');
      await chrome.storage.local.set({ qrFail: Object.assign((await chrome.storage.local.get('qrFail')).qrFail || {}, { [invNo]: { at: Date.now(), why, no: j.no } }) });
      await window.otSend({ type: 'jobsDone', ids: [j.id] });
      return;
    }
    await window.otSend({ type: 'expectDownload', job: Object.assign({}, j, { no: target.no, saveAs: target.saveAs }) });
    btnOf().click();
    panel.set('核对过：购买方、税号对，价税合计 ¥' + amt + '（订单 ' + target.no + '），已点「PDF下载」，存成 ' + target.saveAs);
    await sleep(5000);
    await window.otSend({ type: 'jobsDone', ids: [j.id] });
    await window.otSend({ type: 'closeMe' });
  })().catch(e => console.warn('[订单分拣] 二维码发票', e));
})();
