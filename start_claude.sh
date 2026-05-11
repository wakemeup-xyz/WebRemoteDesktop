#!/bin/sh
# 切换 Claude Code 的 API provider 并启动
# 用法: sh start_claude.sh
#
# 设计说明:
# 利用 Claude CLI 的 --settings 参数加载 provider 专属配置。
# --settings 的优先级高于 settings.json 和 settings.local.json，
# 因此 provider 的 env 配置会覆盖默认值，无需再修改 settings.json。

set -e

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
TMP_LIST=$(mktemp)

cleanup() {
    rm -f "$TMP_LIST"
}
trap cleanup EXIT INT TERM

# 收集所有 settings_*.json（排除 settings.json 自身）
count=0
for f in "$CLAUDE_DIR"/settings_*.json; do
    [ -e "$f" ] || continue
    printf '%s\n' "$f" >> "$TMP_LIST"
    count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
    echo "错误: 在 $CLAUDE_DIR 下未找到 settings_*.json 配置文件"
    exit 1
fi

echo "可用的 provider 配置文件:"
i=0
while IFS= read -r f; do
    i=$((i + 1))
    echo "  $i. $(basename "$f")"
done < "$TMP_LIST"
echo

printf "请选择编号: "
read -r choice

if ! printf '%s' "$choice" | grep -Eq '^[0-9]+$'; then
    echo "错误: 请输入数字编号"
    exit 1
fi

if [ "$choice" -lt 1 ] || [ "$choice" -gt "$count" ]; then
    echo "错误: 无效编号"
    exit 1
fi

selected=$(sed -n "${choice}p" "$TMP_LIST")
echo "已选择: $(basename "$selected")"
echo "启动 claude --settings $selected ..."
echo

claude --settings "$selected"
