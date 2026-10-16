const cloud = require('wx-server-sdk');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, HeightRule, VerticalAlign, AlignmentType
} = require('docx'); // 💡 纯 JS 库，无平台二进制依赖
const fs = require('fs');
const path = require('path');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// ================= 尺寸常量（Word 内部单位 twips：1cm = 567 twips） =================
const TWIP = 567;
// A4 内容区 19cm，四列：4 / 5.5 / 4.75 / 4.75 cm
const COL_W = [2268, 3119, 2693, 2693];
const W23 = COL_W[1] + COL_W[2] + COL_W[3];   // 后三列合计
const W01 = COL_W[0] + COL_W[1];              // 前两列合计
const W23P = COL_W[2] + COL_W[3];             // 后两列合计
// 💡 修复点：Word 对行高的计算比 PDF 多出边框/最小行高等开销，
// 普通行 0.95cm、照片行 8.91cm（加 1cm 顶锚点段后仍留 0.13cm 富余，杜绝跨页）
const ROW_H = 537;                            // 普通行高 0.95cm
const PHOTO_H = 5050;                         // 照片行高 8.91cm

const LOGO_PATH = path.join(__dirname, 'assets', 'asd-logo.png');

// cm 转 Word 图片像素（1cm ≈ 37.8px）
const cmToPx = cm => Math.round(cm * 37.8);

/**
 * 通过 https 下载图片为 Buffer（支持一次重定向）
 */
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`图片下载失败 HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * cloud:// 开头的云文件ID → 换取临时外网链接
 */
async function toImageUrl(src) {
  if (!src) return '';
  if (src.startsWith('cloud://')) {
    const res = await cloud.getTempFileURL({ fileList: [src] });
    return (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) || '';
  }
  if (src.startsWith('http')) return src;
  return '';
}

/**
 * 根据文件头魔数识别图片类型（docx v9 的 ImageRun 需要显式 type）
 */
function sniffImageType(buf) {
  if (buf && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  return 'jpg';
}

/**
 * 从图片二进制读取原始宽高（像素），不依赖任何图片库
 * - PNG: 解析 IHDR 头（字节 16-23）
 * - JPEG: 扫描 SOF0/SOF2 标记
 */
function getImageDimensions(buf) {
  if (!buf || buf.length < 24) return { w: 1, h: 1 };
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: 逐个标记扫描
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 1) {
      if (buf[i] !== 0xFF) return { w: 1, h: 1 };
      const marker = buf[i + 1];
      i += 2;
      if (marker === 0xC0 || marker === 0xC2) {
        return { w: buf.readUInt16BE(i + 5), h: buf.readUInt16BE(i + 3) };
      }
      if (i + 1 >= buf.length) break;
      i += buf.readUInt16BE(i);
    }
  }
  return { w: 1, h: 1 };
}

/**
 * 将项目名清洗为合法安全的文件名字段（去除文件系统非法字符、压缩空白、限长）
 */
function safeFileName(name) {
  if (!name) return '未命名项目';
  return String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 50) || '未命名项目';
}

/**
 * 数字补零到 3 位（1 → 001，12 → 012，123 → 123）
 */
function pad3(n) {
  const s = String(n);
  return s.length >= 3 ? s : '0'.repeat(3 - s.length) + s;
}

/**
 * 把当前时间格式化为 YYYYMMDDhhmm（例：2026年10月10日12:15 → 202610101215）
 */
function formatTimestamp(d) {
  d = d || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * 文本单元格
 */
function textCell(text, { width, colSpan = 1, bold = false, align = AlignmentType.CENTER, keepNext = false } = {}) {
  return new TableCell({
    columnSpan: colSpan,
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    // 💡 修复点：清除单元格默认内边距，段落段前/段后归零，保证 EXACT 行高不被打爆
    margins: { top: 0, bottom: 0, left: 108, right: 108 },
    children: [new Paragraph({
      alignment: align,
      keepNext, // 💡 防止表格被拆到两页
      spacing: { before: 0, after: 0, line: 240, lineRule: 'exact' },
      children: [new TextRun({ text: text || '', bold, font: 'SimSun', size: 21 })]
    })]
  });
}

/**
 * 照片单元格（含图片则等比缩放居中嵌入）
 */
function photoCell(buf, width, keepNext = false) {
  let imageRun = null;
  if (buf) {
    // 单元格可显示的最大区域，保持原图比例（照片行高 8.91cm，图片略小防止裁切）
    const MAX_W = cmToPx(9.1);
    const MAX_H = cmToPx(8.7);
    const { w: natW, h: natH } = getImageDimensions(buf);
    const ratio = natW / natH;
    let w, h;
    if (MAX_W / MAX_H > ratio) {
      // 单元格更宽，按高度限制
      h = MAX_H;
      w = Math.round(MAX_H * ratio);
    } else {
      w = MAX_W;
      h = Math.round(MAX_W / ratio);
    }
    imageRun = new ImageRun({
      type: sniffImageType(buf),
      data: buf,
      transformation: { width: w, height: h }
    });
  }
  const children = [new Paragraph({
    alignment: AlignmentType.CENTER,
    keepNext,
    spacing: { before: 0, after: 0 },
    children: imageRun ? [imageRun] : []
  })];
  return new TableCell({
    columnSpan: 2,
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    children
  });
}

/**
 * 构建一张查验表格（结构与 PDF 版一致）
 * 💡 前四行所有段落加 keepNext、所有行加 cantSplit，保证整张表永远不被拆到两页
 */
function buildTable(item, imgBuf1, imgBuf2, itemNo) {
  const textRow = (cells, { keepNext = true } = {}) => new TableRow({
    cantSplit: true,
    height: { value: ROW_H, rule: HeightRule.EXACT },
    children: cells
  });

  return new Table({
    width: { size: W23 + COL_W[0], type: WidthType.DXA },
    columnWidths: COL_W,
    rows: [
      // 第一行：查验子项（带 3 位序号：查验子项001/002/...）
      textRow([
        textCell(`查验子项${pad3(itemNo)}`, { width: COL_W[0], bold: true }),
        textCell(item.subItemName, { width: W23, colSpan: 3, align: AlignmentType.LEFT })
      ]),
      // 第二行：表头
      textRow([
        textCell('现场拍摄影像', { width: W01, colSpan: 2, bold: true }),
        textCell('现场拍摄数据', { width: W23P, colSpan: 2, bold: true })
      ]),
      // 第三行：照片
      new TableRow({
        cantSplit: true,
        height: { value: PHOTO_H, rule: HeightRule.EXACT },
        children: [
          photoCell(imgBuf1, W01, true),
          photoCell(imgBuf2, W23P, true)
        ]
      }),
      // 第四行：拍摄位置
      textRow([
        textCell('拍摄位置', { width: COL_W[0], bold: true }),
        textCell(item.location, { width: W23, colSpan: 3, align: AlignmentType.LEFT })
      ]),
      // 第五行：拍摄说明（最后一行不加 keepNext，允许与后续内容分页）
      textRow([
        textCell('拍摄说明', { width: COL_W[0], bold: true, keepNext: false }),
        textCell(item.description, { width: W23, colSpan: 3, align: AlignmentType.LEFT, keepNext: false })
      ], { keepNext: false })
    ]
  });
}

exports.main = async (event) => {
  // 1. 接收前端数据
  const { projectName, projectDate, checkItems = [] } = event;

  // 2. 逐项下载照片为 Buffer
  const itemData = [];
  for (const item of checkItems) {
    let imgBuf1 = null;
    let imgBuf2 = null;
    try {
      const url1 = await toImageUrl(item.photoImage);
      if (url1) imgBuf1 = await downloadBuffer(url1);
    } catch (e) {
      console.error('影像图片下载失败', e.message);
    }
    try {
      const url2 = await toImageUrl(item.photoData);
      if (url2) imgBuf2 = await downloadBuffer(url2);
    } catch (e) {
      console.error('数据图片下载失败', e.message);
    }
    itemData.push({ item, imgBuf1, imgBuf2 });
  }

  // 3. 封面段落（Logo 距顶约 2cm，标题约 4cm，公司/日期推到页面下部）
  const coverChildren = [];
  if (fs.existsSync(LOGO_PATH)) {
    coverChildren.push(new Paragraph({
      spacing: { before: 2 * TWIP },
      children: [new ImageRun({
        type: 'png',
        data: fs.readFileSync(LOGO_PATH),
        transformation: { width: cmToPx(2.02), height: cmToPx(1.58) }
      })]
    }));
  }
  coverChildren.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: Math.round(0.5 * TWIP) },
      children: [new TextRun({ text: projectName || '', bold: true, font: 'SimSun', size: 52 })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: Math.round(1.5 * TWIP) },
      children: [new TextRun({ text: '消防查验阶段图片资料', bold: true, font: 'SimSun', size: 48 })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 16 * TWIP },
      children: [new TextRun({ text: '江苏安仕达消防技术有限公司', font: 'SimSun', size: 28 })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: Math.round(0.8 * TWIP) },
      children: [new TextRun({ text: projectDate || '', font: 'SimSun', size: 28 })]
    })
  );

  // 4. 表格段落（表与表之间空 1cm；section 2 开头加 0 高度锚点段，强制首张表遵守 1cm 页边距）
  const tableChildren = [
    new Paragraph({
      spacing: { before: 0, after: 0, line: 20, lineRule: 'exact' },
      children: []
    })
  ];
  itemData.forEach(({ item, imgBuf1, imgBuf2 }, idx) => {
    tableChildren.push(buildTable(item, imgBuf1, imgBuf2, idx + 1));
    if (idx !== itemData.length - 1) {
      // 💡 修复点：用固定行高 1cm 的空段落做间距，避免 Word 默认行高撑大
      tableChildren.push(new Paragraph({
        spacing: { before: 0, after: 0, line: TWIP, lineRule: 'exact' },
        children: []
      }));
    }
  });

  // 5. 组装文档：封面一个 section，表格一个 section（自动从新页开始）
  const doc = new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: TWIP, bottom: TWIP, left: TWIP, right: TWIP } }
        },
        children: coverChildren
      },
      {
        properties: {
          page: { margin: { top: TWIP, bottom: TWIP, left: TWIP, right: TWIP } }
        },
        children: tableChildren
      }
    ]
  });

  // 6. 输出 Word 二进制流
  const wordBuffer = await Packer.toBuffer(doc);

  // 7. 上传云存储并回传 fileID（文件名以项目名命名）
  const uploadResult = await cloud.uploadFile({
    cloudPath: `word_reports/${safeFileName(projectName)}_${formatTimestamp()}.docx`,
    fileContent: wordBuffer
  });

  return {
    fileID: uploadResult.fileID
  };
};
