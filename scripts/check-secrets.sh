#!/usr/bin/env bash
# check-secrets.sh — 敏感值扫描（提交前必跑）
#
# 为什么建（2026-09-25）：
#   dsh-xiaoai 公开前清理了历史，
#   但台式DSH 随后提交的 e545c74 又从旧代码带回了真实 ID。
#   → 清理不是一次性的，需要【持续检查】。
#
# 用法：
#   bash scripts/check-secrets.sh          # 检查当前工作区
#   bash scripts/check-secrets.sh --history # 连历史一起查
#   bash scripts/check-secrets.sh --pre-push # 作为 pre-push 钩子

set -u
FAIL=0

# 本项目特定的敏感值
PATTERNS=(
  "4JHDWC96I96G3B24|设备ID"
  "JsU0SVNivU+mbRhFQO2tSA==|ssecurity"
  "AWgq+EHXOA5juV7MnrC0mA==|ssecurity"
  "28620806|小米账号ID"
  "981379594|小米设备DID"
)

echo "═══ 敏感值扫描 ═══"

# 工作区检查
echo ""
echo "【工作区 / 已跟踪文件】"
for p in "${PATTERNS[@]}"; do
  PAT="${p%%|*}"; NAME="${p##*|}"
  FILES=$(git ls-files -z 2>/dev/null | xargs -0 grep -l "$PAT" 2>/dev/null | head -5)
  if [ -n "$FILES" ]; then
    echo "  ❌ $NAME（$PAT）:"
    echo "$FILES" | sed 's/^/      /'
    FAIL=1
  else
    echo "  ✅ $NAME"
  fi
done

# 历史检查（可选）
if [ "${1:-}" = "--history" ]; then
  echo ""
  echo "【git 历史】"
  for p in "${PATTERNS[@]}"; do
    PAT="${p%%|*}"; NAME="${p##*|}"
    N=$(git log --all -S "$PAT" --oneline 2>/dev/null | wc -l)
    if [ "$N" -gt 0 ]; then
      echo "  ❌ $NAME: $N 个提交"
      FAIL=1
    else
      echo "  ✅ $NAME"
    fi
  done
fi

echo ""
if [ "$FAIL" = "1" ]; then
  echo "🔴 发现敏感值，不要提交/推送"
  exit 1
else
  echo "✅ 未发现敏感值"
  exit 0
fi
