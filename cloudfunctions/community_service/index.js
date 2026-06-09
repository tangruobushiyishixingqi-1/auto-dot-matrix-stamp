// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV }) // 使用当前云环境
const db = cloud.database()
const _ = db.command

// 云函数入口函数
exports.main = async (event, context) => {
  const { action, photo_url, page } = event

  switch (action) {

    // ========== 新增社区照片 ==========
    case 'add': {
      if (!photo_url) {
        return { code: -1, msg: '缺少 photo_url 参数' }
      }

      try {
        const res = await db.collection('community_photos').add({
          data: {
            photo_url: photo_url,          // 照片 URL
            create_time: db.serverDate(),   // 服务端时间
            likes: 0,                       // 初始点赞数
            status: 1                       // 1=可见, 0=隐藏
          }
        })

        return {
          code: 0,
          msg: '发布成功',
          data: { _id: res._id }
        }
      } catch (err) {
        return { code: -1, msg: '发布失败', error: err.toString() }
      }
    }

    // ========== 获取社区照片列表（分页、匿名） ==========
    case 'get': {
      // 默认 page 从 0 开始
      const currentPage = (page !== undefined && page !== null) ? Number(page) : 0
      const pageSize = 10

      try {
        const res = await db.collection('community_photos')
          .where({
            status: _.eq(1) // 只获取可见数据
          })
          .orderBy('create_time', 'desc') // 最新发布排前面
          .skip(currentPage * pageSize)
          .limit(pageSize)
          .field({
            _openid: false // 【核心安全要求】显式隐藏 _openid，实现绝对匿名
          })
          .get()

        return {
          code: 0,
          msg: '获取成功',
          data: {
            list: res.data,
            pageSize: pageSize
          }
        }
      } catch (err) {
        return { code: -1, msg: '获取失败', error: err.toString() }
      }
    }

    // ========== 点赞（原子递增 likes） ==========
    case 'like': {
      const { photo_id } = event
      if (!photo_id) {
        return { code: -1, msg: '缺少 photo_id 参数' }
      }

      try {
        const res = await db.collection('community_photos').doc(photo_id).update({
          data: {
            likes: _.inc(1),  // 原子递增，线程安全
          }
        })

        if (res.stats.updated === 0) {
          return { code: -1, msg: '该照片不存在或已被删除' }
        }

        return {
          code: 0,
          msg: '点赞成功',
        }
      } catch (err) {
        return { code: -1, msg: '点赞失败', error: err.toString() }
      }
    }

    // ========== 未知 action ==========
    default:
      return { code: -1, msg: '未知 action，请使用 add 或 get' }
  }
}
