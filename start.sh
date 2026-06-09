#!/bin/bash
# =============================================================================
# start.sh —— 一键启动：Flask 后端 + Cloudflare Tunnel 公网隧道
# =============================================================================
# 使用方式: bash start.sh
# 功能:
#   1. 自动启动 Flask 后端 (python server.py)
#   2. 自动启动 cloudflared 隧道，将本地端口 5001 暴露到公网
#   3. 自动获取公网 URL 并写入 utils/api_config.js
#   4. 所有日志实时打印在终端
# =============================================================================

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  🚀 印章处理器 - 一键启动脚本${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

# ===== Step 1: 检查依赖 =====

# 检查 Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}[❌] 未找到 python3，请先安装 Python${NC}"
    exit 1
fi
echo -e "${GREEN}[✅] python3 已安装${NC}"

# 检查 cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo -e "${YELLOW}[⚠️] 未找到 cloudflared，正在安装...${NC}"
    brew install cloudflared 2>&1 || {
        echo -e "${RED}[❌] cloudflared 安装失败，请手动执行: brew install cloudflared${NC}"
        exit 1
    }
    echo -e "${GREEN}[✅] cloudflared 安装完成${NC}"
else
    echo -e "${GREEN}[✅] cloudflared 已安装 ($(cloudflared --version 2>&1 | head -1))${NC}"
fi

# 检查 Flask 依赖
if ! python3 -c "import flask" 2>/dev/null; then
    echo -e "${YELLOW}[⚠️] 正在安装 Flask 依赖...${NC}"
    pip3 install flask pillow 2>&1 | tail -1
    echo -e "${GREEN}[✅] Flask 依赖已安装${NC}"
fi

echo ""

# ===== Step 2: 清理旧进程 =====
echo -e "${YELLOW}[🔄] 清理旧进程...${NC}"

# 清理旧 Flask 进程
OLD_FLASK=$(lsof -ti:5001 2>/dev/null || true)
if [ -n "$OLD_FLASK" ]; then
    kill -9 $OLD_FLASK 2>/dev/null || true
    sleep 1
    echo -e "${GREEN}[✅] 已清理旧 Flask 进程${NC}"
fi

# 清理旧 cloudflared 进程
OLD_CLOUDFLARED=$(pgrep -f "cloudflared.*tunnel" 2>/dev/null || true)
if [ -n "$OLD_CLOUDFLARED" ]; then
    kill -9 $OLD_CLOUDFLARED 2>/dev/null || true
    sleep 1
    echo -e "${GREEN}[✅] 已清理旧 cloudflared 进程${NC}"
fi

echo ""

# ===== Step 3: 启动 Flask 后端 =====
echo -e "${YELLOW}[🔄] 启动 Flask 后端 (端口 5001)...${NC}"
cd "$PROJECT_DIR"
python3 server.py &
FLASK_PID=$!
echo -e "${GREEN}[✅] Flask 后端已启动 (PID: $FLASK_PID)${NC}"

# 等待 Flask 启动
sleep 2

# 验证 Flask 是否正常运行
if ! kill -0 $FLASK_PID 2>/dev/null; then
    echo -e "${RED}[❌] Flask 后端启动失败，请检查错误信息${NC}"
    exit 1
fi
echo -e "${GREEN}[✅] Flask 健康检查 OK${NC}"
echo ""

# ===== Step 4: 启动 Cloudflare Tunnel =====
echo -e "${YELLOW}[🔄] 启动 Cloudflare Tunnel...${NC}"
echo -e "${YELLOW}[⏳] 正在获取公网地址，请稍候（约 5-10 秒）...${NC}"

# 启动 cloudflared，捕获日志到临时文件
TMP_LOG=$(mktemp)
cloudflared tunnel --url localhost:5001 --no-autoupdate > "$TMP_LOG" 2>&1 &
CLOUDFLARED_PID=$!

# 等待隧道建立并提取公网 URL
TUNNEL_URL=""
for i in $(seq 1 15); do
    sleep 1
    TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TMP_LOG" 2>/dev/null | head -1) || true
    if [ -n "$TUNNEL_URL" ]; then
        break
    fi
done

if [ -z "$TUNNEL_URL" ]; then
    echo -e "${RED}[❌] 无法获取 Cloudflare Tunnel 公网地址${NC}"
    echo -e "${YELLOW}[ℹ️]  请检查网络连接，或手动运行: cloudflared tunnel --url localhost:5001${NC}"
    echo -e "${YELLOW}[ℹ️]  日志内容:${NC}"
    cat "$TMP_LOG"
    kill $FLASK_PID 2>/dev/null || true
    kill $CLOUDFLARED_PID 2>/dev/null || true
    rm -f "$TMP_LOG"
    exit 1
fi

echo -e "${GREEN}[✅] Cloudflare Tunnel 已启动 (PID: $CLOUDFLARED_PID)${NC}"
echo -e "${GREEN}[🌐] 公网地址: ${CYAN}$TUNNEL_URL${NC}"
echo ""

# ===== Step 5: 更新 API 配置文件 =====
echo -e "${YELLOW}[🔄] 更新前端 API 配置文件...${NC}"

# 写入新的 API 配置
cat > "$PROJECT_DIR/utils/api_config.js" << EOF
// =============================================================================
// API 地址统一配置文件
// =============================================================================
// 由 start.sh 脚本自动更新，请勿手动修改
// 格式: 'http://IP:端口' 或 'https://xxx.trycloudflare.com'
// =============================================================================
const API_BASE = '${TUNNEL_URL}';

module.exports = {
  API_BASE: API_BASE,
};
EOF

echo -e "${GREEN}[✅] 已更新 utils/api_config.js -> ${CYAN}${TUNNEL_URL}${NC}"
echo ""

# ===== 完成 =====
echo -e "${CYAN}============================================${NC}"
echo -e "${GREEN}  🎉 全部服务已启动！${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo -e "  ${GREEN}Flask 后端:${NC}        http://localhost:5001"
echo -e "  ${GREEN}公网地址:${NC}          ${CYAN}${TUNNEL_URL}${NC}"
echo -e "  ${GREEN}小程序 API:${NC}        已自动配置为公网地址"
echo ""
echo -e "  ${YELLOW}⚠️  重要提示:${NC}"
echo -e "  ${YELLOW}  每次重启此脚本，公网地址都会变化！${NC}"
echo -e "  ${YELLOW}  如果你重新编译小程序，请确保 start.sh 正在运行${NC}"
echo ""
echo -e "  ${YELLOW}按 Ctrl+C 停止所有服务${NC}"
echo ""

# ===== 清理函数 =====
cleanup() {
    echo ""
    echo -e "${YELLOW}[🔄] 正在停止所有服务...${NC}"
    kill $FLASK_PID 2>/dev/null || true
    kill $CLOUDFLARED_PID 2>/dev/null || true
    rm -f "$TMP_LOG"
    echo -e "${GREEN}[✅] 所有服务已停止${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# 持续输出 cloudflared 日志
echo -e "${YELLOW}[📋] Cloudflare Tunnel 实时日志:${NC}"
echo -e "${YELLOW}----------------------------------------${NC}"
tail -f "$TMP_LOG" &
TAIL_PID=$!

# 等待任一子进程结束
wait $FLASK_PID $CLOUDFLARED_PID 2>/dev/null || true

# 清理
kill $TAIL_PID 2>/dev/null || true
rm -f "$TMP_LOG"
cleanup
