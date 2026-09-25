# syntax=docker/dockerfile:1

# ---------- 依赖与源码（构建 / 校验共用） ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM deps AS build
COPY . .
RUN npm run build

# ---------- 静态站点运行镜像（nginx） ----------
FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O- http://127.0.0.1/healthz || exit 1

# ---------- verify 一次性校验镜像 ----------
FROM deps AS verify
COPY . .
# 逻辑校验、生产构建、页面可访问检查均在脚本内依次完成
CMD ["sh", "scripts/verify.sh"]
