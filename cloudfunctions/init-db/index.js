/**
 * 数据库初始化示例
 * 用于微信云开发数据库迁移演示数据到生产环境
 * 
 * 使用方式：
 * 1. 在微信云开发控制台的"云函数"中创建函数 "init-db"
 * 2. 复制此代码到云函数编辑器
 * 3. 调用：wx.cloud.callFunction({ name: 'init-db', data: { adminOpenid: '你的openid' } })
 * 
 * 注意：此函数应仅在部署时调用一次，之后应删除或禁用
 */

const cloud = require('wx-server-sdk')
const db = cloud.database()

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

exports.main = async (event, context) => {
  console.log('🔧 开始初始化数据库...\n')

  const { adminOpenid, adminName = 'Administrator' } = event

  if (!adminOpenid) {
    return { 
      success: false, 
      error: '缺少 adminOpenid 参数，请传入超级管理员的微信 openid'
    }
  }

  try {
    // 第一步：初始化工序库
    console.log('📋 初始化工序库...')
    const processes = [
      { key: 'blanking', name: '下料', station: '下料工' },
      { key: 'pressing', name: '敦压', station: '敦压工' },
      { key: 'programming', name: '编程', station: '编程工' },
      { key: 'pulling_tail', name: '拉尾子', station: '拉尾工' },
      { key: 'finish_turning', name: '精车', station: '精车工' },
      { key: 'milling_head', name: '铣方头', station: '铣床工' },
      { key: 'tapping', name: '攻丝', station: '攻丝工' },
      { key: 'drilling_head', name: '打方头孔', station: '钻床工' },
      { key: 'tapping_repeat', name: '攻丝（复攻）', station: '攻丝工' },
      { key: 'threading', name: '压螺纹', station: '螺纹工' },
      { key: 'polishing', name: '压光', station: '抛光工' },
      { key: 'marking', name: '打字', station: '打字工' },
      { key: 'heat_treatment', name: '热处理', station: '热处理工' },
      { key: 'quality_check', name: '质检', station: '质检员' },
      { key: 'warehouse', name: '入库', station: '仓管员' }
    ]

    // 检查是否已初始化
    const existingProcesses = await db.collection('processes').get()
    if (existingProcesses.data.length === 0) {
      for (const proc of processes) {
        await db.collection('processes').add({ data: proc })
      }
      console.log(`✅ 已添加 ${processes.length} 个工序\n`)
    } else {
      console.log('⏭️  工序库已存在，跳过\n')
    }

    // 第二步：初始化超级管理员账号
    console.log('👤 初始化超级管理员账号...')
    const existingAdmin = await db.collection('users').where({
      openid: adminOpenid
    }).get()

    if (existingAdmin.data.length === 0) {
      const admin = {
        openid: adminOpenid,
        name: adminName,
        role: 'superadmin',
        stations: ['超级管理员'],
        status: 'active',
        createdAt: db.serverDate(),
        lastLoginAt: null,
        lastDeviceId: ''
      }
      await db.collection('users').add({ data: admin })
      console.log(`✅ 已创建超级管理员账号: ${adminName} (openid: ${adminOpenid})\n`)
    } else {
      console.log('⏭️  超级管理员账号已存在\n')
    }

    // 第三步：初始化材料类型与库存
    console.log('📦 初始化材料库存...')
    const materials = [
      { name: '不锈钢420', stock: { '80': 1000.0 } },
      { name: '不锈钢304', stock: { '80': 2.0 } },
      { name: '不锈钢316', stock: { '100': 1.5 } },
      { name: '不锈钢431', stock: {} },
      { name: '铜', stock: {} },
      { name: '双相钢', stock: {} }
    ]

    const existingInventory = await db.collection('inventory').get()
    if (existingInventory.data.length === 0) {
      for (const mat of materials) {
        await db.collection('inventory').add({
          data: {
            name: mat.name,
            stock: mat.stock,
            createdAt: db.serverDate(),
            lastUpdatedAt: db.serverDate()
          }
        })
      }
      console.log(`✅ 已初始化 ${materials.length} 种材料库存\n`)
    } else {
      console.log('⏭️  库存记录已存在\n')
    }

    // 第四步：初始化审计日志（可选）
    console.log('📝 初始化审计日志集合...')
    const existingLogs = await db.collection('audit_logs').count()
    console.log(`✅ 审计日志集合已准备，当前记录数: ${existingLogs.total}\n`)

    // 返回初始化报告
    return {
      success: true,
      message: '数据库初始化完成！',
      summary: {
        processes: processes.length,
        admin: { name: adminName, openid: adminOpenid },
        materials: materials.length,
        timestamp: new Date().toISOString()
      }
    }
  } catch (err) {
    console.error('❌ 初始化失败:', err)
    return {
      success: false,
      error: err.message,
      details: err
    }
  }
}
