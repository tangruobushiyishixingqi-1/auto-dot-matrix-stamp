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
    recommendedThickness: 6.67,  // 推荐线宽倍率
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
  chooseImage: function() {
    var that = this;
    wx.chooseImage({
      count: 1,
      sizeType: ['original', 'compressed'],
      sourceType: ['album', 'camera'],
      success: function(res) {
        var tempPath = res.tempFilePaths[0];
        that.setData({
          cropperSrc: tempPath,
          showCropper: true,
          resultImage: '',
          mosaicSrc: '',
        });
      },
    });
  },

  onCropperCancel: function() { this.setData({ showCropper: false }); },

  onCropperConfirm: function(e) {
    var detail = e.detail;
    if (!detail || !detail.tempFilePath) {
      wx.showToast({ title: '裁剪失败', icon: 'none' });
      return;
    }
    var optimal = this._calcOptimalThickness(this.data.mode);
    this.setData({
      inputImage: detail.tempFilePath,
      showCropper: false,
      thicknessScale: optimal,
      recommendedThickness: optimal,
    });
    wx.showToast({
      title: '推荐线宽倍率为 ' + optimal + '（目标线宽 20px）',
      icon: 'none',
      duration: 2000,
    });
  },

  _calcOptimalThickness: function(mode) {
    var baseWidth = mode === 'improved' ? 4 : 3;
    return Math.round((20 / baseWidth) * 100) / 100;
  },

  setMode: function(e) {
    var mode = e.currentTarget.dataset.mode;
    var optimal = this._calcOptimalThickness(mode);
    this.setData({ mode: mode, thicknessScale: optimal, recommendedThickness: optimal });
    wx.showToast({
      title: '推荐线宽倍率为 ' + optimal + '（目标线宽 20px）',
      icon: 'none',
      duration: 2000,
    });
  },

  toggleClahe: function(e) { this.setData({ useClahe: e.detail.value }); },

  onClaheClipChanging: function(e) { this.setData({ claheClip: Math.round(e.detail.value * 10) / 10 }); },
  onClaheClipChange: function(e) { this.setData({ claheClip: Math.round(e.detail.value * 10) / 10 }); },

  onThicknessChanging: function(e) { this.setData({ thicknessScale: Math.round(e.detail.value * 10) / 10 }); },
  onThicknessChange: function(e) { this.setData({ thicknessScale: Math.round(e.detail.value * 10) / 10 }); },

  toggleResize: function(e) { this.setData({ enableResize: e.detail.value }); },
  onWidthChange: function(e) { this.setData({ outputWidth: Math.round(e.detail.value) }); },
  onHeightChange: function(e) { this.setData({ outputHeight: Math.round(e.detail.value) }); },

  // ===== 参数值点击键盘输入 =====
  onClaheClipTap: function() {
    this._showNumPrompt('claheClip', this.data.claheClip, 1, 5, 0.1);
  },

  onThicknessTap: function() {
    this._showNumPrompt('thicknessScale', this.data.thicknessScale, 0, 10, 0.1);
  },

  onWidthTap: function() {
    this._showNumPrompt('outputWidth', this.data.outputWidth, 8, 512, 1);
  },

  onHeightTap: function() {
    this._showNumPrompt('outputHeight', this.data.outputHeight, 8, 512, 1);
  },

  _showNumPrompt: function(key, currentVal, min, max, step) {
    var that = this;
    wx.showModal({
      title: '输入数值',
      content: '',
      editable: true,
      placeholderText: '当前值 ' + currentVal + '（范围 ' + min + '~' + max + '）',
      success: function(res) {
        if (res.confirm) {
          var inputStr = (res.content || '').trim();
          if (inputStr === '') { return; }
          var newVal = parseFloat(inputStr);
          if (isNaN(newVal)) {
            wx.showToast({ title: '请输入有效数字', icon: 'none' });
            return;
          }
          if (step >= 1) {
            newVal = Math.round(newVal);
          } else {
            newVal = Math.round(newVal * 10) / 10;
          }
          if (newVal < min) { newVal = min; }
          if (newVal > max) { newVal = max; }
          var obj = {};
          obj[key] = newVal;
          that.setData(obj);
          if (key === 'thicknessScale') {
            var optimal = that._calcOptimalThickness(that.data.mode);
            that.setData({ recommendedThickness: optimal });
          }
        }
      },
    });
  },

  // === 核心推理 ===
  generateSketch: function() {
    var that = this;
    var inputImage = this.data.inputImage;
    var mode = this.data.mode;
    var useClahe = this.data.useClahe;
    var claheClip = this.data.claheClip;
    var thicknessScale = this.data.thicknessScale;
    var enableResize = this.data.enableResize;
    var outputWidth = this.data.outputWidth;
    var outputHeight = this.data.outputHeight;
    var apiBase = this.data.apiBase;
    if (!inputImage) { wx.showToast({ title: '请先选择图片', icon: 'none' }); return; }
    var outputSizeStr = '';
    if (enableResize && outputWidth > 0 && outputHeight > 0) outputSizeStr = outputWidth + ',' + outputHeight;
    that.setData({ isProcessing: true }); wx.showLoading({ title: '⏳ 生成线稿中...' });
    wx.uploadFile({
      url: apiBase + '/api/sketch2anime_upload', filePath: inputImage, name: 'image',
      formData: { mode: mode, use_clahe: useClahe ? 'true' : 'false', clahe_clip: String(claheClip), thickness_scale: String(thicknessScale), output_size: outputSizeStr },
      success: function(resp) {
        try {
          var json = JSON.parse(resp.data);
          if (resp.statusCode === 200 && json.success && json.image_base64) {
            var fs = wx.getFileSystemManager();
            var tempFilePath = wx.env.USER_DATA_PATH + '/sketch_result_' + Date.now() + '.png';
            fs.writeFile({
              filePath: tempFilePath, data: wx.base64ToArrayBuffer(json.image_base64), encoding: 'binary',
              success: function() {
                that.setData({ resultImage: tempFilePath, isProcessing: false, mosaicSrc: tempFilePath });
                wx.hideLoading(); wx.showToast({ title: '✅ 线稿生成成功', icon: 'success' });
                setTimeout(function() { that._initMosaic(); }, 600);
              },
              fail: function(err) { console.error('写入结果失败:', err); that.setData({ isProcessing: false }); wx.hideLoading(); wx.showToast({ title: '❌ 结果保存失败', icon: 'none' }); },
            });
          } else { that.setData({ isProcessing: false }); wx.hideLoading(); wx.showToast({ title: json.error || '❌ 处理失败', icon: 'none' }); }
        } catch (e) { that.setData({ isProcessing: false }); wx.hideLoading(); console.error('解析响应失败:', e, resp.data); wx.showToast({ title: '❌ 响应解析失败', icon: 'none' }); }
      },
      fail: function(err) { that.setData({ isProcessing: false }); wx.hideLoading(); console.error('上传失败:', err); wx.showToast({ title: '❌ 连接后端失败，请先启动服务: python server.py', icon: 'none', duration: 3000 }); },
    });
  },

  // === 保存图片 ===
  saveImage: function() {
    if (this._resEdited && this._mosaicCanvas) { this._saveCanvasImage(); return; }
    var resultImage = this.data.resultImage;
    if (!resultImage) { wx.showToast({ title: '没有可保存的线稿', icon: 'none' }); return; }
    wx.saveImageToPhotosAlbum({
      filePath: resultImage,
      success: function() { wx.showToast({ title: '✅ 已保存到相册', icon: 'success' }); },
      fail: function(err) {
        console.error('保存到相册失败:', err);
        if (err.errMsg && (err.errMsg.indexOf('deny') >= 0 || err.errMsg.indexOf('auth') >= 0)) {
          wx.showModal({ title: '提示', content: '需要保存到相册的权限，是否去设置开启？', success: function(r) { if (r.confirm) wx.openSetting({}); } });
        } else { wx.showToast({ title: '❌ 保存失败', icon: 'none' }); }
      },
    });
  },

  resetAll: function() {
    this._mosaicInitialized = false; this._resEdited = false; this._mosaicGridData = null;
    this.setData({ inputImage: '', resultImage: '', mosaicSrc: '', isProcessing: false });
  },

  // =========================================================================
  // 马赛克像素点击翻转交互模块
  // =========================================================================

  _initMosaic: function() {
    var that = this;
    var query = wx.createSelectorQuery();
    query.select('#hiddenMosaicCanvas').fields({ node: true, size: true }).exec(function(r) {
      if (!r || !r[0] || !r[0].node) { setTimeout(function() { that._initMosaic(); }, 300); return; }
      var canvas = r[0].node;
      var ctx = canvas.getContext('2d');
      var SIZE = 320;
      canvas.width = SIZE; canvas.height = SIZE;
      that._mosaicCanvas = canvas;
      that._mosaicCtx = ctx;

      var img = canvas.createImage();
      img.onload = function() {
        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        var imageData = ctx.getImageData(0, 0, SIZE, SIZE);
        var pixels = imageData.data;
        var cellSize = SIZE / 32;
        var grid = [];
        for (var row = 0; row < 32; row++) {
          var gRow = [];
          for (var col = 0; col < 32; col++) {
            var px = Math.round(col * cellSize + cellSize / 2);
            var py = Math.round(row * cellSize + cellSize / 2);
            var idx = (py * SIZE + px) * 4;
            var gray = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
            gRow.push(gray > 128 ? 1 : 0);
          }
          grid.push(gRow);
        }
        that._mosaicGridData = grid;
        that._mosaicInitialized = true;
        that._syncMosaicToImage();
      };
      img.onerror = function() { console.error('马赛克图片加载失败'); };
      img.src = that.data.resultImage;
    });
  },

  _syncMosaicToImage: function() {
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
    ctx.strokeStyle = 'rgba(200,200,200,0.4)'; ctx.lineWidth = 0.5;
    for (var i = 0; i <= M; i++) {
      ctx.beginPath(); ctx.moveTo(i * cellSize, 0); ctx.lineTo(i * cellSize, SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * cellSize); ctx.lineTo(SIZE, i * cellSize); ctx.stroke();
    }

    var that = this;
    wx.canvasToTempFilePath({
      canvas: canvas, fileType: 'png', quality: 1,
      success: function(res) { that.setData({ mosaicSrc: res.tempFilePath }); },
      fail: function(e) { console.error('导出马赛克失败:', e); },
    }, this);
  },

  onMosaicTap: function(e) {
    if (!this._mosaicInitialized || !this._mosaicGridData) return;
    var that = this;
    var ct = e.changedTouches && e.changedTouches[0];
    if (!ct || typeof ct.clientX !== 'number') return;

    var query = wx.createSelectorQuery();
    query.select('#mosaicImage').boundingClientRect(function(rect) {
      if (!rect || !rect.width || !rect.height) return;
      var clickX = ct.clientX - rect.left;
      var clickY = ct.clientY - rect.top;
      var w = rect.width / 32;
      var h = rect.height / 32;
      var col = Math.floor(clickX / w);
      var row = Math.floor(clickY / h);
      if (col < 0 || col >= 32 || row < 0 || row >= 32) return;

      var grid = that._mosaicGridData;
      grid[row][col] = grid[row][col] === 0 ? 1 : 0;
      that._resEdited = true;
      that._syncMosaicToImage();
    }).exec();
  },

  _saveCanvasImage: function() {
    var that = this;
    if (this._mosaicCanvas) {
      wx.canvasToTempFilePath({
        canvas: this._mosaicCanvas, fileType: 'png', quality: 1,
        success: function(res) {
          wx.saveImageToPhotosAlbum({
            filePath: res.tempFilePath,
            success: function() { wx.showToast({ title: '✅ 编辑后图片已保存', icon: 'success' }); },
            fail: function(err) {
              console.error('保存到相册失败:', err);
              if (err.errMsg && (err.errMsg.indexOf('deny') >= 0 || err.errMsg.indexOf('auth') >= 0)) {
                wx.showModal({ title: '提示', content: '需要保存到相册的权限，是否去设置开启？', success: function(r) { if (r.confirm) wx.openSetting({}); } });
              } else { wx.showToast({ title: '❌ 保存失败', icon: 'none' }); }
            },
          });
        }, fail: function(e) { console.error('Canvas截图失败:', e); wx.showToast({ title: '❌ 截图失败', icon: 'none' }); },
      }, this);
    } else {
      wx.saveImageToPhotosAlbum({
        filePath: that.data.resultImage,
        success: function() { wx.showToast({ title: '✅ 已保存到相册', icon: 'success' }); },
        fail: function(err) { console.error('保存失败:', err); wx.showToast({ title: '❌ 保存失败', icon: 'none' }); },
      });
    }
  },

  onLoad: function() {
    wx.getNetworkType({
      success: function(res) { if (res.networkType === 'none') wx.showToast({ title: '⚠️ 当前无网络连接', icon: 'none' }); },
    });
  },
});
