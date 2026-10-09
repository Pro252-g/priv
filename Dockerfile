FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server ./server
COPY public ./public
COPY .local/models ./.local/models
ENV HOST=0.0.0.0 PORT=3000 IEP_DATA_DIR=/data IEP_SECURE_COOKIE=true
EXPOSE 3000
CMD ["npm", "start"]
