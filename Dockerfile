# รันเกมในคอนเทนเนอร์ (ใช้กับ Render / Railway / Fly.io / เครื่องตัวเองก็ได้)
FROM node:lts-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]
