#!/bin/sh
# 一次性校验：逻辑测试 → 生产构建 → 页面可访问检查。
# 全部通过则退出码 0，任一失败即以非零退出码报告。
set -eu

echo "== [1/3] 逻辑校验（node --test，精确有理数/连续时间/校验器/证据稳定性） =="
npm test

echo "== [2/3] 生产构建（vite build） =="
npm run build

echo "== [3/3] 页面可访问检查 =="
# Compose 中通过 CHECK_URL 指向健康的 web 服务；本地裸跑时自行起静态服务检查 dist。
if [ -n "${CHECK_URL:-}" ]; then
  echo "检查已部署站点：$CHECK_URL"
  node scripts/check-page.mjs "$CHECK_URL"
else
  echo "未提供 CHECK_URL，改对本地 dist 临时起静态服务检查"
  node scripts/check-page.mjs --serve dist
fi

echo "== verify 全部通过 =="
