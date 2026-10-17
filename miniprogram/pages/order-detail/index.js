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
    panelFlash: false,
    // 一键完成剩余工序（管理员/流转工）
    batchOpen: false,
    batchQty: '',
    batchSubmitting: false,
    // 订单二维码折叠（下拉页面到底部或点标题展开）
    qrExpanded: false,
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
    // ===== 工单认领（按工序）=====
    // stepClaimFlags: 每道工序的认领/完成标志（流转列表汇总行用）
    // claimableSteps: 可认领的未完成工序；myClaimSteps: 我认领的未完成工序
    claimState: 'none',
    canClaim: false,
    currentClaim: null,
    stepClaimFlags: [],
    claimableSteps: [],
    myClaimSteps: [],
    // 并行模型：面板当前填写的目标工序（-1 = 无）
    selectedStepIdx: -1,
    selectedAcc: 0,
    selectedClaimNames: '',
    selectedClaimCount: 0,
    // 订单级进度：最新提交工序 + 完成道数 + 完工确认权限
    lastSubmitStepName: '',
    lastSubmitStepStation: '',
    doneCount: 0,
    totalSteps: 0,
    allStepsDone: false,
    canFinalize: false,
    finalizing: false,
    claimBtnLoading: false,
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
    // 扫码进入时自动滚动到「操作面板」（普通浏览不滚动）
    this._focusPanel = options.focus === 'panel'
    // 大字模式（老年版）：个人中心可开关，只影响工单详情页字号
    this.setData({
      isDesktopPlatform: drawing.isDesktop(),
      elderMode: !!wx.getStorageSync('elderMode')
    })
    await this.refresh({ force: true })
    if (this._focusPanel) {
      this._focusPanel = false
      setTimeout(() => {
        wx.pageScrollTo({ selector: '.action-panel', duration: 300 }).catch(() => {})
        this.setData({ panelFlash: true })
        setTimeout(() => this.setData({ panelFlash: false }), 2500)
      }, 350)
    }
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  /** 页面下拉到底部 → 自动展开折叠的订单二维码 */
  onReachBottom() {
    if (!this.data.qrExpanded) this.setData({ qrExpanded: true })
  },

  /** 点击二维码标题展开/收起 */
  toggleQrSection() {
    this.setData({ qrExpanded: !this.data.qrExpanded })
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
      // 工种后缀只显示一个命中配合岗关键字的工种（管理员显示「管理员」）
      const programmerList = (progPick.list || [])
        .map(e => ({ ...e, _stationDisplay: api.pickerStationDisplay(e, acc.partnerKeyword || '') }))

      // 图纸 URL 改为懒加载：先让首屏出来，再异步换临时链接
      const drawingUrls = await this._resolveDrawingUrls(order.drawings || [])
      const pendingLen = (this.data.pendingDrawings || []).length
      const drawingCount = drawingUrls.length + pendingLen

      this.setData({
        materialTypes: materialTypes || [],
        activeEmployees,
        programmerEmployees: programmerList,
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
    // 流转工：特殊工种，可认领/提交任意工序（其余权限与普通员工一致）
    const isFloater = _stations.includes(api.FLOATER_STATION)

    // ===== 并行模型基础数据：工序相互独立，完成判定 = stepDone 标记或累计达数量 =====
    const steps = order.steps || []
    const qtyTarget = Number(order.qty) || 0
    const stepQtyMap = order.stepQty || {}
    const stepDoneMap = order.stepDone || {}
    // 累计根数：优先读并行模型 stepQty；老单（旧顺序模型只写 history 不写 stepQty）
    // 回退用 history 流水按工序汇总（新记录有 stepIndex，老记录按 stepKey 匹配）
    const accFromHistory = (i) => ((order.history || []).filter(h => {
      if (h.stepIndex !== undefined && h.stepIndex !== null) return Number(h.stepIndex) === i
      return !!steps[i] && h.stepKey === steps[i].key
    }).reduce((sum, h) => sum + (Number(h.qty) || 0), 0))
    const accOf = (i) => { const v = Number(stepQtyMap[i]) || 0; return v > 0 ? v : accFromHistory(i) }
    // 完成判定与后端 orderManager.isStepDone 同口径：
    // stepDone 标记 / 累计达标 / 老单兼容（无 stepDone 字段时指针之前的工序视为已完成）
    const doneOf = (i) => !!stepDoneMap[i] || (qtyTarget > 0 && accOf(i) >= qtyTarget) || (!order.stepDone && i < (Number(order.currentStepIndex) || 0))
    const doneFlags = steps.map((s, i) => doneOf(i))
    const doneCount = doneFlags.filter(Boolean).length
    const allStepsDone = steps.length > 0 && doneCount === steps.length
    const isCompleted = order.status === 'completed'

    // 认领映射（数组兼容）
    const stepClaims = order.stepClaims || {}
    const toList = (v) => Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : [])
    const meId = user.id || ''
    const claimListOf = (i) => toList(stepClaims[i])
    const claimAllowed = !isCompleted && (!order.paused || isAdmin)

    // 每道工序标志（认领人数/完成状态/累计根数），工序流转列表汇总行使用
    const stepClaimFlags = steps.map((s, i) => {
      const list = claimListOf(i)
      const mine = list.some(c => c.userId === meId)
      return {
        count: list.length,
        names: list.map(c => c.userName || '').filter(Boolean).join('、'),
        has: list.length > 0,
        mine,
        done: doneFlags[i],
        acc: accOf(i),
        qty: qtyTarget,
        stepName: s.name,
        // 未完成 + 未认领过 + 岗位匹配（或管理/流转工）→ 可认领
        canClaim: claimAllowed && !doneFlags[i] && !mine && (isAdmin || isFloater || _stations.includes(s.station))
      }
    })

    // 我认领的未完成工序（面板填写目标候选）
    const myClaimSteps = steps
      .map((s, i) => ({ s, i }))
      .filter(x => !doneFlags[x.i] && claimListOf(x.i).some(c => c.userId === meId))
      .map(x => ({ index: x.i, stepName: x.s.name, station: x.s.station || '', acc: accOf(x.i) }))

    // 可认领工序：全部未完成 + 岗位匹配（或管理/流转工），含已被他人认领的（可加入协作）
    const claimableSteps = steps
      .map((s, i) => {
        const f = stepClaimFlags[i]
        if (doneFlags[i] || (!f.canClaim && !f.has)) return null
        return {
          index: i, stepName: s.name, station: s.station || '',
          canClaim: f.canClaim, mine: f.mine, has: f.has, names: f.names, count: f.count, acc: accOf(i)
        }
      })
      .filter(Boolean)

    // ===== 面板填写目标工序（selectedStepIdx）=====
    // 优先保持用户已选；失效（越界/已完成）时回退：我认领的第一道 → 管理/流转工取第一道未完成 → -1
    let selIdx = Number(this.data.selectedStepIdx)
    const selValid = Number.isInteger(selIdx) && selIdx >= 0 && selIdx < steps.length && !doneFlags[selIdx]
    if (!selValid) {
      selIdx = myClaimSteps.length > 0 ? myClaimSteps[0].index
        : (steps.length > 0 && (isAdmin || isFloater) ? steps.findIndex((s, i) => !doneFlags[i]) : -1)
    }
    const selectedStep = selIdx >= 0 ? steps[selIdx] : null
    const iClaimedSelected = selIdx >= 0 && claimListOf(selIdx).some(c => c.userId === meId)
    // 能否提交：工单未完成 + 有有效目标工序 + 我认领了它（管理员/流转工跨认领放行）
    const canComplete = !isCompleted && selIdx >= 0 && (isAdmin || isFloater || iClaimedSelected)

    // 面板表单按选中工序渲染
    const isBlankingStep = !!(selectedStep && selectedStep.key === 'blanking') && canComplete
    const autoLength = (isBlankingStep && order.drawingDetail && (order.drawingDetail.blankingLength || order.drawingDetail.length)) ? (order.drawingDetail.blankingLength || order.drawingDetail.length) : ''
    const partner = api.resolvePartner(selectedStep)
    const isProgrammerStep = !!(partner.need && canComplete)
    // 并行模型：工序下标被认领/提交数据引用，运行期不再增删重复工序，隐藏道数调整
    const isRepeatableStep = false
    const repeatOptions = []
    const repeatTotalChoice = 1

    // 订单级进度提示：最新提交的工序（currentStepIndex 新语义 = 最后提交的工序）
    const lastPtr = Number(order.currentStepIndex) || 0
    const lastStep = steps[lastPtr]

    // 完工确认：全部工序完成 + 我有权限（入库认领人/仓管员/管理员）
    const warehouseIdx = steps.findIndex(s => s.key === 'warehouse')
    const iAmWarehouseClaimant = warehouseIdx >= 0 && claimListOf(warehouseIdx).some(c => c.userId === meId)
    const canFinalize = allStepsDone && !isCompleted && (isAdmin || iAmWarehouseClaimant || _stations.includes('仓管员'))

    // 选中工序的累计/认领信息（表单区展示）
    const selectedAcc = selIdx >= 0 ? accOf(selIdx) : 0
    const selectedClaimList = selIdx >= 0 ? claimListOf(selIdx) : []
    const selectedClaimNames = selectedClaimList.map(c => c.userName || '').filter(Boolean).join('、')

    // 工序 → 历史记录分组（新数据带 stepIndex 精确分组；老数据按 1:1 下标对齐）
    const hist = order.history || []
    const useStepIndex = hist.length > 0 && typeof hist[0].stepIndex === 'number'
    const stepRecordLines = steps.map((s, i) => {
      if (useStepIndex) return hist.filter(h => h.stepIndex === i)
      return i < hist.length ? [hist[i]] : []
    })

    return {
      isAdmin, isFloater, canComplete, isBlankingStep, autoLength,
      isProgrammerStep, isRepeatableStep, repeatOptions, repeatTotalChoice,
      partnerLabel: partner.label,
      partnerKeyword: partner.keyword,
      // 表单上下文 = 选中工序
      selectedStepIdx: selIdx,
      currentStepKey: selectedStep ? selectedStep.key : '',
      currentStepStation: selectedStep ? (selectedStep.station || '') : '',
      currentStepName: selectedStep ? (selectedStep.name || '') : '',
      selectedAcc, selectedClaimNames, selectedClaimCount: selectedClaimList.length,
      // 订单级进度（最后提交工序 + 完成道数）
      currentStepIndex: lastPtr,
      lastSubmitStepName: lastStep ? (lastStep.name || '') : '',
      lastSubmitStepStation: lastStep ? (lastStep.station || '') : '',
      doneCount, totalSteps: steps.length, allStepsDone, canFinalize,
      stepClaimFlags, stepRecordLines, claimableSteps, myClaimSteps,
      qtyTarget,
      batchRemaining: Math.max(steps.length - doneCount, 0)
    }
  },

  /** 把 _computeAccessState 的结果转成 setData 的工序面板补丁（统一各调用点） */
  _stepPatch(acc) {
    return {
      isAdmin: acc.isAdmin,
      isFloater: acc.isFloater,
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
      // 并行模型：选中工序 + 订单级进度 + 完工确认
      selectedStepIdx: acc.selectedStepIdx,
      selectedAcc: acc.selectedAcc || 0,
      selectedClaimNames: acc.selectedClaimNames || '',
      selectedClaimCount: acc.selectedClaimCount || 0,
      currentStepIndex: Number(acc.currentStepIndex) || 0,
      lastSubmitStepName: acc.lastSubmitStepName || '',
      lastSubmitStepStation: acc.lastSubmitStepStation || '',
      doneCount: acc.doneCount || 0,
      totalSteps: acc.totalSteps || 0,
      allStepsDone: !!acc.allStepsDone,
      canFinalize: !!acc.canFinalize,
      stepClaimFlags: acc.stepClaimFlags || [],
      claimableSteps: acc.claimableSteps || [],
      myClaimSteps: acc.myClaimSteps || [],
      stepRecordLines: acc.stepRecordLines || [],
      qtyTarget: acc.qtyTarget || 0,
      batchRemaining: acc.batchRemaining || 0,
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
    const stepStation = (acc && acc.currentStepStation) || ''
    // 工种后缀只显示一个与当前工序匹配的工种（管理员显示「管理员」）
    const pool = api.pickOperatorEmployees(all, stepStation)
      .map(e => ({ ...e, _stationDisplay: api.pickerStationDisplay(e, stepStation) }))
    if (this.data.operatorId && pool.some(e => e.id === this.data.operatorId)) {
      return { operatorEmployees: pool }
    }
    const app = getApp()
    const me = (app && app.globalData && app.globalData.currentUser) || {}
    const meStations = Array.isArray(me.stations) ? me.stations : (me.station ? [me.station] : [])
    const meIsAdmin = me.role === 'admin' || me.role === 'superadmin'
    // 本人是否有当前工序的操作权限：管理员 / 流转工 / 岗位匹配（超管不在候选池也算有权限）
    const hasPermission = meIsAdmin
      || !!(acc && acc.isFloater)
      || (!!acc && meStations.includes(acc.currentStepStation))
    const self = (me.id && hasPermission)
      ? { id: me.id, name: me.name || '', stations: meStations, _stationDisplay: api.pickerStationDisplay(me, stepStation) }
      : (me.id ? pool.find(e => e.id === me.id) : null)
    // 默认自己（仅当本人有当前工序的操作权限）；无权限则不默认显示
    if (!self) {
      return { operatorEmployees: pool, operatorId: '', operatorLabel: '' }
    }
    const st = api.pickerStationDisplay(self, stepStation)
    return {
      operatorEmployees: pool,
      operatorId: self.id,
      operatorLabel: self.name + (st ? ` · ${st}` : '')
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
    this.setData({ pickerTarget: target, pickerList: list })
  },

  hideEmployeePicker() {
    this.setData({ pickerTarget: '' })
  },

  onPickerPanelTap() { /* 阻止冒泡 */ },

  selectEmployee(event) {
    const id = event.currentTarget.dataset.id
    const emp = (this.data.pickerList || []).find(e => e.id === id)
    if (!emp) return
    // 后缀只显示一个匹配工种：操作员按当前工序岗位；配合人员按关键字（编程/调字）
    const match = this.data.pickerTarget === 'programmer'
      ? (this.data.partnerKeyword || '')
      : (this.data.currentStepStation || '')
    const stationDisplay = api.pickerStationDisplay(emp, match)
    const label = emp.name + (stationDisplay ? ` · ${stationDisplay}` : '')
    if (this.data.pickerTarget === 'programmer') {
      this.setData({ programmerId: emp.id, programmerLabel: label, pickerTarget: '' })
    } else {
      this.setData({ operatorId: emp.id, operatorLabel: label, pickerTarget: '' })
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
    // 工序操作员必须岗位匹配（管理员不受限）——与后端校验同口径，避免提交后才报错；
    // 选自己始终允许（本人有面板操作权限才进得来，超管不在候选池也合法）
    const opPool = this.data.operatorEmployees || []
    const meId = (getApp().globalData.currentUser || {}).id
    if (opPool.length > 0 && this.data.operatorId !== meId && !opPool.some(e => e.id === this.data.operatorId)) {
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
        // 并行模型：提交目标是面板选中的工序
        stepIndex: this.data.selectedStepIdx,
        operatorId: this.data.operatorId,
        note,
        completedQty: isBlankingStep ? null : completedQty,
        materialConsumption: submitConsumption,
        // 编程员（后端校验岗位，非编程员会被拒绝）
        programmerId: isProgrammerStep ? this.data.programmerId : ''
      })
      // 多人协作：该工序累计未满订单数量 → 部分提交，工序保持进行中
      if (result && result.partial) {
        ui.hideLoading()
        this.setData({
          note: '',
          completedQty: '',
          materialConsumption: { material: '', roughness: '', length: '', qty: '' },
          calcWeightInfo: null
        })
        await this.refresh({ force: true })
        ui.toast(`已记录 ${isBlankingStep ? materialConsumption.qty : completedQty} 根，该工序累计 ${result.accumulated}/${result.qtyTarget} 根`, 'none')
        return
      }
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
      ui.toast(`已完成「${this.data.currentStepName || '工序'}」`, 'success')
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

  // ===== 一键完成剩余所有工序（管理员直接执行；流转工需管理员审批）=====

  toggleBatchForm() {
    this.setData({ batchOpen: !this.data.batchOpen, batchQty: '' })
  },

  onBatchQtyInput(event) {
    this.setData({ batchQty: event.detail.value })
  },

  async submitBatchComplete() {
    if (this.data.batchSubmitting) return
    const qty = Number(this.data.batchQty)
    if (!qty || qty <= 0) { ui.toast('请填写每道工序的根数'); return }
    const operatorId = this.data.operatorId
    if (!operatorId) { ui.toast('请先在上方选择工序操作员'); return }
    const ok = await ui.confirm('确定一键完成剩余所有工序吗？', '一键完成', { confirmColor: '#b45309', modalTimeout: 6000, fallbackOnTimeout: true })
    if (!ok) return
    this.setData({ batchSubmitting: true })
    try {
      ui.showLoading('提交中...')
      const r = await api.batchComplete(this.orderId, operatorId, qty)
      ui.hideLoading()
      this.setData({ batchOpen: false, batchQty: '' })
      if (r && r.pendingApproval) {
        ui.toast('已提交，等待管理员审批', 'success')
      } else {
        ui.toast(`已一键完成 ${r.completedCount} 道工序，工单完工`, 'success')
      }
      await this.refresh({ force: true })
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '一键完成失败')
    } finally {
      this.setData({ batchSubmitting: false })
    }
  },

  // ===== 工单认领（按工序）=====

  /** 认领当前工序：后端校验岗位匹配/无人认领，幂等可重复点击 */
  async claimCurrentStep() {
    const idx = Number(this.data.order && this.data.order.currentStepIndex) || 0
    await this._claimStepAt(idx)
  },

  /** 面板切换填写的目标工序（在我认领的工序 chips 间切换） */
  selectPanelStep(event) {
    const idx = Number(event.currentTarget.dataset.stepIndex)
    if (!Number.isInteger(idx)) return
    this.setData({ selectedStepIdx: idx })
    // 重算表单上下文（下料字段/编程员/操作员候选池随工序变化）
    const app = getApp()
    const order = this.data.order
    if (order) {
      const acc = this._computeAccessState(app.globalData.currentUser, order)
      this.setData(this._stepPatch(acc))
    }
  },

  /** 确认工单完工（并行模型收尾）：全部工序完成后由入库仓管员/管理员触发 */
  async finalizeOrderConfirm() {
    if (this.data.finalizing) return
    const ok = await ui.confirm('确认所有工序已完成，工单完工？', '工单已完成')
    if (!ok) return
    this.setData({ finalizing: true })
    try {
      ui.showLoading('确认完工中...')
      await api.finalizeOrder(this.orderId)
      ui.hideLoading()
      await this.refresh({ force: true })
      ui.toast('工单已完工', 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '确认完工失败')
    } finally {
      this.setData({ finalizing: false })
    }
  },

  /** 认领指定工序（工序流转列表里的未来工序按钮） */
  async claimStep(event) {
    const idx = Number(event.currentTarget.dataset.stepIndex)
    if (!Number.isInteger(idx)) return
    await this._claimStepAt(idx)
  },

  /** 按下标认领工序的统一入口 */
  async _claimStepAt(idx) {
    if (this.data.claimBtnLoading) return
    this.setData({ claimBtnLoading: true })
    try {
      ui.showLoading('认领中...')
      await api.claimOrder(this.orderId, idx)
      ui.hideLoading()
      ui.toast('认领成功，已加入「我的工单」', 'success')
      await this.refresh({ force: true })
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '认领失败')
    } finally {
      this.setData({ claimBtnLoading: false })
    }
  },

  /** 取消/撤销当前工序认领：本人可取消自己的认领；管理员可撤销任何人的认领（换人推进） */
  async releaseCurrentClaim() {
    const idx = Number(this.data.order && this.data.order.currentStepIndex) || 0
    await this._releaseStepAt(idx)
  },

  /** 撤销指定工序的认领（工序流转列表里的撤销按钮） */
  async releaseStepClaim(event) {
    const idx = Number(event.currentTarget.dataset.stepIndex)
    if (!Number.isInteger(idx)) return
    await this._releaseStepAt(idx)
  },

  /** 按下标撤销认领的统一入口（多认领模型：stepClaims[idx] 是认白数组） */
  async _releaseStepAt(idx) {
    const raw = ((this.data.order && this.data.order.stepClaims) || {})[idx]
    // 兼容数组（新模型）与单对象（旧缓存）：统一归一化为数组
    const list = Array.isArray(raw) ? raw.filter(Boolean) : (raw ? [raw] : [])
    if (list.length === 0) return
    const me = getApp().globalData.currentUser || {}
    const myClaim = list.find(c => c.userId === me.id)
    const isSelf = !!myClaim
    // 工序名：优先取认领记录上的，缺失时回退到步骤定义
    const stepName = list[0].stepName || ((this.data.order.steps || [])[idx] || {}).name || ''
    // 被撤销人名字列表（管理员撤销他人时展示）
    const names = list.map(c => c.userName).filter(Boolean).join('、')
    const ok = await ui.confirm(
      isSelf
        ? `确定取消认领「${stepName}」吗？取消后其他员工可重新认领该工序。`
        : `确定撤销「${names || '该员工'}」对「${stepName}」的认领吗？撤销后其他员工可重新认领该工序。`,
      isSelf ? '取消认领' : '撤销认领',
      { confirmColor: '#b45309', modalTimeout: 4000, fallbackOnTimeout: true }
    )
    if (!ok) return
    if (this.data.claimBtnLoading) return
    this.setData({ claimBtnLoading: true })
    try {
      ui.showLoading('处理中...')
      if (isSelf) {
        // 只取消本人认领（不误伤同工序其他认领人）
        await api.releaseClaim(this.orderId, idx, myClaim.claimId)
      } else {
        // 管理员撤销他人：该工序全部认领逐条撤销（后端一次撤一条）
        for (const c of list) {
          await api.releaseClaim(this.orderId, idx, c.claimId)
        }
      }
      ui.hideLoading()
      ui.toast(isSelf ? '已取消认领' : '已撤销认领', 'success')
      await this.refresh({ force: true })
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '撤销认领失败')
    } finally {
      this.setData({ claimBtnLoading: false })
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

