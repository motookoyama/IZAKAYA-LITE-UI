# Stage 1: Build optimized static assets
FROM node:20-slim AS builder

ENV NODE_ENV=production \
    SWC_SKIP_VALIDATION=1
WORKDIR /app

COPY package-lock.json package.json ./
RUN npm ci --no-audit --progress=false

COPY . .
RUN npm run build

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
