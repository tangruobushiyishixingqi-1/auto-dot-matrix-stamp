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
    mosaicSrc: '',      // 给 <image> 显示的图片路径
    // ===== 内联键盘输入状态 =====
    editingKey: null,   // 当前正在编辑的参数名，null 表示未编辑
    editingValue: '',   // 编辑框中的临时文本
  },

  // 隐藏 Canvas 引用（离屏，用于像素操作）
  _mosaicCanvas: null,
  _mosaicCtx: null,
  _mosaicInitialized: false,
  _mosaicCellSize: 10,
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

  // ===== 参数值点击键盘输入（内联输入框，支持 Enter 确认） =====
  // _pendingKey / _pendingValue 为局部变量，不受 bindblur 清空影响，
  // 避免 WeChat 小程序中 bindblur 先于 bindconfirm 触发时丢失编辑目标
  _pendingKey: null,
  _pendingValue: '',

  startEdit: function(e) {
    var key = e.currentTarget.dataset.key;
    this._pendingKey = key;
    var currentVal = this.data[key];
    this._pendingValue = String(currentVal);
    this.setData({
      editingKey: key,
      editingValue: String(currentVal),
    });
  },

  onEditInput: function(e) {
    this._pendingValue = e.detail.value;
    this.setData({ editingValue: e.detail.value });
  },

  confirmEdit: function() {
    var key = this._pendingKey;
    var inputStr = (this._pendingValue || '').trim();
    if (!key || inputStr === '') { this.setData({ editingKey: null, editingValue: '' }); this._pendingKey = null; this._pendingValue = ''; return; }

    var configs = {
      claheClip: { min: 1, max: 5, step: 0.1 },
      thicknessScale: { min: 0, max: 10, step: 0.1 },
      outputWidth: { min: 8, max: 512, step: 1 },
      outputHeight: { min: 8, max: 512, step: 1 },
    };
    var cfg = configs[key];
    if (!cfg) { this.setData({ editingKey: null, editingValue: '' }); this._pendingKey = null; this._pendingValue = ''; return; }

    var newVal = parseFloat(inputStr);
    if (isNaN(newVal)) {
      wx.showToast({ title: '请输入有效数字', icon: 'none' });
      return;
    }
    if (cfg.step >= 1) { newVal = Math.round(newVal); }
    else { newVal = Math.round(newVal * 10) / 10; }
    if (newVal < cfg.min) { newVal = cfg.min; }
    if (newVal > cfg.max) { newVal = cfg.max; }

    var obj = {};
    obj[key] = newVal;
    obj.editingKey = null;
    obj.editingValue = '';
    this._pendingKey = null;
    this._pendingValue = '';
    this.setData(obj);

    if (key === 'thicknessScale') {
      var optimal = this._calcOptimalThickness(this.data.mode);
      this.setData({ recommendedThickness: optimal });
    }
  },

  cancelEdit: function() {
    this.setData({ editingKey: null, editingValue: '' });
  },



  onKeyDown: function(e) {
    // 针对小程序 input 组件，使用 bindconfirm + bindblur 组合处理
    // bindconfirm 在点击键盘"完成"按钮时触发
    // 这里只是保留以备需要
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

    // ---- [LOG] Debug: check input values before sending ----
    console.log('[generateSketch] STATE VALUES — enableResize:', enableResize, 'outputWidth:', outputWidth, 'outputHeight:', outputHeight);

    if (!inputImage) { wx.showToast({ title: '请先选择图片', icon: 'none' }); return; }
    var outputSizeStr = '';
    if (enableResize && outputWidth > 0 && outputHeight > 0) outputSizeStr = outputWidth + ',' + outputHeight;
    console.log('[generateSketch] SENDING output_size:', outputSizeStr);

    that.setData({ isProcessing: true }); wx.showLoading({ title: '⏳ 生成图片中...' });
    wx.uploadFile({
      url: apiBase + '/api/sketch2anime_upload', filePath: inputImage, name: 'image',
      formData: { mode: mode, use_clahe: useClahe ? 'true' : 'false', clahe_clip: String(claheClip), thickness_scale: String(thicknessScale), output_size: outputSizeStr },
      success: function(resp) {
        try {
          var json = JSON.parse(resp.data);
          console.log('[generateSketch] SERVER RESPONSE — success:', json.success, 'width:', json.width, 'height:', json.height, 'error:', json.error);
          if (resp.statusCode === 200 && json.success && json.image_base64) {
            var fs = wx.getFileSystemManager();
            var tempFilePath = wx.env.USER_DATA_PATH + '/sketch_result_' + Date.now() + '.png';
            fs.writeFile({
              filePath: tempFilePath, data: wx.base64ToArrayBuffer(json.image_base64), encoding: 'binary',
              success: function() {
                console.log('[generateSketch] FILE SAVED — tempFilePath:', tempFilePath);
                that.setData({ resultImage: tempFilePath, isProcessing: false, mosaicSrc: tempFilePath });
                wx.hideLoading(); wx.showToast({ title: '图片处理成功', icon: 'success' });
                setTimeout(function() { console.log('[generateSketch] Calling _initMosaic now'); that._initMosaic(); }, 600);
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
    var cols = this.data.outputWidth > 0 ? this.data.outputWidth : 32;
    var rows = this.data.outputHeight > 0 ? this.data.outputHeight : 32;
    console.log('[_initMosaic] Grid dimensions:', cols, 'x', rows);

    // 动态计算格子大小，防止超大尺寸撑爆 Canvas（最大 640px）
    var maxDim = 640;
    var cellBase = 10;
    var cellSize = (cols * cellBase > maxDim || rows * cellBase > maxDim)
      ? Math.min(Math.floor(maxDim / cols), Math.floor(maxDim / rows), cellBase)
      : cellBase;
    var W = cols * cellSize;
    var H = rows * cellSize;

    var query = wx.createSelectorQuery();
    query.select('#hiddenMosaicCanvas').fields({ node: true, size: true }).exec(function(r) {
      if (!r || !r[0] || !r[0].node) { setTimeout(function() { that._initMosaic(); }, 300); return; }
      var canvas = r[0].node;
      var ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      that._mosaicCanvas = canvas;
      that._mosaicCtx = ctx;
      that._mosaicCellSize = cellSize;

      var img = canvas.createImage();
      img.onload = function() {
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0, W, H);
        var imageData = ctx.getImageData(0, 0, W, H);
        var pixels = imageData.data;
        var grid = [];
        for (var row = 0; row < rows; row++) {
          var gRow = [];
          for (var col = 0; col < cols; col++) {
            var px = Math.round(col * cellSize + cellSize / 2);
            var py = Math.round(row * cellSize + cellSize / 2);
            if (px >= W) px = W - 1;
            if (py >= H) py = H - 1;
            var idx = (py * W + px) * 4;
            var gray = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
            gRow.push(gray > 128 ? 1 : 0);
          }
          grid.push(gRow);
        }
        that._mosaicGridData = grid;
        that._mosaicInitialized = true;
        console.log('[_initMosaic] Grid built:', rows, 'rows x', cols, 'cols');
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
    var rows = grid.length;
    var cols = grid[0] ? grid[0].length : 0;
    if (rows === 0 || cols === 0) return;
    var cellSize = this._mosaicCellSize || 10;
    var W = cols * cellSize;
    var H = rows * cellSize;

    ctx.clearRect(0, 0, W, H);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var v = (grid[r] && grid[r][c] !== undefined) ? grid[r][c] : 0;
        ctx.fillStyle = v === 1 ? '#ffffff' : '#000000';
        ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
      }
    }
    ctx.strokeStyle = 'rgba(200,200,200,0.4)'; ctx.lineWidth = 0.5;
    for (var i = 0; i <= cols; i++) {
      ctx.beginPath(); ctx.moveTo(i * cellSize, 0); ctx.lineTo(i * cellSize, H); ctx.stroke();
    }
    for (var i = 0; i <= rows; i++) {
      ctx.beginPath(); ctx.moveTo(0, i * cellSize); ctx.lineTo(W, i * cellSize); ctx.stroke();
    }

    var that = this;
    wx.canvasToTempFilePath({
      canvas: canvas, fileType: 'png', quality: 1,
      success: function(res) { console.log('[_syncMosaicToImage] Exported mosaic, mosaicSrc set'); that.setData({ mosaicSrc: res.tempFilePath }); },
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
      var grid = that._mosaicGridData;
      var rows = grid.length;
      var cols = grid[0] ? grid[0].length : 0;
      if (rows === 0 || cols === 0) return;
      var clickX = ct.clientX - rect.left;
      var clickY = ct.clientY - rect.top;
      var w = rect.width / cols;
      var h = rect.height / rows;
      var col = Math.floor(clickX / w);
      var row = Math.floor(clickY / h);
      if (col < 0 || col >= cols || row < 0 || row >= rows) return;

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
