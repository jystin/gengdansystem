# 跟单系统 Bug 修复交接文档

> 本文档由 2026-07-25 的会话生成，记录了对跟单系统（微信小程序 + 云开发）的全面 Bug 排查与修复工作。
> 接手者请完整阅读本文档后再开始工作。

---

## 一、项目背景

这是一个**微信小程序跟单系统**，使用**云开发**（云函数 + 云数据库）。

### 技术栈
- 前端：微信小程序（`miniprogram/` 目录）
- 后端：云函数（`cloudfunctions/` 目录），每个子目录一个云函数
- 数据库：云开发数据库（集合：`orders`、`users`、`inventory`、`material_logs`、`pending_applications`、`audit_logs` 等）

### 核心业务流程
1. **创建工单**：管理员创建工单，配置工序列表（如：下料→敦压→精车→...→入库）
2. **工序流转**：员工扫码进入工单，完成当前工序并填入产量（根数），工单流转到下一工序
3. **下料扣库存**：下料工序需要填写材料消耗（材料类型、粗度、长度、数量），系统计算吨数并扣减库存
4. **工单完工**：所有工序完成后，工单标记为 `completed`
5. **撤回工序**：管理员可撤回已完成的工序，工单回退，库存回退
6. **产量统计**：按员工、按月统计完成的根数

### 工单状态机
- `processing`：生产中
- `paused`：已暂停（`paused: true`）
- `completed`：已完工

### 关键字段说明
- `orders.history`：数组，按完成顺序追加，每条记录包含 `stepKey`、`operatorId`、`operator`、`completedAt`、`qty`（根数）、`materialConsumption`（下料才有）
- `orders.currentStepIndex`：当前待完成工序的索引
- `orders.stepKeys`：工序列表（key 数组）
- `orders.paused`：是否暂停
- `inventory.stock`：对象，key 是粗度（如 `"42"`），value 是吨数

---

## 二、本次会话做了什么

用户要求全面排查并修复系统中的逻辑 Bug。按用户要求，依次排查了以下模块：

1. 库存相关逻辑（下料扣库存、撤回回退库存、删除工单回退库存）
2. 员工相关逻辑（权限校验、审批、岗位管理、员工列表）
3. 员工产量统计（月度根数、累计统计）
4. 工单完整生命周期（创建、流转、完工、撤回、修改工序配置）

---

## 三、已完成的修复（共 13 个 Bug）

### 模块一：库存相关（5 个 Bug）

#### Bug 1：下料库存校验漏洞（严重）
- **文件**：`cloudfunctions/completeStep/index.js`
- **问题**：库存为 0 或库存记录不存在时，`if (invRes.data.length > 0)` 只在记录存在时校验，不存在时直接跳过所有校验，导致库存为 0 仍能下料成功
- **修复**：增加 else 兜底拒绝 + 数值严谨校验（`Number.isFinite` 替代 `|| 0`）

#### Bug 2：check-then-inc 没有原子保护（严重）
- **文件**：`cloudfunctions/completeStep/index.js`、`cloudfunctions/inventoryManager/index.js`
- **问题**：先读取库存判断充足，再 `inc(-dedQty)` 扣减，两步之间有竞态窗口，并发下料会扣成负数
- **修复**：改为 `where(stock >= dedQty).update(inc(-dedQty))` 一步原子完成，数据库引擎层面保证不会扣成负数

#### Bug 3：revertStep 时序错误 + 静默吞错（严重）
- **文件**：`cloudfunctions/orderManager/index.js`
- **问题**：原代码"先回退库存，后用乐观锁更新工单"。两个管理员同时撤回同一工序 → 库存被双倍回退，但工单只回退一次。且库存回退失败被 `catch(e){}` 静默吞掉
- **修复**：调整为"先乐观锁更新工单（失败直接抛错，库存未动）→ 成功后才回退库存"；库存回退失败时写审计日志而非静默吞掉

#### Bug 4：deleteOrder 同样问题 + 完全没有乐观锁（严重）
- **文件**：`cloudfunctions/orderManager/index.js`
- **问题**：删除工单时直接 `doc(order._id).remove()`，无 where 条件。两个管理员同时删除 → 库存双倍回退。库存回退失败被静默吞掉
- **修复**：改为"先用带 `currentStepIndex` 条件的 `remove()`（乐观锁）删除工单（失败抛错，库存未动）→ 成功后才回退库存"

#### Bug 5：completeStep 回滚工序缺乐观锁
- **文件**：`cloudfunctions/completeStep/index.js`
- **问题**：库存扣减失败后回滚工序状态时，直接 `doc(order._id).update()`，无 where 条件，并发场景下可能覆盖他人修改
- **修复**：改为 `where(currentStepIndex: newStepIndex).update()`，两处回滚（扣减失败分支 + 异常 catch 分支）都加上

---

### 模块二：员工相关（4 个 Bug）

#### Bug 6：requireSuperAdmin 权限漏洞
- **文件**：`cloudfunctions/employeeManager/index.js`
- **问题**：`requireSuperAdmin` 不校验 `status === 'active'`，被禁用的超管仍可调用 `updateRole` 修改他人角色
- **修复**：补充 `status === 'active'` 校验，与 `requireAdmin` 保持一致

#### Bug 7：审批通过时硬编码 role='worker'
- **文件**：`cloudfunctions/approveEmployee/index.js`
- **问题**：`inviteEmployee` 时超管可设 `role='admin'`，但审批通过时统一硬编码为 `worker`，申请中的 role 字段被忽略
- **修复**：改为使用 `application.role || 'worker'`（`inviteEmployee` 时已校验仅超管可邀请 admin）

#### Bug 8：取消管理员时未移除"管理员中心"岗位
- **文件**：`cloudfunctions/employeeManager/index.js`
- **问题**：设为 admin 时会加上"管理员中心"岗位，但取消管理员（设为 worker）时没有移除，导致取消后仍能访问管理员中心
- **修复**：设为 worker 时过滤掉"管理员中心"

#### Bug 9：listEmployees 用 name 去重导致同名员工被误过滤
- **文件**：`cloudfunctions/employeeManager/index.js`
- **问题**：两个同名不同人的员工，pending 中的会被错误过滤掉
- **修复**：改为用 `openid` 去重

---

### 模块三：产量统计（1 个 Bug，影响多处）

#### Bug 10：时区问题导致月度统计错乱（严重）
- **文件**：`cloudfunctions/completeStep/index.js`、`cloudfunctions/orderManager/index.js`
- **问题**：云函数运行在 UTC 时区，但 `formatTime()` 用 `getMonth()` 等本地时间方法返回 UTC 时间。导致：
  - 每月最后一天晚上 8 点（UTC+8）后完成的工序，`completedAt` 会变成下个月的日期，月度统计归错月份
  - 月初凌晨 0-8 点完成的会归到上个月
  - `currentMonthRoots` 用 `new Date().getMonth()` 取月份索引，月初凌晨取到上月
- **修复**：所有时间函数改为 UTC+8（`new Date(Date.now() + 8 * 60 * 60 * 1000)` + `getUTC*` 方法），涉及 `completeStep.formatTime`、`orderManager.formatTime/formatDate/isOverdue/getDashboard/getEmployeeMonthlyProduction/getAllEmployeesMonthlyProduction`

---

### 模块四：工单生命周期（3 个 Bug）

#### Bug 11：revertStep 撤回已完工工单时 paused 状态不一致
- **文件**：`cloudfunctions/orderManager/index.js`
- **问题**：撤回 `completed` 工单时设为 `processing`，但没有处理 `paused` 标志，可能产生 `paused=true` 但 `status='processing'` 的矛盾状态
- **修复**：正确处理 `paused` 标志：`newPaused = newStatus === 'paused' ? true : (newStatus === 'completed' ? false : order.paused)`

#### Bug 12：completeStep 管理员在暂停状态下完成工序后 paused 状态丢失
- **文件**：`cloudfunctions/completeStep/index.js`
- **问题**：管理员可以在暂停状态下完成工序，但 `status` 直接设为 `processing`，丢失了 `paused: true`
- **修复**：`newStatus = isCompleted ? 'completed' : (order.paused ? 'paused' : 'processing')`，`newPaused = isCompleted ? false : order.paused`

#### Bug 13：updateStepKeys 删除已完成工序不回退库存也不清理历史记录（最严重）
- **文件**：`cloudfunctions/orderManager/index.js`
- **问题**：管理员修改工序配置时，如果删除了已完成的工序（如下料），`currentStepIndex` 会回退但 `history` 里还保留着记录，且下料扣的库存不会回退。导致：产量统计错乱、库存丢失、工序可被重复完成
- **修复**：清理被移除的 `history` 记录（`newHistory = history.slice(0, newIndex)`）、回退对应库存、加乐观锁保护

---

## 四、修改的文件清单

| 文件 | 修改内容 |
|------|---------|
| `cloudfunctions/completeStep/index.js` | 库存校验漏洞、原子扣减、乐观锁回滚、时区修复、paused 状态处理 |
| `cloudfunctions/inventoryManager/index.js` | 原子扣减（where+inc） |
| `cloudfunctions/orderManager/index.js` | revertStep 时序+静默吞错、deleteOrder 乐观锁、updateStepKeys 乐观锁+库存回退+history清理、paused 状态处理、时区修复 |
| `cloudfunctions/employeeManager/index.js` | requireSuperAdmin 校验 status、updateRole 移除管理员中心、listEmployees 用 openid 去重 |
| `cloudfunctions/approveEmployee/index.js` | 审批通过时使用申请中的 role |

---

## 五、当前状态

### ✅ 已完成
- 所有 13 个 Bug 的代码修复已完成
- 所有修改的文件已通过 lint 检查（仅有 CommonJS 模块提示，属项目原有，非本次引入）
- 代码逻辑自洽，状态一致性保证

### ⏳ 未完成（下一步要做的事）

1. **部署云函数到云端**
   - 以下 5 个云函数需要重新上传部署：
     - `cloudfunctions/completeStep`
     - `cloudfunctions/inventoryManager`
     - `cloudfunctions/orderManager`
     - `cloudfunctions/employeeManager`
     - `cloudfunctions/approveEmployee`
   - 部署方式：在微信开发者工具中右键云函数目录 → "上传并部署：云端安装依赖"

2. **测试验证**
   - 重点测试场景：
     - 库存为 0 时下料是否被拒绝
     - 并发下料是否不会扣成负数
     - 撤回工序后库存是否正确回退
     - 删除工单后库存是否正确回退
     - 修改工序配置（删除已完成的下料工序）后库存是否回退、history 是否清理
     - 月末晚上 8 点后完成的工序是否归到正确的月份
     - 暂停工单完成工序后状态是否一致

3. **历史数据修复（可选）**
   - 时区 Bug 导致的历史数据中，月末晚上 8 点后完成的工序 `completedAt` 月份是错的（UTC 月份）
   - 如果业务主要在白天（9:00-18:00）操作，UTC 和 UTC+8 落在同月，历史数据影响很小，可以不修
   - 如果需要修正，写一个一次性脚本：扫描所有工单的 `history`，对每条 `completedAt` 加 8 小时后重新格式化

4. **提交 Git**
   - 当前所有修改在工作区，**尚未 git add/commit**
   - 用户未明确要求提交，所以没有提交
   - 建议分模块提交，每个模块一个 commit

---

## 六、踩过的坑（绝对不要再踩）

### 1. check-then-inc 不是原子操作
```javascript
// ❌ 错误：两步之间有竞态窗口
const stock = await db.collection('inventory').where({...}).get()
if (stock >= dedQty) {
  await db.collection('inventory').doc(invId).update({ data: { [path]: _.inc(-dedQty) } })
}

// ✅ 正确：where 条件 + inc 一步原子完成
const res = await db.collection('inventory').where({
  _id: invId,
  [path]: _.gte(dedQty)  // 只有库存充足才执行
}).update({ data: { [path]: _.inc(-dedQty) } })
if (res.stats.updated === 0) throw new Error('库存不足')
```

### 2. 库存记录不存在时不能静默跳过
```javascript
// ❌ 错误：记录不存在时跳过校验，导致库存为 0 仍能下料
if (invRes.data.length > 0) { /* 校验库存 */ }
// 没有 else，直接放行

// ✅ 正确：记录不存在时必须拒绝
if (invRes.data.length === 0) {
  return { success: false, error: '库存记录不存在，无法下料' }
}
```

### 3. 静默吞掉错误会导致数据不一致无法追踪
```javascript
// ❌ 错误：库存回退失败被静默吞掉，工单已回退但库存没回退，无法追踪
} catch (e) { /* 静默处理库存回滚失败 */ }

// ✅ 正确：失败时写审计日志，至少能追溯
} catch (e) {
  console.error('[xxx] 库存回退失败:', e.message)
  await db.collection('audit_logs').add({ data: { action: '库存回退失败', detail: { reason: e.message, ... } } })
}
```

### 4. 云函数时区是 UTC，不是本地时间
```javascript
// ❌ 错误：云函数 UTC 环境，getMonth() 返回 UTC 月份
function formatTime() {
  const now = new Date()
  return `${now.getFullYear()}-${now.getMonth()+1}...`  // UTC 时间！
}

// ✅ 正确：手动转 UTC+8
function formatTime() {
  const china = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${china.getUTCFullYear()}-${china.getUTCMonth()+1}...`  // UTC+8 时间
}
```

### 5. 乐观锁要用在所有可能并发的写操作上
```javascript
// ❌ 错误：无 where 条件，并发覆盖
await db.collection('orders').doc(order._id).update({ data: { currentStepIndex: newIndex, ... } })

// ✅ 正确：where 条件保护，失败抛错
const res = await db.collection('orders').where({
  _id: order._id,
  currentStepIndex: order.currentStepIndex  // 乐观锁
}).update({ data: { currentStepIndex: newIndex, ... } })
if (res.stats.updated === 0) throw new Error('状态已变更，请刷新后重试')
```

### 6. 删除已完成工序时必须清理 history 和回退库存
```javascript
// ❌ 错误：只改 stepKeys 和 currentStepIndex，history 残留，库存丢失
await db.collection('orders').doc(order._id).update({
  data: { stepKeys: newStepKeys, currentStepIndex: newIndex, ... }
})

// ✅ 正确：清理 history、回退库存、乐观锁保护
const newHistory = history.slice(0, newIndex)  // 清理被移除的历史记录
// 回退被移除的下料工序库存（复用 revertStep 的库存回退逻辑）
const res = await db.collection('orders').where({
  _id: order._id,
  currentStepIndex: order.currentStepIndex
}).update({ data: { stepKeys: newStepKeys, currentStepIndex: newIndex, history: newHistory, ... } })
```

### 7. 时序问题：先改工单状态，成功后才动库存
```javascript
// ❌ 错误：先回退库存，后更新工单。乐观锁失败时库存已动但工单没动
await回退库存()
const res = await 乐观锁更新工单()
if (res.stats.updated === 0) throw new Error('请刷新重试')  // 库存已回退！

// ✅ 正确：先乐观锁更新工单，成功后才动库存
const res = await 乐观锁更新工单()
if (res.stats.updated === 0) throw new Error('请刷新重试')  // 库存未动，安全
await 回退库存()
```

### 8. `|| 0` 会吞掉 falsy 值，应该用 `?? 0` 或显式校验
```javascript
// ❌ 有隐患：0、负数、NaN 都会被 || 0 吞掉
const currentStock = Number(stock[rKey]) || 0

// ✅ 正确：显式校验
let currentStock = Number(stock[rKey])
if (!Number.isFinite(currentStock)) currentStock = 0
```

---

## 七、架构关键点（供接手者理解）

### 工单状态一致性
- `status` 和 `paused` 必须保持一致：
  - `status='paused'` ↔ `paused=true`
  - `status='processing'` ↔ `paused=false`
  - `status='completed'` ↔ `paused=false`（完工工单不能暂停）
- 所有修改工单状态的地方都要同时维护这两个字段

### 库存扣减的三个入口
1. `completeStep`（下料工序自动扣减）
2. `inventoryManager.deductStock`（手动出库）
- 两处都必须用 `where(stock >= qty) + inc(-qty)` 原子操作

### 库存回退的三个入口
1. `revertStep`（撤回工序）
2. `deleteOrder`（删除工单）
3. `updateStepKeys`（修改工序配置，删除已完成的下料工序）
- 三处都必须：先乐观锁更新工单，成功后才回退库存
- 回退失败要写审计日志，不能静默吞掉

### 产量统计原理
- 基于 `orders.history` 数组，按 `operatorId` 匹配员工
- `completedAt` 字符串用正则 `^(\d{4}-\d{2})` 提取年月
- `qty` 字段是根数（下料工序的 `materialConsumption.qty` 也是根数，不是吨数）
- 撤回/删除工单后 `history` 记录被移除，统计自动减少

---

## 八、未排查但建议后续检查的点

1. **前端并发保护**：前端按钮点击是否有防重复提交（如 loading 状态锁）
2. **`createOrder` 工单号生成**：`daily_counters` 计数器的并发安全性已检查，逻辑合理
3. **`snapshotManager`/`backupManager`**：备份恢复逻辑已检查，全量备份恢复无并发问题
4. **`autoBackup`**：自动备份逻辑已检查，无问题
5. **前端权限控制**：前端 UI 的显隐控制（如管理员才显示某些按钮）是否与后端校验一致
6. **历史数据**：时区 Bug 修复前的历史 `completedAt` 数据月份可能错误，需要评估是否要修正

---

## 九、快速验证清单（部署后测试）

| # | 测试场景 | 预期结果 |
|---|---------|---------|
| 1 | 库存为 0 时下料 | 拒绝，提示"库存不足" |
| 2 | 库存记录不存在时下料 | 拒绝，提示"库存记录不存在" |
| 3 | 两人同时下料挤占同一库存 | 只有一个成功，另一个提示"库存不足" |
| 4 | 撤回下料工序 | 库存正确回退 |
| 5 | 删除已下料的工单 | 库存正确回退 |
| 6 | 修改工序配置，删除已完成的下料工序 | 库存回退，history 清理 |
| 7 | 月末晚上 9 点完成工序 | 归到当月而非下月 |
| 8 | 暂停工单后管理员完成工序 | status='paused', paused=true 一致 |
| 9 | 撤回已完工工单的最后一道工序 | status='processing', paused 正确 |
| 10 | 超管邀请管理员并审批通过 | role='admin' 而非 'worker' |
| 11 | 取消管理员角色 | "管理员中心"岗位被移除 |
| 12 | 两人同时撤回同一工序 | 只有一个成功，另一个提示"请刷新重试" |
