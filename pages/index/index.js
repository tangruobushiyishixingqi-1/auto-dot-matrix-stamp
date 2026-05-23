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
    // 裁剪相关（1:1 正方形）
    cropX: 0,
    cropY: 0,
    cropSize: 200,
    imgW: 0,
    imgH: 0,
    imgX: 0,
    imgY: 0,
    canvasW: 375,
  },

  _canvas: null,
  _ctx: null,
  _imgObj: null,
  _dragStart: null,
  _pinchStart: null,
  _cropImgSrc: '',
  _cl: 0,
  _ct: 0,

  // === 图片选择（选择后弹出裁剪框） ===
  chooseImage() {
    const that = this;
    wx.chooseImage({
      count: 1,
      sizeType: ['original', 'compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        const tempPath = res.tempFilePaths[0];
        that._cropImgSrc = tempPath;
        that.setData({
          cropperSrc: tempPath,
          showCropper: true,
          resultImage: '',
        });
        // 等渲染完成后初始化裁剪
        setTimeout(() => that._initCropper(), 300);
      },
    });
  },

  // === 初始化裁剪器 ===
  _initCropper() {
    const that = this;
    const query = wx.createSelectorQuery();
    query.select('#cropperCanvas').fields({ node: true, size: true }).exec(r => {
      if (!r || !r[0] || !r[0].node) {
        setTimeout(() => that._initCropper(), 200);
        return;
      }
      const canvas = r[0].node;
      const ctx = canvas.getContext('2d');
      const PR = wx.getWindowInfo().pixelRatio || 2;
      const W = 375;
      canvas.width = W * PR;
      canvas.height = W * PR;
      ctx.scale(PR, PR);
      that._canvas = canvas;
      that._ctx = ctx;

      // 获取 canvas 屏幕位置（用于触摸计算）
      query.select('#cropperCanvas').boundingClientRect(rect => {
        if (rect) {
          that._cl = rect.left;
          that._ct = rect.top;
        }
      }).exec();

      // 加载图片
      const img = canvas.createImage();
      img.onload = () => {
        that._imgObj = img;
        const w = W;
        let dw, dh;
        if (img.width / img.height > 1) {
          dw = w;
          dh = w / img.width * img.height;
        } else {
          dh = w;
          dw = w / img.height * img.width;
        }
        const dx = (w - dw) / 2;
        const dy = (w - dh) / 2;
        let s = Math.min(dw, dh) * 0.8;
        s = Math.max(80, Math.min(s, Math.min(dw, dh)));
        const cx = Math.round(dx + (dw - s) / 2);
        const cy = Math.round(dy + (dh - s) / 2);
        that.setData({
          imgW: dw, imgH: dh, imgX: dx, imgY: dy,
          cropX: cx, cropY: cy, cropSize: Math.round(s),
          canvasW: w,
        });
        that._drawCrop();
      };
      img.onerror = () => {
        wx.showToast({ title: '图片加载失败', icon: 'none' });
      };
      img.src = that._cropImgSrc;
    });
  },

  // === 绘制裁剪画面 ===
  _drawCrop() {
    const ctx = this._ctx;
    const canvas = this._canvas;
    const img = this._imgObj;
    if (!ctx || !canvas || !img) return;
    const { cropX, cropY, cropSize, imgX, imgY, imgW, imgH } = this.data;
    const PR = wx.getWindowInfo().pixelRatio || 2;
    const W = this.data.canvasW;
    canvas.width = W * PR;
    canvas.height = W * PR;
    ctx.scale(PR, PR);
    ctx.clearRect(0, 0, W, W);

    // 绘制原图
    ctx.drawImage(img, imgX, imgY, imgW, imgH);

    // 半透明黑色遮罩覆盖非裁剪区域
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, W, cropY);
    ctx.fillRect(0, cropY + cropSize, W, W - cropY - cropSize);
    ctx.fillRect(0, cropY, cropX, cropSize);
    ctx.fillRect(cropX + cropSize, cropY, W - cropX - cropSize, cropSize);

    // 裁剪框白色边框
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(cropX, cropY, cropSize, cropSize);

    // 边角白色直角标识
    ctx.lineWidth = 4;
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 4;
    const G = 2, L = 22;
    ctx.beginPath();
    ctx.moveTo(cropX + G, cropY + G);
    ctx.lineTo(cropX + G, cropY + G + L);
    ctx.moveTo(cropX + G, cropY + G);
    ctx.lineTo(cropX + G + L, cropY + G);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cropX + cropSize - G, cropY + G);
    ctx.lineTo(cropX + cropSize - G, cropY + G + L);
    ctx.moveTo(cropX + cropSize - G, cropY + G);
    ctx.lineTo(cropX + cropSize - G - L, cropY + G);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cropX + G, cropY + cropSize - G);
    ctx.lineTo(cropX + G, cropY + cropSize - G - L);
    ctx.moveTo(cropX + G, cropY + cropSize - G);
    ctx.lineTo(cropX + G + L, cropY + cropSize - G);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cropX + cropSize - G, cropY + cropSize - G);
    ctx.lineTo(cropX + cropSize - G, cropY + cropSize - G - L);
    ctx.moveTo(cropX + cropSize - G, cropY + cropSize - G);
    ctx.lineTo(cropX + cropSize - G - L, cropY + cropSize - G);
    ctx.stroke();
    ctx.shadowBlur = 0;
  },

  // === 触摸事件 ===
  _onCropTouchStart(e) {
    if (!this._imgObj) return;
    if (e.touches.length === 1) {
      this._dragStart = {
        x: e.touches[0].clientX - this._cl,
        y: e.touches[0].clientY - this._ct,
        cx: this.data.cropX,
        cy: this.data.cropY,
      };
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      this._pinchStart = {
        dist: Math.sqrt(dx * dx + dy * dy),
        size: this.data.cropSize,
      };
    }
  },

  _onCropTouchMove(e) {
    if (!this._imgObj) return;
    if (this._dragStart && e.touches.length === 1) {
      const nx = e.touches[0].clientX - this._cl;
      const ny = e.touches[0].clientY - this._ct;
      let x = this._dragStart.cx + (nx - this._dragStart.x);
      let y = this._dragStart.cy + (ny - this._dragStart.y);
      const { imgX, imgY, imgW, imgH, cropSize } = this.data;
      x = Math.max(imgX, Math.min(x, imgX + imgW - cropSize));
      y = Math.max(imgY, Math.min(y, imgY + imgH - cropSize));
      this.setData({ cropX: Math.round(x), cropY: Math.round(y) });
      this._drawCrop();
    } else if (this._pinchStart && e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (this._pinchStart.dist <= 0) return;
      let s = Math.round(this._pinchStart.size * d / this._pinchStart.dist);
      const { imgX, imgY, imgW, imgH, cropX, cropY, cropSize: os } = this.data;
      s = Math.max(80, Math.min(s, Math.min(imgW, imgH)));
      const cx_ = cropX + os / 2;
      const cy_ = cropY + os / 2;
      let x = Math.round(cx_ - s / 2);
      let y = Math.round(cy_ - s / 2);
      x = Math.max(imgX, Math.min(x, imgX + imgW - s));
      y = Math.max(imgY, Math.min(y, imgY + imgH - s));
      this.setData({ cropSize: s, cropX: x, cropY: y });
      this._drawCrop();
    }
  },

  _onCropTouchEnd() {
    this._dragStart = null;
    this._pinchStart = null;
  },

  // === 裁剪取消 ===
  onCropperCancel() {
    this.setData({ showCropper: false });
    this._cleanup();
  },

  // === 裁剪确认 ===
  onCropperConfirm() {
    const that = this;
    const canvas = this._canvas;
    const ctx = this._ctx;
    const img = this._imgObj;
    if (!canvas || !ctx || !img) {
      wx.showToast({ title: '裁剪失败', icon: 'none' });
      return;
    }
    const { cropX, cropY, cropSize, imgW } = this.data;
    const PR = wx.getWindowInfo().pixelRatio || 2;
    const scale = img.width / imgW;
    const ow = Math.round(cropSize * scale);

    wx.showLoading({ title: '裁剪中...' });
    const W = 375;
    canvas.width = W * PR;
    canvas.height = W * PR;
    ctx.scale(PR, PR);
    ctx.clearRect(0, 0, W, W);
    ctx.drawImage(img, this.data.imgX, this.data.imgY, imgW, this.data.imgH);

    wx.canvasToTempFilePath({
      x: cropX, y: cropY, width: cropSize, height: cropSize,
      destWidth: ow, destHeight: ow,
      canvas: canvas, fileType: 'png', quality: 1,
      success(res) {
        wx.hideLoading();
        that.setData({
          inputImage: res.tempFilePath,
          showCropper: false,
        });
        that._cleanup();
      },
      fail(e) {
        wx.hideLoading();
        console.error(e);
        wx.showToast({ title: '裁剪失败', icon: 'none' });
      },
    });
  },

  _cleanup() {
    this._imgObj = null;
    this._canvas = null;
    this._ctx = null;
    this._dragStart = null;
    this._pinchStart = null;
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

  onThicknessChanging(e) {
    this.setData({ thicknessScale: Math.round(e.detail.value * 10) / 10 });
  },

  onThicknessChange(e) {
    this.setData({ thicknessScale: Math.round(e.detail.value * 10) / 10 });
  },

  toggleResize(e) {
    this.setData({ enableResize: e.detail.value });
  },

  onWidthChange(e) {
    this.setData({ outputWidth: Math.round(e.detail.value) });
  },

  onHeightChange(e) {
    this.setData({ outputHeight: Math.round(e.detail.value) });
  },

  // === 核心推理 ===
  generateSketch() {
    const that = this;
    const { inputImage, mode, useClahe, claheClip, thicknessScale, enableResize, outputWidth, outputHeight, apiBase } = this.data;

    if (!inputImage) {
      wx.showToast({ title: '请先选择图片', icon: 'none' });
      return;
    }

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
        thickness_scale: String(thicknessScale),
        output_size: outputSizeStr,
      },

      success(resp) {
        try {
          const json = JSON.parse(resp.data);
          if (resp.statusCode === 200 && json.success && json.image_base64) {
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

  resetAll() {
    this.setData({ inputImage: '', resultImage: '', isProcessing: false });
  },

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
