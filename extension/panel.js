// 发票页、旺旺页共用的右下角小面板（补图的面板在 scraper 里，那个还要给控制台用法用，不共用）
// opts.top：放在右上角（旺旺页右下角是「发送」按钮，卡片不能盖住它，2026-10-03 测出来的）
// buttons：[[id, 文字, 悬停说明], …]
window.otPanel = function (title, buttons, onClick, opts) {
  const el = document.createElement('div');
  el.setAttribute('style', 'position:fixed;right:16px;' + (opts && opts.top ? 'top:72px' : 'bottom:16px') + ';z-index:2147483647;background:#fff;color:#1f2a2e;'
    + 'border:1px solid #cfd6d3;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:12px 14px;'
    + 'font:13px/1.5 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;width:240px');
  el.innerHTML = '<div data-otp-full><div style="font-weight:600;margin-bottom:4px;display:flex;justify-content:space-between">订单分拣 · ' + title
    + '<button data-otp-mini title="收起面板" style="font:inherit;border:0;background:none;cursor:pointer;color:#66727a;padding:0 2px">—</button></div>'
    + '<div data-otp-status style="color:#66727a;font-size:12px;margin-bottom:10px"></div>'
    + '<div data-otp-btns style="display:grid;gap:6px"></div><div style="color:#8a949a;font-size:11px;margin-top:8px">数据仅保存在本机扩展中，不上传。</div></div>'
    + '<button data-otp-mini hidden title="展开面板" style="font:inherit;font-weight:600;border:0;background:none;cursor:pointer;color:#1c6e8c;padding:0">订单分拣 ▴</button>';
  document.body.appendChild(el);
  // 收起成一个小条：卡片会挡住淘宝页右下角的按钮（用户 2026-10-03）
  const full = el.querySelector('[data-otp-full]'), pill = el.querySelector('button[hidden][data-otp-mini]');
  el.addEventListener('click', e => {
    const t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-otp-mini')) {
      const mini = !full.hidden;
      full.hidden = mini; pill.hidden = !mini;
      el.style.width = mini ? 'auto' : '240px'; el.style.padding = mini ? '7px 12px' : '12px 14px';
      return;
    }
    const id = t && t.getAttribute('data-otp'); if (id) onClick(id);
  });
  const st = el.querySelector('[data-otp-status]'), btns = el.querySelector('[data-otp-btns]');
  const setButtons = list => {
    btns.innerHTML = list.map(([id, label, tip]) =>
      '<button data-otp="' + id + '" title="' + String(tip || label).replace(/"/g, '&quot;') + '" style="font:inherit;padding:7px 0;border-radius:6px;border:1px solid #1c6e8c;background:#1c6e8c;color:#fff;cursor:pointer">' + label + '</button>').join('');
  };
  setButtons(buttons);
  const det = document.createElement('div');
  det.style.cssText = 'margin:-4px 0 10px;max-height:260px;overflow:auto';
  st.after(det);
  // orders: [{ no, date, amount, lines: [{ title, img, qty }] }]
  const detail = orders => {
    det.textContent = '';
    for (const o of orders || []) {
      const head = document.createElement('div');
      head.style.cssText = 'font-size:12px;color:#1f2a2e;font-weight:600;margin-top:6px';
      head.textContent = o.date + ' · ¥' + o.amount + ' · ' + o.no;
      det.appendChild(head);
      for (const l of o.lines || []) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:4px;font-size:12px;color:#44515a';
        const im = document.createElement('img');
        im.referrerPolicy = 'no-referrer'; im.alt = '';
        im.style.cssText = 'width:44px;height:44px;object-fit:cover;border-radius:4px;background:#eef1ef;flex:none';
        if (l.img) im.src = l.img;
        const t = document.createElement('span');
        t.textContent = l.title + (l.qty > 1 ? ' ×' + l.qty : '');
        row.append(im, t); det.appendChild(row);
      }
    }
  };
  const api = { set(s) { st.textContent = s; }, buttons: setButtons, detail };                    // 状态里有从页面读来的店名，当纯文字放，别让它变成网页代码
  window.__otPanel = api;
  return api;
};

// 干活页没办成（安全验证、页面没加载出来、找不到要点的东西、出错）：
//   写一条结果 jobFail = { stage, why, at, host }（主页正在等这一段时，看到就立即结束这一段，红条写这句原因），记进本机调试日志，
//   面板上写明原因，并把本页切到前台（安全验证等要用户在这一页上处理）。不用 alert：后台标签页里的弹窗用户看不到
window.otFail = function (stage, why) {
  const p = window.__otPanel || window.otPanel('出错', [], () => {}, { top: true });
  p.set(why);
  window.otLog(stage, 'fail', why);
  chrome.storage.local.set({ jobFail: { stage, why: String(why).slice(0, 300), at: Date.now(), host: location.host } }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'focusMe' }).catch(() => {});
};

// 本机调试日志：写进 chrome.storage.local 的 autoLog（后台排队追加，见 background.js），界面上没有入口
window.otLog = function (stage, ev, msg) {
  chrome.runtime.sendMessage({ type: 'autoLog', e: { stage, ev, msg: String(msg == null ? '' : msg).slice(0, 500) } }).catch(() => {});
};

// 出现滑块 / 安全验证：停下交给用户，不绕过
window.otNeedsVerify = function () {
  if (/punish|captcha|_____tmd_____/i.test(location.href)) return true;
  if (document.querySelector('iframe[src*="captcha"],iframe[src*="punish"],#nc_1_wrapper,.nc-container,#baxia-dialog-content,[id^="baxia-dialog"]')) return true;
  const dlg = [...document.querySelectorAll('[role=dialog],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]')]
    .filter(e => e.getBoundingClientRect().width > 0).map(e => e.innerText).join(' ');
  return /拖动.{0,6}滑块|滑动验证|安全验证|请完成验证/.test(dlg);
};

// 一个页面只有一条排队线：同步、下载、扫描一件做完再做下一件（各排各的会互相抢页面，同步翻到一半被下载切走标签，2026-09 离线复现）。
// 同一种活已经排着没开始的，不再重复排
window.otQueue = function () {
  let chain = Promise.resolve();
  const waiting = new Set();
  return (kind, fn) => {
    if (waiting.has(kind)) return chain;
    waiting.add(kind);
    return (chain = chain.then(() => { waiting.delete(kind); return fn(); }).catch(e => console.warn('[订单分拣]', e)));
  };
};

// 给扩展后台发消息，限时等回话：后台卡住时别让页面无声地一直等（2026-09 真实窗口里后台不回话，下载停在第一单、面板什么都不显示）
window.otSend = function (m, ms) {
  return Promise.race([chrome.runtime.sendMessage(m),
    new Promise((_, no) => setTimeout(() => no(new Error('扩展后台没有回应，请到扩展管理页重新加载「订单分拣」再试')), ms || 15000))]);
};

// 主页排的活：invJobs = { 活的种类: 排活时间 }。页面打开时（或已开着时）领走 2 分钟内、属于本页的活。
//   - 只有正显示在前台的页面才领：这类页面在后台标签里常常渲染成一片空白（2026-09 实测），读出来是空的
//   - 可能同时开着两个同样的页面：先写「我领了」，等一下再读回来，确认是自己领到的才干，免得两个页面重复翻账号
//   - opts.takeover（旺旺页：同一时间只有一个）：领了活却没做完的是本页加载之前的旧页面（被跳转、刷新掉了），旧页面已经没了，本页接着做。
//     以前旧页面在跳走前的一瞬间领走了新活，新页面看到「已有页面领了」就不做，主页干等到超时（2026-10-09 离线复现）
//   - 做完（或交出去）后在领取记录上记 done，之后再打开的页面不会把做完的活再做一遍
window.otTakeJob = function (kinds, run, opts) {
  const me = Math.random().toString(36).slice(2), born = Date.now();
  // 要离开的页面不再领活（跳转、刷新开始时就停）
  addEventListener('beforeunload', () => { window.__otClosing = true; });
  addEventListener('pagehide', () => { window.__otClosing = true; });
  const take = async jobs => {
    if (document.visibilityState !== 'visible' || window.__otClosing) return;      // 马上要关的页面不再领活
    for (const kind of kinds) {
      const at = jobs && jobs[kind];
      if (!at || Date.now() - at > 120000) continue;
      const key = 'invClaim_' + kind;
      const c = (await chrome.storage.local.get(key))[key];
      // 这份活已经有页面领了（旺旺页：领活的旧页面已经不在、活又没做完的除外）
      if (c && c.at === at && !(opts && opts.takeover && !c.done && c.by !== me && (c.t || 0) < born)) continue;
      await chrome.storage.local.set({ [key]: { at, by: me, t: Date.now() } });
      await new Promise(r => setTimeout(r, 400));
      if (((await chrome.storage.local.get(key))[key] || {}).by !== me || window.__otClosing) continue;
      Promise.resolve(run(kind, true)).catch(() => {}).then(async () => {
        const x = (await chrome.storage.local.get(key))[key];
        if (x && x.by === me && x.at === at) await chrome.storage.local.set({ [key]: Object.assign({}, x, { done: true }) });
      }).catch(() => {});
    }
  };
  const check = () => chrome.storage.local.get('invJobs').then(r => take(r.invJobs));
  check();
  chrome.storage.onChanged.addListener(ch => { if (ch.invJobs && ch.invJobs.newValue) take(ch.invJobs.newValue); });
  document.addEventListener('visibilitychange', check);        // 后台页被切到前台时再看一眼
};

// 主页派活打开的页面有时整页空白（淘宝那边没渲染出来，2026-09 实测时好时坏）：放掉这份活、刷新一次，刷新后重新领。
// 只自动刷新一次（记在扩展存储里），还不行就提示用户
window.otRetryBlank = async function (kind) {
  const key = 'otReload_' + kind, last = (await chrome.storage.local.get(key))[key];
  if (last && Date.now() - last < 120000) { await chrome.storage.local.remove(key); return false; }
  await chrome.storage.local.set({ [key]: Date.now() });
  await chrome.storage.local.remove('invClaim_' + kind);
  location.reload();
  return true;
};

// 插件开的干活页做完了：ms 毫秒后请后台关掉本页（后台只关自己开的干活页，用户自己打开的不关）；从现在起本页不再领新活
window.otCloseLater = function (ms) {
  window.__otClosing = true;
  setTimeout(() => window.otSend({ type: 'closeMe' }).catch(() => {}), ms || 0);
};

// 页面是前端慢慢渲染出来的：等 ok() 成立（最多 ms 毫秒）
window.otWaitFor = async function (ok, ms) {
  for (let t = 0; t < ms; t += 300) { if (ok()) return true; await new Promise(r => setTimeout(r, 300)); }
  return !!ok();
};
