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
    thicknessScale: 1.0,    // 线宽倍率
    enableResize: true,     // 是否压缩输出尺寸
    outputWidth: 32,        // 输出宽度
    outputHeight: 32,       // 输出高度
    isProcessing: false,    // 是否正在处理
    apiBase: API_BASE,      // API 地址
    showCropper: false,     // 是否显示裁剪弹窗
    cropperSrc: '',         // 传给裁剪的图片路径
    // ===== 马赛克翻转编辑器 =====
    M: 32,
    mosaicSrc: '',      // 给 <image> 显示的图片路径
  },

  // 隐藏 Canvas 引用（离屏，320x320 固定尺寸，只用于像素操作）
  _mosaicCanvas: null,
  _mosaicCtx: null,
  _mosaicInitialized: false,
  // 内存中的网格数据（只存内存，绝不触发 setData 刷新！）
  _mosaicGridData: null,
  // 标记用户是否做过编辑
  _resEdited: false,

  // === 图片选择（选择后弹出裁剪框，由 crop-handles 组件处理） ===
  chooseImage() {
    const that = this;
    wx.chooseImage({
      count: 1,
      sizeType: ['original', 'compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        const tempPath = res.tempFilePaths[0];
        that.setData({
          cropperSrc: tempPath,
          showCropper: true,
          resultImage: '',
          mosaicSrc: '',
        });
        // crop-handles 组件自动初始化并绘制
      },
    });
  },

  onCropperCancel() { this.setData({ showCropper: false }); },

  /**
   * 裁剪确认 —— 由 crop-handles 组件通过 bind:cropperconfirm 触发
   * e.detail: { tempFilePath, width, height }
   */
  onCropperConfirm(e) {
    const detail = e.detail;
    if (!detail || !detail.tempFilePath) {
      wx.showToast({ title: '裁剪失败', icon: 'none' });
      return;
    }
    this.setData({
      inputImage: detail.tempFilePath,
      showCropper: false,
    });
  },

  setMode(e) { this.setData({ mode: e.currentTarget.dataset.mode }); },
  toggleClahe(e) { this.setData({ useClahe: e.detail.value }); },
  onClaheClipChanging(e) { this.setData({ claheClip: Math.round(e.detail.value*10)/10 }); },
  onClaheClipChange(e) { this.setData({ claheClip: Math.round(e.detail.value*10)/10 }); },
  onThicknessChanging(e) { this.setData({ thicknessScale: Math.round(e.detail.value*10)/10 }); },
  onThicknessChange(e) { this.setData({ thicknessScale: Math.round(e.detail.value*10)/10 }); },
  toggleResize(e) { this.setData({ enableResize: e.detail.value }); },
  onWidthChange(e) { this.setData({ outputWidth: Math.round(e.detail.value) }); },
  onHeightChange(e) { this.setData({ outputHeight: Math.round(e.detail.value) }); },

  // === 核心推理 ===
  generateSketch() {
    const that = this;
    const { inputImage, mode, useClahe, claheClip, thicknessScale, enableResize, outputWidth, outputHeight, apiBase } = this.data;
    if (!inputImage) { wx.showToast({ title: '请先选择图片', icon: 'none' }); return; }
    let outputSizeStr = '';
    if (enableResize && outputWidth > 0 && outputHeight > 0) outputSizeStr = `${outputWidth},${outputHeight}`;
    that.setData({ isProcessing: true }); wx.showLoading({ title: '⏳ 生成线稿中...' });
    wx.uploadFile({
      url: `${apiBase}/api/sketch2anime_upload`, filePath: inputImage, name: 'image',
      formData: { mode, use_clahe: useClahe?'true':'false', clahe_clip: String(claheClip), thickness_scale: String(thicknessScale), output_size: outputSizeStr },
      success(resp) {
        try {
          const json = JSON.parse(resp.data);
          if (resp.statusCode === 200 && json.success && json.image_base64) {
            const fs = wx.getFileSystemManager();
            const tempFilePath = `${wx.env.USER_DATA_PATH}/sketch_result_${Date.now()}.png`;
            fs.writeFile({ filePath: tempFilePath, data: wx.base64ToArrayBuffer(json.image_base64), encoding: 'binary',
              success() {
                that.setData({ resultImage: tempFilePath, isProcessing: false, mosaicSrc: tempFilePath });
                wx.hideLoading(); wx.showToast({ title: '✅ 线稿生成成功', icon: 'success' });
                setTimeout(() => that._initMosaic(), 600);
              },
              fail(err) { console.error('写入结果失败:', err); that.setData({ isProcessing: false }); wx.hideLoading(); wx.showToast({ title: '❌ 结果保存失败', icon: 'none' }); },
            });
          } else { that.setData({ isProcessing: false }); wx.hideLoading(); wx.showToast({ title: json.error||'❌ 处理失败', icon: 'none' }); }
        } catch(e) { that.setData({ isProcessing: false }); wx.hideLoading(); console.error('解析响应失败:', e, resp.data); wx.showToast({ title: '❌ 响应解析失败', icon: 'none' }); }
      },
      fail(err) { that.setData({ isProcessing: false }); wx.hideLoading(); console.error('上传失败:', err); wx.showToast({ title: '❌ 连接后端失败，请先启动服务: python server.py', icon: 'none', duration: 3000 }); },
    });
  },

  // === 保存图片 ===
  saveImage() {
    if (this._resEdited && this._mosaicCanvas) { this._saveCanvasImage(); return; }
    const { resultImage } = this.data;
    if (!resultImage) { wx.showToast({ title: '没有可保存的线稿', icon: 'none' }); return; }
    wx.saveImageToPhotosAlbum({
      filePath: resultImage,
      success() { wx.showToast({ title: '✅ 已保存到相册', icon: 'success' }); },
      fail(err) {
        console.error('保存到相册失败:', err);
        if (err.errMsg && (err.errMsg.includes('deny')||err.errMsg.includes('auth'))) {
          wx.showModal({ title: '提示', content: '需要保存到相册的权限，是否去设置开启？', success(r) { if (r.confirm) wx.openSetting({}); } });
        } else { wx.showToast({ title: '❌ 保存失败', icon: 'none' }); }
      },
    });
  },

  resetAll() {
    this._mosaicInitialized = false; this._resEdited = false; this._mosaicGridData = null;
    this.setData({ inputImage: '', resultImage: '', mosaicSrc: '', isProcessing: false });
  },

  // =========================================================================
  // 马赛克像素点击翻转交互模块
  // 离屏 Canvas 做像素操作 + <image> 显示（跟随 scroll-view 自然滚动）
  // 网格数据存内存 _mosaicGridData，绝不触发 setData 导致闪烁
  // =========================================================================

  // ===== 初始化隐藏 Canvas =====
  _initMosaic() {
    var that = this;
    var query = wx.createSelectorQuery();
    query.select('#hiddenMosaicCanvas').fields({ node: true, size: true }).exec(function(r) {
      if (!r || !r[0] || !r[0].node) { setTimeout(() => that._initMosaic(), 300); return; }
      var canvas = r[0].node;
      var ctx = canvas.getContext('2d');
      var SIZE = 320; // 32 格 × 每格 10px
      canvas.width = SIZE; canvas.height = SIZE;
      that._mosaicCanvas = canvas;
      that._mosaicCtx = ctx;

      var img = canvas.createImage();
      img.onload = function() {
        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        // 采样 32x32 网格
        var imageData = ctx.getImageData(0, 0, SIZE, SIZE);
        var pixels = imageData.data;
        var cellSize = SIZE / 32;
        var grid = [];
        for (var row = 0; row < 32; row++) {
          var gRow = [];
          for (var col = 0; col < 32; col++) {
            var px = Math.round(col * cellSize + cellSize/2);
            var py = Math.round(row * cellSize + cellSize/2);
            var idx = (py * SIZE + px) * 4;
            var gray = (pixels[idx] + pixels[idx+1] + pixels[idx+2]) / 3;
            gRow.push(gray > 128 ? 1 : 0);
          }
          grid.push(gRow);
        }
        // 只存内存，绝不 setData
        that._mosaicGridData = grid;
        that._mosaicInitialized = true;
        // 绘制纯黑白网格到隐藏 Canvas → 导出到 <image>
        that._syncMosaicToImage();
      };
      img.onerror = function() { console.error('马赛克图片加载失败'); };
      img.src = that.data.resultImage;
    });
  },

  // ===== 将 _mosaicGridData 绘制到隐藏 Canvas → 导出到 <image> =====
  _syncMosaicToImage() {
    var ctx = this._mosaicCtx;
    var canvas = this._mosaicCanvas;
    var grid = this._mosaicGridData;
    if (!ctx || !canvas || !grid) return;
    var SIZE = 320, cellSize = 10, M = 32;

    ctx.clearRect(0, 0, SIZE, SIZE);
    for (var r = 0; r < M; r++) {
      for (var c = 0; c < M; c++) {
        var v = (grid[r] && grid[r][c] !== undefined) ? grid[r][c] : 0;
        ctx.fillStyle = v === 1 ? '#ffffff' : '#000000';
        ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
      }
    }
    // 灰色网格线
    ctx.strokeStyle = 'rgba(200,200,200,0.4)'; ctx.lineWidth = 0.5;
    for (var i = 0; i <= M; i++) {
      ctx.beginPath(); ctx.moveTo(i*cellSize,0); ctx.lineTo(i*cellSize,SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0,i*cellSize); ctx.lineTo(SIZE,i*cellSize); ctx.stroke();
    }

    // 导出到临时文件，更新 <image> 显示
    var that = this;
    wx.canvasToTempFilePath({
      canvas, fileType: 'png', quality: 1,
      success(res) { that.setData({ mosaicSrc: res.tempFilePath }); },
      fail(e) { console.error('导出马赛克失败:', e); },
    }, this);
  },

  // ===== 点击翻转 =====
  onMosaicTap(e) {
    if (!this._mosaicInitialized || !this._mosaicGridData) return;
    var that = this;
    var ct = e.changedTouches && e.changedTouches[0];
    if (!ct || typeof ct.clientX !== 'number') return;

    // 每次点击实时获取 <image> 的视口位置（完美兼容滚动）
    var query = wx.createSelectorQuery();
    query.select('#mosaicImage').boundingClientRect(function(rect) {
      if (!rect || !rect.width || !rect.height) return;
      // 点击相对坐标
      var clickX = ct.clientX - rect.left;
      var clickY = ct.clientY - rect.top;
      // 格子尺寸（CSS 像素）
      var w = rect.width / 32;
      var h = rect.height / 32;
      // 网格坐标（grid[0]=顶部，grid[31]=底部，与显示一致，无需反转）
      var col = Math.floor(clickX / w);
      var row = Math.floor(clickY / h);
      if (col < 0 || col >= 32 || row < 0 || row >= 32) return;

      // 【核心】只修改内存数据
      var grid = that._mosaicGridData;
      grid[row][col] = grid[row][col] === 0 ? 1 : 0;
      that._resEdited = true;

      // 重绘隐藏 Canvas → 更新 <image> 显示
      that._syncMosaicToImage();
    }).exec();
  },

  // ===== 从隐藏 Canvas 保存编辑后的图片 =====
  _saveCanvasImage() {
    var that = this;
    if (this._mosaicCanvas) {
      wx.canvasToTempFilePath({
        canvas: this._mosaicCanvas, fileType: 'png', quality: 1,
        success(res) {
          wx.saveImageToPhotosAlbum({
            filePath: res.tempFilePath,
            success() { wx.showToast({ title: '✅ 编辑后图片已保存', icon: 'success' }); },
            fail(err) {
              console.error('保存到相册失败:', err);
              if (err.errMsg && (err.errMsg.indexOf('deny')>=0||err.errMsg.indexOf('auth')>=0)) {
                wx.showModal({ title: '提示', content: '需要保存到相册的权限，是否去设置开启？', success(r) { if (r.confirm) wx.openSetting({}); } });
              } else { wx.showToast({ title: '❌ 保存失败', icon: 'none' }); }
            },
          });
        }, fail(e) { console.error('Canvas截图失败:', e); wx.showToast({ title: '❌ 截图失败', icon: 'none' }); },
      }, this);
    } else {
      wx.saveImageToPhotosAlbum({
        filePath: that.data.resultImage,
        success() { wx.showToast({ title: '✅ 已保存到相册', icon: 'success' }); },
        fail(err) { console.error('保存失败:', err); wx.showToast({ title: '❌ 保存失败', icon: 'none' }); },
      });
    }
  },

  onLoad() {
    wx.getNetworkType({
      success(res) { if (res.networkType === 'none') wx.showToast({ title: '⚠️ 当前无网络连接', icon: 'none' }); },
    });
  },
});
