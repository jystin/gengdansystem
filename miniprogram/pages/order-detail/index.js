const api = require('../../utils/api')
const ui = require('../../utils/ui')
const storage = require('../../utils/cloud-storage')
const drawing = require('../../utils/drawing')
const imageSave = require('../../utils/image-save')
const localQr = require('../../utils/local-qr')
const { buildQrUrl } = require('../../utils/qr-url')

// 小程序码 fileID → 临时链接缓存（临时链接 2 小时过期）
const _wxacodeUrlCache = Object.create(null)
const _textQrUrlCache = Object.create(null)

function getQrUrlSync(order) {
  if (order && order.qrCodeFileID && _wxacodeUrlCache[order.qrCodeFileID]) {
    return _wxacodeUrlCache[order.qrCodeFileID]
  }
  return getTextQrUrlSync(order)
}

function getTextQrUrlSync(order) {
  const text = order ? (order.qrContent || order.id) : ''
  const key = `${text}_320`
  if (text && !_textQrUrlCache[key]) {
    _textQrUrlCache[key] = buildQrUrl(text, 320)
  }
  return _textQrUrlCache[key] || ''
}

function withQrUrls(order) {
  if (!order) return order
  return { ...order, qrUrl: getQrUrlSync(order), textQrUrl: getTextQrUrlSync(order) }
}

/**
 * 异步刷新小程序码临时链接（getTempFileURL 链接 2 小时过期）
 * @returns {string} 可展示的 URL
 */
async function refreshQrUrlAsync(order) {
  if (order && order.qrCodeFileID) {
    try {
      const result = await storage.getTempFileURL([order.qrCodeFileID])
      if (result && result.fileList && result.fileList[0] && result.fileList[0].tempFileURL) {
        _wxacodeUrlCache[order.qrCodeFileID] = result.fileList[0].tempFileURL
        return result.fileList[0].tempFileURL
      }
    } catch (e) { /* 降级到文本二维码 */ }
  }
  return getQrUrlSync(order)
}

/**
 * 为 steps 生成唯一 _stepKey，防止同名工序 wx:key 重复警告
 */
function ensureStepKeys(order) {
  if (!order || !Array.isArray(order.steps)) return order
  return { ...order, steps: order.steps.map((s, i) => ({ ...s, _stepKey: `${s.key}_${i}` })) }
}

Page({
  data: {
    order: null,
    note: '',
    completedQty: '',
    currentUser: { role: '', status: 'active' },
    processList: [],
    editingSteps: false,
    selectedSteps: [],
    selectedStepKeys: [],
    isAdmin: false,
    canComplete: false,
    materialTypes: [],
    materialConsumption: { material: '', roughness: '', length: '', qty: '' },
    isBlankingStep: false,
    operatorId: '',
    operatorLabel: '请选择操作员',
    activeEmployees: [],
    // 工序操作员候选：管理员 + 岗位精确匹配当前工序的员工（与后端 completeStep 校验同口径）
    operatorEmployees: [],
    currentStepStation: '',   // 当前工序岗位（如「质检员」），用于筛选操作员
    currentStepName: '',      // 当前工序名（如「质检」），用于提示文案
    // ===== 配合人员（敦压 / 拉尾子 / 精车 / 铣方头 = 编程员；打字 = 调字员，均必填）=====
    isProgrammerStep: false,
    programmerId: '',
    programmerLabel: '',       // 已选人员的显示文本（空 = 未选，显示占位符）
    programmerEmployees: [],
    programmerFallback: false, // 系统里还没配该岗位员工时的兜底标记
    partnerLabel: '编程员',     // 当前工序配合人员的称谓（由工序决定）
    partnerKeyword: '编程',     // 当前工序配合人员的岗位关键字
    // ===== 可重复工序（精车1~精车4）=====
    isRepeatableStep: false,
    repeatOptions: [],       // [{ value, label }]
    repeatTotalChoice: 1,    // 本工单该工序共需几道
    // ===== 员工选择弹层（操作员 / 编程员 共用）=====
    pickerTarget: '',        // '' | 'operator' | 'programmer'
    pickerKeyword: '',
    pickerList: [],
    pendingDrawings: [],
    drawingUrls: [],
    drawingCount: 0,
    hasDrawings: false,
    hasPending: false,
    // 二维码保存能力（电脑端可「另存为」到任意目录，移动端保存到相册）
    isDesktop: imageSave.isDesktop(),
    isDevtools: imageSave.isDevtools(),
    canSaveQrToDisk: imageSave.canSaveToDisk(),
    // 前端状态：是否正在后台补充加载（用于 UI 展示骨架屏/弱提示）
    isLoadingMore: false,
    // 小程序码重新生成状态
    qrRegenerating: false,
    // ===== 编辑工单字段 =====
    editingFields: false,
    editFieldsDraft: {}, // 顶层字段
    editDetailDraft: {}, // 图纸细节字段
    editBtnLoading: false,
    // 是否电脑端（决定图纸上传方式：文件/PDF vs 拍照）
    isDesktopPlatform: false
  },

  async onLoad(options) {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    // 支持两种进入方式：
    //   1. 页面跳转 → options.id = 工单号
    //   2. 微信扫码（小程序码）→ options.scene = 工单号
    const orderId = options.id || options.scene
    if (!orderId) {
      ui.toast('缺少工单号，请扫描有效的小程序码')
      return
    }
    this.orderId = decodeURIComponent(orderId)
    this.setData({ isDesktopPlatform: drawing.isDesktop() })
    await this.refresh({ force: true })
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  async onShow() {
    // 节流：3 秒内已刷新过则不重复刷新，避免从后台切回/页面跳转时反复请求
    if (this._lastRefreshAt && Date.now() - this._lastRefreshAt < 3000) return
    if (this._inputFocusing || this.data.hasPending) return
    await this.refresh()
  },

  /**
   * 刷新工单详情
   * @param {Object} opts
   * @param {boolean} opts.force 是否强制刷新（忽略节流）
   *
   * 分阶段加载策略：
   *   1. 首屏优先：只拿工单主数据，立即 setData 渲染核心 UI
   *   2. 后台补齐：并行加载 materialTypes / employees / drawing URLs
   *   3. 下料计算：仅在当前是下料工序时，异步计算重量/库存
   * 这样用户能最快看到工单主体，避免等待所有接口串行完成。
   */
  async refresh(opts = {}) {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    if (!this.orderId) return

    // 节流保护（非强制刷新时）
    if (!opts.force && this._lastRefreshAt && Date.now() - this._lastRefreshAt < 3000) return

    this._lastRefreshAt = Date.now()
    if (this._refreshing) return
    this._refreshing = true

    try {
      ui.showLoading('加载中...')

      // ===== Phase 1: 首屏核心数据（只请求工单，最快渲染）=====
      let order = await api.getOrder(this.orderId)

      if (!order) {
        ui.resetLoading()
        ui.toast('工单不存在')
        this.setData({ order: null })
        return
      }

      const user = app.globalData.currentUser
      const acc = this._computeAccessState(user, order)
      const { isAdmin, isBlankingStep, autoLength } = acc

      // 工序面板归属：工序变了就重置「编程员」选择（每道工序都要重新选编程员）
      const panelKey = `${order.id || this.orderId}#${acc.currentStepIndex}`
      if (this._panelKey !== panelKey) {
        this._panelKey = panelKey
        this._panelReset = true
      }

      // 确保 steps 有唯一 _stepKey（防止 wx:key 重复警告）
      order = ensureStepKeys(order)

      // 清理工单 history 中的操作员英文名
      if (order.history && Array.isArray(order.history)) {
        order.history = order.history.map(h => ({
          ...h,
          operator: api.cleanName(h.operator, '操作员')
        }))
      }

      let mcUpdate = null
      if (isBlankingStep) {
        const prevMc = this.data.materialConsumption || {}
        mcUpdate = {
          material: prevMc.material || '',
          roughness: prevMc.roughness || '',
          length: prevMc.length || autoLength,
          qty: prevMc.qty || ''
        }
      }

      // 先渲染首屏，让用户立刻看到工单主体
      // 如果当前处于编辑工序模式，则不要覆盖已选工序，避免 instanceId 丢失导致删除时清空全部
      // 异步刷新小程序码临时链接（优先 wxacode，降级文本二维码）
      const qrUrl = await refreshQrUrlAsync(order)
      this.setData({
        order: withQrUrls({ ...order, qrUrl }),
        currentUser: user,
        ...(this.data.editingSteps ? {} : {
          selectedSteps: order.steps || [],
          selectedStepKeys: (order.steps || []).map(s => s.key)
        }),
        ...this._stepPatch(acc),
        ...(this._panelReset ? { programmerId: '', programmerLabel: '' } : {}),
        drawingCount: (order.drawings || []).length + (this.data.pendingDrawings || []).length,
        hasDrawings: (order.drawings || []).length + (this.data.pendingDrawings || []).length > 0,
        ...(mcUpdate ? { materialConsumption: mcUpdate } : {})
      })
      this._panelReset = false
      ui.hideLoading()

      // ===== Phase 2: 后台并行加载参考数据（员工、材料类型）和图纸 URL =====
      this.setData({ isLoadingMore: true })
      const [materialTypes, employees] = await Promise.all([
        api.getMaterialTypes(),
        api.listEmployees()
      ])


      const activeEmployees = (employees || [])
        .filter(e => e.status === 'active' && e.role !== 'superadmin')
        .map(e => ({ ...e, name: api.cleanName(e.name, '员工'), _stationDisplay: api.getEmployeeDisplayStations(e) }))

      // 配合人员候选：岗位命中本工序 partnerKeyword 的在职员工（默认「编程」）；
      // 严格匹配，一个都没配则返回空列表并提示去员工管理配置岗位
      const progPick = api.pickPartnerEmployees(activeEmployees, acc.partnerKeyword)

      // 图纸 URL 改为懒加载：先让首屏出来，再异步换临时链接
      const drawingUrls = await this._resolveDrawingUrls(order.drawings || [])
      const pendingLen = (this.data.pendingDrawings || []).length
      const drawingCount = drawingUrls.length + pendingLen

      this.setData({
        materialTypes: materialTypes || [],
        activeEmployees,
        programmerEmployees: progPick.list,
        programmerFallback: progPick.fallback,
        drawingUrls,
        drawingCount,
        hasDrawings: drawingCount > 0,
        hasPending: pendingLen > 0,
        isLoadingMore: false,
        // 操作员候选 = 管理员 + 岗位匹配当前工序的员工；此处 activeEmployees 还没进 data，显式传入
        ...this._operatorPoolPatch(acc, activeEmployees)
      })


      // ===== Phase 3: 下料工序才需要的重量/库存计算（完全异步，不阻塞 UI）=====
      if (isBlankingStep) {
        this._updateCalcWeight()
      } else if (this.data.calcWeightInfo) {
        this.setData({ calcWeightInfo: null })
      }
    } catch (e) {
      ui.handleError(e, '加载工单失败')
    } finally {
      ui.hideLoading()
      this._refreshing = false
    }
  },

  /**
   * 批量解析图纸 fileID → 临时 URL
   * 与首屏渲染解耦，避免 wx.cloud.getTempFileURL 阻塞页面展示
   * 返回与 order.drawings 一一对应的数组（下标稳定），每项带 fileID/name/isPDF，
   * 便于删除时按 fileID 精确定位（避免按下标错删）
   */
  async _resolveDrawingUrls(drawings) {
    if (!Array.isArray(drawings) || drawings.length === 0) return []

    const fileIDList = drawings.filter(d => d.fileID).map(d => d.fileID)
    const urlMap = Object.create(null)

    if (fileIDList.length > 0) {
      try {
        const t = await storage.getTempFileURL(fileIDList)
        if (t && t.fileList) {
          for (const item of t.fileList) {
            if (item.fileID && item.tempFileURL) urlMap[item.fileID] = item.tempFileURL
          }
          // 诊断：临时链接拿不到的文件（status≠0 时带 errMsg，常见：文件被删/权限不足/env 不符）
          const failed = t.fileList.filter(it => !(it.fileID && it.tempFileURL))
          if (failed.length > 0) {
            console.warn('[order-detail] 以下图纸临时链接获取失败（点开时会走云下载兜底）',
              failed.map(f => ({ fileID: f.fileID, status: f.status, errMsg: f.errMsg })))
          }
        }
      } catch (e) {
        console.warn('[order-detail] 图纸临时链接获取失败（点开时会走云下载兜底）', e)
      }
    }

    // 客户端解析不到的（典型：云存储权限为「仅创建者可读写」，别人上传的文件客户端读不到），
    // 走云函数服务端兜底（管理员权限，不受安全规则限制）——顺带修复缩略图不显示
    const missing = drawings.filter(d => d.fileID && !urlMap[d.fileID]).map(d => d.fileID)
    if (missing.length > 0) {
      try {
        const serverMap = await drawing.resolveUrlsViaServer(missing)
        Object.assign(urlMap, serverMap)
        const stillMissing = missing.filter(id => !serverMap[id])
        if (stillMissing.length > 0) {
          console.warn('[order-detail] 云函数兜底后仍无链接的文件（可能已删除）', stillMissing)
        }
      } catch (e) {
        console.warn('[order-detail] 云函数兜底解析临时链接失败', e)
      }
    }

    return drawings.map((d, i) => {
      const name = d.name || ''
      const isPDF = d.type === 'pdf' || drawing.isPdfName(name)
      return {
        key: d.fileID || d.tempFilePath || `drawing_${i}`,
        url: d.fileID ? (urlMap[d.fileID] || '') : (d.tempFilePath || ''),
        fileID: d.fileID || '',
        name,
        isPDF
      }
    })
  },

  previewDrawing(event) {
    const index = Number(event.currentTarget.dataset.index)
    drawing.openDrawing(this.data.drawingUrls || [], index)
  },

  /** 预览待上传的图纸（本地临时文件 / PDF） */
  previewPendingDrawing(event) {
    const index = Number(event.currentTarget.dataset.index)
    drawing.openDrawing(this.data.pendingDrawings || [], index)
  },

  async chooseDrawing() {
    if (this._choosingLock) return
    this._choosingLock = true
    try {
      const app = getApp()
      const privacyOk = await app.requirePrivacyAuthorize()
      if (!privacyOk) return

      // 移动端：拍照/相册；电脑端：本地文件（支持 PDF）
      const picked = await drawing.chooseDrawings(9)
      if (!picked.length) return

      const pendingDrawings = (this.data.pendingDrawings || []).concat(picked)
      const drawingCount = (this.data.drawingUrls || []).length + pendingDrawings.length
      this.setData({
        pendingDrawings,
        drawingCount,
        hasDrawings: drawingCount > 0,
        hasPending: pendingDrawings.length > 0
      })
    } catch (e) {
      ui.handleError(e, '选择图纸失败')
    } finally {
      this._choosingLock = false
    }
  },

  removePendingDrawing(event) {
    const index = Number(event.currentTarget.dataset.index)
    const pendingDrawings = this.data.pendingDrawings.filter((_, i) => i !== index)
    const drawingCount = (this.data.drawingUrls || []).length + pendingDrawings.length
    this.setData({
      pendingDrawings,
      drawingCount,
      hasDrawings: drawingCount > 0,
      hasPending: pendingDrawings.length > 0
    })
  },

  /**
   * 删除已上传的图纸(点 ✕ 直接执行)
   * 流程:wx.cloud.deleteFile(云存储) + api.updateOrderDrawings(数据库)
   * 【修复】原本用 wx.showModal 二次确认,但你这环境下 modal 会被吞,
   *   改成点 ✕ 直接执行 + toast 反馈,确保每次点击都有反应。
   *   误删可重新上传,代价低;管理员操作默认信任。
   */
  async deleteUploadedDrawing(event) {
    const ds = (event && event.currentTarget && event.currentTarget.dataset) || {}
    const fileID = ds.fileId || ''
    const index = Number(ds.index)
    if (!this.orderId) {
      ui.toast('工单数据未加载完成')
      return
    }
    const drawings = (this.data.order && this.data.order.drawings) || []
    // 优先按 fileID 精确定位（避免 drawingUrls 与 drawings 下标错位删错文件）
    let targetIdx = fileID ? drawings.findIndex(d => d.fileID === fileID) : -1
    if (targetIdx < 0 && Number.isInteger(index) && index >= 0 && index < drawings.length) {
      targetIdx = index
    }
    if (targetIdx < 0) {
      ui.toast('图纸数据异常,无法删除')
      return
    }
    const target = drawings[targetIdx]
    ui.showLoading('正在删除图纸...')
    try {
      // 1. 删除云存储文件(失败不阻塞,数据库为准)
      if (target.fileID) {
        try {
          await storage.deleteFile({ fileList: [target.fileID] })
        } catch (e) {
          console.warn('[deleteDrawing] deleteFile 失败,继续更新数据库', e)
        }
      }
      // 2. 整体覆盖数据库 drawings 数组(replace 模式,不能用 append 否则删不掉)
      const newDrawings = drawings.filter((_, i) => i !== targetIdx)
      await api.updateOrderDrawings(this.orderId, newDrawings, 'replace')
      // 3. 更新本地 UI
      const newDrawingUrls = (this.data.drawingUrls || []).filter((_, i) => i !== targetIdx)
      const drawingCount = newDrawingUrls.length + (this.data.pendingDrawings || []).length
      this.setData({
        order: { ...this.data.order, drawings: newDrawings },
        drawingUrls: newDrawingUrls,
        drawingCount,
        hasDrawings: drawingCount > 0
      })
      ui.hideLoading()
      ui.toast('图纸已删除', 'success')
    } catch (e) {
      ui.hideLoading()
      console.error('[deleteDrawing] failed', e)
      ui.handleError(e, '删除图纸失败')
    }
  },

  /**
   * 编辑工单字段(防下错单):
   * 1. 进入编辑模式:复制当前 order 字段到 draft,字段变 input
   * 2. 保存:合并顶层字段 + drawingDetail,调 api.updateOrderFields
   * 3. 取消:清空 draft,关闭编辑
   *
   * 二维码不需要重新生成(指向工单号 GDxxx,工单号不变)
   */
  enterEditFields() {
    if (!this.data.order) return
    const o = this.data.order
    this.setData({
      editingFields: true,
      editFieldsDraft: {
        customerName: o.customerName || '',
        type: o.type || '',
        size: o.size || '',
        qty: o.qty != null ? String(o.qty) : '',
        singleNo: o.singleNo || '',
        material: o.material || '',
        dueDate: o.dueDate || '',
        orderDate: o.orderDate || '',
        remarks: o.remarks || ''
      },
      editDetailDraft: {
        blankingRoughness: (o.drawingDetail && o.drawingDetail.blankingRoughness) || '',
        productRoughness: (o.drawingDetail && o.drawingDetail.productRoughness) || '',
        length: (o.drawingDetail && o.drawingDetail.length) || '',
        blankingLength: (o.drawingDetail && o.drawingDetail.blankingLength) || '',
        topHoleThread: (o.drawingDetail && o.drawingDetail.topHoleThread) || '',
        crossHole: (o.drawingDetail && o.drawingDetail.crossHole) || '',
        squareHead: (o.drawingDetail && o.drawingDetail.squareHead) || ''
      },
      editBtnLoading: false
    })
  },

  cancelEditFields() {
    this.setData({
      editingFields: false,
      editFieldsDraft: {},
      editDetailDraft: {},
      editBtnLoading: false
    })
  },

  onEditFieldInput(event) {
    const key = event.currentTarget.dataset.key
    if (!key) return
    this.setData({ [`editFieldsDraft.${key}`]: event.detail.value })
  },

  /** 编辑表单日期字段（picker mode=date 的 bindchange，event.detail.value = YYYY-MM-DD） */
  onEditFieldDate(event) {
    const key = event.currentTarget.dataset.key
    if (!key) return
    this.setData({ [`editFieldsDraft.${key}`]: event.detail.value })
  },

  onEditDetailInput(event) {
    const key = event.currentTarget.dataset.key
    if (!key) return
    this.setData({ [`editDetailDraft.${key}`]: event.detail.value })
  },

  async saveEditFields() {
    if (this.data.editBtnLoading) return
    const draft = this.data.editFieldsDraft || {}
    const detail = this.data.editDetailDraft || {}

    // 本地校验:必填项
    if (!draft.type || !String(draft.type).trim()) return ui.toast('请输入种类')
    if (!draft.size || !String(draft.size).trim()) return ui.toast('请输入尺寸')
    if (!draft.material || !String(draft.material).trim()) return ui.toast('请输入材质')
    const qty = Number(draft.qty)
    if (!Number.isFinite(qty) || qty <= 0) return ui.toast('请输入正确的数量')

    const fields = {
      customerName: String(draft.customerName || '').trim(),
      type: String(draft.type || '').trim(),
      size: String(draft.size || '').trim(),
      qty: qty,
      singleNo: String(draft.singleNo || '').trim(),
      material: String(draft.material || '').trim(),
      dueDate: String(draft.dueDate || '').trim(),
      orderDate: String(draft.orderDate || '').trim(),
      remarks: String(draft.remarks || '').trim()
    }
    // 图纸细节(全字段透传,后端白名单过滤)
    const drawingDetail = {
      blankingRoughness: String(detail.blankingRoughness || '').trim(),
      productRoughness: String(detail.productRoughness || '').trim(),
      length: String(detail.length || '').trim(),
      blankingLength: String(detail.blankingLength || '').trim(),
      topHoleThread: String(detail.topHoleThread || '').trim(),
      crossHole: String(detail.crossHole || '').trim(),
      squareHead: String(detail.squareHead || '').trim()
    }

    this.setData({ editBtnLoading: true })
    try {
      const res = await api.updateOrderFields(this.orderId, { ...fields, drawingDetail })
      // 云函数返回 { success: true, order: {...} },需要取 .order
      const updated = (res && res.order) || null
      // 同步本地 order(用云端返回值;若无返回则用本地拼接兜底)
      const rawOrder = updated || { ...this.data.order, ...fields, drawingDetail }
      // 重新应用 QR URL + 确保 steps 有唯一 key(云端返回可能没有)
      const newOrder = withQrUrls(ensureStepKeys(rawOrder))
      this.setData({
        order: newOrder,
        editingFields: false,
        editFieldsDraft: {},
        editDetailDraft: {},
        editBtnLoading: false
      })
      ui.toast('修改已保存', 'success')
    } catch (e) {
      console.error('[editFields] failed', e)
      this.setData({ editBtnLoading: false })
      ui.handleError(e, '保存失败')
    }
  },

  clearPendingDrawings() {
    const drawingCount = (this.data.drawingUrls || []).length
    this.setData({
      pendingDrawings: [],
      drawingCount,
      hasDrawings: drawingCount > 0,
      hasPending: false
    })
  },

  async saveDrawings() {
    const pendingDrawings = this.data.pendingDrawings || []
    if (pendingDrawings.length === 0) return
    const user = this.data.currentUser
    if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
      ui.toast('仅管理员可上传图纸')
      return
    }
    try {
      ui.showLoading('上传图纸中...')
      const order = this.data.order || {}
      const drawings = []
      const CONCURRENCY = 3
      for (let i = 0; i < pendingDrawings.length; i += CONCURRENCY) {
        const batch = pendingDrawings.slice(i, i + CONCURRENCY)
        const results = await Promise.allSettled(batch.map(async (d) => {
          const ext = d.ext || drawing.extOf(d.name) || drawing.extOf(d.tempFilePath) || 'jpg'
          const cloudPath = `drawings/${order.singleNo || order.id || 'order'}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`
          const up = await storage.uploadFile(cloudPath, d.tempFilePath)
          return {
            name: d.name,
            fileID: up.fileID,
            cloudPath: up.fileID,
            type: d.isPDF ? 'pdf' : (d.type || 'image')
          }
        }))
        for (const result of results) {
          if (result.status === 'fulfilled') drawings.push(result.value)
        }
      }

      const res = await api.updateOrderDrawings(this.orderId, drawings)
      const updated = ensureStepKeys(res && res.order ? res.order : res)
      this.setData({
        order: withQrUrls(updated),
        pendingDrawings: []
      })
      await this.refresh()
      ui.hideLoading()
      ui.toast('图纸上传成功', 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '上传图纸失败')
    }
  },

  onNoteInput(event) {
    this._inputFocusing = true
    this.setData({ note: event.detail.value })
  },

  onQtyInput(event) {
    this._inputFocusing = true
    this.setData({ completedQty: event.detail.value })
  },

  onNoteBlur() { this._inputFocusing = false },
  onQtyBlur() { this._inputFocusing = false },

  bindMaterialType(event) {
    const index = Number(event.detail.value)
    const material = (this.data.materialTypes || [])[index]
    this.setData({
      materialConsumption: { ...this.data.materialConsumption, material }
    })
    this._updateCalcWeight()
  },

  bindMaterialQty(event) {
    this.setData({
      materialConsumption: { ...this.data.materialConsumption, qty: event.detail.value }
    })
    this._updateCalcWeight()
  },

  bindMaterialRoughness(event) {
    this.setData({
      materialConsumption: { ...this.data.materialConsumption, roughness: event.detail.value }
    })
    this._updateCalcWeight()
  },

  bindMaterialLength(event) {
    this.setData({
      materialConsumption: { ...this.data.materialConsumption, length: event.detail.value }
    })
    this._updateCalcWeight()
  },

  // 提取公共状态计算逻辑（refresh/completeStep/revertStep/saveStepChanges 复用）
  _computeAccessState(user, order) {
    const isAdmin = user.role === 'admin' || user.role === 'superadmin'
    const _stations = user.stations || (user.station ? [user.station] : [])
    const canComplete = order.status !== 'completed' && (isAdmin || _stations.includes(order.currentStation))
    const currentStep = order.steps && order.steps[order.currentStepIndex]
    const isBlankingStep = currentStep && currentStep.key === 'blanking'
    const autoLength = (isBlankingStep && order.drawingDetail && (order.drawingDetail.blankingLength || order.drawingDetail.length)) ? (order.drawingDetail.blankingLength || order.drawingDetail.length) : ''

    // 配合人员（编程员 / 调字员）：后端 PROCESS_LIBRARY 标记 needPartner（兼容 needProgrammer）
    const partner = api.resolvePartner(currentStep)
    const isProgrammerStep = !!(partner.need && order.status !== 'completed')

    // 可重复工序（精车）：可选项从「第几道」到 maxRepeat（最多4道）
    const isRepeatableStep = !!(currentStep && currentStep.repeatable && order.status !== 'completed')
    const maxRepeat = (currentStep && Number(currentStep.maxRepeat)) || 4
    const seq = (currentStep && currentStep._seq) || 1
    const totalNow = (currentStep && currentStep._repeatTotal) || 1
    const repeatOptions = []
    if (isRepeatableStep) {
      for (let n = seq; n <= maxRepeat; n++) {
        repeatOptions.push({ value: n, label: `${n} 道` })
      }
    }
    const repeatTotalChoice = Math.min(Math.max(totalNow, seq), maxRepeat)

    return {
      isAdmin, canComplete, isBlankingStep, autoLength,
      isProgrammerStep, isRepeatableStep, repeatOptions, repeatTotalChoice,
      partnerLabel: partner.label,
      partnerKeyword: partner.keyword,
      currentStepKey: currentStep ? currentStep.key : '',
      currentStepStation: currentStep ? (currentStep.station || '') : '',
      currentStepName: currentStep ? (currentStep.name || '') : '',
      currentStepIndex: Number(order.currentStepIndex) || 0
    }
  },

  /** 把 _computeAccessState 的结果转成 setData 的工序面板补丁（统一各调用点） */
  _stepPatch(acc) {
    return {
      isAdmin: acc.isAdmin,
      canComplete: acc.canComplete,
      isBlankingStep: acc.isBlankingStep,
      isProgrammerStep: acc.isProgrammerStep,
      partnerLabel: acc.partnerLabel,
      partnerKeyword: acc.partnerKeyword,
      currentStepStation: acc.currentStepStation,
      currentStepName: acc.currentStepName,
      isRepeatableStep: acc.isRepeatableStep,
      repeatOptions: acc.repeatOptions,
      repeatTotalChoice: acc.repeatTotalChoice,
      // 工序变了 → 操作员候选池随之变化，非法选择自动回退（管理员全程有效，选择被保留）
      ...this._operatorPoolPatch(acc)
    }
  },

  /**
   * 计算「工序操作员」的 setData 补丁（含候选池 operatorEmployees）：
   *   - 已选操作员仍在新候选池中 → 保留原选择
   *   - 否则优先选中当前操作用户（若合法），再退化为候选池第一人
   *   - 候选池为空 → 清空选择（提交时会被前端 / 后端双重拦截并提示配置岗位）
   * 候选池口径与后端 completeStep 校验一致：管理员 / 超管 + 岗位精确匹配当前工序的员工。
   * @param {Object} acc _computeAccessState 的结果
   * @param {Array} [poolOverride] refresh 阶段 activeEmployees 尚未写入 data 时直接传入
   */
  _operatorPoolPatch(acc, poolOverride) {
    const all = poolOverride || this.data.activeEmployees || []
    const pool = api.pickOperatorEmployees(all, (acc && acc.currentStepStation) || '')
    if (this.data.operatorId && pool.some(e => e.id === this.data.operatorId)) {
      return { operatorEmployees: pool }
    }
    const app = getApp()
    const me = (app && app.globalData && app.globalData.currentUser) || {}
    const self = me.id ? pool.find(e => e.id === me.id) : null
    const preferred = self || pool[0]
    if (!preferred) return { operatorEmployees: pool, operatorId: '', operatorLabel: '' }
    const st = api.getEmployeeDisplayStations(preferred)
    return {
      operatorEmployees: pool,
      operatorId: preferred.id,
      operatorLabel: preferred.name + (st ? ` · ${st}` : '')
    }
  },

  async _updateCalcWeight() {
    if (this._calcWeightTimer) clearTimeout(this._calcWeightTimer)
    this._calcWeightTimer = setTimeout(() => this._doCalcWeight(), 300)
  },

  async _doCalcWeight() {
    const { materialConsumption } = this.data
    const len = Number(materialConsumption.length)
    const rVal = Number(materialConsumption.roughness)
    const qty = Number(materialConsumption.qty)
    if (!materialConsumption.material || !len || !rVal || !qty || len <= 0 || rVal <= 0 || qty <= 0) {
      this.setData({ calcWeightInfo: null })
      return
    }
    const coef = api.getRoughnessCoefficient(rVal)
    if (!coef) {
      this.setData({ calcWeightInfo: null })
      return
    }
    const singleWeightKg = len * 1.05 * coef * 0.001
    const totalTons = singleWeightKg * qty / 1000
    let currentStock = 0
    try {
      currentStock = await api.getMaterialStockByRoughness(materialConsumption.material, rVal)
    } catch (e) { currentStock = 0 }
    const remainStock = Math.max(currentStock - totalTons, 0)

    this.setData({
      calcWeightInfo: {
        coef,
        singleWeightKg: singleWeightKg.toFixed(3),
        totalTons: totalTons.toFixed(3),
        currentStock: currentStock.toFixed(3),
        remainStock: remainStock.toFixed(3)
      }
    })
  },

  // ===== 员工选择弹层（操作员 / 编程员 共用同一套 UI）=====

  showEmployeePicker(event) {
    const target = (event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.target) || 'operator'
    // 操作员候选已按「管理员 + 当前工序岗位匹配」筛选，避免选到无关工种（如质检工序选到下料工）
    const list = target === 'programmer'
      ? (this.data.programmerEmployees || [])
      : (this.data.operatorEmployees || [])
    if (list.length === 0) {
      ui.toast(target === 'programmer'
        ? `暂无可选${this.data.partnerLabel}，请先在员工管理中给员工配置含「${this.data.partnerKeyword}」的岗位`
        : `当前工序仅限${this.data.currentStepStation || '对应岗位'}或管理员操作，暂无可选人员，请到员工管理配置岗位`)
      return
    }
    this.setData({ pickerTarget: target, pickerKeyword: '', pickerList: list })
  },

  hideEmployeePicker() {
    this.setData({ pickerTarget: '', pickerKeyword: '' })
  },

  onPickerPanelTap() { /* 阻止冒泡 */ },

  onPickerSearchInput(event) {
    this._inputFocusing = true
    this.setData({ pickerKeyword: event.detail.value.trim() })
  },

  selectEmployee(event) {
    const id = event.currentTarget.dataset.id
    const emp = (this.data.pickerList || []).find(e => e.id === id)
    if (!emp) return
    const stationDisplay = api.getEmployeeDisplayStations(emp)
    const label = emp.name + (stationDisplay ? ` · ${stationDisplay}` : '')
    if (this.data.pickerTarget === 'programmer') {
      this.setData({ programmerId: emp.id, programmerLabel: label, pickerTarget: '', pickerKeyword: '' })
    } else {
      this.setData({ operatorId: emp.id, operatorLabel: label, pickerTarget: '', pickerKeyword: '' })
    }
  },

  /** 可重复工序（精车）：选择「本工单共需几道」 */
  onRepeatTotalChange(event) {
    const value = Number(event.currentTarget.dataset.value)
    if (!value) return
    this.setData({ repeatTotalChoice: value })
  },



  async completeStep() {
    const { isBlankingStep, materialConsumption, note, completedQty, isProgrammerStep, isRepeatableStep } = this.data

    if (isBlankingStep) {
      if (!materialConsumption.material) { ui.toast('请选择材料类型'); return }
      const rVal = Number(materialConsumption.roughness)
      if (!materialConsumption.roughness || isNaN(rVal) || rVal < 0 || rVal > 200) { ui.toast('请输入有效的粗度（0-200mm）'); return }
      const len = Number(materialConsumption.length)
      if (!materialConsumption.length || isNaN(len) || len <= 0) { ui.toast('请输入有效的长度（mm）'); return }
      const matQty = Number(materialConsumption.qty)
      if (!materialConsumption.qty || isNaN(matQty) || matQty <= 0) { ui.toast('请输入有效的消耗数量'); return }
    } else {
      const qty = Number(completedQty)
      if (!completedQty || isNaN(qty) || qty < 0) { ui.toast('请输入有效的非负数字'); return }
    }

    if (!this.data.operatorId) { ui.toast('请选择操作员'); return }
    // 工序操作员必须岗位匹配（管理员不受限）——与后端校验同口径，避免提交后才报错
    const opPool = this.data.operatorEmployees || []
    if (opPool.length > 0 && !opPool.some(e => e.id === this.data.operatorId)) {
      ui.toast(`当前工序仅允许${this.data.currentStepStation || '对应岗位'}或管理员操作`)
      return
    }
    // 配合人员必填（敦压 / 拉尾子 / 精车 / 铣方头=编程员；打字=调字员）
    if (isProgrammerStep && !this.data.programmerId) { ui.toast(`请选择${this.data.partnerLabel}`); return }

    try {
      let submitConsumption = null
      if (isBlankingStep) {
        const len = Number(materialConsumption.length)
        const rVal = Number(materialConsumption.roughness)
        const pieces = Number(materialConsumption.qty)
        const coef = api.getRoughnessCoefficient(rVal) || (rVal * rVal * 0.006165)
        const calcTons = len * 1.05 * coef * 0.001 * pieces / 1000
        submitConsumption = {
          ...materialConsumption,
          calcTons: Math.round(calcTons * 10000) / 10000
        }
      }
      ui.showLoading('提交中...')
      const result = await api.completeCurrentStep({
        orderId: this.orderId,
        operatorId: this.data.operatorId,
        note,
        completedQty: isBlankingStep ? null : completedQty,
        materialConsumption: submitConsumption,
        // 编程员（后端校验岗位，非编程员会被拒绝）
        programmerId: isProgrammerStep ? this.data.programmerId : '',
        // 精车多道：本工单该工序共需几道，后端按差值追加/回收未完成的重复工序
        repeatTotal: isRepeatableStep ? this.data.repeatTotalChoice : undefined
      })
      const order = ensureStepKeys(result && result.order ? result.order : result)
      const app = getApp()
      const acc = this._computeAccessState(app.globalData.currentUser, order)

      this.setData({
        order: withQrUrls(order),
        note: '',
        completedQty: '',
        ...this._stepPatch(acc),
        ...(acc.currentStepIndex !== (this.data.order && this.data.order.currentStepIndex)
          ? { programmerId: '', programmerLabel: '' }
          : {}),
        materialConsumption: { material: '', roughness: '', length: '', qty: '' },
        calcWeightInfo: null
      })
      this._panelKey = `${order.id || this.orderId}#${acc.currentStepIndex}`
      ui.hideLoading()
      ui.toast('工序已完成并流转', 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '提交失败')
    }
  },

  async togglePause() {
    try {
      const order = ensureStepKeys(await api.togglePause(this.orderId, !this.data.order.paused))
      this.setData({
        order: withQrUrls(order)
      })
      ui.toast(order.paused ? '已暂停' : '已恢复', 'none')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  async toggleUrgent() {
    try {
      const order = ensureStepKeys(await api.toggleOrderUrgent(this.orderId, !this.data.order.urgent))
      this.setData({
        order: withQrUrls(order)
      })
      ui.toast(order.urgent ? '已设为加急' : '已取消加急', 'success')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  enterEditSteps() {
    if (this.data.currentUser.role !== 'admin' && this.data.currentUser.role !== 'superadmin') {
      ui.toast('只有管理员可以编辑工序')
      return
    }
    const processList = api.getProcessLibrary()
    const { order } = this.data
    const currentStepIndex = order.currentStepIndex || 0
    const selectedSteps = this._renumberSteps((order.steps || []).map((step, index) => ({
      ...step,
      instanceId: `${step.key}_${index}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      canDelete: index >= currentStepIndex,
      canRevert: index < currentStepIndex
    })))
    this.setData({
      editingSteps: true,
      processList,
      selectedSteps,
      selectedStepKeys: selectedSteps.map(s => s.key)
    })
  },

  exitEditSteps() {
    const { order } = this.data
    this.setData({ editingSteps: false, selectedSteps: order.steps, selectedStepKeys: order.steps.map(s => s.key) })
  },

  /** 编辑工序时重新编号（精车 → 精车1/精车2/精车3），让列表所见即所得 */
  _renumberSteps(list) {
    const arr = Array.isArray(list) ? list : []
    const total = {}
    arr.forEach(s => { total[s.key] = (total[s.key] || 0) + 1 })
    const seq = {}
    return arr.map(s => {
      seq[s.key] = (seq[s.key] || 0) + 1
      // 用工序库里的原始名做基准，避免把已带的编号叠加成「精车11」
      const base = (api.getProcessByKey(s.key) || {}).name || s.name
      return { ...s, name: total[s.key] > 1 ? `${base}${seq[s.key]}` : base }
    })
  },

  addStep(event) {
    const stepKey = event.currentTarget.dataset.key
    const step = this.data.processList.find((p) => p.key === stepKey)
    if (!step) return
    const newStep = {
      ...step,
      instanceId: `${stepKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      canDelete: true,
      canRevert: false
    }
    // 可重复工序（精车）插到同名前一道之后，保持连续，不会被排到入库后面
    const newSelectedSteps = this._renumberSteps(api.insertStepSmart(this.data.selectedSteps, newStep))
    this.setData({
      selectedSteps: newSelectedSteps,
      selectedStepKeys: newSelectedSteps.map((s) => s.key)
    })
  },

  removeSelectedStep(event) {
    const instanceId = event.currentTarget.dataset.instanceId
    // 防御 instanceId 缺失时误清空全部
    if (!instanceId) {
      console.warn('[order-detail] 删除工序失败：缺少 instanceId')
      ui.toast('操作失败，请重试')
      return
    }
    const step = this.data.selectedSteps.find(s => s.instanceId === instanceId)
    if (step && !step.canDelete) {
      ui.toast('该工序已完成，无法删除')
      return
    }
    const newSelectedSteps = this._renumberSteps(this.data.selectedSteps.filter((s) => s.instanceId !== instanceId))
    this.setData({
      selectedSteps: newSelectedSteps,
      selectedStepKeys: newSelectedSteps.map((s) => s.key)
    })
  },

  async revertStep(event) {
    // 严格限制：仅管理员可回退工序
    if (!this.data.isAdmin) {
      ui.toast('仅管理员可回退工序')
      return
    }

    const ds = event.currentTarget.dataset || {}
    const instanceId = ds.instanceId
    const stepKey = ds.stepKey
    const stepIndexRaw = ds.stepIndex
    let step = null
    let stepIndex = Number.isInteger(Number(stepIndexRaw)) && stepIndexRaw !== undefined && stepIndexRaw !== ''
      ? Number(stepIndexRaw)
      : -1

    if (instanceId) {
      // 编辑工序模式：按 instanceId 定位，并换算成工序下标
      const idx = (this.data.selectedSteps || []).findIndex(s => s.instanceId === instanceId)
      if (idx >= 0) {
        step = this.data.selectedSteps[idx]
        stepIndex = idx
      }
    } else if (stepIndex >= 0) {
      // 工序流程列表：按下标定位（精车1/2/3 等同名工序必须靠下标区分）
      step = (this.data.order.steps || [])[stepIndex]
    } else if (stepKey) {
      // 兜底：仅按 key 定位
      step = (this.data.order.steps || []).find(s => s.key === stepKey)
    }
    if (!step) return

    // 二次确认，防止误操作
    // 【环境兼容】超时兜底：若环境吞掉弹窗，4 秒后按「确认」继续，
    // 避免出现「点了没反应」；撤回本身可重新做工序恢复，风险可控。
    const ok = await ui.confirm(
      `确定要撤回「${step.name}」吗？该工序的完成记录将被移除，当前工序将回退到此步骤。`,
      '确认撤回',
      { confirmColor: '#e53935', modalTimeout: 4000, fallbackOnTimeout: true }
    )
    if (!ok) return

    try {
      ui.showLoading('撤回中...')
      const updatedOrder = ensureStepKeys(await api.revertCompletedStep(this.orderId, step.key, stepIndex >= 0 ? stepIndex : undefined))
      if (!updatedOrder || !Array.isArray(updatedOrder.stepKeys)) {
        ui.hideLoading()
        ui.toast('撤回失败，返回数据异常')
        return
      }
      const revertedSteps = updatedOrder.steps || api.buildSteps(updatedOrder.stepKeys)
      const app = getApp()
      const acc = this._computeAccessState(app.globalData.currentUser, updatedOrder)
      const isBlankingAfterRevert = acc.isBlankingStep

      this.setData({
        order: withQrUrls(updatedOrder),
        editingSteps: false,
        selectedSteps: revertedSteps,
        selectedStepKeys: (updatedOrder.stepKeys || []).map(k => k),
        ...this._stepPatch(acc),
        // 撤回后当前工序变了，配合人员需要重新选择
        programmerId: '',
        programmerLabel: '',
        materialConsumption: isBlankingAfterRevert ? { material: '', roughness: '', length: acc.autoLength, qty: '' } : this.data.materialConsumption
      })
      this._panelKey = `${updatedOrder.id || this.orderId}#${acc.currentStepIndex}`
      if (isBlankingAfterRevert) {
        await this._updateCalcWeight()
      } else {
        if (this.data.calcWeightInfo) this.setData({ calcWeightInfo: null })
      }
      ui.hideLoading()
      ui.toast('已撤回工序', 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '撤回失败')
    }
  },

  async saveStepChanges() {
    const { selectedSteps } = this.data
    if (selectedSteps.length === 0) {
      ui.toast('至少需要一个工序')
      return
    }
    const selectedStepKeys = selectedSteps.map((s) => s.key)
    try {
      ui.showLoading('保存中...')
      const updatedOrder = ensureStepKeys(await api.updateOrderStepKeys(this.orderId, selectedStepKeys))
      if (!updatedOrder || !Array.isArray(updatedOrder.stepKeys)) {
        ui.hideLoading()
        ui.toast('保存失败，返回数据异常')
        return
      }
      // 若后端未展开 steps，则根据 stepKeys 本地同步，确保 UI 有数据（含精车1/2/3 编号）
      const savedSteps = updatedOrder.steps || api.buildSteps(updatedOrder.stepKeys)
      const app = getApp()
      const acc = this._computeAccessState(app.globalData.currentUser, updatedOrder)
      const isBlankingAfterSave = acc.isBlankingStep

      this.setData({
        order: withQrUrls(updatedOrder),
        editingSteps: false,
        selectedSteps: savedSteps,
        selectedStepKeys: (updatedOrder.stepKeys || []).map(k => k),
        ...this._stepPatch(acc),
        materialConsumption: isBlankingAfterSave ? { material: '', roughness: '', length: acc.autoLength, qty: '' } : this.data.materialConsumption
      })
      this._panelKey = `${updatedOrder.id || this.orderId}#${acc.currentStepIndex}`
      if (isBlankingAfterSave) {
        await this._updateCalcWeight()
      } else {
        if (this.data.calcWeightInfo) this.setData({ calcWeightInfo: null })
      }
      ui.hideLoading()
      ui.toast('工序已更新', 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '保存失败')
    }
  },

  async regenerateWxacode() {
    if (this.data.qrRegenerating) return
    this.setData({ qrRegenerating: true })
    try {
      const res = await api.generateWxacode(this.orderId, true)
      if (!res || !res.fileID) { ui.toast('生成失败：' + (res && res.error || '未知错误')); return }
      ui.toast('小程序码已生成', 'success')
      await this.refresh({ force: true })
    } catch (e) {
      ui.handleError(e, '小程序码生成失败')
    } finally {
      this.setData({ qrRegenerating: false })
    }
  },

  // ===== 二维码保存 / 复制 / 预览 =====

  /**
   * 取出某一种二维码的保存信息
   * @param {'wxacode'|'text'} kind
   */
  _qrTarget(kind) {
    const order = this.data.order || {}
    const orderId = order.id || this.orderId || 'order'
    if (kind === 'wxacode') {
      if (!order.qrUrl) return null
      return {
        kind,
        url: order.qrUrl,
        fileID: order.qrCodeFileID || '',
        fileName: imageSave.safeFileName(`${orderId}_微信小程序码`) + '.png'
      }
    }
    if (!order.textQrUrl) return null
    return {
      kind,
      url: order.textQrUrl,
      fileID: '',
      fileName: imageSave.safeFileName(`${orderId}_文本二维码`) + '.png'
    }
  },

  /** 点击二维码 → 全屏预览（预览态下仍有长按/右键菜单，可另存） */
  previewQrCode(event) {
    const kind = (event.currentTarget.dataset.kind) || 'wxacode'
    const target = this._qrTarget(kind)
    if (!target) return
    imageSave.previewImage([target.url])
  },

  /** 保存二维码：电脑端弹「另存为」对话框，移动端存入相册 */
  async saveQrCode(event) {
    if (this._qrSaving) return
    const kind = (event.currentTarget.dataset.kind) || 'wxacode'
    const target = this._qrTarget(kind)
    if (!target) {
      ui.toast('二维码尚未生成')
      return
    }
    this._qrSaving = true
    const isLocal = kind === 'text'
    ui.showLoading(isLocal ? '正在生成二维码...' : '正在准备图片...')
    try {
      let result
      if (isLocal) {
        // 备用文本二维码：api.qrserver.com 是外国域名、无 ICP 备案，无法加入
        // downloadFile 合法域名白名单（<image> 展示不受限但 downloadFile 必失败，
        // 报 fail invalid url）。改为本地生成 PNG，完全不走网络。
        const order = this.data.order || {}
        const text = order.qrContent || order.id || ''
        const gen = localQr.writeQrFile(text, target.fileName)
        result = await imageSave.saveLocalFile({ filePath: gen.path, fileName: target.fileName })
      } else {
        // 小程序码：云文件走 wx.cloud.downloadFile，不占合法域名额度
        result = await imageSave.saveImage(target)
      }
      ui.hideLoading()
      ui.toast(result.mode === 'disk' ? '已保存' : '已保存到相册', 'success')
    } catch (e) {
      ui.hideLoading()
      if (imageSave.isCancel(e)) return
      // 开发者工具不支持 saveFileToDisk：给明确提示，并复制链接方便用浏览器下载
      if (e && e.code === imageSave.DEVTOOLS_UNSUPPORTED) {
        // 注意顺序：先复制（会弹系统「内容已复制」），再 toast 我们的说明，保证说明不被顶掉
        try { await imageSave.copyText(target.url) } catch (e2) { /* 复制失败不打断 */ }
        ui.toast('开发者工具不支持「另存为」，请在电脑版微信中使用（链接已复制）', 'none', 3000)
        return
      }
      // 其他失败：直接打开全屏预览兜底 —— PC 端预览层「右键 → 图片另存为」是稳定路径，
      // 同时把真实失败原因透出（不再是笼统的「保存失败」），便于定位
      console.error('[saveQrCode] 另存为失败', e)
      const reason = String((e && (e.message || e.errMsg)) || '').slice(0, 40) || '未知原因'
      try { imageSave.previewImage([target.url]) } catch (e2) { /* 预览失败忽略 */ }
      ui.toast(`另存为失败：${reason}。已打开预览，可右键图片另存`, 'none', 3500)
    } finally {
      this._qrSaving = false
    }
  }
})

