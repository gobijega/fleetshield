# Production image for Fleet Shield (Fly.io — see DEPLOY.md).
FROM node:20.18-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install prod deps first so this layer is cached between code-only deploys.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

USER node
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
