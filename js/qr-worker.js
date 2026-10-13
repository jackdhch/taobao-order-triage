// 在后台线程里读二维码（js/qr-scan.js 的多尝试）：拍屏大图一次 jsQR 可能要一两秒，放在主页线程里界面会卡。
// 主页发来 { id, blob, budget }（图片文件本身），这里解码成位图、取像素、逐个尝试，回 { id, text }（读不出是 ''）
importScripts('../vendor/jsqr/jsQR.js', 'qr-scan.js');
self.onmessage = async e => {
  const { id, blob, budget } = e.data || {};
  try {
    const bmp = await createImageBitmap(blob);
    const img = self.QrScan.pixels(bmp);
    bmp.close();
    self.postMessage({ id, text: self.QrScan.scanSync(img, self.jsQR, { budget }) });
  } catch (err) {
    self.postMessage({ id, text: '', err: String((err && err.message) || err) });
  }
};
