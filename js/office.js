/*
 * office —— 零依赖生成最小的 xlsx（报销清单）和 docx（用途说明草稿），浏览器和 Node 共用。
 * 两种文件本身都是 zip 包，用 js/zip.js 打包（只打包不压缩）；Excel、WPS、LibreOffice 都能打开。
 *   makeXlsx([{ name: '报销清单', rows: [[表头…], [值…]], widths: [列宽…] }]) → Uint8Array
 *     文字用 inlineStr（不另建共享字符串表）；数字写成数值、两位小数显示；第一行加粗并冻结
 *   makeDocx({ title, paras: ['一段', …], images: [{ data: Uint8Array, type: 'jpeg' | 'png', w, h }] }) → Uint8Array
 *     图片按页宽缩放、内嵌在文末（word/media/…）
 */
(function (root) {
  'use strict';
  const Z = typeof module !== 'undefined' && module.exports ? require('./zip.js') : root.Zip;
  const enc = new TextEncoder();
  // XML 里不允许的控制字符去掉，五个特殊字符转义
  const x = s => String(s == null ? '' : s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, '')
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const file = (name, text) => ({ name, data: enc.encode(HEAD + text) });

  // ── xlsx ──
  const col = i => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
  function sheetXml(sh) {
    const rows = sh.rows || [];
    const cols = (sh.widths || []).map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('');
    const body = rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((v, ci) => {
      const ref = col(ci) + (ri + 1);
      if (v == null || v === '') return '';
      // 数字（金额）写成数值，样式 2 = 两位小数；表头（第一行）样式 1 = 加粗
      if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"' + (ri ? ' s="2"' : ' s="1"') + '><v>' + v + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr"' + (ri ? '' : ' s="1"') + '><is><t xml:space="preserve">' + x(v) + '</t></is></c>';
    }).join('') + '</row>').join('');
    return '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheetViews><sheetView workbookViewId="0">' + (rows.length > 1 ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '') + '</sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>' + (cols ? '<cols>' + cols + '</cols>' : '') + '<sheetData>' + body + '</sheetData></worksheet>';
  }
  function makeXlsx(sheets, when) {
    const n = sheets.length, ws = (i, f) => sheets.map((s, j) => f(s, j + 1)).join('');
    return Z.makeZip([
      file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + ws(0, (s, i) => '<Override PartName="/xl/worksheets/sheet' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
      file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
      file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        // 工作表名最长 31 字、不能有 []:*?/\
        + ws(0, (s, i) => '<sheet name="' + x(String(s.name || 'Sheet' + i).replace(/[[\]:*?/\\]/g, '').slice(0, 31)) + '" sheetId="' + i + '" r:id="rId' + i + '"/>') + '</sheets></workbook>'),
      file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + ws(0, (s, i) => '<Relationship Id="rId' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + i + '.xml"/>')
        + '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
      file('xl/styles.xml', '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
        + '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'),
      ...sheets.map((s, j) => file('xl/worksheets/sheet' + (j + 1) + '.xml', sheetXml(s))),
    ], when);
  }

  // ── docx ──
  // A4 纵向，页边距 2.54 cm：版心宽 9026 缇 = 5731510 EMU（1 缇 = 635 EMU）
  const PAGE_W = 5731510, PAGE_H = 7600000;
  const para = (t, o) => '<w:p>' + (o && o.center ? '<w:pPr><w:jc w:val="center"/></w:pPr>' : '')
    + '<w:r>' + (o && o.big ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : o && o.bold ? '<w:rPr><w:b/></w:rPr>' : '') + '<w:t xml:space="preserve">' + x(t) + '</w:t></w:r></w:p>';
  function picXml(i, w, h) {
    let cx = PAGE_W, cy = Math.round(PAGE_W * h / w);
    if (cy > PAGE_H) { cy = PAGE_H; cx = Math.round(PAGE_H * w / h); }
    return '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + i + '" name="图片' + i + '"/>'
      + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="' + i + '" name="image' + i + '"/><pic:cNvPicPr/></pic:nvPicPr>'
      + '<pic:blipFill><a:blip r:embed="rIdImg' + i + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
      + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  }
  function makeDocx(d, when) {
    const imgs = (d.images || []).filter(im => im && im.data && im.w > 0 && im.h > 0);
    const ext = im => im.type === 'png' ? 'png' : 'jpeg';
    const body = (d.title ? para(d.title, { center: true, big: true }) : '')
      + (d.paras || []).map(p => typeof p === 'string' ? para(p) : para(p.text, p)).join('')
      + imgs.map((im, i) => picXml(i + 1, im.w, im.h)).join('')
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
    return Z.makeZip([
      file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + imgs.map((im, i) => '<Relationship Id="rIdImg' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + (i + 1) + '.' + ext(im) + '"/>').join('')
        + '</Relationships>'),
      file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' + body + '</w:body></w:document>'),
      ...imgs.map((im, i) => ({ name: 'word/media/image' + (i + 1) + '.' + ext(im), data: im.data })),
    ], when);
  }

  const api = { makeXlsx, makeDocx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Office = api;
})(typeof self !== 'undefined' ? self : this);
