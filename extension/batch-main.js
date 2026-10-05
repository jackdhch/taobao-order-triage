// 批量开票页：在页面自己的 JS 环境（MAIN world）里发回车。
// Fusion 的日期框靠 keyCode === 13 认回车；扩展内容脚本（隔离环境）给事件补的 keyCode 页面看不见，只能在这边造事件。
// 内容脚本给要回车的输入框打上 data-ot-enter，再发 'ot-enter' 事件过来
window.addEventListener('ot-enter', () => {
  const el = document.querySelector('[data-ot-enter]');
  if (!el) return;
  el.removeAttribute('data-ot-enter');
  const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'keyCode', { get: () => 13 });
  Object.defineProperty(ev, 'which', { get: () => 13 });
  el.dispatchEvent(ev);
});
