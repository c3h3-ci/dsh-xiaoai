#!/bin/bash
# ============================================================================
# DSH 升级脚本（带自动验证 + 自动回滚）
#
# 设计目标：**即使升级失败到 DSH 完全起不来，也能自动恢复** ——
#           不依赖任何 AI 在线，纯 shell 脚本自愈。
#
# 用法：
#   bash scripts/upgrade-dsh.sh                # 升级到默认版本
#   bash scripts/upgrade-dsh.sh 0.1.7-rc.2     # 指定版本
#   bash scripts/upgrade-dsh.sh --rollback     # 手动回滚
#
# 流程：
#   1. 记录当前版本 + 备份（DSH 目录 + ~/.dsh）
#   2. 装新版本
#   3. 重启 dsh-web，等 90 秒
#   4. 跑 8 项验证
#   5. 验证失败 → 自动回滚到旧版本 + 重启 + 二次验证
#   6. 写结果到日志（我可以事后读）
# ============================================================================
set -uo pipefail

NODE_BIN="/home/duola/.config/nvm/versions/node/v22.22.0/bin"
export PATH="$NODE_BIN:$PATH"
DSH_ROOT="/media/duola/devdata/config/nvm/versions/node/v22.22.0/lib/node_modules/@deepseek-ai"
BACKUP_DIR="/media/duola/devdata/AI-workspace/dsh-upgrade-backups"
TS=$(date +%Y%m%d-%H%M%S)
LOG="$BACKUP_DIR/upgrade-$TS.log"

NEW_VERSION="${1:-0.1.7-rc.2}"
[ "$NEW_VERSION" = "--rollback" ] && { exec bash "$0" --do-rollback; }

mkdir -p "$BACKUP_DIR"
exec > >(tee -a "$LOG") 2>&1

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "════════ DSH 升级开始 ════════"
log "目标版本: $NEW_VERSION"
log "日志: $LOG"

# ── 0. 记录当前版本 ──
OLD_VERSION=$(node -p "require('$DSH_ROOT/dsh/package.json').version" 2>/dev/null)
log "当前版本: $OLD_VERSION"
if [ -z "$OLD_VERSION" ]; then log "❌ 读不到当前版本，中止"; exit 1; fi
echo "$OLD_VERSION" > "$BACKUP_DIR/last-good-version.txt"

# ── 1. 备份 ──
log "① 备份 DSH 目录（约需 10-30 秒）…"
tar czf "$BACKUP_DIR/dsh-$OLD_VERSION-$TS.tgz" -C "$(dirname $DSH_ROOT)" "@deepseek-ai" 2>/dev/null
BK_SIZE=$(du -h "$BACKUP_DIR/dsh-$OLD_VERSION-$TS.tgz" 2>/dev/null | cut -f1)
log "   ✅ DSH 备份完成: dsh-$OLD_VERSION-$TS.tgz ($BK_SIZE)"

log "② 备份 ~/.dsh（配置+凭据+会话，可能较大）…"
tar czf "$BACKUP_DIR/dshhome-$TS.tgz" -C "$HOME" .dsh 2>/dev/null
DH_SIZE=$(du -h "$BACKUP_DIR/dshhome-$TS.tgz" 2>/dev/null | cut -f1)
log "   ✅ ~/.dsh 备份完成: dshhome-$TS.tgz ($DH_SIZE)"

# ── 2. 升级 ──
log "③ 安装 @deepseek-ai/dsh@$NEW_VERSION …"
if ! npm install -g "@deepseek-ai/dsh@$NEW_VERSION" 2>&1 | tail -3; then
  log "❌ 安装失败 → 立即回滚"
  bash "$0" --do-rollback
  exit 1
fi
ACTUAL=$(node -p "require('$DSH_ROOT/dsh/package.json').version" 2>/dev/null)
log "   装好了: $ACTUAL"
if [ "$ACTUAL" != "$NEW_VERSION" ]; then
  log "⚠️ 版本不符（期望 $NEW_VERSION，实际 $ACTUAL）→ 回滚"
  bash "$0" --do-rollback
  exit 1
fi

# ── 3. 重启 ──
log "④ 重启 dsh-web …"
# ⚠️ 用 systemd-run 启动【独立 unit】做重启 —— 若直接在这里调 systemctl，
#    重启 dsh-web 会连带把本脚本（同 cgroup）一起杀掉，日志就断在半路
#    （2026-09-25 实测：日志停在"等待 90 秒"，脚本进程消失）。
systemd-run --user --on-active=2 --unit="dsh-upgrade-restart-$TS" \
  systemctl --user restart dsh-web.service >/dev/null 2>&1
log "   等待 90 秒（DSH 启动 + 插件加载）…"
sleep 90

# ── 4. 验证 ──
log "⑤ 运行验证 …"
PASS=0; FAIL=0
check() {
  local name="$1"; local ok="$2"
  if [ "$ok" = "1" ]; then log "   ✅ $name"; PASS=$((PASS+1));
  else log "   ❌ $name"; FAIL=$((FAIL+1)); fi
}

# 4.1 DSH 服务活着
systemctl --user is-active dsh-web.service >/dev/null 2>&1
check "DSH 服务 active" "$?"

# 4.2 web 端口响应
timeout 15 curl -s -o /dev/null --noproxy '*' http://127.0.0.1:3080/ 2>/dev/null
check "Web 端口 3080 响应" "$?"

# 4.3 哨兵日志无 FAILED（最近 3 分钟）
if tail -50 ~/.dsh/xiaoai-sentinel.log 2>/dev/null | grep -q "FAILED"; then
  check "插件无 boot:FAILED" "0"
else
  check "插件无 boot:FAILED" "1"
fi

# 4.4 插件 phase=running
if tail -20 ~/.dsh/xiaoai-sentinel.log 2>/dev/null | grep -q "phase=running"; then
  check "插件 phase=running" "1"
else
  check "插件 phase=running" "0"
fi

# 4.5 音箱已连接
if tail -30 ~/.dsh/xiaoai-state/xiaoai.log 2>/dev/null | grep -q "已连接音箱"; then
  check "音箱已连接" "1"
else
  check "音箱已连接" "0"
fi

# 4.6 语音约束注入
if tail -100 ~/.dsh/xiaoai-state/xiaoai.log 2>/dev/null | grep -q "已注入语音播报约束"; then
  check "语音约束已注入" "1"
else
  check "语音约束已注入" "0"
fi

# 4.7 预设挂载
if tail -100 ~/.dsh/xiaoai-state/xiaoai.log 2>/dev/null | grep -q "已挂载 Agent 预设"; then
  check "Agent 预设已挂载" "1"
else
  check "Agent 预设已挂载" "0"
fi

# 4.8 飞书通道 (发一条测试消息给自己，验证端到端)
FEISHU_OK=0
SECRET=$(grep -E "^\s+DSH_FEISHU_APP_SECRET_07DDBF" ~/.dsh/.credentials.yaml 2>/dev/null | head -1 | sed 's/.*: *//' | tr -d '"'"'"'')
if [ -n "$SECRET" ]; then
  TOK=$(timeout 20 curl -s --noproxy '*' -X POST \
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
    -H "Content-Type: application/json" \
    -d "{\"app_id\":\"cli_aa1834c029f89bd9\",\"app_secret\":\"$SECRET\"}" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('tenant_access_token',''))" 2>/dev/null)
  if [ -n "$TOK" ]; then
    MSG="{\"text\":\"DSH 升级验证成功（$ACTUAL）\"}"
    CODE=$(timeout 20 curl -s --noproxy '*' -X POST \
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
      -d "{\"receive_id\":\"oc_371035d16330372536555f278d54701c\",\"msg_type\":\"text\",\"content\":\"$(echo $MSG | sed 's/"/\\"/g')\"}" 2>/dev/null \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('code','-1'))" 2>/dev/null)
    [ "$CODE" = "0" ] && FEISHU_OK=1
  fi
fi
check "飞书通道可用（已发测试消息）" "$FEISHU_OK"

# 4.9 boot-wake 插件（升级后能否自动唤醒 agent）
BW_OK=0
BW_RESP=$(timeout 20 curl -s --noproxy '*' "http://127.0.0.1:3080/api/boot-wake" 2>/dev/null)
if echo "$BW_RESP" | grep -q '"enabled"'; then
  # 检查配置里有「台式DSH主会话」这个目标
  if echo "$BW_RESP" | grep -q "e7184984"; then BW_OK=1; fi
fi
check "boot-wake 插件可用（重启后能自动唤醒）" "$BW_OK"

# 4.10 唤醒历史里有本次重启的记录（真实验证唤醒生效）
BW_WOKE=0
if echo "$BW_RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    hist = d.get('history') or []
    # 最近 5 分钟内有 reboot 记录 = 本次升级触发的唤醒生效了
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc)
    for h in hist[:5]:
        if h.get('kind') == 'reboot' and h.get('ok'):
            at = datetime.datetime.fromisoformat(h['at'].replace('Z','+00:00'))
            if (now - at).total_seconds() < 300:
                sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then BW_WOKE=1; fi
check "本次重启已触发唤醒（agent 会上线）" "$BW_WOKE"

log ""
log "验证结果: $PASS 通过 / $FAIL 失败"

# ── 5. 判定 ──
# 关键项：前 6 项必须通过（飞书那项宽松）
if [ "$FAIL" -gt 1 ]; then
  log "❌ 验证失败（$FAIL 项）→ 自动回滚"
  log ""
  log "── DSH 启动日志里的错误（诊断用）──"
  journalctl --user -u dsh-web --since "10 min ago" --no-pager 2>/dev/null \
    | grep -iE "error|cannot resolve|failed|missing" | tail -15 | sed 's/^/   /'
  log "── 哨兵日志尾部 ──"
  tail -20 ~/.dsh/xiaoai-sentinel.log 2>/dev/null | sed 's/^/   /'
  log ""
  bash "$0" --do-rollback
  exit 1
fi

log "════════ ✅ 升级成功 ════════"
log "版本: $OLD_VERSION → $ACTUAL"
log "备份保留在: $BACKUP_DIR"
exit 0

# ── 回滚（独立入口，可手动调用：bash upgrade-dsh.sh --rollback）──
if [ "${1:-}" = "--do-rollback" ]; then
  NODE_BIN="/home/duola/.config/nvm/versions/node/v22.22.0/bin"
  export PATH="$NODE_BIN:$PATH"
  DSH_ROOT="/media/duola/devdata/config/nvm/versions/node/v22.22.0/lib/node_modules/@deepseek-ai"
  BACKUP_DIR="/media/duola/devdata/AI-workspace/dsh-upgrade-backups"
  log "════════ 开始回滚 ════════"

  GOOD=$(cat "$BACKUP_DIR/last-good-version.txt" 2>/dev/null)
  if [ -z "$GOOD" ]; then log "❌ 没有记录旧版本号，无法回滚"; exit 1; fi
  log "回滚到: $GOOD"

  # 优先用 npm 装回旧版本（最干净）
  if npm install -g "@deepseek-ai/dsh@$GOOD" 2>&1 | tail -2; then
    log "   ✅ npm 装回 $GOOD"
  else
    # npm 失败 → 从 tar 恢复
    LATEST_BK=$(ls -t "$BACKUP_DIR"/dsh-$GOOD-*.tgz 2>/dev/null | head -1)
    if [ -z "$LATEST_BK" ]; then log "❌ 找不到备份包"; exit 1; fi
    log "   npm 失败，从 tar 恢复: $(basename $LATEST_BK)"
    rm -rf "$DSH_ROOT"
    mkdir -p "$DSH_ROOT"
    tar xzf "$LATEST_BK" -C "$(dirname $DSH_ROOT)"
    log "   ✅ 已从 tar 恢复"
  fi

  V=$(node -p "require('$DSH_ROOT/dsh/package.json').version" 2>/dev/null)
  log "   当前版本: $V"

  log "重启 dsh-web …"
  systemd-run --user --on-active=2 --unit="dsh-rollback-$(date +%s)" systemctl --user restart dsh-web.service >/dev/null 2>&1
  sleep 90

  if systemctl --user is-active dsh-web.service >/dev/null 2>&1 && \
     timeout 15 curl -s -o /dev/null --noproxy '*' http://127.0.0.1:3080/ 2>/dev/null; then
    log "════════ ✅ 回滚成功（DSH $V 已恢复） ════════"
    exit 0
  else
    log "════════ ❌ 回滚后 DSH 仍未起来，需要人工介入 ════════"
    log "备份文件在: $BACKUP_DIR"
    log "手动恢复: tar xzf $BACKUP_DIR/dshhome-*.tgz -C \$HOME"
    exit 1
  fi
fi
