// 云函数入口文件 — 旧线稿生成代理
// 当前小程序前端已改为 Canvas 本地生成；此文件仅保留给需要外部服务的旧方案。
const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 如需恢复旧方案，请将下方地址替换为可访问的外部服务地址。
const NGROK_URL = 'https://xxxx.ngrok.io'

// 云函数入口函数
exports.main = async (event, context) => {
  const { action } = event

  switch (action) {

    // ========== 线稿生成 ==========
    case 'generate': {
      const { image_base64, mode, thickness_scale, output_size } = event

      if (!image_base64) {
        return { success: false, error: '缺少 image_base64 参数' }
      }

      try {
        const resp = await axios.post(NGROK_URL + '/api/sketch2anime_b64', {
          image_base64: image_base64,
          mode: mode || 'default',
          use_clahe: false,
          clahe_clip: 2.0,
          thickness_scale: thickness_scale || 1.0,
          output_size: output_size || '',
        }, {
          timeout: 60000, // 线稿生成可能需要较长时间
          headers: { 'Content-Type': 'application/json' },
        })

        return resp.data
      } catch (err) {
        console.error('[sketch_service] 转发请求失败:', err.message)
        return {
          success: false,
          error: '外部线稿服务不可用；当前前端默认使用本地 Canvas 生成',
          detail: err.message,
        }
      }
    }

    // ========== 健康检查 ==========
    case 'ping': {
      try {
        const resp = await axios.get(NGROK_URL + '/api/health', { timeout: 5000 })
        return { success: true, data: resp.data }
      } catch (err) {
        return { success: false, error: '外部线稿服务不可用' }
      }
    }

    default:
      return { success: false, error: '未知 action，请使用 generate 或 ping' }
  }
}
