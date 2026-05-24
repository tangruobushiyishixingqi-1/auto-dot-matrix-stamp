// components/image-cropper-handles/image-cropper-handles.js
/**
 * 基于拖拽控制点（Resize Handles）的裁剪组件（Canvas + DOM 混合架构）
 *
 *  ==== 架构 ====
 *  所有 DOM 元素都是 .cropper-canvas-area 的直接子节点（平级兄弟）：
 *    Canvas        → 图片 + 半透明遮罩
 *    .crop-box     → 裁剪框边框（pointer-events: none，纯视觉，不响应触摸）
 *    .crop-center  → 内部拖拽区（bindtouch*）
 *    .handle-tl/tr/bl/br/top/bottom/left/right → 8个独立控制点（catchtouch*）
 *
 *  ==== 事件分流（三重保证） ====
 *  第 1 层 — 物理隔离（WXML 结构）：
 *    control point 与 crop-center 是兄弟节点，根本不存在冒泡路径交叉
 *  第 2 层 — catch vs bind（WXML 事件绑定）：
 *    handle × 8 → catchtouch* 阻止事件冒泡；center → bindtouch* 正常响应
 *  第 3 层 — currentTarget（JS 防御）：
 *    使用 e.currentTarget.dataset 而非 e.target.dataset
 *
 *  ==== 边界限制 ====
 *  - 裁剪框不能超出图片边界
 *  - 最小尺寸 50×50 像素
 *  - 固定宽高比 1:1（正方形裁剪）
 */

const windowInfo = wx.getWindowInfo();
const PR = windowInfo.pixelRatio || 2;
const CANVAS_SIZE = 375;
const MIN_CROP_SIZE = 50;
const MAX_RETRY = 30; // 最多重试 30 次（~3 秒）

Component({
  properties: {
    src: { type: String, value: '' },
    show: { type: Boolean, value: false },
  },

  data: {
    cx: 0, cy: 0, cs: 200,
    ix: 0, iy: 0, iw: 0, ih: 0,
  },

  _c: null,
  _ctx: null,
  _img: null,
  _cl: 0, _ct: 0,
  _drag: null,
  _loading: false,

  observers: {
    'show, src'(show, src) {
      console.log('[crop] observer show:', show, 'src:', !!src);
      if (show && src) {
        // 父级 setData({showCropper:true, cropperSrc:path}) 后，
        // observer 以正确的属性值触发。wx:if 创建 DOM + 渲染需要时间，
        // 但 _queryCanvas 内部的 retry loop 会等 DOM 就绪。
        setTimeout(() => this._start(), 50);
      } else if (!show) {
        this._img = null;
        this._c = null;
        this._ctx = null;
        this._drag = null;
        this._loading = false;
      }
    },
  },

  // ready() 在组件 JS 实例创建时就触发，此时 parent 的 setData 可能
  // 还未同步到子组件，因此属性值始终为默认值 {show:false, src:''}。
  // 所有初始化工作交由组合 observer 'show, src' 完成。

  methods: {
    /**
     * 带重试限制的 Canvas 节点查询
     */
    _queryCanvas(callback, retries) {
      if (retries === undefined) retries = MAX_RETRY;
      const that = this;
      this.createSelectorQuery().select('#cropCanvas').fields({ node: true, size: true }).exec(r => {
        if (r && r[0] && r[0].node) {
          callback(r[0].node);
        } else if (retries > 0 && that.properties.show) {
          setTimeout(() => that._queryCanvas(callback, retries - 1), 100);
        } else if (retries <= 0) {
          console.error('[crop] Canvas query failed after max retries');
          that._loading = false;
          wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
        }
      });
    },

    _queryPosition(callback, retries) {
      if (retries === undefined) retries = MAX_RETRY;
      const that = this;
      this.createSelectorQuery().select('#cropCanvas').boundingClientRect(rect => {
        if (rect && typeof rect.left === 'number') {
          callback(rect.left, rect.top);
        } else if (retries > 0 && that.properties.show) {
          setTimeout(() => that._queryPosition(callback, retries - 1), 100);
        } else if (retries <= 0) {
          console.error('[crop] Position query failed after max retries');
        }
      }).exec();
    },

    _start() {
      if (this._loading) return;
      this._loading = true;

      this._queryCanvas(node => {
        const ctx = node.getContext('2d');
        node.width = CANVAS_SIZE * PR;
        node.height = CANVAS_SIZE * PR;
        ctx.scale(PR, PR);
        this._c = node;
        this._ctx = ctx;

        this._queryPosition((left, top) => {
          this._cl = left;
          this._ct = top;
          this._load(this.properties.src);
        });
      });
    },

    _load(src) {
      const img = this._c.createImage();
      img.onload = () => {
        this._img = img;
        this._loading = false;
        const w = CANVAS_SIZE;
        let dw, dh;
        if (img.width / img.height > 1) {
          dw = w; dh = w / img.width * img.height;
        } else {
          dh = w; dw = w / img.height * img.width;
        }
        const dx = (w - dw) / 2;
        const dy = (w - dh) / 2;
        let s = Math.min(dw, dh) * 0.8;
        s = Math.max(MIN_CROP_SIZE, Math.min(s, Math.min(dw, dh)));
        const cx = dx + (dw - s) / 2;
        const cy = dy + (dh - s) / 2;
        this.setData({
          ix: dx, iy: dy, iw: dw, ih: dh,
          cx: Math.round(cx), cy: Math.round(cy), cs: Math.round(s),
        });
        this._draw();
      };
      img.onerror = () => {
        this._loading = false;
        wx.showToast({ title: '图片加载失败', icon: 'none' });
      };
      img.src = src;
    },

    // ================================================================
    //  绘制
    // ================================================================

    _draw() {
      const ctx = this._ctx;
      const c = this._c;
      const img = this._img;
      if (!ctx || !c || !img) return;

      const { cx, cy, cs, ix, iy, iw, ih } = this.data;
      const W = CANVAS_SIZE;

      c.width = W * PR;
      c.height = W * PR;
      ctx.scale(PR, PR);
      ctx.clearRect(0, 0, W, W);

      ctx.drawImage(img, ix, iy, iw, ih);

      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, W, cy);
      ctx.fillRect(0, cy + cs, W, W - cy - cs);
      ctx.fillRect(0, cy, cx, cs);
      ctx.fillRect(cx + cs, cy, W - cx - cs, cs);
    },

    // ================================================================
    //  边界约束
    // ================================================================

    _clampCrop(cx, cy, cs, ix, iy, iw, ih) {
      cs = Math.max(MIN_CROP_SIZE, cs);
      if (cx < ix) cx = ix;
      if (cy < iy) cy = iy;
      const maxW = ix + iw;
      const maxH = iy + ih;
      if (cx + cs > maxW) cx = maxW - cs;
      if (cy + cs > maxH) cy = maxH - cs;
      const maxCs = Math.min(maxW - cx, maxH - cy);
      if (cs > maxCs) cs = maxCs;
      cs = Math.max(MIN_CROP_SIZE, cs);
      cx = Math.max(ix, Math.min(cx, maxW - cs));
      cy = Math.max(iy, Math.min(cy, maxH - cs));
      return { cx, cy, cs };
    },

    // ================================================================
    //  触摸事件
    // ================================================================

    _refreshPosition() {
      const that = this;
      this.createSelectorQuery().select('#cropCanvas').boundingClientRect(rect => {
        if (rect && typeof rect.left === 'number') {
          that._cl = rect.left;
          that._ct = rect.top;
        }
      }).exec();
    },

    onTouchStart(e) {
      if (!this._img) return;
      const touch = e.touches[0];
      if (!touch) return;

      const ct = e.currentTarget;
      if (!ct || !ct.dataset) return;
      const part = ct.dataset.part;
      const handle = ct.dataset.handle || '';

      if (part === 'handle') {
        this._refreshPosition();
        const px = touch.clientX - this._cl;
        const py = touch.clientY - this._ct;
        this._drag = {
          mode: 'resize',
          handle,
          startX: px,
          startY: py,
          initCx: this.data.cx,
          initCy: this.data.cy,
          initCs: this.data.cs,
        };
        return;
      }

      if (part === 'center') {
        this._refreshPosition();
        const px = touch.clientX - this._cl;
        const py = touch.clientY - this._ct;
        this._drag = {
          mode: 'pan',
          handle: '',
          startX: px,
          startY: py,
          initCx: this.data.cx,
          initCy: this.data.cy,
          initCs: this.data.cs,
        };
      }
    },

    onTouchMove(e) {
      if (!this._img || !this._drag) return;
      const touch = e.touches[0];
      if (!touch) return;

      const px = touch.clientX - this._cl;
      const py = touch.clientY - this._ct;
      const { mode, handle, startX, startY, initCx, initCy, initCs } = this._drag;
      const dx = px - startX;
      const dy = py - startY;

      let newCx = initCx;
      let newCy = initCy;
      let newCs = initCs;

      if (mode === 'resize') {
        switch (handle) {
          case 'br':
            newCs = initCs + ((Math.abs(dx) > Math.abs(dy)) ? dx : dy);
            break;
          case 'bl':
            newCs = initCs + ((Math.abs(dx) > Math.abs(dy)) ? (-dx) : dy);
            newCx = (initCx + initCs) - newCs;
            break;
          case 'tr':
            newCs = initCs + ((Math.abs(dx) > Math.abs(dy)) ? dx : (-dy));
            newCy = (initCy + initCs) - newCs;
            break;
          case 'tl':
            newCs = initCs + ((Math.abs(dx) > Math.abs(dy)) ? (-dx) : (-dy));
            newCx = (initCx + initCs) - newCs;
            newCy = (initCy + initCs) - newCs;
            break;
          case 'right':
            newCs = initCs + dx;
            break;
          case 'left':
            newCs = initCs - dx;
            newCx = initCx + dx;
            break;
          case 'bottom':
            newCs = initCs + dy;
            break;
          case 'top':
            newCs = initCs - dy;
            newCy = initCy + dy;
            break;
        }
      } else {
        newCx = initCx + dx;
        newCy = initCy + dy;
      }

      const { ix, iy, iw, ih } = this.data;
      const clamped = this._clampCrop(newCx, newCy, newCs, ix, iy, iw, ih);

      this.setData({
        cx: Math.round(clamped.cx),
        cy: Math.round(clamped.cy),
        cs: Math.round(clamped.cs),
      });
      this._draw();
    },

    onTouchEnd() {
      this._drag = null;
    },

    // ================================================================
    //  确认 / 取消
    // ================================================================

    onCancel() {
      this.triggerEvent('croppercancel');
    },

    onConfirm() {
      const that = this;
      const { _c: c, _ctx: ctx, _img: img } = this;
      if (!c || !ctx || !img) {
        wx.showToast({ title: '裁剪失败', icon: 'none' });
        return;
      }

      const { cx, cy, cs, ix, iy, iw, ih } = this.data;
      const scale = img.width / iw;
      const ow = Math.round(cs * scale);

      wx.showLoading({ title: '裁剪中...' });

      const W = CANVAS_SIZE;
      c.width = W * PR;
      c.height = W * PR;
      ctx.scale(PR, PR);
      ctx.clearRect(0, 0, W, W);
      ctx.drawImage(img, ix, iy, iw, ih);

      wx.canvasToTempFilePath({
        x: cx, y: cy, width: cs, height: cs,
        destWidth: ow, destHeight: ow,
        canvas: c, fileType: 'png', quality: 1,
        success(res) {
          wx.hideLoading();
          that.triggerEvent('cropperconfirm', {
            tempFilePath: res.tempFilePath,
            width: ow, height: ow,
          });
        },
        fail(e) {
          wx.hideLoading();
          console.error('[crop] confirm fail:', e);
          wx.showToast({ title: '裁剪失败', icon: 'none' });
        },
      });
    },
  },
});
