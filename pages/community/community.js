// pages/community/community.js — 社区广场页面
// 优先走云开发；云环境不可用时读取本地社区缓存。

Page({
  data: {
    // 照片列表（原始数据，用于分列）
    photoList: [],
    // 左列 / 右列（两列瀑布流）
    leftList: [],
    rightList: [],
    // 分页
    page: 0,
    pageSize: 10,
    hasMore: true,
    loading: false,
  },

  onLoad() {
    this.fetchPhotos()
  },

  /**
   * 下拉刷新（用户下拉时重新加载第一页）
   */
  onPullDownRefresh() {
    this.setData({
      photoList: [],
      leftList: [],
      rightList: [],
      page: 0,
      hasMore: true,
    })
    this.fetchPhotos().then(() => {
      wx.stopPullDownRefresh()
    }).catch(() => {
      wx.stopPullDownRefresh()
    })
  },

  /**
   * 触底加载更多
   */
  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({
      page: this.data.page + 1,
    })
    this.fetchPhotos()
  },

  /**
   * 获取社区照片
   * 绝对匿名：服务器不返回任何用户身份信息
   */
  fetchPhotos() {
    const that = this
    const { page, pageSize } = this.data

    this.setData({ loading: true })

    return new Promise((resolve, reject) => {
      if (!wx.cloud) {
        that._loadLocalPhotos(resolve)
        return
      }

      wx.cloud.callFunction({
        name: 'community_service',
        data: { action: 'get', page: page },
        success(res) {
          const result = res.result || {}
          if (result.code === 0) {
            const data = result.data || {}
            const newList = Array.isArray(data) ? data : (data.list || [])
            that._appendPhotos(newList, pageSize, resolve)
          } else {
            that._loadLocalPhotos(resolve)
          }
        },
        fail(err) {
          console.error('[fetchPhotos] 云函数请求失败:', err)
          that._loadLocalPhotos(resolve)
        },
      })
    })
  },

  _appendPhotos(newList, pageSize, resolve) {
    const oldList = this.data.photoList
    const merged = oldList.concat(newList)
    const hasMore = newList.length === pageSize
    const { left, right } = this._splitIntoColumns(merged)
    this.setData({
      photoList: merged,
      leftList: left,
      rightList: right,
      hasMore: hasMore,
      loading: false,
    })
    resolve()
  },

  _loadLocalPhotos(resolve) {
    const all = wx.getStorageSync('local_community_photos') || []
    const start = this.data.page * this.data.pageSize
    const list = all.slice(start, start + this.data.pageSize)
    this._appendPhotos(list, this.data.pageSize, resolve)
  },

  /**
   * 将照片列表均衡分配到左右两列（瀑布流算法）
   * 每张图片高度不确定，这里简化：按累计高度最短列优先分配
   */
  _splitIntoColumns(list) {
    const left = []
    const right = []
    let leftHeight = 0
    let rightHeight = 0

    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      // 固定估算高度，实际由 CSS mode="widthFix" 自适应
      const estimatedHeight = 200

      if (leftHeight <= rightHeight) {
        left.push(item)
        leftHeight += estimatedHeight
      } else {
        right.push(item)
        rightHeight += estimatedHeight
      }
    }
    return { left, right }
  },

  /**
   * 点击图片预览大图
   */
  onPreviewImage(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({
      current: url,
      urls: [url],
    })
  },

  /**
   * 点赞处理
   * 使用本地缓存防止重复点赞
   */
  handleLike(e) {
    const photoId = e.currentTarget.dataset.id
    if (!photoId) return

    // 读取本地缓存中的已点赞列表
    let likedPhotos = wx.getStorageSync('liked_photos') || []

    // 检查是否已点赞
    if (likedPhotos.indexOf(photoId) !== -1) {
      wx.showToast({ title: '你已经点过赞啦', icon: 'none' })
      return
    }

    const finishLike = () => {
      likedPhotos.push(photoId)
      wx.setStorageSync('liked_photos', likedPhotos)
      const updateList = (list) => {
        return list.map(item => {
          if (item._id === photoId) return { ...item, likes: (item.likes || 0) + 1 }
          return item
        })
      }
      this.setData({
        photoList: updateList(this.data.photoList),
        leftList: updateList(this.data.leftList),
        rightList: updateList(this.data.rightList),
      })
      this._updateLocalLike(photoId)
      wx.showToast({ title: '点赞成功', icon: 'success' })
    }

    if (!wx.cloud || String(photoId).indexOf('local_') === 0) {
      finishLike()
      return
    }

    wx.cloud.callFunction({
      name: 'community_service',
      data: { action: 'like', photo_id: photoId },
      success: (res) => {
        const result = res.result || {}
        if (result.code === 0) finishLike()
        else wx.showToast({ title: result.msg || '点赞失败', icon: 'none' })
      },
      fail: (err) => {
        console.error('[handleLike] 云函数请求失败:', err)
        wx.showToast({ title: '点赞失败', icon: 'none' })
      },
    })
  },

  _updateLocalLike(photoId) {
    const list = wx.getStorageSync('local_community_photos') || []
    const next = list.map(item => {
      if (item._id === photoId) return { ...item, likes: (item.likes || 0) + 1 }
      return item
    })
    wx.setStorageSync('local_community_photos', next)
  },
})
