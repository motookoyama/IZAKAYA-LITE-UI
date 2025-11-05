FROM node:20-slim AS builder
WORKDIR /app
ENV SWC_SKIP_VALIDATION=1
ARG VITE_API_BASE_URL="http://localhost:4117"
ENV VITE_API_BASE=$VITE_API_BASE_URL
COPY package*.json ./
RUN npm install --no-audit --progress=false
COPY . .
RUN npm run build

FROM nginx:1.25-alpine AS runner
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
