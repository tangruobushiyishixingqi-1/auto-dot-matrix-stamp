// pages/index/index.js —— 图像转黑白线稿主页逻辑
// API 后端地址（开发时请替换为实际局域网 IP）
const API_BASE = 'http://127.0.0.1:5001';

Page({
  data: {
    inputImage: '',         // 上传的图片临时路径
    resultImage: '',        // 线稿结果图片临时路径
    mode: 'default',        // 提取模式
    useClahe: false,        // 是否启用 CLAHE
    claheClip: 2.0,         // CLAHE 对比度系数
    enableResize: true,     // 是否压缩输出尺寸
    outputWidth: 32,        // 输出宽度
    outputHeight: 32,       // 输出高度
    isProcessing: false,    // 是否正在处理
    apiBase: API_BASE,      // API 地址
  },


  // === 图片选择 ===
  chooseImage() {
    const that = this;
    wx.chooseImage({
      count: 1,
      sizeType: ['original', 'compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        const tempPath = res.tempFilePaths[0];
        that.setData({
          inputImage: tempPath,
          resultImage: '',
        });
      },
    });
  },

  // === 参数设置 ===
  setMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode });
  },

  toggleClahe(e) {
    this.setData({ useClahe: e.detail.value });
  },

  onClaheClipChanging(e) {
    this.setData({ claheClip: Math.round(e.detail.value * 10) / 10 });
  },

  onClaheClipChange(e) {
    this.setData({ claheClip: Math.round(e.detail.value * 10) / 10 });
  },

  // === 输出尺寸控制 ===
  toggleResize(e) {
    this.setData({ enableResize: e.detail.value });
  },

  onWidthChange(e) {
    this.setData({ outputWidth: Math.round(e.detail.value) });
  },

  onHeightChange(e) {
    this.setData({ outputHeight: Math.round(e.detail.value) });
  },

  // === 核心推理（使用 wx.uploadFile，可直接读取 http://tmp/ 路径）===
  generateSketch() {
    const that = this;
    const { inputImage, mode, useClahe, claheClip, enableResize, outputWidth, outputHeight, apiBase } = this.data;

    if (!inputImage) {
      wx.showToast({ title: '请先选择图片', icon: 'none' });
      return;
    }

    // 构造 output_size 参数
    let outputSizeStr = '';
    if (enableResize && outputWidth > 0 && outputHeight > 0) {
      outputSizeStr = `${outputWidth},${outputHeight}`;
    }

    that.setData({ isProcessing: true });
    wx.showLoading({ title: '⏳ 生成线稿中...' });

    wx.uploadFile({
      url: `${apiBase}/api/sketch2anime_upload`,
      filePath: inputImage,
      name: 'image',
      formData: {
        mode: mode,
        use_clahe: useClahe ? 'true' : 'false',
        clahe_clip: String(claheClip),
        output_size: outputSizeStr,
      },

      success(resp) {
        try {
          const json = JSON.parse(resp.data);
          if (resp.statusCode === 200 && json.success && json.image_base64) {
            // 将 base64 写为临时文件再显示
            const fs = wx.getFileSystemManager();
            const tempFilePath = `${wx.env.USER_DATA_PATH}/sketch_result_${Date.now()}.png`;
            const buffer = wx.base64ToArrayBuffer(json.image_base64);
            fs.writeFile({
              filePath: tempFilePath,
              data: buffer,
              encoding: 'binary',
              success() {
                that.setData({ resultImage: tempFilePath, isProcessing: false });
                wx.hideLoading();
                wx.showToast({ title: '✅ 线稿生成成功', icon: 'success' });
              },
              fail(err) {
                console.error('写入结果失败:', err);
                that.setData({ isProcessing: false });
                wx.hideLoading();
                wx.showToast({ title: '❌ 结果保存失败', icon: 'none' });
              },
            });
          } else {
            that.setData({ isProcessing: false });
            wx.hideLoading();
            wx.showToast({ title: json.error || '❌ 处理失败', icon: 'none' });
          }
        } catch(e) {
          that.setData({ isProcessing: false });
          wx.hideLoading();
          console.error('解析响应失败:', e, resp.data);
          wx.showToast({ title: '❌ 响应解析失败', icon: 'none' });
        }
      },
      fail(err) {
        that.setData({ isProcessing: false });
        wx.hideLoading();
        console.error('上传失败:', err);
        wx.showToast({ title: '❌ 连接后端失败，请先启动服务: python server.py', icon: 'none', duration: 3000 });
      },
    });
  },

  // === 保存到相册 ===
  saveImage() {
    const { resultImage } = this.data;
    if (!resultImage) {
      wx.showToast({ title: '没有可保存的线稿', icon: 'none' });
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath: resultImage,
      success() { wx.showToast({ title: '✅ 已保存到相册', icon: 'success' }); },
      fail(err) {
        console.error('保存到相册失败:', err);
        if (err.errMsg && (err.errMsg.includes('deny') || err.errMsg.includes('auth'))) {
          wx.showModal({
            title: '提示',
            content: '需要保存到相册的权限，是否去设置开启？',
            success(res) { if (res.confirm) wx.openSetting({}); },
          });
        } else {
          wx.showToast({ title: '❌ 保存失败', icon: 'none' });
        }
      },
    });
  },

  // === 重置 ===
  resetAll() {
    this.setData({ inputImage: '', resultImage: '', isProcessing: false });
  },

  // === 生命周期 ===
  onLoad() {
    wx.getNetworkType({
      success(res) {
        if (res.networkType === 'none') {
          wx.showToast({ title: '⚠️ 当前无网络连接', icon: 'none' });
        }
      },
    });
  },
});
