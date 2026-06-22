# 兴祥机械跟单系统 - 代码架构与开发指南

> 本文档为「兴祥机械跟单系统」小程序的完整代码架构解析与自主迭代指引。
> 适用对象：项目维护者、新加入开发者。
> 阅读完本文档后，开发者应能独立完成：① 修改现有功能；② 添加新功能；③ 排查常见问题。

---

## 一、项目总览

### 1.1 业务定位
- **场景**：机械加工厂的工单（生产订单）全流程管理
- **核心闭环**：管理员创建工单 → 车间员工扫码完成工序 → 库存自动扣减 → 产量自动统计 → 备份与还原
- **技术栈**：微信小程序原生 + 微信云开发（云函数 + 云数据库 + 云存储）

### 1.2 关键信息
- **AppID**：`wx9bfacc8055b12874`
- **云开发环境**：`cloud1-d5g9vjcxhac7a2f30`
- **最低基础库版本**：2.19.0（在 `miniprogram/app.js` 中检测）
- **云函数数量**：10 个
- **页面数量**：8 个（4 个主包 + 2 个分包）
- **角色模型**：`superadmin` > `admin` > `worker`

---

## 二、目录结构与模块划分

```
跟单系统/
├── miniprogram/                          # 小程序前端
│   ├── app.js                            # 应用入口：登录态、错误监控、权限守卫
│   ├── app.json                          # 全局配置：页面注册、分包、窗口样式
│   ├── app.wxss                          # 全局样式（主色 #0f766e、警示 #dc2626）
│   ├── privacy.json                      # 微信隐私保护配置
│   ├── sitemap.json                      # 站内搜索规则
│   │
│   ├── pages/                            # 主包页面（4 个）
│   │   ├── home/index.*                  # 首页：仪表盘 + 员工管理弹窗 + 日志
│   │   ├── scan/index.*                  # 扫码入口：识别工单码/入驻码
│   │   ├── join/index.*                  # 员工入驻申请页
│   │   └── profile/index.*               # 个人中心：我的数据
│   │
│   ├── package-order/                    # 订单分包（按需加载）
│   │   ├── pages/
│   │   │   ├── orders/index.*            # 工单列表（多分类筛选、批量导出）
│   │   │   └── order-detail/index.*      # 工单详情（核心业务页，~895 行）
│   │   └── utils/qr-url.js               # 二维码 URL 生成（第三方 API）
│   │
│   ├── package-admin/                    # 管理分包
│   │   ├── pages/
│   │   │   ├── admin/index.*             # 管理中心：仪表盘 + 二维码 + 备份
│   │   │   ├── create-order/index.*      # 创建工单表单
│   │   │   └── material/index.*          # 材料库存管理
│   │   │
│   ├── utils/                            # 全局工具
│   │   ├── api.js                        # ★ 统一 API 服务层（云函数调用封装，~518 行）
│   │   ├── ui.js                         # UI 工具：loading/toast/modal/防抖节流
│   │   └── export-excel.js               # 工单导出为 .xls（HTML 表格）
│   │
│   └── components/skeleton/              # 骨架屏组件（已封装，未使用）
│
├── cloudfunctions/                       # 云函数（10 个）
│   ├── auth/                             # 鉴权 + 邀请码 + 小程序码
│   ├── orderManager/                     # 工单管理大集合（14 个 action）
│   ├── completeStep/                     # 完成工序 + 库存扣减
│   ├── createOrder/                      # 创建工单
│   ├── approveEmployee/                  # 员工审批
│   ├── employeeManager/                  # 员工列表/岗位/角色
│   ├── inventoryManager/                 # 库存 CRUD
│   ├── backupManager/                    # 备份还原
│   ├── autoBackup/                       # 定时自动备份
│   └── init-db/                          # 一次性数据库初始化
│
├── admin/                                # Web 静态管理后台（预留，2.21KB 起步）
├── scripts/                              # 预发布检查脚本
├── project.config.json                   # 小程序项目配置
└── project.private.config.json           # 私有配置（云开发环境 ID）
```

---

## 三、核心业务流转

### 3.1 入驻流程（从陌生访客到活跃员工）

```
[陌生用户扫码] → 微信小程序码(generateJoinQRCode)
     ↓
pages/scan/index.js (识别 INV-XXXXXXXX)
     ↓
pages/join/index.js (填写姓名+备注)
     ↓
云函数 auth → submitJoinApplication
     ↓
数据库 pending_applications (status=pending)
     ↓
[管理员] pages/home/index.js → 员工管理弹窗 → 审批通过
     ↓
云函数 approveEmployee → approve
     ↓
数据库 users (status=active)
     ↓
下次启动 app.js → auth/login → state='active' ✓
```

涉及文件：
- `miniprogram/pages/scan/index.js`（L59-85）`scanCode()`
- `miniprogram/pages/join/index.js`（L45-87）`submitApplication()`
- `miniprogram/utils/api.js`（L396-406）`submitJoinApplication()`
- `cloudfunctions/auth/index.js`（L337-412）`submitJoinApplication()`
- `cloudfunctions/auth/index.js`（L513-673）`generateJoinQRCode()`（4 级回退）
- `miniprogram/pages/home/index.js`（L166-196）`toggleEmpModal()` + L280-290 `approveEmp()`
- `cloudfunctions/approveEmployee/index.js`（L25-113）`approve`

### 3.2 工单生命周期

```
[管理员] 创建工单
  ↓ createOrder 云函数
数据库 orders (status='processing', currentStepIndex=0, history=[])
  ↓
[员工] 扫码进入详情
  ↓
[员工] 完成当前工序
  ↓ completeStep 云函数
乐观锁更新 currentStepIndex + history 追加
  ↓ （下料工序）原子 inc 扣减库存
  ↓
循环至所有工序完成
  ↓
status='completed'，弹完工提示
  ↓
[管理员] 可：暂停/恢复、加急/取消加急、撤回工序、上传图纸、删除
```

涉及文件：
- `miniprogram/package-admin/pages/create-order/index.js`（L592-631）`submit()`
- `cloudfunctions/createOrder/index.js`（L28-172）`main()`
- `miniprogram/package-order/pages/order-detail/index.js`（L322-411）`completeStep()`
- `cloudfunctions/completeStep/index.js`（L34-286）`main()`
- `miniprogram/package-order/pages/order-detail/index.js`（L501-538）`revertStep()`
- `cloudfunctions/orderManager/index.js`（L218-282）`revertStep()`

### 3.3 库存与产量统计

```
[管理员] 入库/出库/设置库存
  ↓ inventoryManager 云函数（原子 inc）
数据库 inventory（按 material + roughness 维度存）
数据库 material_logs（流水日志）
  ↓
[员工] 完成下料工序
  ↓ completeStep 云函数
  ↓ 预检 → 乐观锁 → 原子 inc(-X)
  ↓
数据库 orders.history 追加（带 materialConsumption）
  ↓
[管理员] 查看月度报表
  ↓ orderManager → allEmployeesMonthlyProduction
  ↓ 内存聚合：遍历所有工单 history 按 operatorId 分组
  ↓
导出 Excel → utils/export-excel.js（HTML 表格格式）
```

### 3.4 备份与还原

```
[超管] 手动备份
  ↓ backupManager → backup
8 个集合分页拉取（每页 200）→ 写入 backups.collections
  ↓
自动定时：autoBackup（每 2 小时触发）→ 写入 type='auto' 备份
  ↓
MAX_BACKUPS=24，超过自动清理
  ↓
[超管] 还原
  ↓ backupManager → restore（confirm=true 二次确认）
逐集合：fetchAll → 逐条删除 → 逐条 add
  ⚠️ 注意：所有 users._id 重新生成，token 全部失效，所有用户需重新登录
```

---

## 四、关键模块与配置详解

### 4.1 应用入口 `app.js`

**职责**：
1. 初始化云开发
2. 全局错误监控（`wx.onError` + `wx.onUnhandledRejection` + 包装 `wx.cloud.callFunction`）
3. 网络状态监听
4. 设备 ID 持久化（`dev-{timestamp}-{random}`）
5. 鉴权：`syncAccessContext()` → `auth/login`
6. 权限守卫：`requireActiveAccess(redirectUrl)`

**关键方法**：
- `setupErrorMonitoring()` (L12-37)：注册三类错误捕获
- `logError(type, detail)` (L40-53)：本地存储最近 50 条
- `syncAccessContext()` (L167-199)：调用 `auth` 云函数
- `_clearAuth()` (L201-207)：清除登录态（已登录/已禁用都走这里）
- `waitForAccessReady()` (L209-212)：Promise 化登录等待
- `requireActiveAccess(redirectUrl)` (L223-239)：权限守卫

**globalData 字段**：
```js
{
  currentUser: null | { id, name, role, stations, status },
  accessState: 'guest' | 'pending' | 'active',
  deviceId: 'dev-...',
  appName: '兴祥机械跟单系统',
  accessReady: false,  // 鉴权是否完成
  authReadyPromise: null,  // 鉴权 Promise（防重复）
  isNetworkConnected: true,
  systemInfo: null
}
```

### 4.2 鉴权云函数 `cloudfunctions/auth/index.js`

**Action 列表**：
- `login` (L115-251)：通过 openid + deviceId 登录，含 4 级回退匹配（users → pending_applications[approved] → guest → pending）
- `verify` (L257-292)：验证 token
- `logout` (L689-692)：清空会话（仅返回成功，未真正失效 token）
- `createInviteCode` (L300-329)：仅管理员生成 INV-XXXXXXXX
- `submitJoinApplication` (L337-412)：用户提交申请
- `generateJoinQRCode` (L513-673)：4 级回退生成小程序码
- `ping` (L64-71)：健康检查，返回 openid

**Token 机制**：
- HMAC-SHA256 签名
- 格式：`base64(payload).hex(signature)`
- `TOKEN_SECRET` 从环境变量读取，默认值（生产必须设置）
- 7 天过期

**4 级小程序码生成回退**（L549-670）：
1. `cloud.openapi.wxacode.getUnlimited`（推荐）
2. `cloud.openapi.wxacode.get`（普通小程序码）
3. `cloud.openApi.wxacode.getUnlimited`（兼容旧版）
4. HTTP 直调 `api.weixin.qq.com/wxa/getwxacodeunlimit`
5. HTTP 直调 `api.weixin.qq.com/wxa/getwxacode`

### 4.3 统一 API 服务层 `miniprogram/utils/api.js`

**所有云函数调用都通过此文件**，不要在页面中直接 `wx.cloud.callFunction`。

**核心机制**：
- **5 秒缓存**：仅 GET 类操作（`getDashboard` / `listOrders` / `getOrder` / `listEmployees` / `getMaterialTypes` / `getMaterialInventory` / `getMaterialStockByRoughness` / `getMaterialLogs` / `listLogs`）
- **1 次重试**：网络类错误自动重试，业务错误不重试
- **30 秒清理**：定时清理过期缓存
- **统一错误抛出**：业务错误抛 `Error(result.error)`

**关键常量**：
- `PROCESS_LIBRARY` (L7-23)：15 个工序（前后端一致，硬编码 3 处：utils/api.js、orderManager.js、completeStep.js、init-db.js）
- `ROUGHNESS_COEFFICIENTS` (L26-38)：45 个粗度系数（kg/m），查表失败时用 `d*d*0.006165` 兜底

**导出函数分类**：
```
工单  : getDashboard / listOrders / getOrder / createOrder
      : completeCurrentStep / togglePause / toggleOrderUrgent
      : revertCompletedStep / updateOrderStepKeys / updateOrderDrawings / deleteOrder
员工  : listEmployees / updateEmployeeStations / updateEmployeeRole / inviteEmployee
      : approveEmployee / rejectEmployee / deleteEmployee
库存  : getMaterialTypes / getMaterialInventory / getMaterialStockByRoughness
      : addMaterialStock / deductMaterialStock / setMaterialStock / addMaterialType / getMaterialLogs
产量  : getEmployeeMonthlyProduction / getAllEmployeesMonthlyProduction / getProductionRows
      : buildMonthHeaders
日志  : listLogs(days) / cleanupOldLogs()
入驻  : getSystemJoinInviteCode / getSystemJoinPath / getJoinQRCodeFileID
      : generateJoinQRCode(force) / isQRCodeExpired / isValidJoinInviteCode
      : submitJoinApplication
备份  : createBackup / listBackups / restoreBackup / deleteBackup
工具  : getCurrentUserId / isCurrentUserAdmin / isCurrentUserActive
      : getOrderStatusLabel / isOverdue
```

### 4.4 工单详情页 `package-order/pages/order-detail/index.js`

**这是整个系统最复杂、修改最频繁的页面**（约 895 行）。

**状态字段**：
```js
data: {
  order,                          // 当前工单（含 steps / history / currentStepIndex）
  note, completedQty,             // 完成工序时的输入
  currentUser,                    // 当前用户
  processList,                    // 工序库（从 api.js 取）
  editingSteps,                   // 是否在编辑工序
  selectedSteps, selectedStepKeys,  // 已选工序（含 instanceId）
  isAdmin, canComplete,           // 权限与操作权
  materialTypes,                  // 材料下拉选项
  materialConsumption,            // 下料工序的输入
  isBlankingStep,                 // 当前是否是下料
  operatorId, operatorLabel,      // 操作员选择
  activeEmployees,                // 可选操作员列表
  showOperatorPicker,             // 操作员选择弹窗
  operatorSearchKeyword           // 操作员搜索关键词
}
```

**关键方法**：
- `onLoad(options)` (L31-39)：校验权限 + 初次 refresh
- `refresh()` (L57-156)：并发加载工单+材料+员工，处理图纸临时 URL
- `completeStep()` (L322-411)：完成工序（带重复提交保护 `_completing`）
- `togglePause() / toggleUrgent()` (L413-435)：管理员切换
- `enterEditSteps()` (L437-460)：进入编辑模式
- `addStep() / removeSelectedStep()` (L468-498)：编辑工序
- `revertStep()` (L501-538)：撤回已完成的工序
- `saveStepChanges()` (L541-573)：保存工序配置
- `deleteOrder()` (L575-605)：删除工单（带重复点击保护 `_deleting`）
- `_uploadFiles()` (L822-884)：上传图纸到云存储
- `chooseDrawing()` (L662-668)：触发 ActionSheet（隐私授权检查）

**业务逻辑要点**：
- `canComplete = order.status !== 'completed' && (isAdmin || _stations.includes(order.currentStation))`
- 下料工序必须填：material + roughness (0-200) + length (>0) + qty (>0)
- 其他工序必须填：completedQty (非负)
- 库存扣减：预检 → 乐观锁 → 原子 inc
- 操作员：默认当前用户，admin 可选其他人
- 重复工序：允许添加（用 instanceId 区分），已完成的不可删可撤回

### 4.5 工单管理云函数 `cloudfunctions/orderManager/index.js`

**最大的云函数**（约 706 行，14 个 action）。

**Action 列表**：
```
dashboard                → 仪表盘（6 个 count + 1 个 pending）
listOrders(page, pageSize)  → 工单列表（默认 pageSize=100，enrichOrder 加工）
getOrder(orderId)        → 单个工单
togglePause              → 暂停/恢复（仅管理员）
toggleUrgent             → 加急切换（仅管理员）
revertStep               → 撤回工序（仅管理员，含库存回退）
updateStepKeys           → 修改工序配置（仅管理员）
updateDrawings           → 追加图纸（仅管理员）
deleteOrder              → 删除工单（仅管理员，含库存回退+清理）
employeeMonthlyProduction    → 单员工月度产量
allEmployeesMonthlyProduction → 全员月度产量（单次查 1000 工单内存聚合）
productionRows           → 全部生产明细行
listLogs(days)           → 审计日志（限制 1-7 天，最多 100 条）
cleanupLogs              → 清理 3 个月前日志（已加 admin 守卫）
```

**enrichOrder(order) (L78-91)**：统一加工工单返回字段
- `steps`：根据 `stepKeys` 映射为完整工序对象
- `overdue` / `category` / `categoryLabel` / `statusLabel` / `progress` / `currentStepName` / `currentStation`

**dashboard.processing 修复说明**：
原逻辑 `total - completed - paused - overdue - urgent` 有 bug（urgent 是 processing 子集，重复减）。
**正确公式**：`total - completed - paused`。

### 4.6 完成工序云函数 `cloudfunctions/completeStep/index.js`

**核心逻辑**：
1. 鉴权（用户 active）
2. operatorId 校验（非管理员必须本人）
3. 工单状态检查（未完工、未暂停-非管理员）
4. **库存预检**（下料工序）→ 不通过则报错
5. 构造 historyEntry（含 stepKey / stepName / operator / qty / materialConsumption）
6. **乐观锁** `where({_id, currentStepIndex}).update()`，updated=0 则报错
7. 乐观锁成功后 → 原子 `inc(-X)` 扣减库存
8. 库存扣减失败 → 写 `audit_logs` 标记（不阻断主流程）
9. 构造 enriched order 返回前端

**自动完工分支**（L81-122）：
当 `currentStepIndex` 越界（所有工序已完成），走该分支：
- 构造 `__completed__` historyEntry
- 写 `status='completed'`
- **已加乐观锁修复**：`where({_id, status: 'processing'}).update()` 防止并发完工

### 4.7 创建工单云函数 `cloudfunctions/createOrder/index.js`

**工单号生成**（已修复竞态）：
- 格式：`GD + 8位日期 + 3位序号`，如 `GD20260115001`
- 原子计数器集合 `daily_counters`（key = `GD20260115`，seq 自增）
- 修复后的逻辑：`inc(1)` 后立即 `get()` 读取最新值
- **唯一性保护**：循环检查 `orders.id` 是否已存在，最多 50 次

**`stepKeys` 校验**：必须存在于 `PROCESS_LIBRARY` 中（`steps.filter(Boolean)` 过滤掉无效 key）

### 4.8 数据库集合速查

| 集合 | 关键字段 | 索引 |
|---|---|---|
| `users` | openid, name, role, stations[], status | openid unique, status |
| `orders` | id, qrContent, customerName, type, size, qty, material, dueDate, stepKeys[], currentStepIndex, history[], drawings[], drawingDetail, status, paused, urgent | id unique, status, paused, urgent, dueDate, createdAt |
| `inventory` | name, stock{roughness: tonnage} | name unique |
| `material_logs` | type(in/out/set), material, roughness, qty, operator, operatorId, note, orderId | createdAt |
| `pending_applications` | deviceId, openid, name, stations[], status, userId | status |
| `invite_codes` | code(INV-XXXXXXXX), type, createdBy, maxUses, usedCount, isActive, expiresAt | - |
| `join_qrcodes` | inviteCode, fileID, cloudPath | - |
| `processes` | key, name, station | - |
| `audit_logs` | action, targetId, targetName, operatorId, operatorName, note, createdAt | createdAt, targetId |
| `backups` | backupId, type(full/auto), counts{}, totalRecords, collections{}, createdAt | - |
| `daily_counters` | _key(GD+YYYYMMDD), seq | _key unique |

---

## 五、自主迭代指引

### 5.1 添加新页面

**步骤**：
1. 创建页面文件：`miniprogram/pages/new-page/index.{js,wxml,wxss,json}`
2. 在 `app.json` 中注册（主包直接加，分包在 `subpackages` 中加）
3. 如需 API：在 `miniprogram/utils/api.js` 中添加云函数调用封装
4. 页面中使用 `getApp().waitForAccessReady()` 等待鉴权，`requireActiveAccess()` 守卫

**模板**：
```js
const api = require('../../utils/api')
Page({
  data: { currentUser: null },
  async onShow() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/home/index')) return
    this.setData({ currentUser: app.globalData.currentUser })
    // 业务逻辑
  }
})
```

### 5.2 修改现有功能

#### 5.2.1 修改首页指标
**文件**：`miniprogram/pages/home/index.js` + `cloudfunctions/orderManager/index.js`
- 前端 WXML：`miniprogram/pages/home/index.wxml`（`dashboard.*` 字段）
- 后端字段：`getDashboard()` 返回的字段
- 若要新增指标，需同时修改前端展示 + 后端聚合

#### 5.2.2 修改工单详情页
**文件**：`miniprogram/package-order/pages/order-detail/index.{js,wxml,wxss}`
- 修改业务流程：编辑 `index.js`，注意 `refresh()` 是入口
- 修改 UI：编辑 `index.wxml` + `index.wxss`
- 注意：所有云函数调用通过 `utils/api.js`

#### 5.2.3 修改工序库
**文件**（3 处必须同步）：
- `miniprogram/utils/api.js`（L7-23）
- `cloudfunctions/orderManager/index.js`（L10-26）
- `cloudfunctions/completeStep/index.js`（L10-26）
- `cloudfunctions/init-db/index.js`（L120-136）

修改后须：
1. 在 `init-db` 中执行一次，重新写入 `processes` 集合
2. 已存在的工单（`stepKeys`）可能引用旧的 key，需手工迁移

#### 5.2.4 修改材料类型
**文件**：
- `cloudfunctions/inventoryManager/index.js`（L9-11）`MATERIAL_TYPES`
- `cloudfunctions/init-db/index.js`（L166-173）默认材料列表

注意：`MATERIAL_LOW_THRESHOLDS`（L13-15）低库存阈值需要同步修改。

#### 5.2.5 修改导出格式
**文件**：`miniprogram/utils/export-excel.js`
- `generateOrderHtml(orders)` (L92-189)：工单导出 HTML 表格
- `generateProductionDetailHtml(rows, singleEmployee, year)` (L255-332)：员工生产明细
- `exportOrders(orders, fileName)` (L204-245)：统一导出入口

#### 5.2.6 修改审计日志映射
**文件**：3 个页面都有 `logActionMap`：
- `miniprogram/pages/home/index.js`（L46-69）
- `miniprogram/pages/profile/index.js`（L26-49）
- `miniprogram/package-admin/pages/admin/index.js`（L37-60）

**建议**：提取到 `utils/api.js` 或新建 `utils/log-actions.js` 统一管理。

### 5.3 添加新功能模块（以"添加新工序"为例）

**步骤**：
1. 在 `utils/api.js` + 3 个云函数 + `init-db` 中同步添加工序定义
2. （可选）在 `processes` 集合中预置
3. 测试：创建工单时可选新工序，完成流转是否正常

### 5.4 添加新云函数

**步骤**：
1. 在 `cloudfunctions/` 下新建目录（如 `newFunction`）
2. 编写 `index.js` + `package.json`
3. 在微信开发者工具中"上传并部署"
4. 在 `miniprogram/utils/api.js` 中添加调用封装：
   ```js
   async function callNewFunction(params) {
     const result = await callFunction('newFunction', { action: 'xxx', ...params })
     return result.data
   }
   module.exports = { ..., callNewFunction }
   ```
5. 在小程序端调用

### 5.5 修改数据库结构

**警告**：数据库结构变更涉及生产数据，务必：
1. 先在测试环境验证
2. 编写数据迁移脚本
3. 在 `DATABASE_INDEXES.json` 中更新索引
4. 在云开发控制台手动添加/修改索引
5. 修改对应云函数的 `where` 查询与 `data` 写入

### 5.6 排查常见问题

| 现象 | 可能原因 | 排查路径 |
|---|---|---|
| 扫码后空白 | `scan/index.js` `extractOrderId` 没匹配 GD | `console.log` `scannedText` |
| 库存扣成负数 | `completeStep` 库存预检与 inc 之间的窗口 | `material_logs` + `audit_logs` 查 `stock_deduction_failed` |
| 工单号重复 | 旧版本 `createOrder` 竞态（已修复） | 检查部署版本 + `daily_counters` 集合 |
| 工序撤回后显示错位 | `revertStep` 计算 `revertIndex` 错误（已修复） | `order.history` 数组顺序 |
| Token 失效 | `restoreBackup` 后 `users._id` 变化 | 通知所有员工重新扫码登录 |
| 二维码生成失败 | 4 级回退全失败 | `auth/index.js` L549-670 加日志 |

---

## 六、修改注意事项

### 6.1 强制规范
1. **所有云函数调用必须通过 `utils/api.js`**，禁止页面直接 `wx.cloud.callFunction`
2. **所有权限校验在云函数中做**（前端只是 UX 提示）
3. **任何写入操作需考虑并发**：使用乐观锁或原子 inc
4. **删除操作需考虑库存回退**：参考 `orderManager/deleteOrder`
5. **新增集合需在 `init-db` 中预创建**（避免首次访问失败）
6. **修改 `PROCESS_LIBRARY` 必须 4 处同步**

### 6.2 性能注意事项
1. **`orderManager` 大量操作 `.limit(1000)`**：超过 1000 工单后内存聚合性能下降
2. **缓存 5 秒**：`getDashboard` / `listOrders` 等有 5 秒缓存，数据更新可能有延迟
3. **`getAllEmployeesMonthlyProduction` 单次查 1000 工单 + 200 用户** + 内存聚合
4. **云函数默认 20s 超时**：`backupManager/restoreBackup` 大数据量可能超时
5. **`orderManager/listOrders` 硬编码 100**：超过 100 工单会丢失（需改造分页）

### 6.3 安全注意事项
1. **`TOKEN_SECRET` 必须在云函数环境变量中设置**（默认值是开发用，不安全）
2. **`daily_counters` 集合无索引保护**：若需要严格唯一性，需加 `unique` 索引
3. **`auth` 云函数返回的 user 对象不包含 openid**：前端若需要 openid 必须调用 `auth/ping` 获取
4. **操作员代操作有完整审计**（historyEntry 含 `operatorId` + `user._id`）

### 6.4 已知限制与遗留问题
1. **第三方二维码 API**（`package-order/utils/qr-url.js`）：工单号暴露给 `api.qrserver.com`，生产环境应替换为云函数内 `cloud.openapi.wxacode.getUnlimited`
2. **`getOpenid` 云函数目录为空**：无实际功能
3. **`admin/` 目录是预留 Web 后台**，未实现完整功能
4. **`orderManager/cleanupLogs` 20 轮循环**：极端情况下仍可能遗留
5. **导出 Excel 用 HTML 表格伪装 .xls**：在 Mac Numbers 中可能显示异常
6. **`deleteOrder` 后 setTimeout 1.5s 才返回**：用户可能在等待期间操作其他按钮（已加 `_deleting` 保护）

---

## 七、上线 Checklist

- [ ] 云函数全部上传并部署（含依赖）
- [ ] `TOKEN_SECRET` 环境变量已设置
- [ ] 数据库索引已创建（参考 `DATABASE_INDEXES.json`）
- [ ] `init-db` 已执行一次（创建集合+工序+管理员+材料）
- [ ] `privacy.json` 已配置（微信公众平台）
- [ ] 隐私协议已审核通过
- [ ] 备案信息已完善
- [ ] 已备份当前数据库（`backupManager` 手动）
- [ ] 通知所有用户首次登录需扫码申请

---

## 八、附录：关键文件速查

| 想做什么 | 改这个文件 |
|---|---|
| 修改首页指标 | `miniprogram/pages/home/index.{js,wxml}` + `cloudfunctions/orderManager/index.js#getDashboard` |
| 修改工单详情 | `miniprogram/package-order/pages/order-detail/index.{js,wxml,wxss}` |
| 修改创建工单 | `miniprogram/package-admin/pages/create-order/index.{js,wxml}` + `cloudfunctions/createOrder/index.js` |
| 修改库存 | `miniprogram/package-admin/pages/material/index.{js,wxml}` + `cloudfunctions/inventoryManager/index.js` |
| 修改员工审批 | `miniprogram/pages/home/index.js`（员工管理弹窗） + `cloudfunctions/approveEmployee/index.js` |
| 修改导出 | `miniprogram/utils/export-excel.js` |
| 修改工序库 | `miniprogram/utils/api.js` + 3 个云函数 + `init-db`（4 处同步） |
| 修改权限模型 | `miniprogram/app.js#requireActiveAccess` + 各云函数 `requireAdmin/requireSuperAdmin` |
| 修改审计日志 | `cloudfunctions/*/index.js`（每个写 `audit_logs` 的地方） + 3 个页面的 `logActionMap` |
| 修改样式主色 | `miniprogram/app.wxss` |
| 修改路由 | `miniprogram/app.json`（注意分包懒加载） |
| 添加新云函数 | `cloudfunctions/newFn/index.js` + `miniprogram/utils/api.js` 加封装 |
| 添加新集合 | `cloudfunctions/init-db/index.js#L101`（requiredCollections） + 在云开发控制台创建 |

---

**文档版本**：v1.0  
**最后更新**：2026-06-22  
**适用代码版本**：release_0.1.0
