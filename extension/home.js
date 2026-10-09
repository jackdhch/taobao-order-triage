// 插件运行的每个淘宝页面上一个小按钮「← 订单分拣」：点了切回已打开的分拣主页（没开着就新开），由后台聚焦标签页和窗口
// （用户 2026-10-08：跳到淘宝以后没有按钮能回到主页）。
// 只放在最外层页面，旺旺页的聊天框架里不放；位置避开淘宝的关键按钮：一般放右上角，
// 旺旺页右下角是输入框和「发送」、右上角是插件的进度面板，所以放左下角（会话列表底部）
(() => {
  if (window.top !== window || window.__otHome) return;
  window.__otHome = 1;
  const add = () => {
    if (!document.body || document.getElementById('ot-home')) return;
    const b = document.createElement('button');
    b.id = 'ot-home';
    b.type = 'button';
    b.textContent = '← 订单分拣';
    b.title = '回到订单分拣主页（已打开就切换过去，没有则新开）';
    const im = /^https:\/\/market\.m\.taobao\.com\/app\/im\//.test(location.href);
    // z-index 比插件面板（2147483647）低一层：面板展开时盖在按钮上面也没关系，两者不在同一个角
    b.setAttribute('style', 'position:fixed;' + (im ? 'left:12px;bottom:12px' : 'right:12px;top:10px') + ';z-index:2147483646;margin:0;'
      + 'font:12px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;padding:3px 10px;border-radius:14px;border:1px solid #1c6e8c;'
      + 'background:#fff;color:#1c6e8c;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15);opacity:.92;white-space:nowrap');
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'goHome' }).catch(() => {});
    });
    document.body.appendChild(b);
  };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
  // 有的淘宝页面会整页重画 body：按钮被冲掉了再补上
  setInterval(add, 3000);
})();
