const cloud = require('wx-server-sdk');
const PDFDocument = require('pdfkit'); // 💡 纯 JS 库，无 phantomjs 等平台二进制依赖，彻底解决 ENOENT
const fs = require('fs');
const path = require('path');
const https = require('https');

// 初始化微信云开发环境
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// ================= 尺寸常量（1cm = 28.3465pt，A4: 595.28 x 841.89pt） =================
const CM = 28.3465;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 1 * CM;
const TABLE_W = 19 * CM;                                 // 表格总宽 19cm
const COLS = [4, 5.5, 4.75, 4.75].map(c => c * CM);      // 四列宽度
const ROW_H = 1 * CM;                                    // 普通行高
const PHOTO_H = 9.35 * CM;                               // 照片行高

// 内嵌中文字体（与云函数一起部署，无需运行时联网下载）
const FONT_REG = path.join(__dirname, 'fonts', 'NotoSansSC-Regular.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'NotoSansSC-Bold.ttf');
// 内嵌封面 Logo
const LOGO_PATH = path.join(__dirname, 'assets', 'asd-logo.png');

/**
 * 将项目名清洗为合法安全的文件名字段
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
 * 把图片地址统一转换为可下载的 https 地址
 * cloud:// 开头的云文件ID → 换取临时外网链接
 */
async function toImageUrl(src) {
  if (!src) return '';
  if (src.startsWith('cloud://')) {
    const res = await cloud.getTempFileURL({ fileList: [src] });
    // 💡 修复点：原代码误写为 fileList.tempFileURL，漏了数组下标 [0]
    return (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) || '';
  }
  if (src.startsWith('http')) return src;
  return '';
}

/**
 * 绘制一个带边框的单元格
 */
function cell(doc, text, x, y, w, h, { bold = false, align = 'center', size = 10.5 } = {}) {
  doc.save()
    .lineWidth(1)
    .rect(x, y, w, h)
    .stroke('#000000')
    .restore();
  if (text) {
    doc.font(bold ? 'SC-Bold' : 'SC')
      .fontSize(size)
      .fillColor('#000000')
      .text(text, x + 6, y + h / 2, { width: w - 12, align, baseline: 'middle', lineBreak: false });
  }
}

/**
 * 绘制一张查验表格（尺寸与原 HTML 版完全一致）
 */
function drawTable(doc, item, imgBuf1, imgBuf2, itemNo) {
  const x0 = MARGIN;
  const c0 = x0;
  const c1 = c0 + COLS[0];
  const c2 = c1 + COLS[1];
  const c3 = c2 + COLS[2];
  const w23 = COLS[1] + COLS[2] + COLS[3]; // 后三列合计宽

  let y = doc.y + CM; // 💡 表格间距固定 1cm
  const totalH = ROW_H * 4 + PHOTO_H;
  // 剩余空间不足时换页（留 0.5pt 容差，保证一页能放下两张表 + 1cm 间距）
  if (y + totalH > PAGE_H - MARGIN + 0.5) {
    doc.addPage();
    y = MARGIN;
  }

  // 第一行：查验子项（带 3 位序号：查验子项001/002/...）
  cell(doc, `查验子项${pad3(itemNo)}`, c0, y, COLS[0], ROW_H, { bold: true });
  cell(doc, item.subItemName || '', c1, y, w23, ROW_H, { align: 'left' });
  y += ROW_H;

  // 第二行：表头
  cell(doc, '现场拍摄影像', c0, y, COLS[0] + COLS[1], ROW_H, { bold: true });
  cell(doc, '现场拍摄数据', c2, y, COLS[2] + COLS[3], ROW_H, { bold: true });
  y += ROW_H;

  // 第三行：照片
  cell(doc, '', c0, y, COLS[0] + COLS[1], PHOTO_H);
  cell(doc, '', c2, y, COLS[2] + COLS[3], PHOTO_H);
  if (imgBuf1) {
    doc.image(imgBuf1, c0 + 4, y + 4, { fit: [COLS[0] + COLS[1] - 8, PHOTO_H - 8], align: 'center', valign: 'center' });
  }
  if (imgBuf2) {
    doc.image(imgBuf2, c2 + 4, y + 4, { fit: [COLS[2] + COLS[3] - 8, PHOTO_H - 8], align: 'center', valign: 'center' });
  }
  y += PHOTO_H;

  // 第四行：拍摄位置
  cell(doc, '拍摄位置', c0, y, COLS[0], ROW_H, { bold: true });
  cell(doc, item.location || '', c1, y, w23, ROW_H, { align: 'left' });
  y += ROW_H;

  // 第五行：拍摄说明
  cell(doc, '拍摄说明', c0, y, COLS[0], ROW_H, { bold: true });
  cell(doc, item.description || '', c1, y, w23, ROW_H, { align: 'left' });
  y += ROW_H;

  doc.y = y;
}

/**
 * 绘制封面
 */
function drawCover(doc, projectName, projectDate) {
  // 左上角 Logo（距 A4 上边缘 2cm、左边 1cm）
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, MARGIN, 2 * CM, { width: 2.02 * CM, height: 1.58 * CM });
  }

  // 封面标题（4cm 处，26pt 加粗居中）
  doc.font('SC-Bold').fontSize(26).fillColor('#000000')
    .text(projectName || '', MARGIN, 4 * CM, { width: TABLE_W, align: 'center', lineBreak: false });

  // 副标题（6.417cm 处，24pt 加粗居中）
  doc.font('SC-Bold').fontSize(24)
    .text('消防查验阶段图片资料', MARGIN, 6.417 * CM, { width: TABLE_W, align: 'center', lineBreak: false });

  // 公司名（距底部 3.494cm，14pt）
  doc.font('SC').fontSize(14)
    .text('江苏安仕达消防技术有限公司', MARGIN, PAGE_H - 3.494 * CM - 14, { width: TABLE_W, align: 'center', lineBreak: false });

  // 日期（距底部 2cm，14pt）
  doc.font('SC').fontSize(14)
    .text(projectDate || '', MARGIN, PAGE_H - 2 * CM - 14, { width: TABLE_W, align: 'center', lineBreak: false });
}

exports.main = async (event) => {
  // 1. 接收从小程序前端传过来的数据（项目名、日期、查验子项数组）
  const { projectName, projectDate, checkItems = [] } = event;

  // 2. 创建 PDF 文档并注册内嵌中文字体
  const doc = new PDFDocument({
    size: 'A4',
    // 💡 修复点：bottom 设为 0，禁用 pdfkit 文本自动分页
    // （否则贴底文字会被强制挪到新页，导致最后一行单元格文字和边框分家）
    // 分页完全由 drawTable 中的自定义逻辑控制
    margins: { top: MARGIN, bottom: 0, left: MARGIN, right: MARGIN },
    info: { Title: projectName || '消防查验报告' }
  });
  doc.registerFont('SC', FONT_REG);
  doc.registerFont('SC-Bold', FONT_BOLD);

  // 3. 绘制封面
  drawCover(doc, projectName, projectDate);

  // 4. 逐个绘制查验表格（图片先换取外网临时链接并下载为 Buffer）
  for (let idx = 0; idx < checkItems.length; idx++) {
    const item = checkItems[idx];
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
    drawTable(doc, item, imgBuf1, imgBuf2, idx + 1);
  }

  // 5. 输出 PDF 二进制流（Buffer）
  const pdfBuffer = await new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });

  // 6. 上传到云存储并把 fileID 回传给前端（文件名以项目名统一命名）
  const uploadResult = await cloud.uploadFile({
    cloudPath: `pdf_reports/${safeFileName(projectName)}_${formatTimestamp()}.pdf`,
    fileContent: pdfBuffer
  });

  return {
    fileID: uploadResult.fileID
  };
};
