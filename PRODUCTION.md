生产环境上线操作指南

本文档指导如何从演示版本升级到生产环境部署。

## 📋 核心变更（演示 → 生产）

| 模块 | 演示环境 | 生产环境 |
|-----|--------|--------|
| **鉴权与会话** | 本地 mock-store + 前端 sessionUserId | 微信 openid + 云函数 + 数据库 |
| **邀请码** | 固定全局码 `JOIN-20260516` | 云函数动态生成，有效期 24h，仅一次使用 |
| **审批流** | 本地状态切换 | 后端数据库记录 + 审计日志 |
| **权限校验** | 前端 currentUser.role 判定 | 后端通过 token/openid 验证 |
| **库存/工单管理** | 本地 state 数组 | 数据库集合 (orders, inventory, logs) |
| **演示快捷方式** | 存在多处（如手动设置 sessionUserId） | 全部移除 |

---

## 🚀 上线前准备清单（必做）

### 第 1 步：准备微信小程序账号与环境
- [ ] 在微信公众平台注册小程序账号（或获得现有账号权限）
- [ ] 记录 AppID、AppSecret、服务器 IP 白名单
- [ ] 申请小程序云开发环境（云函数、数据库、存储）
- [ ] 配置小程序服务器域名（用于调用云函数）

### 第 2 步：部署云函数与数据库
- [ ] 将 `cloudfunctions/auth/index.js` 上传为云函数，函数名：`auth`
- [ ] 在微信云开发控制台创建以下数据库集合：
  ```
  - users                   (已激活用户)
  - pending_applications    (待审批申请)
  - invite_codes           (邀请码及其状态)
  - orders                 (工单表)
  - inventory              (库存表，按材料+粗度维度)
  - audit_logs             (审计日志)
  ```
- [ ] 配置 users 集合的默认第一个超级管理员账号（或在云函数初始化时插入）
  ```json
  {
    "openid": "你本人的微信 openid",
    "name": "你的名字",
    "role": "superadmin",
    "stations": ["超级管理员"],
    "status": "active",
    "createdAt": "Date",
    "lastLoginAt": "Date"
  }
  ```

### 第 3 步：迁移本地 mock 数据到数据库
- [ ] 导出 mock-store 中的初始工单、库存、材料数据到对应集合
- [ ] 批量导入历史员工数据（active 用户）到 users 集合
- [ ] 导入审计日志（如需要）

### 第 4 步：修改客户端代码
- [ ] 在 `miniprogram/app.js` 中修改鉴权逻辑：
  ```javascript
  // 原来的 mock-store 调用改为调用云函数
  syncAccessContext() {
    const deviceId = this.ensureDeviceId()
    
    // 先尝试调用云函数鉴权
    return wx.cloud.callFunction({
      name: 'auth',
      data: { action: 'login', deviceId }
    }).then(res => {
      const { state, user, token } = res.result
      this.globalData.accessState = state
      this.globalData.currentUser = user
      if (token) {
        wx.setStorageSync('auth_token', token)
      }
      return res.result
    }).catch(err => {
      // 降级：如果云函数不可用，使用本地 fallback（仅开发/演示）
      console.warn('auth service unavailable, falling back to mock')
      // ... 原本地逻辑
    })
  }
  ```
- [ ] 移除所有演示快捷方式（见第 5 步）
- [ ] 在所有写操作前调用云函数验证 token
  ```javascript
  // 例：创建工单前验证
  async createOrder(payload) {
    const token = wx.getStorageSync('auth_token')
    const verifyRes = await wx.cloud.callFunction({
      name: 'auth',
      data: { action: 'verify', token }
    })
    if (!verifyRes.result.success) {
      throw new Error('权限验证失败')
    }
    // 继续创建工单...
  }
  ```

### 第 5 步：移除演示快捷方式
发现的演示代码位置需要在生产分支中移除或禁用：

#### 5.1 硬编码邀请码（需替换为动态生成）
```javascript
// ❌ 旧代码（miniprogram/utils/mock-store.js）
const SYSTEM_JOIN_INVITE_CODE = 'JOIN-20260516'

// ✅ 新代码：通过云函数动态获取
async function getInviteCode() {
  const token = wx.getStorageSync('auth_token')
  const res = await wx.cloud.callFunction({
    name: 'auth',
    data: { action: 'createInviteCode', token, expiresIn: 86400, maxUses: 1 }
  })
  return res.result.inviteCode
}
```

#### 5.2 演示用户 ID 列表（删除）
```javascript
// ❌ 删除这些行（miniprogram/utils/mock-store.js state.employees）
const state = {
  employees: [
    // { id: 'u-root', name: '我', role: 'superadmin', ... },  ← 删除
    // { id: 'u-admin', name: '张主管', role: 'admin', ... },  ← 删除
    // ... 其他演示数据
  ]
}
```

#### 5.3 sessionUserId 初始化（仅保留受控的登录流）
移除开发工具中的手动设置，只在 `app.js` 中通过云函数鉴权后设置。

#### 5.4 审计检查脚本
在 release 分支提交前运行：
```bash
node scripts/pre-release-check.js
```
确保无 ❌ 错误（⚠️ 警告可在管理评审后发布）。

### 第 6 步：配置权限与日志
- [ ] 在数据库集合设置访问权限（只允许云函数访问）
  ```javascript
  // 伪代码：在微信云开发控制台配置规则
  users: {
    read: false,      // 禁止直接读
    write: false,     // 禁止直接写
    create: false,
    delete: false,
    update: false
  }
  // 所有操作都通过云函数
  ```
- [ ] 启用审计日志记录（audit_logs 集合）
  - 所有工单创建/修改
  - 所有权限变更（申请通过、角色提升）
  - 所有库存增减
  - 所有邀请码生成和使用
- [ ] 配置告警规则（如需要）
  - 异常的批量操作
  - 权限提升请求
  - 库存预警

### 第 7 步：建立发布流程
- [ ] 创建发布检查清单（见附录）
- [ ] 在 GitHub 中创建 `release/` 分支，配置分支保护：
  ```
  需要 PR 审查（至少 1 人）
  需要所有 status check 通过（包括 pre-release-check.js）
  禁止强制推送
  ```
- [ ] 为发布版本添加 tag 和 release notes
  ```bash
  git tag -a v1.0.0 -m "Production release v1.0.0"
  git push origin v1.0.0
  ```

---

## 🔐 关键安全点

### 1. 邀请码管理
```javascript
// ✅ 生产做法：每个邀请码有以下属性
{
  code: "INV-XXXXXXXX",           // 随机生成
  createdBy: "superadmin_id",     // 谁创建的
  createdAt: "2026-05-20T10:00:00Z",
  expiresAt: "2026-05-21T10:00:00Z",  // 24h 后过期
  maxUses: 1,                     // 仅用一次
  usedCount: 0,                   // 已使用次数
  isActive: true                  // 是否启用
}
```

### 2. 权限校验（后端强制）
```javascript
// 所有写操作都需要后端验证
function approveEmployee(employeeId, operatorId, token) {
  // 1. 验证 token 有效性
  const user = verifyToken(token)
  if (!user) throw Error('unauthorized')
  
  // 2. 检查操作者是否管理员
  if (user.role !== 'admin' && user.role !== 'superadmin') {
    throw Error('insufficient_privilege')
  }
  
  // 3. 只允许 admin 管理 worker，只有 superadmin 能提升到 admin
  const target = db.users.findById(employeeId)
  if (user.role === 'admin' && target.role !== 'worker') {
    throw Error('insufficient_privilege')
  }
  
  // 4. 记录审计日志
  auditLog.create({
    action: 'approve_employee',
    operator: user.id,
    target: employeeId,
    timestamp: now()
  })
  
  // 5. 更新数据库
  db.users.update(employeeId, { status: 'active' })
}
```

### 3. 数据入库校验
```javascript
// 防止表单注入、数据污染
function createOrder(payload, token) {
  const user = verifyToken(token)
  
  // 校验类型与范围
  if (!payload.customerName || typeof payload.customerName !== 'string') {
    throw Error('invalid_customer_name')
  }
  if (typeof payload.qty !== 'number' || payload.qty <= 0) {
    throw Error('invalid_qty')
  }
  if (payload.stations && !Array.isArray(payload.stations)) {
    throw Error('invalid_stations')
  }
  
  // 只允许管理员创建工单
  if (user.role !== 'admin' && user.role !== 'superadmin') {
    throw Error('insufficient_privilege')
  }
  
  // 创建并记录日志
  const order = {
    id: generateOrderId(),
    ...sanitize(payload),
    createdBy: user.id,
    createdAt: now()
  }
  
  db.orders.insert(order)
  auditLog.create({ action: 'create_order', operator: user.id, orderId: order.id })
  
  return order
}
```

---

## 📊 数据库初始化脚本示例

```javascript
// cloudfunctions/init/index.js
// 在部署后首次调用此函数初始化数据库

exports.main = async (event, context) => {
  const cloud = require('wx-server-sdk')
  const db = cloud.database()
  
  // 初始化工序库
  const processes = [
    { key: 'blanking', name: '下料', station: '下料工' },
    { key: 'pressing', name: '敦压', station: '敦压工' },
    // ... 其他工序
  ]
  
  await db.collection('processes').insertMany({
    data: processes
  })
  
  // 初始化超级管理员（需传入 openid 参数）
  const { adminOpenid, adminName } = event
  
  const admin = {
    openid: adminOpenid,
    name: adminName || 'Admin',
    role: 'superadmin',
    stations: ['超级管理员'],
    status: 'active',
    createdAt: db.serverDate()
  }
  
  await db.collection('users').add({ data: admin })
  
  console.log('数据库初始化完成')
  return { success: true }
}
```

---

## 🧪 测试清单（上线前）

- [ ] **鉴权测试**
  - [ ] 新设备首次打开 → 显示 guest 状态
  - [ ] 扫码申请 → 显示 pending，无法访问内部页面
  - [ ] 管理员审批 → 用户状态变为 active，可访问
  - [ ] 强制登出后重启 → 需重新授权

- [ ] **权限测试**
  - [ ] worker 无法创建工单
  - [ ] worker 无法管理其他员工
  - [ ] admin 可创建工单、管理 worker，不能提升权限
  - [ ] superadmin 可做所有操作

- [ ] **工单流转测试**
  - [ ] 创建工单 → 记录审计日志
  - [ ] 员工完成工序 → 库存自动扣减，记录日志
  - [ ] 管理员撤回工序 → 库存自动回退
  - [ ] 暂停/恢复工单 → 权限检查正确

- [ ] **库存管理测试**
  - [ ] 入库 → 金额/数量变化正确
  - [ ] 出库 → 库存不足时拒绝
  - [ ] 手动调整库存 → 仅管理员可操作

- [ ] **性能测试**
  - [ ] 1000+ 工单列表 → 分页加载，< 2s
  - [ ] 批量导出 500 份工单 → < 10s

- [ ] **灾备测试**
  - [ ] 数据库备份策略已制定
  - [ ] 恢复流程已测试

---

## 📈 监控与告警

### 关键指标
- 云函数调用成功率 >= 99.9%
- 平均响应时间 < 200ms
- 数据库查询 P95 < 500ms

### 告警规则
- 云函数错误率 > 1%
- 审批时间 > 24h 未审批
- 邀请码使用异常（如一个码被多设备使用）

---

## 📞 发布后支持

### 常见问题
1. **用户申请后无法看到审批进度**
   - 检查 pending_applications 集合
   - 确认管理员已审批

2. **库存计算错误**
   - 查看 audit_logs 中的 deduct_material 记录
   - 对账数据库与页面显示

3. **工单无法流转到下一步**
   - 检查当前用户的岗位是否在 stations 中
   - 查看审计日志中的权限检查

### 回滚方案
若生产环境出现严重问题：
1. 立即切换小程序体验版为旧版本
2. 检查云函数日志找出问题
3. 修复代码并重新部署测试版
4. 经管理员审批后再发布新版本

---

## ✅ 发布前最后检查

```bash
# 1. 运行预发布检查
node scripts/pre-release-check.js

# 2. 本地测试（微信开发者工具）
# - 完整走通申请 → 审批 → 访问流程
# - 创建工单、完成工序、撤回等操作
# - 检查审计日志

# 3. 检查 Git 提交记录
git log --oneline | head -5

# 4. 标记版本
git tag -a v1.0.0-prod -m "Production Release v1.0.0"
git push origin v1.0.0-prod

# 5. 在微信小程序后台上传新版本并提交审核
# - 版本号：1.0.0
# - 版本描述：正式版上线，使用云函数鉴权与数据库存储
# - 选择自动发布或待审批发布
```

---

## 附录：环境配置检查表

| 配置项 | 演示环境 | 生产环境 |
|------|--------|--------|
| project.config.json 中的 appid | 测试号 | 真实小程序 AppID |
| 云开发环境 | 可选（本地 mock） | ✅ 必需 |
| 数据库集合 | 无 | ✅ users, orders, inventory 等 |
| 邀请码 | 固定 JOIN-20260516 | ✅ 动态生成，有效期 24h |
| 权限校验 | 前端 mock | ✅ 后端 token + openid |
| 审计日志 | 简单 console 输出 | ✅ 详细日志入库 |
| SSL/HTTPS | 不必须 | ✅ 必需 |
| 服务器备份 | 无 | ✅ 自动备份，异地灾备 |

---

**发布联系人**：[你的名字/团队]
**最后更新**：2026-05-20
**版本**：1.0.0-production-ready
