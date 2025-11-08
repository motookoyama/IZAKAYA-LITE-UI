FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app

# Install dependencies for the job runner
COPY ops/playability-job/package.json .
RUN npm install --omit=dev

# Copy the scripted scenario
RUN mkdir -p scripts
COPY scripts/check_content_playability_full.js ./scripts/check_content_playability_full.js

CMD ["node", "scripts/check_content_playability_full.js"]
