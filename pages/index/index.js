// pages/index/index.js —— 图像转黑白线稿主页逻辑
const { API_BASE } = require('../../utils/api_config');
const BLEPrinter = require('../../utils/ble-printer');

Page({
  data: {
    currentTab: '', // 当前选中的 Tab：''（初始） | 'processor' | 'community'

    inputImage: '',         // 上传的图片临时路径


    resultImage: '',        // 线稿结果图片临时路径
    mode: 'default',        // 提取模式
    thicknessScale: 1.0,    // 线宽倍率
    recommendedThickness: 6.67,  // 推荐线宽倍率
    enableResize: true,     // 是否压缩输出尺寸
    outputWidth: 32,        // 输出宽度
    outputHeight: 32,       // 输出高度
    // ===== 图片来源类型：''（未选择）| 'upload'（上传照片）| 'mosaic'（手绘马赛克） =====
    imageSourceType: '',    // 图片来源类型，用于条件渲染
    isProcessing: false,    // 是否正在处理
    apiBase: API_BASE,      // 线稿服务地址
    showCropper: false,     // 是否显示裁剪弹窗
    cropperSrc: '',         // 传给裁剪的图片路径
    // ===== 马赛克翻转编辑器 =====
    mosaicSrc: '',      // 给 <image> 显示的图片路径
    // ===== 内联键盘输入状态 =====
    editingKey: null,   // 当前正在编辑的参数名，null 表示未编辑
    editingValue: '',   // 编辑框中的临时文本
    // ===== 蓝牙打印 =====
    bleConnected: false,      // 蓝牙是否已连接
    bleDeviceName: '',        // 已连接的设备名称
    bleDeviceList: [],        // 扫描到的设备列表
    bleScanning: false,       // 是否正在扫描
    bleSending: false,        // 是否正在发送数据
    bleProgress: 0,           // 发送进度 0~100
    bleProgressText: '',      // 进度描述文本
    bleLog: '',               // 蓝牙日志
    bleShowConfig: false,     // 是否显示 UUID 配置
    // ----- 默认使用 ESP32S3_BLE 硬件控制的 UUID -----
    bleServiceUuid: '4FAFC201-1FB5-459E-8FCC-C5C9C331914B',
    bleTxUuid: 'BEB5483E-36E1-4688-B7F5-EA07361B26A8',
    bleRxUuid: 'BEB5483E-36E1-4688-B7F5-EA07361B26A8',
    // ===== 硬件控制（GPIO 高低电平） =====
    hwCommandSending: false,  // 是否正在发送硬件控制指令
  },


  // === Tab 切换 ===
  switchTab: function(e) {
    var tab = e.currentTarget.dataset.tab;
    this.setData({ currentTab: tab });
  },

  // === 返回初始选择页 ===
  goBack: function() {
    this.setData({
      currentTab: '',
      imageSourceType: '',
      inputImage: '',
      resultImage: '',
      mosaicSrc: '',
      showCropper: false,
      cropperSrc: '',
      isProcessing: false,
    });
    this._mosaicInitialized = false;
    this._resEdited = false;
    this._mosaicGridData = null;
    this._mosaicCanvas = null;
    this._mosaicCtx = null;
    this._mosaicRect = null;
    this._lastPaintedCell = null;
  },


  // === 返回选择图片来源 ===
  goBackSourceType: function() {
    this.setData({
      imageSourceType: '',
      inputImage: '',
      resultImage: '',
      mosaicSrc: '',
    });
    this._mosaicInitialized = false;
    this._resEdited = false;
    this._mosaicGridData = null;
    this._mosaicCanvas = null;
    this._mosaicCtx = null;
    this._mosaicRect = null;
    this._lastPaintedCell = null;
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

  // ===== 图片来源选择：上传照片 vs 手绘马赛克 =====
  /** 点击「上传彩色照片」按钮：从相册选择图片 */
  onChooseImageUpload: function() {
    var that = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: function(res) {
        var tempPath = res.tempFiles[0].tempFilePath;
        that.setData({
          imageSourceType: 'upload',
          cropperSrc: tempPath,
          showCropper: true,
          resultImage: '',
          mosaicSrc: '',
        });
      },
    });
  },

  /** 点击「手绘马赛克图案」按钮：立即渲染空白网格画布 */
  onChooseMosaic: function() {
    var that = this;
    // 清除先前状态
    that._mosaicInitialized = false;
    that._resEdited = false;
    that._mosaicGridData = null;
    that._mosaicCanvas = null;
    that._mosaicCtx = null;
    that._mosaicRect = null;
    that._lastPaintedCell = null;

    that.setData({
      imageSourceType: 'mosaic',
      inputImage: '',
      resultImage: '',
      mosaicSrc: '',
    }, function() {
      // setData 回调中，DOM 已更新，canvas 节点已就绪，立刻渲染
      that._renderBlankMosaicGrid();
    });
  },

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

  onThicknessChanging: function(e) { this.setData({ thicknessScale: Math.round(e.detail.value * 10) / 10 }); },
  onThicknessChange: function(e) { this.setData({ thicknessScale: Math.round(e.detail.value * 10) / 10 }); },

  toggleResize: function(e) {
    this.setData({ enableResize: e.detail.value });
    // 手绘马赛克模式下，变化尺寸后重新渲染空白网格
    if (this.data.imageSourceType === 'mosaic') {
      var that = this;
      setTimeout(function() { that._renderBlankMosaicGrid(); }, 200);
    }
  },
  onWidthChange: function(e) {
    this.setData({ outputWidth: Math.round(e.detail.value) });
    // 手绘马赛克模式下，变化尺寸后重新渲染空白网格
    if (this.data.imageSourceType === 'mosaic') {
      var that = this;
      setTimeout(function() { that._renderBlankMosaicGrid(); }, 200);
    }
  },
  onHeightChange: function(e) {
    this.setData({ outputHeight: Math.round(e.detail.value) });
    // 手绘马赛克模式下，变化尺寸后重新渲染空白网格
    if (this.data.imageSourceType === 'mosaic') {
      var that = this;
      setTimeout(function() { that._renderBlankMosaicGrid(); }, 200);
    }
  },

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

  // ===== 判断响应是否为 Cloudflare Tunnel 错误 =====
  _isCloudflareError: function(resp) {
    return resp.statusCode === 530 ||
      (typeof resp.data === 'string' && resp.data.indexOf('error code: 1033') >= 0) ||
      (typeof resp.data === 'string' && resp.data.indexOf('cloudflare') >= 0);
  },

  // === 核心推理（调用原有线稿处理后端） ===
  generateSketch: function() {
    var that = this;
    var inputImage = this.data.inputImage;
    var mode = this.data.mode;
    var thicknessScale = this.data.thicknessScale;
    var enableResize = this.data.enableResize;
    var outputWidth = this.data.outputWidth;
    var outputHeight = this.data.outputHeight;
    var apiBase = this.data.apiBase;

    if (!inputImage) { wx.showToast({ title: '请先选择图片', icon: 'none' }); return; }
    if (!apiBase) { wx.showToast({ title: '请先配置线稿服务地址', icon: 'none', duration: 3000 }); return; }
    var outputSizeStr = '';
    if (enableResize && outputWidth > 0 && outputHeight > 0) outputSizeStr = outputWidth + ',' + outputHeight;

    that._doGenerateSketch(inputImage, mode, thicknessScale, outputSizeStr, apiBase, 0);
  },

  /** 内部重试函数：retryCount 从 0 开始 */
  _doGenerateSketch: function(inputImage, mode, thicknessScale, outputSizeStr, apiBase, retryCount) {
    var that = this;
    var MAX_RETRIES = 3;

    that.setData({ isProcessing: true });
    if (retryCount === 0) {
      wx.showLoading({ title: '生成图片中...' });
    } else {
      wx.showLoading({ title: '重试中 (' + retryCount + '/' + MAX_RETRIES + ')...' });
    }

    wx.uploadFile({
      url: apiBase + '/api/sketch2anime_upload', filePath: inputImage, name: 'image',
      formData: { mode: mode, use_clahe: 'false', clahe_clip: '2.0', thickness_scale: String(thicknessScale), output_size: outputSizeStr },
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
              fail: function(err) { console.error('写入结果失败:', err); that.setData({ isProcessing: false }); wx.hideLoading(); wx.showToast({ title: '结果保存失败', icon: 'none' }); },
            });
          } else { that.setData({ isProcessing: false }); wx.hideLoading(); wx.showToast({ title: json.error || '处理失败', icon: 'none' }); }
        } catch (e) {
          var isCloudflareError = that._isCloudflareError(resp);

          if (isCloudflareError && retryCount < MAX_RETRIES) {
            console.warn('[generateSketch] 线稿服务异常，' + ((retryCount + 1) * 1000) + 'ms后自动重试 (' + (retryCount + 1) + '/' + MAX_RETRIES + ')');
            wx.hideLoading();
            setTimeout(function() {
              that._doGenerateSketch(inputImage, mode, thicknessScale, outputSizeStr, apiBase, retryCount + 1);
            }, (retryCount + 1) * 1000);
          } else {
            that.setData({ isProcessing: false }); wx.hideLoading();
            var responseText = typeof resp.data === 'string' ? resp.data.substring(0, 500) : JSON.stringify(resp.data);
            console.error('解析响应失败:', e, '响应内容前500字符:', responseText, 'statusCode:', resp.statusCode);
            if (resp.statusCode === 404) {
              wx.showToast({ title: '线稿服务地址不可用', icon: 'none', duration: 3000 });
            } else if (isCloudflareError || resp.statusCode === 530) {
              wx.showToast({ title: '线稿服务暂不可用', icon: 'none', duration: 3000 });
            } else {
              wx.showToast({ title: '服务器返回异常数据（status:' + resp.statusCode + '）', icon: 'none', duration: 3000 });
            }
          }
        }
      },
      fail: function(err) {
        that.setData({ isProcessing: false }); wx.hideLoading();
        console.error('上传失败:', err);
        wx.showToast({ title: '连接线稿服务失败', icon: 'none', duration: 3000 });
      },
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

  // === 匿名分享到社区（优先云开发，失败时保存到本地社区） ===
  shareToCommunity: function() {
    var that = this;
    var imagePath = this.data.mosaicSrc || this.data.resultImage;
    if (!imagePath) {
      wx.showToast({ title: '没有可分享的图片', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在匿名发布...' });

    if (!wx.cloud) {
      that._saveCommunityPostLocally(imagePath);
      wx.hideLoading();
      wx.showToast({ title: '已保存到本地社区', icon: 'success' });
      return;
    }

    var cloudPath = 'community/' + Date.now() + '_' + Math.floor(Math.random() * 100000) + '.png';
    wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: imagePath,
      success: function(uploadRes) {
        wx.cloud.callFunction({
          name: 'community_service',
          data: { action: 'add', photo_url: uploadRes.fileID },
          success: function(cbRes) {
            wx.hideLoading();
            var result = cbRes.result || {};
            if (result.code === 0) {
              wx.showToast({ title: '发布成功！', icon: 'success' });
            } else {
              that._saveCommunityPostLocally(imagePath);
              wx.showToast({ title: '已保存到本地社区', icon: 'success' });
            }
          },
          fail: function(err) {
            console.error('[shareToCommunity] 云函数发布失败:', err);
            that._saveCommunityPostLocally(imagePath);
            wx.hideLoading();
            wx.showToast({ title: '已保存到本地社区', icon: 'success' });
          },
        });
      },
      fail: function(err) {
        console.error('[shareToCommunity] 云存储上传失败:', err);
        that._saveCommunityPostLocally(imagePath);
        wx.hideLoading();
        wx.showToast({ title: '已保存到本地社区', icon: 'success' });
      },
    });
  },

  _saveCommunityPostLocally: function(imagePath) {
    var list = wx.getStorageSync('local_community_photos') || [];
    list.unshift({
      _id: 'local_' + Date.now(),
      photo_url: imagePath,
      likes: 0,
      create_time: Date.now(),
      local: true,
    });
    wx.setStorageSync('local_community_photos', list);
  },

  resetAll: function() {
    this._mosaicInitialized = false; this._resEdited = false; this._mosaicGridData = null;
    this.setData({ inputImage: '', resultImage: '', mosaicSrc: '', isProcessing: false });
  },

  // =========================================================================
  // 手绘马赛克：渲染空白网格画布
  // =========================================================================

  /**
   * 根据当前 outputWidth / outputHeight 生成全白的空白网格数据，
   * 渲染到离屏 Canvas 并输出到 mosaicSrc，让用户在预览区看到一张空白的马赛克网格。
   */
  _renderBlankMosaicGrid: function() {
    var that = this;
    var cols = this.data.outputWidth > 0 ? this.data.outputWidth : 32;
    var rows = this.data.outputHeight > 0 ? this.data.outputHeight : 32;
    console.log('[_renderBlankMosaicGrid] Grid dimensions:', cols, 'x', rows);

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
      if (!r || !r[0] || !r[0].node) {
        setTimeout(function() { that._renderBlankMosaicGrid(); }, 300);
        return;
      }
      var canvas = r[0].node;
      var ctx = canvas.getContext('2d');
      canvas.width = W;
      canvas.height = H;
      that._mosaicCanvas = canvas;
      that._mosaicCtx = ctx;
      that._mosaicCellSize = cellSize;

      // 生成全白网格（所有格子 = 1 代表白色）
      var grid = [];
      for (var row = 0; row < rows; row++) {
        var gRow = [];
        for (var col = 0; col < cols; col++) {
          gRow.push(1); // 1 = 白色（未填色）
        }
        grid.push(gRow);
      }
      that._mosaicGridData = grid;
      that._mosaicInitialized = true;
      that._resEdited = false;
      console.log('[_renderBlankMosaicGrid] Blank grid built:', rows, 'rows x', cols, 'cols');

      // 渲染到 Canvas
      ctx.clearRect(0, 0, W, H);
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var v = grid[r][c];
          ctx.fillStyle = v === 1 ? '#ffffff' : '#000000';
          ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
        }
      }
      // 绘制网格线
      ctx.strokeStyle = 'rgba(200,200,200,0.4)';
      ctx.lineWidth = 0.5;
      for (var i = 0; i <= cols; i++) {
        ctx.beginPath(); ctx.moveTo(i * cellSize, 0); ctx.lineTo(i * cellSize, H); ctx.stroke();
      }
      for (var i = 0; i <= rows; i++) {
        ctx.beginPath(); ctx.moveTo(0, i * cellSize); ctx.lineTo(W, i * cellSize); ctx.stroke();
      }

      // 导出图片到 image 标签展示
      that._renderGridToCanvases();

      // 导出为图片路径，同时设置 resultImage 和 mosaicSrc 以触发预览展示
      wx.canvasToTempFilePath({
        canvas: canvas, fileType: 'png', quality: 1,
        success: function(res) {
          console.log('[_renderBlankMosaicGrid] Exported blank mosaic');
          that.setData({
            resultImage: res.tempFilePath,
            mosaicSrc: res.tempFilePath,
          });
        },
        fail: function(e) {
          console.error('[_renderBlankMosaicGrid] Export failed:', e);
        },
      }, that);
    });
  },

  // =========================================================================
  // 手绘马赛克交互模块：手指点击 / 拖动绘制
  // =========================================================================

  // 记录触屏坐标，避免重复触发同一格
  _lastPaintedCell: null,

  /**
   * 把内存中的 grid 数据渲染到隐藏 Canvas（hiddenMosaicCanvas，供导出/打印）
   * 然后导出为图片路径更新 mosaicSrc，供 image 标签展示。
   */
  _renderGridToCanvases: function() {
    var grid = this._mosaicGridData;
    if (!grid) return;
    var rows = grid.length;
    var cols = grid[0] ? grid[0].length : 0;
    if (rows === 0 || cols === 0) return;
    var cellSize = this._mosaicCellSize || 10;
    var that = this;

    var hiddenCtx = this._mosaicCtx;
    var hiddenCanvas = this._mosaicCanvas;
    if (!hiddenCtx || !hiddenCanvas) return;

    var W = cols * cellSize;
    var H = rows * cellSize;
    hiddenCtx.clearRect(0, 0, W, H);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var v = (grid[r] && grid[r][c] !== undefined) ? grid[r][c] : 0;
        hiddenCtx.fillStyle = v === 1 ? '#ffffff' : '#000000';
        hiddenCtx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
      }
    }
    hiddenCtx.strokeStyle = 'rgba(200,200,200,0.4)'; hiddenCtx.lineWidth = 0.5;
    for (var i = 0; i <= cols; i++) {
      hiddenCtx.beginPath(); hiddenCtx.moveTo(i * cellSize, 0); hiddenCtx.lineTo(i * cellSize, H); hiddenCtx.stroke();
    }
    for (var i = 0; i <= rows; i++) {
      hiddenCtx.beginPath(); hiddenCtx.moveTo(0, i * cellSize); hiddenCtx.lineTo(W, i * cellSize); hiddenCtx.stroke();
    }

    // 导出为图片路径，更新 mosaicSrc 供 image 展示
    wx.canvasToTempFilePath({
      canvas: hiddenCanvas, fileType: 'png', quality: 1,
      success: function(res) {
        that.setData({ mosaicSrc: res.tempFilePath });
      },
      fail: function(e) { console.error('导出马赛克失败:', e); },
    }, that);
  },

  /**
   * 从触摸事件中解析出格子行列坐标（基于 image 元素实际显示尺寸等比计算）
   */
  _getCellFromTouch: function(touch) {
    var grid = this._mosaicGridData;
    if (!grid) return null;
    var rows = grid.length;
    var cols = grid[0] ? grid[0].length : 0;
    if (rows === 0 || cols === 0) return null;

    var rect = this._mosaicRect;
    if (!rect) return null;

    var clickX = touch.clientX - rect.left;
    var clickY = touch.clientY - rect.top;
    if (clickX < 0 || clickY < 0 || clickX > rect.width || clickY > rect.height) return null;

    var w = rect.width / cols;
    var h = rect.height / rows;
    var col = Math.floor(clickX / w);
    var row = Math.floor(clickY / h);
    if (col < 0 || col >= cols || row < 0 || row >= rows) return null;

    return { row: row, col: col };
  },

  /** 触摸开始：将格子设为黑色 */
  onMosaicTouchStart: function(e) {
    if (!this._mosaicInitialized || !this._mosaicGridData) return;
    var that = this;
    // 获取 image 元素的 bounding rect
    var q = wx.createSelectorQuery();
    q.select('#mosaicCanvas').boundingClientRect(function(rect) {
      that._mosaicRect = rect;
      var touch = e.changedTouches && e.changedTouches[0];
      if (!touch) return;
      var cell = that._getCellFromTouch(touch);
      if (!cell) return;
      that._paintCell(cell.row, cell.col);
    }).exec();
  },

  /** 触摸移动：手指划过连续涂黑格子 */
  onMosaicTouchMove: function(e) {
    if (!this._mosaicInitialized || !this._mosaicGridData) return;
    var that = this;
    var touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    var cell = that._getCellFromTouch(touch);
    if (!cell) return;

    // 避免同一格重复触发
    if (that._lastPaintedCell &&
        that._lastPaintedCell.row === cell.row &&
        that._lastPaintedCell.col === cell.col) return;

    that._paintCell(cell.row, cell.col);
    that._lastPaintedCell = cell;
  },

  /** 触摸结束：清理状态 */
  onMosaicTouchEnd: function(e) {
    this._lastPaintedCell = null;
  },

  /**
   * 将指定格子翻转黑白（0↔1），并更新隐藏 Canvas 导出为 mosaicSrc，
   * 通过 image 标签的 src 更新自动反映给用户。
   */
  _paintCell: function(row, col) {
    var grid = this._mosaicGridData;
    if (!grid) return;
    if (row < 0 || row >= grid.length) return;
    if (col < 0 || col >= grid[0].length) return;

    // 所有模式统一用翻转逻辑：黑色→白色，白色→黑色
    grid[row][col] = grid[row][col] === 0 ? 1 : 0;
    this._resEdited = true;

    // 更新隐藏 Canvas 并导出（保持 mosaicSrc 最新，触发 image 刷新）
    var that = this;
    var rows = grid.length;
    var cols = grid[0].length;
    var cellSize = this._mosaicCellSize || 10;
    if (this._mosaicCtx && this._mosaicCanvas) {
      var W = cols * cellSize;
      var H = rows * cellSize;
      var ctx = this._mosaicCtx;
      var cvs = this._mosaicCanvas;
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
        ctx.beginPath(); ctx.moveTo(i * cellSize, 0); ctx.lineTo(i * cellSize, W); ctx.stroke();
      }
      for (var i = 0; i <= rows; i++) {
        ctx.beginPath(); ctx.moveTo(0, i * cellSize); ctx.lineTo(W, i * cellSize); ctx.stroke();
      }

      wx.canvasToTempFilePath({
        canvas: cvs, fileType: 'png', quality: 1,
        success: function(res) {
          that.setData({ mosaicSrc: res.tempFilePath });
        },
        fail: function(e) { console.error('导出马赛克失败:', e); },
      }, that);
    }
  },

  /**
   * 从照片结果初始化马赛克网格（照片模式用）
   */
  _initMosaic: function() {
    var that = this;
    var cols = this.data.outputWidth > 0 ? this.data.outputWidth : 32;
    var rows = this.data.outputHeight > 0 ? this.data.outputHeight : 32;
    console.log('[_initMosaic] Grid dimensions:', cols, 'x', rows);

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
        // 渲染到两个 Canvas 并导出
        that._renderGridToCanvases();
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

  // =========================================================================
  // 蓝牙打印模块
  // =========================================================================

  onLoad: function() {
    // 初始化 BLE 打印机
    this._blePrinter = new BLEPrinter();
    this._setupBLEEvents();
  },

  onUnload: function() {
    if (this._blePrinter) {
      this._blePrinter.closeAdapter();
    }
  },

  /** 设置 BLEPrinter 事件回调 */
  _setupBLEEvents: function() {
    var that = this;
    var printer = this._blePrinter;
    if (!printer) return;

    // 发现设备
    printer.onFoundDevice = function(device) {
      var list = that.data.bleDeviceList;
      // 查找是否已存在
      var foundIdx = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i].deviceId === device.deviceId) {
          foundIdx = i;
          break;
        }
      }

      if (foundIdx >= 0) {
        // 已存在：更新名称（iOS 首次可能无名称，后续广播包会补全）
        var existing = list[foundIdx];
        if (device.name && !existing.name) {
          existing.name = device.name;
          existing.displayName = device.displayName || device.name;
        }
        existing.RSSI = device.RSSI;
        // 触发更新（重新设置整个列表）
        that.setData({ bleDeviceList: list });
      } else {
        // 新设备：添加到列表
        list.push(device);
        that.setData({ bleDeviceList: list });
      }

    };


    // 连接成功
    printer.onConnected = function(name) {
      that.setData({
        bleConnected: true,
        bleDeviceName: name,
        bleScanning: false,
      });
      that._appendBLELog('✅ 已连接: ' + name);
      wx.showToast({ title: '蓝牙已连接', icon: 'success' });
    };

    // 断开连接
    printer.onDisconnected = function() {
      that.setData({
        bleConnected: false,
        bleDeviceName: '',
        bleSending: false,
        bleProgress: 0,
        bleProgressText: '',
      });
      that._appendBLELog('⚠️ 蓝牙已断开');
    };

    // 发送进度
    printer.onSendProgress = function(current, total, msg) {
      var pct = Math.round((current / total) * 100);
      pct = Math.min(pct, 100);
      that.setData({
        bleProgress: pct,
        bleProgressText: msg,
      });
      that._appendBLELog(msg);
    };

    // 发送完成
    printer.onSendComplete = function() {
      that.setData({
        bleSending: false,
        bleProgress: 100,
        bleProgressText: '✅ 打印完成！',
      });
      that._appendBLELog('✅ 打印数据发送完成！');
      wx.showToast({ title: '打印命令已发送', icon: 'success' });
    };

    // 错误
    printer.onError = function(msg) {
      that.setData({
        bleSending: false,
        bleScanning: false,
      });
      that._appendBLELog('❌ ' + msg);
      wx.showToast({ title: msg, icon: 'none', duration: 3000 });
    };

    // 日志输出
    printer.onLog = function(msg) {
      that._appendBLELog(msg);
    };
  },

  /** 追加 BLE 日志 */
  _appendBLELog: function(msg) {
    var log = this.data.bleLog;
    var timestamp = new Date().toLocaleTimeString();
    log = log + '\n[' + timestamp + '] ' + msg;
    // 只保留最近 50 行
    var lines = log.split('\n');
    if (lines.length > 50) {
      lines = lines.slice(lines.length - 50);
      log = lines.join('\n');
    }
    this.setData({ bleLog: log });
  },

  /** 开始扫描蓝牙设备 */
  onBLEScan: function() {
    var that = this;
    if (this.data.bleScanning) return;

    this.setData({
      bleDeviceList: [],
      bleScanning: true,
      bleLog: '',
    });
    this._appendBLELog('🔍 开始扫描蓝牙设备...');

    this._blePrinter.startScan().then(function() {
      // 10 秒后自动停止扫描
      setTimeout(function() {
        if (that.data.bleScanning) {
          that._blePrinter.stopScan();
          that.setData({ bleScanning: false });
          that._appendBLELog('⏹️ 扫描已停止');
        }
      }, 10000);
    }).catch(function() {
      that.setData({ bleScanning: false });
    });
  },

  /** 停止扫描 */
  onBLEStopScan: function() {
    this._blePrinter.stopScan();
    this.setData({ bleScanning: false });
    this._appendBLELog('⏹️ 扫描已停止');
  },

  /** 连接设备 */
  onBLEConnect: function(e) {
    var that = this;
    var deviceId = e.currentTarget.dataset.deviceid;
    var deviceName = e.currentTarget.dataset.name;

    wx.showLoading({ title: '连接中...' });
    this._blePrinter.connect(deviceId, deviceName).then(function() {
      wx.hideLoading();
    }).catch(function() {
      wx.hideLoading();
    });
  },

  /** 脱机调试：将协议包打印到控制台，无需蓝牙连接 */
  onBLEDebugPrint: function() {
    if (!this._mosaicGridData) {
      wx.showToast({ title: '没有点阵数据，请先生成图片', icon: 'none' });
      return;
    }
    var grid = this._mosaicGridData;
    var imageData = this._blePrinter.gridToImageData(grid);
    console.log('============================================');
    console.log('  🧪 触发脱机调试 — 当前点阵: ' + grid.length + '×' + (grid[0] ? grid[0].length : 0));
    console.log('============================================');
    this._blePrinter.debugPrintPackets(imageData);
    this._appendBLELog('🧪 脱机调试完成，请查看开发者工具 Console 面板');
    wx.showToast({ title: '调试日志已输出到 Console', icon: 'none', duration: 2000 });
  },

  /** 断开连接 */
  onBLEDisconnect: function() {
    this._blePrinter.disconnect();
  },


  /** 发送打印数据（新协议：START → DATA×8 → END → 等待 READY → PRINT） */
  onBLESendPrint: function() {
    if (!this._blePrinter._connected) {
      wx.showToast({ title: '请先连接蓝牙设备', icon: 'none' });
      return;
    }
    if (!this._mosaicGridData) {
      wx.showToast({ title: '没有可打印的点阵数据', icon: 'none' });
      return;
    }
    if (this.data.bleSending) {
      wx.showToast({ title: '正在发送中...', icon: 'none' });
      return;
    }

    // 应用当前 UUID 配置
    this._blePrinter.setUUID(
      this.data.bleServiceUuid,
      this.data.bleTxUuid,
      this.data.bleRxUuid
    );

    this.setData({
      bleSending: true,
      bleProgress: 0,
      bleProgressText: '准备发送...',
    });
    this._appendBLELog('🖨️ 开始通过 BLE 协议发送图像数据...');

    // Step 1: 将 32×32 二维点阵数组转换为 128 字节 Uint8Array
    var grid = this._mosaicGridData;
    var imageData = this._blePrinter.gridToImageData(grid);
    this._appendBLELog('📐 点阵数据: ' + grid.length + '×' + (grid[0] ? grid[0].length : 0) + ' → ' + imageData.length + ' 字节');

    // Step 2: 通过 BLE 协议发送（START → DATA×8 → END → 等待 READY → PRINT）
    var that = this;
    this._blePrinter.sendImageData(imageData).then(function() {
      // 全部流程成功完成
      that.setData({
        bleSending: false,
        bleProgress: 100,
        bleProgressText: '✅ 全部发送完成！',
      });
      that._appendBLELog('✅ 图像数据协议发送全部完成！');
      wx.showToast({ title: '打印命令已发送', icon: 'success' });
    }).catch(function(err) {
      // 流程中任一步骤失败
      that.setData({ bleSending: false });
      that._appendBLELog('❌ 发送失败: ' + (err.message || err));
      wx.showToast({ title: '发送失败', icon: 'none', duration: 3000 });
      if (typeof that._blePrinter.onError === 'function') {
        that._blePrinter.onError('发送失败: ' + (err.message || err));
      }
    });
  },


  /** 切换 UUID 配置展开/折叠 */
  onBLEToggleConfig: function() {
    this.setData({ bleShowConfig: !this.data.bleShowConfig });
  },

  /** 输入 UUID */
  onBLEUuidInput: function(e) {
    var key = e.currentTarget.dataset.key;
    var obj = {};
    obj[key] = e.detail.value;
    this.setData(obj);
  },

  /** 确认 UUID 配置 */
  onBLEConfirmUuid: function() {
    this._blePrinter.setUUID(
      this.data.bleServiceUuid,
      this.data.bleTxUuid,
      this.data.bleRxUuid
    );
    this.setData({ bleShowConfig: false });
    this._appendBLELog('✅ UUID 已更新');
    wx.showToast({ title: 'UUID 已更新', icon: 'success' });
  },

  // =========================================================================
  // 硬件 GPIO 控制（ESP32 引脚高低电平）
  // =========================================================================

  /**
   * 发送硬件控制指令（通用）
   * 将字符串转 ArrayBuffer 并通过 BLE 写入特征值
   */
  _sendHWCommand: function(cmdStr) {
    var that = this;

    if (!this._blePrinter.isConnected()) {
      wx.showToast({ title: '请先连接蓝牙设备', icon: 'none' });
      return Promise.reject(new Error('未连接'));
    }

    this.setData({ hwCommandSending: true });
    this._appendBLELog('📤 发送硬件指令: ' + cmdStr);

    // 应用硬件控制的 UUID（默认就是 ESP32S3 的硬件 UUID）
    this._blePrinter.setUUID(
      this.data.bleServiceUuid,
      this.data.bleTxUuid,
      this.data.bleRxUuid
    );

    return this._blePrinter.writeString(cmdStr).then(function() {
      that.setData({ hwCommandSending: false });
      that._appendBLELog('✅ 指令已发送: ' + cmdStr);
      wx.showToast({ title: '指令已发送: ' + cmdStr, icon: 'success' });
    }).catch(function(err) {
      that.setData({ hwCommandSending: false });
      that._appendBLELog('❌ 指令发送失败: ' + (err.errMsg || err.message || ''));
      wx.showToast({ title: '指令发送失败', icon: 'none' });
    });
  },

  /** 引脚置高（发送 "1"） */
  onBLEHigh: function() {
    this._sendHWCommand('1');
  },

  /** 引脚置低（发送 "0"） */
  onBLELow: function() {
    this._sendHWCommand('0');
  },
});
