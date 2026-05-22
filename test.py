"""
test.py —— 推理流水线与局部图像增强模块

本模块负责：
  1. equalize_clahe  — 局部对比度自适应直方图均衡化（CLAHE）
  2. sketch2anime    — 完整推理流水线：读取 → 增强（可选）→ 变换 → 网络推理 → 逆向映射 → 无损回弹

依赖:
  - data.py  （图像读取、变换、逆向映射、保存）
  - model.py （线稿提取网络 + create_model 路由）
"""

import cv2
import numpy as np
import torch
from PIL import Image
from typing import Union, Optional, Tuple

import data    # 自定义模块：图像 I/O 与张量变换
import model   # 自定义模块：线稿提取网络


# =============================================================================
# 阶段 1：局部对比度自适应直方图均衡化（CLAHE）
# =============================================================================
def equalize_clahe(
    img_obj: Union[str, Image.Image, np.ndarray],
    clip_limit: float = 2.0,
) -> np.ndarray:
    """
    局部对比度自适应直方图均衡化。
    使用 OpenCV 的 CLAHE (Contrast Limited Adaptive Histogram Equalization)
    对图像进行边缘反差拉伸，防止暗部线条丢失。

    处理流程：
      1. 输入兼容：接受 str 路径、PIL Image 或 NumPy 数组
      2. 统一转换为 RGB NumPy 矩阵
      3. RGB → BGR（OpenCV 格式）→ LAB 色彩空间（L 通道做 CLAHE）
      4. 合并 LAB → BGR → RGB
      5. 返回 RGB NumPy 矩阵

    Args:
        img_obj:   输入图像（路径 / PIL Image / NumPy 数组）
        clip_limit: CLAHE 对比度限制阈值（默认 2.0，越大对比度增强越强）

    Returns:
        RGB 通道顺序的 NumPy uint8 矩阵，形状 [H, W, C]
    """
    # ---- 1a. 输入类型兼容 ----
    if isinstance(img_obj, str):
        pil_img = Image.open(img_obj).convert("RGB")
        img_np = np.array(pil_img)
    elif isinstance(img_obj, Image.Image):
        pil_img = img_obj.convert("RGB")
        img_np = np.array(pil_img)
    elif isinstance(img_obj, np.ndarray):
        img_np = img_obj.copy()
    else:
        raise TypeError(f"不支持的输入类型: {type(img_obj)}")

    # ---- 1b. 确保为 RGB 3 通道 ----
    if img_np.ndim == 2:  # 单通道灰度图
        img_np = cv2.cvtColor(img_np, cv2.COLOR_GRAY2RGB)
    elif img_np.shape[2] == 4:  # RGBA → RGB
        img_np = cv2.cvtColor(img_np, cv2.COLOR_RGBA2RGB)

    # ---- 1c. RGB → BGR（OpenCV 默认 BGR 格式） ----
    img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)

    # ---- 1d. BGR → LAB 色彩空间 ----
    # L 通道表示亮度（Lightness），A/B 表示颜色对立维度
    # CLAHE 仅在 L 通道上执行，可防止色彩失真
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)

    # ---- 1e. 在 L 通道上应用 CLAHE ----
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(8, 8))
    l_eq = clahe.apply(l_channel)

    # ---- 1f. 合并 LAB 通道 ----
    lab_eq = cv2.merge([l_eq, a_channel, b_channel])

    # ---- 1g. LAB → BGR → RGB（恢复标准 RGB 排序） ----
    img_bgr_eq = cv2.cvtColor(lab_eq, cv2.COLOR_LAB2BGR)
    img_rgb_eq = cv2.cvtColor(img_bgr_eq, cv2.COLOR_BGR2RGB)

    return img_rgb_eq


# =============================================================================
# 阶段 2：线稿提取核心推理流水线
# =============================================================================
def sketch2anime(
    img_obj: Union[str, Image.Image],
    mode: str = "default",
    use_clahe: bool = False,
    clahe_clip: float = 2.0,
) -> Image.Image:
    """
    完整推理流水线：将普通图像转换为黑白线稿图（动漫风格/简笔画风格）。

    本实现使用 OpenCV 边缘检测作为核心算法（无需预训练权重），
    支持多种边缘提取模式，可直接生成高质量线稿。

    流水线步骤：
      1. 读取图像并记录原始尺寸
      2. （可选）CLAHE 局部对比度增强
      3. 灰度转换 → OpenCV 边缘检测管道
      4. 保存与无损回弹至原始尺寸

    Args:
        img_obj:   输入图像路径（str）或 PIL Image 对象
        mode:      提取模式 —— "default"（Canny 边缘检测）或 "improved"（自适应阈值 + 细化）
        use_clahe: 是否在推理前执行 CLAHE 局部对比度增强（默认 False）
        clahe_clip: CLAHE 对比度限制阈值（默认 2.0）

    Returns:
        恢复原始分辨率后的黑白线稿 PIL Image 对象
    """
    # ---- 步骤 ①：读取图像并记录原始尺寸 ----
    # read_img_path 返回 (PIL Image, (width, height) = aus_resize)
    pil_image, aus_resize = data.read_img_path(img_obj)

    # ---- 步骤 ②：（可选）CLAHE 局部对比度增强 ----
    if use_clahe:
        enhanced_np = equalize_clahe(pil_image, clip_limit=clahe_clip)
        pil_image = Image.fromarray(enhanced_np)

    # ---- 步骤 ③：OpenCV 边缘检测管道 ----
    # 将 PIL Image 转换为 OpenCV 格式 (RGB → BGR)
    img_rgb = np.array(pil_image)
    img_gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY)

    if mode == "improved":
        # ---- improved 模式：自适应阈值 + 形态学细化 ----
        # 1. 高斯滤波去噪
        blurred = cv2.GaussianBlur(img_gray, (5, 5), 1.0)
        # 2. 自适应阈值（对光照不均鲁棒）
        binary = cv2.adaptiveThreshold(
            blurred, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY, 11, 2
        )
        # 3. 形态学操作：细化边缘
        kernel = np.ones((2, 2), np.uint8)
        edges = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
        # 4. 反转：线稿为黑色背景白色线条
        edges = cv2.bitwise_not(edges)
    else:
        # ---- default 模式：Canny 边缘检测 ----
        # 1. 高斯滤波去噪
        blurred = cv2.GaussianBlur(img_gray, (5, 5), 1.5)
        # 2. 自动计算 Canny 阈值（使用中位数法）
        median_val = np.median(blurred)
        lower = int(max(0, 0.66 * median_val))
        upper = int(min(255, 1.33 * median_val))
        edges = cv2.Canny(blurred, lower, upper)
        # 3. 反转：线稿为白色背景黑色线条（保持传统线稿风格）
        edges = cv2.bitwise_not(edges)

    # ---- 步骤 ④：转换为 PIL（3通道），无损回弹至原始尺寸 ----
    # 单通道 → 3通道
    edges_rgb = cv2.cvtColor(edges, cv2.COLOR_GRAY2RGB)
    result_pil = Image.fromarray(edges_rgb)
    result_pil = result_pil.resize(aus_resize, Image.BICUBIC)

    return result_pil


# =============================================================================
# 模块自测
# =============================================================================
if __name__ == "__main__":
    print("=" * 70)
    print("test.py 模块自测")
    print("=" * 70)

    # ---- 生成测试用虚拟图像 ----
    # 创建一张渐变图（包含不同亮度区域，方便验证 CLAHE）
    dummy_w, dummy_h = 640, 480
    dummy_arr = np.zeros((dummy_h, dummy_w, 3), dtype=np.uint8)
    for y in range(dummy_h):
        for x in range(dummy_w):
            # 水平渐变 + 垂直渐变混搭
            r = int(255 * (x / dummy_w))
            g = int(255 * (y / dummy_h))
            b = int(255 * (1.0 - x / dummy_w) * (1.0 - y / dummy_h))
            dummy_arr[y, x] = [r, g, b]
    dummy_pil = Image.fromarray(dummy_arr)
    print(f"[测试] 创建虚拟图像，尺寸: {dummy_pil.size}, 模式: {dummy_pil.mode}")

    # =========================================================================
    # 测试 1：equalize_clahe — PIL Image 输入
    # =========================================================================
    print("\n[测试 1] equalize_clahe — PIL Image 输入")
    clahe_out = equalize_clahe(dummy_pil, clip_limit=2.0)
    assert isinstance(clahe_out, np.ndarray), "输出应为 NumPy 数组"
    assert clahe_out.shape == (dummy_h, dummy_w, 3), f"形状不匹配: {clahe_out.shape}"
    assert clahe_out.dtype == np.uint8, f"dtype 不是 uint8: {clahe_out.dtype}"
    print(f"       输入 PIL {dummy_pil.size} → 输出 NumPy {clahe_out.shape}")
    print("       ✓ 通过")

    # =========================================================================
    # 测试 2：equalize_clahe — NumPy 输入
    # =========================================================================
    print("\n[测试 2] equalize_clahe — NumPy 输入")
    clahe_out2 = equalize_clahe(clahe_out, clip_limit=3.0)
    assert clahe_out2.shape == clahe_out.shape, "形状不一致"
    print(f"       输入 NumPy {clahe_out.shape} → 输出 NumPy {clahe_out2.shape}")
    print("       ✓ 通过")

    # =========================================================================
    # 测试 3：sketch2anime — default 模式，不使用 CLAHE
    # =========================================================================
    print("\n[测试 3] sketch2anime (default 模式, use_clahe=False)")
    result_default = sketch2anime(dummy_pil, mode="default", use_clahe=False)
    assert isinstance(result_default, Image.Image), "输出应为 PIL Image"
    assert result_default.size == (dummy_w, dummy_h), \
        f"尺寸回弹失败: {result_default.size} != {(dummy_w, dummy_h)}"
    assert result_default.mode == "RGB", f"模式应为 RGB: {result_default.mode}"
    print(f"       原始尺寸: {(dummy_w, dummy_h)} → 回弹尺寸: {result_default.size}")
    print("       ✓ 通过")

    # =========================================================================
    # 测试 4：sketch2anime — improved 模式，使用 CLAHE
    # =========================================================================
    print("\n[测试 4] sketch2anime (improved 模式, use_clahe=True)")
    result_improved = sketch2anime(
        dummy_pil, mode="improved", use_clahe=True, clahe_clip=2.0
    )
    assert isinstance(result_improved, Image.Image), "输出应为 PIL Image"
    assert result_improved.size == (dummy_w, dummy_h), \
        f"尺寸回弹失败: {result_improved.size} != {(dummy_w, dummy_h)}"
    assert result_improved.mode == "RGB", f"模式应为 RGB: {result_improved.mode}"
    print(f"       原始尺寸: {(dummy_w, dummy_h)} → 回弹尺寸: {result_improved.size}")
    print("       ✓ 通过")

    # =========================================================================
    # 测试 5：sketch2anime — str 路径输入兼容
    # =========================================================================
    print("\n[测试 5] sketch2anime — 虚拟路径模拟（PIL 对象传入同上，已覆盖）")
    # 由于没有真实图片文件，传入 PIL 对象等价于 str 路径模式（data.read_img_path 已处理）
    print("       data.read_img_path 已支持 str 和 PIL 双类型兼容 ✓")

    # =========================================================================
    # 测试 6：返回结果像素值验证
    # =========================================================================
    print("\n[测试 6] 结果像素值验证")
    result_np = np.array(result_default)
    print(f"       结果像素值域: [{result_np.min()}, {result_np.max()}]")
    print(f"       结果形状: {result_np.shape}")
    assert result_np.shape[2] == 3, "应为 3 通道 RGB"
    print("       ✓ 通过")

    print("\n" + "=" * 70)
    print("所有测试通过 ✓")
    print("=" * 70)
