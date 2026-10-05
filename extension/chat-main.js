// 跑在旺旺页自身环境（world MAIN、document_start、每个框架）：记下页面想新开的开票申请页地址。
// 插件代点开票卡片上的「去申请」时，合成的点击不算用户操作，页面调用 window.open 可能被浏览器的弹窗拦截挡下（返回 null）。
// 这里只包一层 window.open：照常打开，把地址和是否被拦写在 <html data-ot-open> 上，extension/chat.js 读到「被拦」就交给后台打开。
// 只记淘宝发票网站的地址，别的不碰
(() => {
  if (window.__otOpenHook) return;
  window.__otOpenHook = 1;
  const orig = window.open;
  window.open = function (url) {
    const w = orig.apply(this, arguments);
    try {
      const u = new URL(String(url), location.href).href;
      if (/^https:\/\/invoice-ua\.taobao\.com\//.test(u)) document.documentElement.setAttribute('data-ot-open', JSON.stringify({ url: u, blocked: !w, at: Date.now() }));
    } catch (e) { /* 地址不合法：不记 */ }
    return w;
  };
})();
