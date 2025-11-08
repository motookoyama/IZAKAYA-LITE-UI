# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app
ENV SWC_SKIP_VALIDATION=1

COPY package*.json ./
RUN npm install --no-audit --progress=false

COPY . .
RUN npm run build

# Stage 2: Serve with Nginx
FROM nginx:1.25-alpine

# ✅ 追加：nginx.conf を正しい場所にコピー
COPY nginx.conf /etc/nginx/conf.d/default.conf

# ✅ build成果物を配置
COPY --from=builder /app/docs /usr/share/nginx/html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
