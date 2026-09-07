FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --production --ignore-scripts

COPY server.js config.js db.js index.html ./

ENV PORT=4173
ENV DATA_DIR=/data
EXPOSE 4173

CMD ["node", "server.js"]
