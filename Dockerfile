# Stage 1: Build optimized static assets
FROM node:20-slim AS builder

ENV SWC_SKIP_VALIDATION=1 \
    NPM_CONFIG_OPTIONAL=true
WORKDIR /app

COPY package-lock.json package.json ./
RUN npm install --no-audit --progress=false \
 && npm install --no-audit --progress=false --no-save --package-lock=false @rollup/rollup-linux-x64-gnu || true \
 && npm install --no-audit --progress=false --no-save --package-lock=false @esbuild/linux-x64 || true

COPY . .
RUN NODE_ENV=production npm run build

# Stage 2: Serve via Nginx
FROM nginx:1.27-alpine

# Remove the default config shipped with the image
RUN rm /etc/nginx/conf.d/default.conf

# Custom runtime configuration + assets
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/docs /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
