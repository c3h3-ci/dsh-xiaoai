#!/usr/bin/env bash
# check-secrets.sh — 敏感值扫描（提交前必跑）
#
# 为什么建（2026-09-25）：
#   dsh-xiaoai 公开前清理了历史，
#   但随后的一次提交又从旧代码带回了真实账号标识。
#   → 清理不是一次性的，需要持续检查。
#
# ⚠️ 设计注意：本脚本【不能把敏感值原文写进来】，
#    否则脚本本身就成了泄露源（第一版犯过这个错）。
#    → 用正则模式匹配（长度+字符集），不写具体值。
#
# 用法：
#   bash scripts/check-secrets.sh            # 检查已跟踪文件
#   bash scripts/check-secrets.sh --history  # 连 git 历史一起查
#   bash scripts/check-secrets.sh --pre-push # 作为 pre-push 钩子

set -u
FAIL=0

# 用【模式】而非具体值：
#   · 18 位大写字母数字混合（设备 deviceId 形态）
#   · 9 位纯数字且以 98 开头（本项目小米设备 DID 形态）
#   · 8 位纯数字且以 28 开头（本项目小米账号 ID 形态）
#   · base64 形态的 ssecurity（22 字符 + == 结尾）
# 注意：2882303761520251711 是小米公开的 OAuth client_id（非个人凭据），
#      用 EXCLUDE 排除，避免误报。
PATTERNS=(
  '[0-9A-Z]{18}|疑似设备deviceId'
  '(^|[^0-9])98[0-9]{7}([^0-9]|$)|疑似小米设备DID'
  '(^|[^0-9])28[0-9]{6}([^0-9]|$)|疑似小米账号ID'
  '[A-Za-z0-9+/]{20}==|疑似ssecurity'
  'ghp_[A-Za-z0-9]{30,}|GitHub token'
  'sk-[A-Za-z0-9]{30,}|API key'
)

# 已知的公开值（会被模式命中但不是个人凭据）
EXCLUDE_VALUES=(
  '2882303761520251711'   # 小米公开 OAuth client_id（完整）
  '288230376152025171'    # 同上，被 18 位模式截断的片段
)

say() { printf '  %s\n' "$1"; }

echo "═══ 敏感值扫描（模式匹配，不写具体值）═══"
echo ""
echo "【已跟踪文件】"
for p in "${PATTERNS[@]}"; do
  PAT="${p%%|*}"; NAME="${p##*|}"
  # 排除本脚本自身（它的模式串会自匹配）
  FILES=$(git ls-files -z 2>/dev/null \
          | xargs -0 grep -lE "$PAT" 2>/dev/null \
          | grep -v '^scripts/check-secrets.sh$' | head -5)
  # 逐个文件确认：把命中片段里的【已知公开值】剔掉后，看是否还有剩余
  REAL=""
  for f in $FILES; do
    HITS=$(grep -oE "$PAT" "$f" 2>/dev/null | sort -u)
    LEFT="$HITS"
    for ex in "${EXCLUDE_VALUES[@]}"; do
      # 把含公开值的行整行剔掉
      LEFT=$(printf '%s\n' "$LEFT" | grep -v "$ex" 2>/dev/null || true)
    done
    # 剔除后若还有非空片段 → 真命中
    if printf '%s\n' "$LEFT" | grep -qE '[0-9A-Za-z]'; then
      REAL="$REAL $f"
    fi
  done
  if [ -n "$REAL" ]; then
    say "❌ $NAME:"
    echo "$REAL" | tr ' ' '\n' | grep -v '^$' | sed 's/^/      /'
    FAIL=1
  else
    say "✅ $NAME"
  fi
done

if [ "${1:-}" = "--history" ]; then
  echo ""
  echo "【git 历史】"
  for p in "${PATTERNS[@]}"; do
    PAT="${p%%|*}"; NAME="${p##*|}"
    N=$(git log --all -G "$PAT" --oneline 2>/dev/null | wc -l)
    if [ "$N" -gt 0 ]; then
      say "⚠️ $NAME: $N 个提交（需人工确认是否真值）"
    else
      say "✅ $NAME"
    fi
  done
fi

echo ""
if [ "$FAIL" = "1" ]; then
  echo "🔴 发现疑似敏感值，不要提交/推送"
  echo "   （如为误报，请把该文件加入本脚本的排除列表）"
  exit 1
else
  echo "✅ 未发现敏感值"
  exit 0
fi
