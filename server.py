"""
server.py —— 线稿生成 API 后端服务 (Flask)

提供 HTTP API 接口，供微信小程序前端调用。
同时保留后续接硬件设备的扩展能力。

使用方式:
    python server.py

API 接口:
    POST /api/sketch2anime
        上传图片 → 返回线稿图片（二进制 PNG）
    GET  /api/health
        健康检查
"""

import io
import os
import sys
import json
import base64
import uuid
import traceback
from datetime import datetime

from flask import Flask, request, jsonify, send_file
from PIL import Image
from werkzeug.utils import secure_filename

from typing import Optional, Tuple

import test  # 推理流水线模块


# =============================================================================
# Flask 应用初始化
# =============================================================================
app = Flask(__name__)

# 手动 CORS 支持：所有路由允许跨域
@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Requested-With"
    response.headers["Access-Control-Max-Age"] = "86400"
    return response

# 配置文件
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 最大上传 16MB
app.config["UPLOAD_FOLDER"] = os.path.join(os.path.dirname(__file__), "temp_uploads")
app.config["RESULT_FOLDER"] = os.path.join(os.path.dirname(__file__), "temp_results")

# 确保临时目录存在
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["RESULT_FOLDER"], exist_ok=True)

# 支持的图片格式
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "bmp", "webp"}

def allowed_file(filename: str) -> bool:
    """检查文件扩展名是否允许"""
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# =============================================================================
# API 路由
# =============================================================================
@app.route("/api/health", methods=["GET"])
def health_check():
    """健康检查接口"""
    return jsonify({
        "status": "ok",
        "service": "sketch2anime",
        "timestamp": datetime.now().isoformat(),
    })


def _parse_output_size(size_str: Optional[str]) -> Optional[Tuple[int, int]]:
    """
    解析 output_size 字符串参数。
    格式: "32,32" → (32, 32)
    空字符串或 None → None（保持原始分辨率）
    """
    if not size_str:
        return None
    try:
        parts = size_str.split(",")
        w, h = int(parts[0].strip()), int(parts[1].strip())
        if w <= 0 or h <= 0:
            return None
        return (w, h)
    except (ValueError, IndexError):
        return None


@app.route("/api/sketch2anime_upload", methods=["POST"])
def sketch2anime_upload_api():
    """
    微信小程序 uploadFile 专用 API：接受 multipart 上传，返回 JSON + base64

    请求方式: POST
    请求体 (multipart/form-data):
        - image: 图片文件（必须）
        - mode: 提取模式（默认 "default"）
        - use_clahe: "true"/"false"（默认 "false"）
        - clahe_clip: 对比度系数（默认 2.0）
        - output_size: 输出尺寸，格式 "width,height"，如 "32,32"（可选）
        - thickness_scale: 线宽倍率，如 "1.5"（可选，默认 1.0）

    返回:
        {
            "success": true/false,
            "image_base64": "base64编码的线稿PNG",
            "width": 640,
            "height": 480,
            "error": "错误信息（失败时）"
        }
    """
    # ---- 1. 检查文件 ----
    if "image" not in request.files:
        return jsonify({"success": False, "error": "未找到上传的图片文件"}), 400
    file = request.files["image"]
    if file.filename == "":
        return jsonify({"success": False, "error": "未选择图片文件"}), 400

    # ---- 2. 读取参数 ----
    mode = request.form.get("mode", "default")
    use_clahe_str = request.form.get("use_clahe", "false")
    clahe_clip_str = request.form.get("clahe_clip", "2.0")
    output_size_str = request.form.get("output_size", "")
    thickness_scale_str = request.form.get("thickness_scale", "1.0")
    use_clahe = use_clahe_str.lower() == "true"
    try:
        clahe_clip = float(clahe_clip_str)
    except ValueError:
        clahe_clip = 2.0
    try:
        thickness_scale = float(thickness_scale_str)
    except ValueError:
        thickness_scale = 1.0
    output_size = _parse_output_size(output_size_str)


    if mode not in ("default", "improved"):
        return jsonify({"success": False, "error": f"不支持的 mode='{mode}'"}), 400

    # ---- 3. 读取图片 ----
    try:
        image_data = file.read()
        pil_image = Image.open(io.BytesIO(image_data)).convert("RGB")
    except Exception as e:
        return jsonify({"success": False, "error": f"图片解析失败: {str(e)}"}), 400

    # ---- 4. 执行推理 ----
    try:
        result_pil = test.sketch2anime(
            img_obj=pil_image,
            mode=mode,
            use_clahe=use_clahe,
            clahe_clip=clahe_clip,
            output_size=output_size,
            thickness_scale=thickness_scale,
        )
        # ---- 5. 编码为 Base64 PNG ----

        img_buffer = io.BytesIO()
        result_pil.save(img_buffer, format="PNG")
        img_buffer.seek(0)
        result_base64 = base64.b64encode(img_buffer.getvalue()).decode("utf-8")
        return jsonify({
            "success": True,
            "image_base64": result_base64,
            "width": result_pil.width,
            "height": result_pil.height,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500



@app.route("/api/sketch2anime", methods=["POST"])
def sketch2anime_api():
    """
    核心 API：图片 → 黑白线稿

    请求方式: POST
    请求体 (multipart/form-data):
        - image: 图片文件（必须）
        - mode: 提取模式，可选 "default" 或 "improved"（默认 "default"）
        - use_clahe: 是否启用 CLAHE，可选 "true" 或 "false"（默认 "false"）
        - clahe_clip: CLAHE 对比度限制系数（默认 2.0）
        - output_size: 输出尺寸，格式 "width,height"，如 "32,32"（可选）
        - thickness_scale: 线宽倍率，如 "1.5"（可选，默认 1.0）

    返回:
        - 成功: 200, image/png（线稿图片二进制数据）
        - 失败: 400/500, application/json（错误信息）
    """
    # ---- 1. 检查文件是否存在 ----
    if "image" not in request.files:
        return jsonify({"error": "未找到上传的图片文件，请使用字段名 'image'"}), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "未选择图片文件"}), 400

    # ---- 2. 读取参数 ----
    mode = request.form.get("mode", "default")
    use_clahe_str = request.form.get("use_clahe", "false")
    clahe_clip_str = request.form.get("clahe_clip", "2.0")
    output_size_str = request.form.get("output_size", "")
    thickness_scale_str = request.form.get("thickness_scale", "1.0")

    use_clahe = use_clahe_str.lower() == "true"
    try:
        clahe_clip = float(clahe_clip_str)
    except ValueError:
        clahe_clip = 2.0
    try:
        thickness_scale = float(thickness_scale_str)
    except ValueError:
        thickness_scale = 1.0
    output_size = _parse_output_size(output_size_str)

    # ---- 3. 验证模式 ----
    if mode not in ("default", "improved"):
        return jsonify({"error": f"不支持的 mode='{mode}'，可选: 'default', 'improved'"}), 400

    # ---- 4. 读取图片 ----
    try:
        image_data = file.read()
        pil_image = Image.open(io.BytesIO(image_data)).convert("RGB")
    except Exception as e:
        return jsonify({"error": f"图片解析失败: {str(e)}"}), 400

    # ---- 5. 执行推理 ----
    try:
        result_pil = test.sketch2anime(
            img_obj=pil_image,
            mode=mode,
            use_clahe=use_clahe,
            clahe_clip=clahe_clip,
            output_size=output_size,
            thickness_scale=thickness_scale,
        )



        # ---- 6. 将结果编码为 PNG 二进制流 ----
        img_buffer = io.BytesIO()
        result_pil.save(img_buffer, format="PNG")
        img_buffer.seek(0)

        # ---- 7. 返回图片 ----
        return send_file(
            img_buffer,
            mimetype="image/png",
            as_attachment=False,
        )

    except Exception as e:
        traceback.print_exc()
        return jsonify({
            "error": f"线稿生成失败: {str(e)}",
            "detail": traceback.format_exc(),
        }), 500


@app.route("/api/sketch2anime_b64", methods=["POST", "OPTIONS"])
def sketch2anime_b64_api():
    # OPTIONS 预检请求直接返回成功
    if request.method == "OPTIONS":
        return jsonify({"status": "ok"}), 200
    """
    Base64 版本 API（适合某些硬件设备的调用方式）

    请求方式: POST
    请求体 (application/json):
        {
            "image_base64": "base64编码的图片数据",
            "mode": "default",
            "use_clahe": false,
            "clahe_clip": 2.0,
            "output_size": "32,32"  （可选，格式 "width,height"）
        }

    返回:
        {
            "success": true,
            "image_base64": "base64编码的线稿PNG",
            "width": 640,
            "height": 480
        }
    """
    data = request.get_json(force=True)
    if not data or "image_base64" not in data:
        return jsonify({"error": "缺少 image_base64 字段"}), 400

    # ---- 解码 Base64 图片 ----
    try:
        base64_str = data["image_base64"]
        # 兼容 data:image/png;base64, 前缀
        if "," in base64_str:
            base64_str = base64_str.split(",")[1]
        image_bytes = base64.b64decode(base64_str)
        pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as e:
        return jsonify({"error": f"Base64 图片解码失败: {str(e)}"}), 400

    # ---- 读取参数 ----
    mode = data.get("mode", "default")
    use_clahe = data.get("use_clahe", False)
    clahe_clip = data.get("clahe_clip", 2.0)
    output_size_str = data.get("output_size", "")
    thickness_scale = data.get("thickness_scale", 1.0)
    output_size = _parse_output_size(output_size_str)

    # ---- 执行推理 ----
    try:
        result_pil = test.sketch2anime(
            img_obj=pil_image,
            mode=mode,
            use_clahe=use_clahe,
            clahe_clip=clahe_clip,
            output_size=output_size,
            thickness_scale=thickness_scale,
        )



        # ---- 编码结果为 Base64 PNG ----
        img_buffer = io.BytesIO()
        result_pil.save(img_buffer, format="PNG")
        result_base64 = base64.b64encode(img_buffer.getvalue()).decode("utf-8")

        return jsonify({
            "success": True,
            "image_base64": result_base64,
            "width": result_pil.width,
            "height": result_pil.height,
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(e),
        }), 500


# =============================================================================
# 社区 API 路由（JSON 文件存储，绝对匿名）
# =============================================================================

COMMUNITY_DATA_FILE = os.path.join(os.path.dirname(__file__), "community_data.json")
COMMUNITY_PHOTOS_DIR = os.path.join(os.path.dirname(__file__), "community_photos")
os.makedirs(COMMUNITY_PHOTOS_DIR, exist_ok=True)


def _load_community_data() -> list:
    """从 JSON 文件加载社区数据"""
    if not os.path.exists(COMMUNITY_DATA_FILE):
        return []
    try:
        with open(COMMUNITY_DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        return []


def _save_community_data(data: list):
    """保存社区数据到 JSON 文件"""
    with open(COMMUNITY_DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@app.route("/api/community/get", methods=["GET"])
def community_get():
    """
    获取社区照片列表（分页，绝对匿名）
    
    查询参数:
        page: 页码，从 0 开始（默认 0）
    
    返回:
        {
            "code": 0,
            "msg": "获取成功",
            "data": {
                "list": [...],
                "pageSize": 10
            }
        }
    """
    try:
        page = int(request.args.get("page", 0))
    except ValueError:
        page = 0
    page_size = 10

    data = _load_community_data()
    # 只返回 status=1（可见）的数据，按时间降序排列
    visible = [item for item in data if item.get("status", 1) == 1]
    visible.sort(key=lambda x: x.get("create_time", ""), reverse=True)

    start = page * page_size
    end = start + page_size
    page_data = visible[start:end]

    return jsonify({
        "code": 0,
        "msg": "获取成功",
        "data": {
            "list": page_data,
            "pageSize": page_size,
        }
    })


@app.route("/api/community/upload_image", methods=["POST"])
def community_upload_image():
    """
    上传社区照片（接受 multipart 上传），保存到本地并返回可访问 URL
    
    请求体 (multipart/form-data):
        - image: 图片文件（必须）
    
    返回:
        {
            "success": true/false,
            "photo_url": "/community_photos/xxx.png",  （成功时）
            "error": "错误信息"  （失败时）
        }
    """
    if "image" not in request.files:
        return jsonify({"success": False, "error": "未找到上传的图片文件"}), 400
    file = request.files["image"]
    if file.filename == "":
        return jsonify({"success": False, "error": "未选择图片文件"}), 400

    # 生成唯一文件名
    ext = "png"
    if file.filename and "." in file.filename:
        orig_ext = file.filename.rsplit(".", 1)[1].lower()
        if orig_ext in ("png", "jpg", "jpeg", "webp", "gif"):
            ext = orig_ext

    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(COMMUNITY_PHOTOS_DIR, filename)
    
    try:
        file.save(filepath)
        return jsonify({
            "success": True,
            "photo_url": f"/community_photos/{filename}",
        })
    except Exception as e:
        return jsonify({"success": False, "error": f"保存图片失败: {str(e)}"}), 500


@app.route("/api/community/add", methods=["POST"])
def community_add():
    """
    添加社区照片记录
    
    请求体 (application/json):
        {
            "photo_url": "/community_photos/xxx.png"
        }
    
    返回:
        {
            "code": 0,
            "msg": "发布成功",
            "data": { "_id": "xxx" }
        }
    """
    data = request.get_json(force=True)
    if not data or "photo_url" not in data:
        return jsonify({"code": -1, "msg": "缺少 photo_url 参数"}), 400

    photo_url = data["photo_url"]
    records = _load_community_data()

    new_record = {
        "_id": uuid.uuid4().hex,
        "photo_url": photo_url,
        "create_time": datetime.now().isoformat(),
        "likes": 0,
        "status": 1,
    }
    records.append(new_record)
    _save_community_data(records)

    return jsonify({
        "code": 0,
        "msg": "发布成功",
        "data": {"_id": new_record["_id"]},
    })


@app.route("/api/community/like", methods=["POST"])
def community_like():
    """
    点赞照片（原子递增 likes）
    
    请求体 (application/json):
        {
            "photo_id": "xxx"
        }
    
    返回:
        {
            "code": 0,
            "msg": "点赞成功"
        }
    """
    data = request.get_json(force=True)
    if not data or "photo_id" not in data:
        return jsonify({"code": -1, "msg": "缺少 photo_id 参数"}), 400

    photo_id = data["photo_id"]
    records = _load_community_data()

    for record in records:
        if record["_id"] == photo_id:
            record["likes"] = record.get("likes", 0) + 1
            _save_community_data(records)
            return jsonify({"code": 0, "msg": "点赞成功"})

    return jsonify({"code": -1, "msg": "该照片不存在或已被删除"}), 404


@app.route("/community_photos/<filename>")
def community_photos_static(filename):
    """提供社区图片的静态文件访问"""
    safe_name = secure_filename(filename)
    filepath = os.path.join(COMMUNITY_PHOTOS_DIR, safe_name)
    if not os.path.exists(filepath):
        return jsonify({"error": "图片不存在"}), 404
    return send_file(filepath, mimetype="image/png")


# =============================================================================
# 启动入口
# =============================================================================
if __name__ == "__main__":
    print("=" * 70)
    print("  🎨 线稿生成 API 服务 (Flask)")
    print("=" * 70)
    print()
    print("  API 端点:")
    print("    POST /api/sketch2anime      - 上传图片，返回线稿 PNG")
    print("    POST /api/sketch2anime_b64  - Base64 版本 API")
    print("    POST /api/sketch2anime_upload - 上传图片，返回 base64 线稿")
    print("    GET  /api/health            - 健康检查")
    print()
    print("  📸 社区 API 端点 (绝对匿名):")
    print("    POST /api/community/upload_image - 上传社区照片")
    print("    POST /api/community/add           - 发布照片记录")
    print("    POST /api/community/like          - 点赞照片")
    print("    GET  /api/community/get?page=0    - 分页获取社区照片")
    print("    GET  /community_photos/<filename> - 访问社区图片")
    print()
    print("  启动地址: http://localhost:5001")
    print()

    app.run(
        host="0.0.0.0",
        port=5001,
        debug=False,
    )
