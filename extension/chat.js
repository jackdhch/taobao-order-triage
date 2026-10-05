// 淘宝旺旺网页版（market.m.taobao.com/app/im/chat，聊天内容在 iframe chat-core 里；本脚本在每个框架里都注入，
// 只在有会话列表的那个框架里干活）
//
// 扫描：只看主页给的「还需要卖家回复」的那几家店（invWant.chat）。逐个点开会话，往上滚加载聊天记录到那几单最早的日期，
//       记下我们要发票的消息、之后对方发来的文件 / 图片（可能是二维码）/ 提到邮箱的话，存进扩展存储 chatScan。
//       只点左侧会话、只滚动消息列表；不碰输入框和「发送」。打开会话会让对方看到「已读」，所以范围只限这几家。
// 下载：主页里点了「下载」的聊天文件排在 dlJobs 里，这里打开会话找到那个文件点「下载文件」。
// 发消息：主页「给卖家发消息」排的 chatQueue(kind=compose)：逐家打开会话，把写好的消息填进输入框（.editBox pre.edit[contenteditable=true]），
//       **不点发送**——用户核对后自己点「发送」或按回车；看到这条消息出现在聊天里，记进 askSent，自动开下一家。
//
// 页面结构（2026-09 实测）：会话 .conversation-item > .name（长店名会截断成「…」）；消息 .message-item(.self) > .nick .time .content；
// 文字在 pre.edit，文件 .file-msg > .file-name[title=完整文件名] .file-size a.download-file；
// 右侧「我的订单」.ww_tab .order-id 是和这家店的订单号；消息列表 .ww_message .rc-scrollbars-view 滚到顶加载更早的
(() => {
  if (window.__otChat) return;
  window.__otChat = 1;
  // 只留一个旺旺页（见 background.js）：外层页面打开就报到；聊天框架里出现「连接断开」超过 5 秒就告诉后台（刷新或关掉）
  if (window.top === window) chrome.runtime.sendMessage({ type: 'chatHello' }).catch(() => {});
  else {
    let dc = 0;
    const tick = setInterval(() => {
      const t = [...document.querySelectorAll('.next-message-title')].some(e => e.offsetWidth && /连接断开/.test(e.textContent));
      dc = t ? dc + 1 : 0;
      if (dc >= 2) { clearInterval(tick); chrome.runtime.sendMessage({ type: 'chatDisconnected' }).catch(() => {}); }
    }, 3000);
  }
  // 聊天界面是异步渲染的，外层页面里也会注入本脚本：等 30 秒还没有会话列表，就不是聊天那个框架
  window.otWaitFor(() => document.querySelector('.ww_conversation_list, .ww_conversation'), 30000).then(ok => { if (ok) boot(); });

  function boot() {
    const I = window.Invoice;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const text = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
    const squash = s => String(s || '').replace(/\s+/g, '');
    // 会话列表里的长店名会被截断成「某某旗舰…」；只有截断的才按前缀对，否则要完全一样（别把「某某」对到「某某二店」）
    const sameShop = (full, shown) => {
      full = squash(full); shown = squash(shown);
      if (!full || !shown) return false;
      if (/[…]$|\.\.\.$/.test(shown)) return full.startsWith(shown.replace(/[…]$|\.\.\.$/, ''));
      return full === shown;
    };
    const view = () => document.querySelector('.ww_message .rc-scrollbars-view');
    const header = () => text(document.querySelector('.ww_header .name'));
    const convItems = () => [...document.querySelectorAll('.conversation-item')];
    const convName = it => text(it.querySelector('.name'));
    // 这一单要找的会话：会话名可能是店名，也可能是卖家旺旺名（个人卖家多是这样，2026-10 实测：有家店的会话名是卖家本人的名字）
    const isConvOf = (o, name) => sameShop(o.shop, name) || (!!o.nick && sameShop(o.nick, name));

    function readMsgs() {
      return [...document.querySelectorAll('.message-item')].map(m => {
        const fileEl = m.querySelector('.file-msg');
        // 商品卡片（.item-pic 之类）里的图不算；只在消息内容里面找，别找到外层 .message-item-line 上去
        const img = [...m.querySelectorAll('.content img')].find(i => i.getBoundingClientRect().width > 60 && !i.closest('.content [class*="item-"]'));
        return {
          self: m.classList.contains('self'),
          time: text(m.querySelector('.time')),
          text: text(m.querySelector('.content pre.edit')) || '',
          file: fileEl ? { name: (fileEl.querySelector('.file-name') || {}).title || text(fileEl.querySelector('.file-name')), size: text(fileEl.querySelector('.file-size')) } : null,
          img: img ? img.currentSrc || img.src : '',
        };
      }).filter(m => m.time);
    }
    // 攒消息：同一条（时间 + 谁发的 + 第几条）只留读到内容的那次
    let pile = new Map();
    function snap() {
      const ms = readMsgs(), n = {};
      for (const m of ms) {
        const k0 = m.time + '|' + (m.self ? 1 : 0);
        n[k0] = (n[k0] || 0) + 1;
        const k = k0 + '|' + n[k0];
        const old = pile.get(k);
        if (!old || (!old.text && m.text) || (!old.file && m.file) || (!old.img && m.img)) pile.set(k, m);
      }
    }
    const collected = () => { snap(); return [...pile.values()].sort((a, b) => a.time.localeCompare(b.time)); };
    // 往上滚到 since 之前（或连续 3 次再也加载不出更早的）
    async function loadBack(since) {
      pile = new Map(); snap();
      for (let k = 0, still = 0; k < 40 && still < 3; k++) {
        if (window.otNeedsVerify()) return false;
        const v = view(); if (!v) return true;
        const first = (readMsgs()[0] || {}).time || '';
        if (since && first && first < since) return true;
        const n = document.querySelectorAll('.message-item').length;
        v.scrollTop = 0; v.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(1500);
        snap();
        still = document.querySelectorAll('.message-item').length === n ? still + 1 : 0;
      }
      return true;
    }
    // 按名字现找条目再点：打开一个会话、滚动加载历史后，旺旺会重画左侧列表，之前拿到的条目已经不在页面上了，点了没反应（2026-09 实测）
    async function openConv(item) {
      const name = convName(item);
      item = convItems().find(x => convName(x) === name) || item;
      if (!sameShop(header(), name)) {
        // 点最里面的店名：旺旺响应点击的是条目里面的元素，点外框没反应（2026-09 实测）；点里面的事件会一路冒泡到外框
        (item.querySelector('.name') || item).click();
        await window.otWaitFor(() => sameShop(header(), name), 8000);
        await sleep(1500);
      }
      return sameShop(header(), name);
    }

    // 打开和某个卖家的聊天：和订单页旺旺图标打开的地址一样（uid=cntaobao<旺旺名>）。聊天在 iframe 里，要让外层页面跳
    function goChat(nick) {
      const url = 'https://market.m.taobao.com/app/im/chat/index.html?&uid=' + encodeURIComponent('cntaobao' + nick) + '&gid=&type=web';
      try { window.top.location.href = url; } catch (e) { location.href = url; }
    }
    const uidHere = () => { const m = /[?&]uid=([^&#]+)/.exec(location.href); try { return m ? decodeURIComponent(m[1]).replace(/^cntaobao/, '') : ''; } catch (e) { return ''; } };
    // 页面因为 goChat 重新加载后：看当前这个会话，记结果，跳下一家；最后一家看完写 chatScan
    async function resumeQueue() {
      const { chatQueue: q } = await chrome.storage.local.get('chatQueue');
      if (!q || Date.now() - q.at > (q.kind === 'compose' ? 60 : 20) * 60000 || !q.items || !q.items.length) return false;
      const cur = q.items[0];
      if (squash(uidHere()) !== squash(cur.nick)) return false;          // 不是插件打开的（用户自己在用旺旺）
      if (q.kind === 'dl') return resumeDownload(q, cur);
      if (q.kind === 'compose') return resumeCompose(q, cur);
      if (window.otNeedsVerify()) { alert('页面出现了安全验证，请手动完成后在分拣主页再点一次。'); await chrome.storage.local.remove('chatQueue'); return true; }
      const n0 = q.done + 1, total = q.done + q.items.length;
      panel.set('正在看第 ' + n0 + ' / ' + total + ' 个会话：' + cur.shop + '（' + cur.nick + '）');
      const opened = await window.otWaitFor(() => sameShop(cur.nick, header()), 15000);
      const next = Object.assign({}, q, { items: q.items.slice(1), done: q.done + 1, at: Date.now() });
      if (opened) {
        await sleep(1200);
        if (!await loadBack(q.since)) { alert('页面出现了安全验证，请手动完成后在分拣主页再点一次。'); await chrome.storage.local.remove('chatQueue'); return true; }
        const msgs = collected();
        const orders = [...document.querySelectorAll('.ww_tab .order-id')].map(text).filter(x => /^\d{15,20}$/.test(x));
        // 保险：右侧「我的订单」里要有这一单，才算是这一单的卖家；没有就记下来，不去猜
        const matched = cur.nos.some(no => orders.includes(no));
        next.out = Object.assign({}, q.out, { [header()]: Object.assign({ at: Date.now(), orders, first: (msgs[0] || {}).time || '', byNick: cur.nick, matched },
          I.chatAnalyze(msgs, { taxId: q.taxId })) });
      } else next.failed = (q.failed || []).concat(cur.shop);
      if (next.items.length) {
        await chrome.storage.local.set({ chatQueue: next });
        await sleep(800 + Math.random() * 800);
        goChat(next.items[0].nick);
        return true;
      }
      await chrome.storage.local.remove('chatQueue');
      await chrome.storage.local.set({ chatScan: { at: Date.now(), convs: next.out } });
      panel.set('看完 ' + total + ' 个会话（其中 ' + q.done + ' 个在列表里、' + (total - q.done) + ' 个按旺旺名打开），结果已送回分拣主页'
        + (next.failed && next.failed.length ? '；没打开：' + next.failed.join('、') : ''));
      return true;
    }

    // 输入框：聊天记录里每条消息也是 pre.edit，只有输入框是可编辑的（2026-10-03 实测）
    const inputBox = () => document.querySelector('.editBox pre.edit[contenteditable="true"]') || document.querySelector('pre.edit[contenteditable="true"]');
    const sentCount = msg => readMsgs().filter(m => m.self && squash(m.text).includes(squash(msg).slice(0, 30))).length;
    // 输入框里还是插件填的那条消息，就清掉（用户自己改过、写了别的，不动）
    function clearMine(msg) {
      const b = inputBox();
      if (b && squash(b.innerText).includes(squash(msg).slice(0, 30))) { b.focus(); document.execCommand('selectAll'); document.execCommand('delete'); }
    }
    async function resumeCompose(q, cur) {
      const n0 = q.done + 1, total = q.done + q.items.length;
      const next = Object.assign({}, q, { items: q.items.slice(1), done: q.done + 1 });
      const go = async () => {
        next.at = Date.now();
        if (next.items.length) { await chrome.storage.local.set({ chatQueue: next }); await sleep(800); goChat(next.items[0].nick); return; }
        await chrome.storage.local.remove('chatQueue');
        panel.buttons([]); panel.detail([]);
        panel.set('都处理完了：发了 ' + next.sent.length + ' 家' + (next.skipped.length ? '，跳过 ' + next.skipped.length + ' 家（' + next.skipped.join('、') + '）' : '') + '。卖家回复后，在分拣主页点「一键处理发票」');
      };
      panel.detail(cur.orders);
      // 会话名可能是旺旺名，也可能是店名；按地址打开的页面加载慢，等 30 秒（15 秒时有两家店没等到，2026-10-04）
      const isTarget = () => sameShop(cur.nick, header()) || sameShop(cur.shop, header());
      const opened = await window.otWaitFor(() => isTarget() && inputBox(), 30000);
      if (!opened) { next.skipped = next.skipped.concat(cur.shop + '（没打开，页面上是「' + (header() || '空') + '」）'); await go(); return true; }
      await sleep(1500);
      // 右边「我的订单」里要有这几单之一，才确认是这个卖家；看不到就不填（2026-10-04 用户发现消息被填进了别家的会话）
      await window.otWaitFor(() => document.querySelector('.ww_tab .order-id'), 8000);
      const orders = [...document.querySelectorAll('.ww_tab .order-id')].map(text).filter(x => /^\d{15,20}$/.test(x));
      // 右边「我的订单」只显示和这家最近的一单（2026-10-04 实测：只显示最近新拍的那单）。
      // 所以也认：会话名对得上，且右边第一行的店名就是这单的店铺
      const tabShop = ((document.querySelector('.ww_tab') || {}).innerText || '').split(String.fromCharCode(10))[0].trim();
      const matched = cur.nos.some(no => orders.includes(no)) || (isTarget() && !!tabShop && squash(tabShop) === squash(cur.shop));
      if (!matched || !isTarget()) {
        panel.set('第 ' + n0 + ' / ' + total + ' 家：' + cur.shop + '。打开的会话是「' + header() + '」，右边「我的订单」里' + (orders.length ? '没有这几单' : '看不到订单')
          + '，不确定是这家，所以没有填消息。请你自己确认后再发，或者点「跳过这家」。');
        let go2 = false;
        panel.buttons([['skip', '跳过这家']]);
        onPanel = id => { if (id === 'skip') go2 = true; };
        while (!go2) await sleep(1000);
        onPanel = null;
        next.skipped = next.skipped.concat(cur.shop + '（没认出会话）'); await go(); return true;
      }
      // 3 天内已经给这家发过带税号的消息（比如用户自己手动发的，主页还没重新扫描）：不再重复要，直接下一家
      const d3 = new Date(Date.now() - 3 * 864e5), pad = n => String(n).padStart(2, '0');
      const since3 = d3.getFullYear() + '-' + pad(d3.getMonth() + 1) + '-' + pad(d3.getDate());
      const recent = q.taxId && readMsgs().find(m => m.self && m.time >= since3 && squash(m.text).includes(squash(q.taxId)));
      if (recent) {
        const { askSent } = await chrome.storage.local.get('askSent');
        const all = Object.assign({}, askSent);
        cur.nos.forEach(no => { all[no] = Date.parse(recent.time.replace(' ', 'T')) || Date.now(); });
        await chrome.storage.local.set({ askSent: all });
        next.skipped = next.skipped.concat(cur.shop + '（' + recent.time.slice(5, 16) + ' 已经发过）');
        panel.set(cur.shop + '：' + recent.time + ' 已经发过要发票的消息，不重复发，打开下一家…');
        await sleep(1500); await go(); return true;
      }
      const before = sentCount(cur.msg);
      const box = inputBox();
      box.focus();
      if (!squash(box.innerText)) document.execCommand('insertText', false, cur.msg);   // 输入框里已经有字（用户自己在写）就不动
      let skip = false, left = false;
      if (q.auto) {
        // 用户在主页确认过清单：核对过会话后自动点「发送」（按钮也只认完整的一次点击）
        panel.set('第 ' + n0 + ' / ' + total + ' 家：' + cur.shop + '（会话「' + header() + '」，右边订单对得上）。正在自动发送…');
        await sleep(1200);
        const sb = document.querySelector('button.send-btn');
        if (sb && isTarget()) for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) sb.dispatchEvent(new MouseEvent(k, { bubbles: true, cancelable: true, view: window }));
        await window.otWaitFor(() => sentCount(cur.msg) > before, 10000);
        if (sentCount(cur.msg) <= before) panel.set('第 ' + n0 + ' / ' + total + ' 家：' + cur.shop + '。自动发送没成功，消息还在输入框里，请核对后自己点「发送」。');
      } else panel.set('第 ' + n0 + ' / ' + total + ' 家：' + cur.shop + '（会话「' + header() + '」，右边订单对得上）。要发票的消息已经填在输入框里，请核对后自己点「发送」，发完会自动打开下一家。');
      panel.buttons([['skip', '跳过这家']]);
      onPanel = id => { if (id === 'skip') skip = true; };
      const t0 = Date.now();
      while (!skip && Date.now() - t0 < 55 * 60000) {
        await sleep(500);
        if (sentCount(cur.msg) > before) break;
        // 会话切走了（用户点了别的会话，或页面自己跳了）：输入框里的字会跟着带到别的会话，马上清掉、停下
        if (!isTarget()) { clearMine(cur.msg); left = true; break; }
      }
      onPanel = null;
      if (left) {
        await chrome.storage.local.remove('chatQueue');
        panel.buttons([]); panel.detail([]);
        panel.set('会话从 ' + cur.shop + ' 切到了「' + header() + '」，为了不发错人，已把填的消息清掉，并停下了。要继续，请回分拣主页再点「给卖家发消息」。');
        return true;
      }
      if (skip || sentCount(cur.msg) <= before) {
        clearMine(cur.msg);                       // 跳过的：填的字也清掉，别留着被带到下一个会话
        next.skipped = next.skipped.concat(cur.shop); await go(); return true;
      }
      const { askSent } = await chrome.storage.local.get('askSent');
      const all = Object.assign({}, askSent);
      cur.nos.forEach(no => { all[no] = Date.now(); });
      await chrome.storage.local.set({ askSent: all });
      next.sent = next.sent.concat(cur.shop);
      panel.set('已发给 ' + cur.shop + '，正在打开下一家…');
      await sleep(q.auto ? 8000 + Math.random() * 7000 : 1500);        // 自动发时每家之间隔 8～15 秒，别太快
      await go();
      return true;
    }

    async function resumeDownload(q, cur) {
      panel.set('正在打开 ' + cur.nick + ' 下载卖家发来的文件…');
      const ids = [];
      if (await window.otWaitFor(() => sameShop(cur.nick, header()), 15000)) {
        await sleep(1200);
        for (const j of cur.jobs) {
          const find = () => [...document.querySelectorAll('.file-msg')].find(f => ((f.querySelector('.file-name') || {}).title || text(f.querySelector('.file-name'))) === j.file);
          if (!find()) await loadBack(j.time ? j.time.slice(0, 10) : '');
          const f = find(), a = f && f.querySelector('a.download-file');
          if (!a) continue;
          await window.otSend({ type: 'expectDownload', job: j });
          a.click(); ids.push(j.id);
          await sleep(2500);
        }
        await window.otSend({ type: 'jobsDone', ids });
      }
      const next = Object.assign({}, q, { items: q.items.slice(1), done: q.done + ids.length, at: Date.now() });
      if (next.items.length) { await chrome.storage.local.set({ chatQueue: next }); await sleep(800); goChat(next.items[0].nick); return true; }
      await chrome.storage.local.remove('chatQueue');
      panel.set('点了 ' + next.done + ' 个文件的下载' + (q.total > next.done ? '，' + (q.total - next.done) + ' 个没找到' : ''));
      return true;
    }

    const one = window.otQueue();
    const scan = () => one('scan', async () => {
      try {
        const { invWant, chatScan } = await chrome.storage.local.get(['invWant', 'chatScan']);
        const want = (invWant && invWant.chat) || [];
        if (!want.length) { panel.set('没有要看卖家回复的订单（都已开票、在平台申请中，或还没导入订单表）'); return; }
        if (!await window.otWaitFor(() => convItems().length, 15000)) { panel.set('会话列表还没加载出来，请稍后再点一次'); return; }
        const since = (invWant.chatSince || '').slice(0, 10);
        const out = Object.assign({}, chatScan && chatScan.convs);
        const items = convItems().filter(it => want.some(o => isConvOf(o, convName(it))));
        let k = 0;
        for (const it of items) {
          if (window.otNeedsVerify()) { alert('页面出现了安全验证，请手动完成后再点「扫描」。'); break; }
          panel.set('正在看第 ' + (++k) + ' / ' + items.length + ' 个会话：' + convName(it));
          if (!await openConv(it)) continue;
          if (!await loadBack(since)) { alert('页面出现了安全验证，请手动完成后再点「扫描」。'); break; }
          const msgs = collected();
          const orders = [...document.querySelectorAll('.ww_tab .order-id')].map(text).filter(s => /^\d{15,20}$/.test(s));
          out[header()] = Object.assign({ at: Date.now(), orders, first: (msgs[0] || {}).time || '' }, I.chatAnalyze(msgs, { taxId: invWant.taxId }));
          await sleep(800 + Math.random() * 800);
        }
        // 左侧最近会话列表里没有的店（聊得太久以前）：用订单页上这一单自己的卖家旺旺名打开，和在订单页点旺旺图标打开的是同一个会话。
        // 一家看完跳下一家（页面会重新加载），进度存在 chatQueue 里；全部看完才写 chatScan，主页的一键处理靠它往下走
        const seenNicks = new Set(Object.keys(out).map(squash));
        const queue = [], seenQ = new Set();
        for (const o of want) {
          if (!o.nick || convItems().some(it => isConvOf(o, convName(it))) || seenNicks.has(squash(o.nick)) || seenQ.has(o.nick)) continue;
          seenQ.add(o.nick);
          queue.push({ nick: o.nick, shop: o.shop, nos: want.filter(x => x.nick === o.nick).map(x => x.no) });
        }
        const noNick = [...new Set(want.filter(o => !o.nick && !convItems().some(it => isConvOf(o, convName(it)))).map(o => o.shop))];
        if (queue.length) {
          await chrome.storage.local.set({ chatQueue: { at: Date.now(), kind: 'scan', since, taxId: invWant.taxId, out, items: queue, noNick, done: items.length } });
          panel.set('列表里看完 ' + items.length + ' 个会话；还有 ' + queue.length + ' 家店不在列表里，按卖家旺旺名逐个打开…');
          return goChat(queue[0].nick);
        }
        await chrome.storage.local.set({ chatScan: { at: Date.now(), convs: out } });
        panel.set('看完 ' + items.length + ' 个会话，结果已送回分拣主页'
          + (noNick.length ? '；' + noNick.length + ' 家店不在会话列表里、也不知道卖家旺旺名（先在订单页补一次图片）' : ''));
      } catch (e) {
        panel.set('扫描出错：' + e.message);
      }
    });

    const download = () => one('download', async () => { try {
      const { dlJobs } = await chrome.storage.local.get('dlJobs');
      const jobs = (dlJobs || []).filter(j => j.kind === 'chat');
      if (!jobs.length) { panel.set('没有要下载的文件'); return; }
      await window.otWaitFor(() => convItems().length, 15000);
      const done = [], later = [];
      for (const j of jobs) {
        if (window.otNeedsVerify()) { alert('页面出现了安全验证，请手动完成后再点下载。'); break; }
        const it = convItems().find(x => sameShop(j.conv, convName(x)));
        if (!it) { later.push(j); continue; }
        if (!await openConv(it)) continue;
        const find = () => [...document.querySelectorAll('.file-msg')].find(f => ((f.querySelector('.file-name') || {}).title || text(f.querySelector('.file-name'))) === j.file);
        if (!find()) await loadBack(j.time ? j.time.slice(0, 10) : '');
        const f = find(), a = f && f.querySelector('a.download-file');
        if (!a) continue;
        await window.otSend({ type: 'expectDownload', job: j });
        a.click();
        done.push(j.id);
        panel.set('已点下载 ' + done.length + ' / ' + jobs.length + ' 个文件');
        await sleep(2500);
      }
      await window.otSend({ type: 'jobsDone', ids: done });   // 交给后台统一删，别和发票页互相盖
      if (later.length) {
        const convs = [...new Set(later.map(j => j.conv))];
        await chrome.storage.local.set({ chatQueue: { at: Date.now(), kind: 'dl', done: done.length, total: jobs.length,
          items: convs.map(c => ({ nick: c, shop: c, jobs: later.filter(j => j.conv === c) })) } });
        panel.set('点了 ' + done.length + ' 个文件的下载；还有 ' + convs.length + ' 个会话不在列表里，逐个打开去下…');
        return goChat(convs[0]);
      }
      panel.set('点了 ' + done.length + ' 个文件的下载' + (jobs.length > done.length ? '，' + (jobs.length - done.length) + ' 个没找到' : ''));
    } catch (e) { panel.set('下载出错：' + e.message); } });

    // 不放按钮：扫描、下载都由分拣主页一键派活，这里只显示进度（用户 2026-10-03：做成全自动，别让人在这里点）
    let onPanel = null;
    const panel = window.otPanel('发票回复', [], id => onPanel && onPanel(id), { top: true });
    panel.set('等分拣主页派活：扫描卖家的发票回复、下载卖家发来的文件');
    resumeQueue().then(busy => { if (!busy) window.otTakeJob(['scan', 'chatDownload'], (kind) => kind === 'scan' ? scan() : download()); });
  }
})();
