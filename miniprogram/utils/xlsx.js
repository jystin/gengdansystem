/**
 * 极简 XLSX 生成器（零依赖，纯 JS，不依赖任何 wx API —— 便于在 Node 里单测）
 *
 * 背景：之前导出走的是「HTML 内容 + .xls 后缀」的伪 Excel。
 *   - 手机端：微信文档预览器是网页内核，能直接渲染 HTML，所以看起来正常
 *   - 电脑端：微信 Windows/Mac 版的内置文档预览对 .xls 支持极差
 *     （社区已确认 PC 端实际只稳定支持 doc/docx/pdf），直接报「文件无法打开」；
 *     就算强行用 Excel 打开，也会因为「内容与扩展名不符」弹格式警告
 *
 * 所以这里直接生成**真正的 xlsx**（OOXML = ZIP + 若干 XML），
 * 任何 Excel / WPS / 在线表格都能无警告打开。
 *
 * XLSX 最小构成：
 *   [Content_Types].xml
 *   _rels/.rels
 *   xl/workbook.xml
 *   xl/_rels/workbook.xml.rels
 *   xl/styles.xml
 *   xl/worksheets/sheet1.xml
 *
 * ZIP 用 STORE（不压缩）：xlsx 允许未压缩条目，省掉 deflate 实现，体积对报表来说完全够用。
 */

// ===================== UTF-8 编码 =====================
// 小程序环境不保证有 TextEncoder，自己实现，同时正确处理代理对（emoji / 扩展汉字）

function utf8Bytes(str) {
  const s = String(str)
  const out = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // 代理对：合并成码点再编 4 字节
      const c2 = s.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        )
      } else {
        out.push(0xef, 0xbf, 0xbd) // 落单的代理项 → U+FFFD
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  const arr = new Uint8Array(out.length)
  for (let i = 0; i < out.length; i++) arr[i] = out[i]
  return arr
}

// ===================== CRC32 =====================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ===================== ZIP（STORE 模式） =====================

// DOS 时间戳固定为 1980-01-01 00:00（ZIP 允许的最小合法值），避免依赖本地时区
const DOS_TIME = 0
const DOS_DATE = 0x21

/**
 * 把若干文件打成 ZIP（不压缩）
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {ArrayBuffer}
 */
function zipStore(files) {
  const local = [] // 本地文件头 + 数据
  const central = [] // 中央目录
  let offset = 0

  files.forEach((f) => {
    const name = utf8Bytes(f.name)
    const crc = crc32(f.data)
    const size = f.data.length

    const lh = new Uint8Array(30 + name.length)
    const dv = new DataView(lh.buffer)
    dv.setUint32(0, 0x04034b50, true) // 本地文件头签名
    dv.setUint16(4, 20, true) // 解压所需版本 2.0
    dv.setUint16(6, 0x0800, true) // 标志位：文件名为 UTF-8
    dv.setUint16(8, 0, true) // 压缩方法 0 = STORE
    dv.setUint16(10, DOS_TIME, true)
    dv.setUint16(12, DOS_DATE, true)
    dv.setUint32(14, crc, true)
    dv.setUint32(18, size, true) // 压缩后大小
    dv.setUint32(22, size, true) // 原始大小
    dv.setUint16(26, name.length, true)
    dv.setUint16(28, 0, true) // 扩展字段长度
    lh.set(name, 30)

    local.push(lh, f.data)

    const ch = new Uint8Array(46 + name.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true) // 中央目录签名
    cv.setUint16(4, 20, true) // 创建版本
    cv.setUint16(6, 20, true) // 解压所需版本
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, DOS_TIME, true)
    cv.setUint16(14, DOS_DATE, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint16(30, 0, true) // 扩展字段
    cv.setUint16(32, 0, true) // 注释
    cv.setUint16(34, 0, true) // 起始磁盘号
    cv.setUint16(36, 0, true) // 内部属性
    cv.setUint32(38, 0, true) // 外部属性
    cv.setUint32(42, offset, true) // 本地文件头偏移
    ch.set(name, 46)

    central.push(ch)
    offset += lh.length + size
  })

  const cdSize = central.reduce((s, c) => s + c.length, 0)

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true) // 中央目录结束记录签名
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true) // 注释长度

  const parts = local.concat(central, [eocd])
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  parts.forEach((part) => {
    out.set(part, p)
    p += part.length
  })
  return out.buffer
}

/** Uint8Array → ArrayBuffer（精确切片，避免带上多余 buffer） */
function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

// ===================== XML 辅助 =====================

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 不允许的控制字符，直接剔除，否则 Excel 会判定文件损坏
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

/** 1 → A, 26 → Z, 27 → AA */
function colLetter(n) {
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// ===================== 样式表 =====================
// 单元格样式索引（调用方用这些常量，避免魔法数字散落各处）
const STYLE = {
  DEFAULT: 0, // 普通文本，有边框
  HEADER: 1, // 表头：白字 + 青底 + 加粗 + 居中
  GROUP: 2, // 分组标题：白字 + 青底 + 加粗 + 左对齐
  SUBHEAD: 3, // 次级表头：加粗 + 浅绿底
  NUMBER: 4, // 数值：加粗 + 居中
  CENTER: 5, // 普通居中
  HEADER_GRAY: 6, // 表头（浅灰底）：加粗
  TITLE: 7, // 大标题：加粗 + 无边框
  WARN: 8 // 待处理：浅黄底
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="4"><font><sz val="11"/><name val="宋体"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="宋体"/></font><font><b/><sz val="11"/><name val="宋体"/></font><font><b/><sz val="14"/><name val="宋体"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0FDF4"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF3CD"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD0D7DE"/></left><right style="thin"><color rgb="FFD0D7DE"/></right><top style="thin"><color rgb="FFD0D7DE"/></top><bottom style="thin"><color rgb="FFD0D7DE"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

// ===================== 工作表 =====================

/**
 * 单元格 → XML
 * 支持三种写法：原始值（string|number）、{ v, s }、null/''（空）
 */
function cellXml(ref, cell) {
  let v = cell
  let s = 0
  if (cell && typeof cell === 'object') {
    v = cell.v
    s = cell.s || 0
  }
  const sAttr = s ? ` s="${s}"` : ''

  if (v === null || v === undefined || v === '') {
    // 空格子也要输出，否则背景色/边框会断掉
    return s ? `<c r="${ref}"${sAttr}/>` : ''
  }

  if (typeof v === 'number' && isFinite(v)) {
    return `<c r="${ref}"${sAttr}><v>${v}</v></c>`
  }
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`
}

/**
 * 生成 sheet XML
 * @param {Object} sheet
 * @param {Array<number>} [sheet.cols]   列宽（可选，按 1-based 顺序）
 * @param {Array<Array>}  sheet.rows     行 × 列 的单元格二维数组
 * @param {Array<string>} [sheet.merges] 合并单元格引用，如 'A1:G1'
 */
function sheetXml(sheet) {
  const rows = sheet.rows || []
  const rowParts = rows.map((cells, ri) => {
    const r = ri + 1
    const cellParts = (cells || [])
      .map((cell, ci) => cellXml(`${colLetter(ci + 1)}${r}`, cell))
      .filter(Boolean)
    if (cellParts.length === 0) return ''
    return `<row r="${r}">${cellParts.join('')}</row>`
  }).filter(Boolean)

  const colsXml = sheet.cols && sheet.cols.length
    ? `<cols>${sheet.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : ''

  const merges = sheet.merges || []
  const mergesXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    : ''

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${rowParts.join('')}</sheetData>${mergesXml}</worksheet>`
}

// ===================== 对外入口 =====================

/**
 * 生成 .xlsx 文件内容
 * @param {Object} sheet
 * @param {string} [sheet.name]  工作表名（默认 Sheet1，Excel 限制 ≤31 字符且不含 : \ / ? * [ ]）
 * @param {Array}  sheet.rows    二维数组
 * @param {Array<number>} [sheet.cols]
 * @param {Array<string>} [sheet.merges]
 * @returns {ArrayBuffer}
 */
function buildXlsx(sheet) {
  const rawName = String((sheet && sheet.name) || 'Sheet1')
  const name = rawName.replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet1'

  const files = [
    {
      name: '[Content_Types].xml',
      data: utf8Bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`)
    },
    {
      name: '_rels/.rels',
      data: utf8Bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
    },
    {
      name: 'xl/workbook.xml',
      data: utf8Bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`)
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8Bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
    },
    { name: 'xl/styles.xml', data: utf8Bytes(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8Bytes(sheetXml(sheet)) }
  ]

  return zipStore(files)
}

module.exports = {
  buildXlsx,
  STYLE,
  // 下面几个导出主要是给单测用的
  utf8Bytes,
  crc32,
  colLetter,
  zipStore,
  toArrayBuffer
}
