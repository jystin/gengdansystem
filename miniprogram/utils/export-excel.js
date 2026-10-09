/**
 * 导出工具（统一入口）
 *
 * ============ 平台策略 ============
 * 电脑端（微信 Windows / Mac）：
 *     生成**真正的 .xlsx**，用 wx.saveFileToDisk 弹系统「另存为」对话框，
 *     用户存到任意目录后双击即可用 Excel / WPS 打开。
 *     为什么不走 wx.openDocument：官方文档虽标注支持 Windows/Mac 版，但实测
 *     PC 端内置文档预览对 xls/xlsx 支持极差，直接报「文件无法打开」。
 * 移动端（iOS / Android）：
 *     同样生成真 .xlsx，用 wx.openDocument 预览（xlsx 是官方支持的主流格式）；
 *     万一预览失败，回退成 HTML 表格（.xls）——即旧版一直可用的那条路。
 * 开发者工具：
 *     wx.saveFileToDisk 在工具里有定义但调用必定失败，所以给明确提示而不是笼统报错。
 *
 * ============ 历史坑（别再踩）============
 * 旧实现用的是「HTML 内容 + .xls 后缀」的伪 Excel 文件：
 *   - 手机端：微信文档预览器是网页内核，能直接渲染 HTML 表格，所以「看起来正常」
 *   - 电脑端：微信 PC 版内置预览打不开 → 报「文件无法打开」
 * 所以导出一律改成真 xlsx。任何 Excel / WPS / 在线表格都能无警告打开。
 */

const xlsx = require('./xlsx')
const imageSave = require('./image-save')

const { STYLE, colLetter } = xlsx
const { platform, canSaveToDisk, isDevtools, DEVTOOLS_UNSUPPORTED } = imageSave

const fs = wx.getFileSystemManager()

// ===================== 环境判断 =====================

/** 是否移动端（保留旧导出名，供其它模块兼容调用） */
function isMobile() {
  const p = platform()
  return p === 'ios' || p === 'android' || p === 'harmonyos'
}

// ===================== 通用小工具 =====================

function fmtDate(dateStr) {
  if (!dateStr) return '未完成'
  return dateStr.includes(' ') ? dateStr.split(' ')[0] : dateStr
}

function formatNow() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** n 个空格子 */
function emptyCells(n) {
  const a = new Array(n)
  for (let i = 0; i < n; i++) a[i] = null
  return a
}

// ===================== 中立报表结构 =====================
/**
 * 一份数据、两种渲染：
 *   - 电脑端 → xlsx.buildXlsx()（真 Excel）
 *   - 手机端 → renderDocToHtml()（微信预览器可直接显示）
 * 这样两个平台看到的内容永远一致，不会出现「手机有、电脑没有」的分叉。
 */
function makeDoc(sheetName, fileName, cols) {
  const rows = []
  const merges = []
  return {
    sheetName,
    fileName,
    cols: cols || [],
    rows,
    merges,
    /** 追加一行，返回该行 1-based 行号（用于登记合并区域） */
    addRow(cells) {
      rows.push(cells || [])
      return rows.length
    },
    addBlank() {
      rows.push([])
      return rows.length
    },
    /** 合并某行的 fromCol..toCol（列号 1-based，仅支持同一行内合并） */
    mergeCells(rowNo, fromCol, toCol) {
      merges.push(`${colLetter(fromCol)}${rowNo}:${colLetter(toCol)}${rowNo}`)
    }
  }
}

/** 'B3' → { col: 2, row: 3 } */
function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)
  if (!m) return { col: 0, row: 0 }
  let col = 0
  for (let i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64)
  return { col, row: Number(m[2]) }
}

// ===================== 员工月度报表 =====================

const PROD_COLS = 7
const PROD_HEADERS = ['工单号', '客户', '工序', '配合人员', '数量(根)', '完成时间', '月份']

/**
 * 构建员工月度生产明细报表
 * @param {Array} rows - getProductionRows() 返回的行数据
 * @param {Object|null} singleEmployee - null=全部员工
 * @param {string} year
 * @param {'operate'|'program'} mode - 统计口径
 */
function buildProductionDoc(rows, singleEmployee, year, mode) {
  const isProgramMode = mode === 'program'

  const grouped = {}
  const stationOf = new Map()
  ;(rows || []).forEach((r) => {
    const k = r.employeeName || '未知'
    if (!grouped[k]) grouped[k] = []
    grouped[k].push(r)
    stationOf.set(k, r.station || '')
  })
  Object.keys(grouped).forEach((k) => {
    grouped[k].sort(
      (a, b) => String(a.monthKey || '').localeCompare(String(b.monthKey || '')) ||
        String(a.completedAt || '').localeCompare(String(b.completedAt || ''))
    )
  })

  const label = isProgramMode ? '配合明细' : '月度生产明细'
  const title = singleEmployee
    ? `${singleEmployee.employee.name} ${label} (${year})`
    : `全体员工${label} (${year})`
  const note = '数量(根)=该工序所属工单的总数量 ｜「配合人员」= 编程员（敦压/拉尾子/精车/铣方头）或调字员（打字）｜ 工单号可在系统中搜索查看详情'
  const fileName = singleEmployee
    ? `员工月度报表_${singleEmployee.employee.name}_${year}`
    : `员工月度报表_全部_${year}`
  const sheetName = singleEmployee
    ? `${singleEmployee.employee.name}${label}`
    : `${year}${label}`

  const doc = makeDoc(sheetName, fileName, [18, 14, 12, 12, 11, 20, 8])

  let r = doc.addRow([{ v: title, s: STYLE.TITLE }, ...emptyCells(PROD_COLS - 1)])
  doc.mergeCells(r, 1, PROD_COLS)
  r = doc.addRow([{ v: note, s: STYLE.DEFAULT }, ...emptyCells(PROD_COLS - 1)])
  doc.mergeCells(r, 1, PROD_COLS)
  doc.addBlank()
  doc.addRow(PROD_HEADERS.map((h) => ({ v: h, s: STYLE.HEADER_GRAY })))

  const employees = singleEmployee
    ? [singleEmployee.employee.name]
    : Object.keys(grouped).sort()

  let dataRows = 0
  employees.forEach((name) => {
    const list = grouped[name] || []
    if (list.length === 0) return

    const gr = doc.addRow([
      { v: `${name} · ${stationOf.get(name) || ''} · 共 ${list.length} 条记录`, s: STYLE.GROUP },
      ...emptyCells(PROD_COLS - 1)
    ])
    doc.mergeCells(gr, 1, PROD_COLS)

    let lastMonth = ''
    list.forEach((row) => {
      const parts = String(row.monthKey || '').split('-')
      const monthLabel = parts[1] ? `${parts[1]}月` : '-'
      // 每个月第一行加浅绿底，方便一眼分段
      const first = monthLabel !== lastMonth
      lastMonth = monthLabel

      // 配合人员：非编程员时带上角色标注（如「王五（调字员）」），方便区分口径
      const partnerText = row.programmerName
        ? (row.partnerRole && row.partnerRole !== '编程员' ? `${row.programmerName}（${row.partnerRole}）` : row.programmerName)
        : '-'

      doc.addRow([
        { v: row.orderId || '', s: first ? STYLE.SUBHEAD : STYLE.DEFAULT },
        { v: row.customerName || '-', s: first ? STYLE.SUBHEAD : STYLE.DEFAULT },
        { v: row.stepName || '', s: first ? STYLE.SUBHEAD : STYLE.DEFAULT },
        { v: partnerText, s: first ? STYLE.SUBHEAD : STYLE.DEFAULT },
        { v: Number(row.qty) || 0, s: STYLE.NUMBER },
        { v: row.completedAt || '-', s: first ? STYLE.SUBHEAD : STYLE.DEFAULT },
        { v: monthLabel, s: STYLE.CENTER }
      ])
      dataRows++
    })
  })

  if (dataRows === 0) {
    const er = doc.addRow([
      { v: '暂无生产记录', s: STYLE.DEFAULT },
      ...emptyCells(PROD_COLS - 1)
    ])
    doc.mergeCells(er, 1, PROD_COLS)
  }

  return doc
}

// ===================== 工单导出 =====================

const ORDER_HEADERS = [
  '工单号', '客户', '种类', '尺寸', '数量', '单号', '材质',
  '交货日期', '下单日期', '状态', '是否加急', '进度',
  '序号', '工序名称', '生产人员', '岗位', '完成时间', '备注'
]
const ORDER_COLS = ORDER_HEADERS.length // 18：12 列工单基础信息 + 6 列工序信息

/**
 * 构建工单导出报表（每道工序独立一行，首行带工单基础信息）
 */
function buildOrderDoc(orders, fileName) {
  const doc = makeDoc('工单导出', fileName || '工单导出', [
    16, 14, 10, 14, 8, 12, 10, 12, 12, 10, 10, 8, 6, 14, 12, 10, 18, 14
  ])
  doc.addRow(ORDER_HEADERS.map((h) => ({ v: h, s: STYLE.HEADER })))

  ;(orders || []).forEach((order) => {
    const allSteps = order.steps || []

    // 【修复】历史记录不能只用 stepKey 索引：精车1/精车2/精车3 的 key 都是 finish_turning，
    // 旧写法 `historyMap[step.key]` 会让三道精车全部显示同一条记录（后写的覆盖先写的）。
    // 历史记录是按完成顺序追加的，而同名工序的第 N 次完成必然对应列表里第 N 个同名工序，
    // 因此按「同名工序出现次序」配对 —— 同时也兼容没有 stepSeq 的老历史记录。
    const historyQueues = {}
    ;(order.history || []).forEach((h) => {
      if (!h || !h.stepKey) return
      if (!historyQueues[h.stepKey]) historyQueues[h.stepKey] = []
      historyQueues[h.stepKey].push(h)
    })
    const historyCursor = {}

    allSteps.forEach((step, index) => {
      const queue = historyQueues[step.key] || []
      const nth = (historyCursor[step.key] = (historyCursor[step.key] || 0) + 1)
      const rec = queue[nth - 1]

      const first = index === 0
      const done = !!(rec && rec.operator)
      const cells = []

      if (first) {
        const base = [
          order.id || '', order.customerName || '', order.type || '', order.size || '',
          Number(order.qty) || 0, order.singleNo || '', order.material || '',
          fmtDate(order.dueDate), fmtDate(order.orderDate), order.statusLabel || '',
          order.urgent ? '是' : '否', `${order.progress || 0}%`
        ]
        base.forEach((v) => cells.push({ v, s: STYLE.SUBHEAD }))
      } else {
        emptyCells(12).forEach((v) => cells.push({ v, s: STYLE.SUBHEAD }))
      }

      cells.push({ v: index + 1, s: STYLE.CENTER })
      cells.push({ v: step.name || '', s: first ? STYLE.SUBHEAD : STYLE.DEFAULT })

      if (done) {
        cells.push({ v: rec.operator, s: first ? STYLE.SUBHEAD : STYLE.DEFAULT })
        cells.push({ v: rec.role || step.station || '', s: first ? STYLE.SUBHEAD : STYLE.DEFAULT })
        cells.push({ v: rec.completedAt || '', s: first ? STYLE.SUBHEAD : STYLE.DEFAULT })
        cells.push({ v: rec.note || '-', s: first ? STYLE.SUBHEAD : STYLE.DEFAULT })
      } else {
        cells.push({ v: '待处理', s: STYLE.WARN })
        cells.push({ v: step.station || '', s: first ? STYLE.SUBHEAD : STYLE.DEFAULT })
        cells.push({ v: '', s: STYLE.DEFAULT })
        cells.push({ v: '', s: STYLE.DEFAULT })
      }

      doc.addRow(cells)
    })
  })

  if (doc.rows.length === 1) {
    doc.addRow([{ v: '无数据', s: STYLE.DEFAULT }, ...emptyCells(ORDER_COLS - 1)])
  }

  return doc
}

// ===================== HTML 渲染（移动端兜底）=====================

const HTML_CELL_STYLE = {
  [STYLE.DEFAULT]: '',
  [STYLE.HEADER]: 'background:#0f766e;color:#fff;font-weight:600;text-align:center;',
  [STYLE.GROUP]: 'background:#0f766e;color:#fff;font-weight:700;',
  [STYLE.SUBHEAD]: 'background:#f0fdf4;font-weight:600;',
  [STYLE.NUMBER]: 'text-align:center;font-weight:600;',
  [STYLE.CENTER]: 'text-align:center;',
  [STYLE.HEADER_GRAY]: 'background:#f1f5f9;font-weight:600;',
  [STYLE.TITLE]: 'font-size:16px;font-weight:700;border:none;',
  [STYLE.WARN]: 'background:#fff3cd;color:#92400e;'
}

function renderDocToHtml(doc) {
  // 解析合并区域：记录 colspan，并标记除左上角外需要跳过的格子
  const skip = new Set()
  const span = {}
  ;(doc.merges || []).forEach((ref) => {
    const [a, b] = ref.split(':')
    const c1 = parseRef(a)
    const c2 = parseRef(b)
    if (!c1.col || c1.row !== c2.row) return
    span[a] = c2.col - c1.col + 1
    for (let c = c1.col + 1; c <= c2.col; c++) skip.add(`${c1.row},${c}`)
  })

  const body = doc.rows.map((cells, ri) => {
    const rowNo = ri + 1
    const tds = []
    for (let ci = 0; ci < cells.length; ci++) {
      if (skip.has(`${rowNo},${ci + 1}`)) continue
      const cell = cells[ci]
      const ref = `${colLetter(ci + 1)}${rowNo}`
      let v = cell
      let s = 0
      if (cell && typeof cell === 'object') {
        v = cell.v
        s = cell.s || 0
      }
      const colspan = span[ref] ? ` colspan="${span[ref]}"` : ''
      const styleHtml = HTML_CELL_STYLE[s] ? ` style="${HTML_CELL_STYLE[s]}"` : ''
      const text = (v === null || v === undefined) ? '' : escapeHtml(v)
      tds.push(`<td${colspan}${styleHtml}>${text}</td>`)
    }
    return `<tr>${tds.join('')}</tr>`
  }).join('')

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<style>
table{border-collapse:collapse;width:100%}
td{border:1px solid #d0d7de;padding:6px 10px;font-size:12px}
</style></head>
<body><table><tbody>${body}</tbody></table></body></html>`
}

// ===================== 落盘 & 打开 =====================

function writeFile(filePath, data, encoding) {
  return new Promise((resolve, reject) => {
    const opt = { filePath, data, success: resolve, fail: reject }
    // data 为 ArrayBuffer 时不能传 encoding
    if (encoding) opt.encoding = encoding
    fs.writeFile(opt)
  })
}

function openDocument(filePath, fileType) {
  return new Promise((resolve, reject) => {
    wx.openDocument({ filePath, fileType, showMenu: true, success: resolve, fail: reject })
  })
}

function saveToDisk(filePath) {
  return new Promise((resolve, reject) => {
    if (typeof wx.saveFileToDisk !== 'function') {
      reject(new Error('当前环境不支持另存为'))
      return
    }
    wx.saveFileToDisk({ filePath, success: resolve, fail: reject })
  })
}

/**
 * 导出报表并让用户拿到文件（平台自适应）
 * @param {Object} doc - makeDoc 产出的结构
 * @returns {Promise<{mode:string, fileName:string, filePath:string}>}
 *   mode: 'disk'（电脑端另存为）| 'document'（移动端预览 xlsx）| 'document-html'（预览兜底）
 */
async function exportDoc(doc) {
  if (!doc || !doc.rows || doc.rows.length === 0) {
    throw new Error('没有可导出的数据')
  }

  const fullFileName = `${doc.fileName}_${formatNow()}.xlsx`
  const filePath = `${wx.env.USER_DATA_PATH}/${fullFileName}`

  // 一次性生成真 xlsx（ArrayBuffer 直接落盘，无编码问题）
  const buffer = xlsx.buildXlsx({
    name: doc.sheetName,
    cols: doc.cols,
    rows: doc.rows,
    merges: doc.merges
  })
  await writeFile(filePath, buffer)

  // ---------- 电脑端：真 Excel + 系统「另存为」对话框 ----------
  if (canSaveToDisk()) {
    await saveToDisk(filePath)
    return { mode: 'disk', fileName: fullFileName, filePath }
  }

  // ---------- 开发者工具：另存为必定失败 ----------
  // 先试预览（工具里可能能打开），不行再给明确提示，而不是笼统报「导出失败」
  if (isDevtools()) {
    try {
      await openDocument(filePath, 'xlsx')
      return { mode: 'document', fileName: fullFileName, filePath }
    } catch (e) {
      const err = new Error('开发者工具不支持「另存为」，请在电脑版微信中导出')
      err.code = DEVTOOLS_UNSUPPORTED
      throw err
    }
  }

  // ---------- 移动端：预览真 xlsx，失败回退 HTML ----------
  try {
    await openDocument(filePath, 'xlsx')
    return { mode: 'document', fileName: fullFileName, filePath }
  } catch (e) {
    console.warn('[export] xlsx 预览失败，回退 HTML 表格', e)
    const htmlName = `${doc.fileName}_${formatNow()}.xls`
    const htmlPath = `${wx.env.USER_DATA_PATH}/${htmlName}`
    await writeFile(htmlPath, renderDocToHtml(doc), 'utf8')
    await openDocument(htmlPath, 'xls')
    return { mode: 'document-html', fileName: htmlName, filePath: htmlPath }
  }
}

/** 导出工单（保留原调用签名，内部改为平台自适应） */
function exportOrders(orders, fileName) {
  if (!orders || orders.length === 0) {
    wx.showToast({ title: '没有可导出的工单', icon: 'none' })
    return Promise.reject(new Error('没有可导出的工单'))
  }
  return exportDoc(buildOrderDoc(orders, fileName))
}

module.exports = {
  exportDoc,
  exportOrders,
  buildProductionDoc,
  buildOrderDoc,
  renderDocToHtml,
  isMobile
}
