# 第三方库（原样拷贝，不改动）

插件不从网上加载任何代码，用到的开源库都放在这里。升级时从 npm 下载同名包，拷贝同样的文件替换即可。

| 目录 | 包 | 版本 | 许可证 | 用途 | 拷贝的文件 |
|---|---|---|---|---|---|
| jsqr/ | [jsqr](https://www.npmjs.com/package/jsqr) | 1.4.0 | Apache-2.0 | 读卖家发来的发票二维码 | dist/jsQR.js |
| pdfjs/ | [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist)（Mozilla PDF.js） | 6.3.289 | Apache-2.0 | 读发票 PDF 里的号码、日期、金额，用于去重 | build/pdf.min.mjs、build/pdf.worker.min.mjs、cmaps/（整个文件夹：没嵌字体的中日韩 PDF 要靠它才读得出字） |
