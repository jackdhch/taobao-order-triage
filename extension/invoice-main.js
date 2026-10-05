// 跑在「全部发票」页自己的脚本环境里（manifest 里 world: MAIN）。
// 淘宝的「下载到本地」是临时造一个指向阿里云发票 PDF 的 <a download> 再点它（2026-09 实测）；扩展代点时浏览器不认，
// 什么都不发生。所以只在扩展正在下载时（<html data-ot-dl="订单号">）把这个地址截下来交给扩展，由扩展的下载功能去存；
// 平时用户亲手点，原样放行
(() => {
  const OK = /^https:\/\/([\w-]+\.)*(aliyuncs\.com|invoice-ua\.taobao\.com)\//i;
  const grab = url => {
    const no = document.documentElement.dataset.otDl;
    if (!no || !OK.test(String(url || ''))) return false;
    window.postMessage({ otInvoiceUrl: String(url), no }, location.origin);
    return true;
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (!grab(this.href)) return click.apply(this, arguments); };
  const open = window.open;
  window.open = function (url) { return grab(url) ? null : open.apply(this, arguments); };
})();
