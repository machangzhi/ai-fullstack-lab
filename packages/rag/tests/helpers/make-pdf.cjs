/**
 * 测试辅助：在内存里生成多页 PDF（Week 5 Day 2）。
 *
 * 使用 pdf-lib 生成标准 xref 的 PDF，保证老版本 pdf.js 也能解析；
 * 夹具文本用英文，避免内置字体不支持中文导致生成失败。
 */

const { PDFDocument, StandardFonts } = require('pdf-lib');

async function createPdf(pages, title) {
  const document = await PDFDocument.create();
  document.setTitle(title);
  const font = await document.embedFont(StandardFonts.Helvetica);

  for (const lines of pages) {
    const page = document.addPage([595, 842]);
    let y = 760;
    lines.forEach((line, index) => {
      page.drawText(line, {
        x: 72,
        y,
        size: index === 0 ? 16 : 12,
        font,
      });
      y -= index === 0 ? 40 : 28;
    });
  }

  return Buffer.from(await document.save());
}

module.exports = { createPdf };
