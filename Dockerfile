FROM node:18-slim

WORKDIR /usr/local/app

COPY package*.json ./

RUN npm ci && \
 npm cache clean --force && \
 mv /usr/local/app/node_modules /node_modules

COPY . .

ENV PORT=80
EXPOSE 80

HEALTHCHECK --interval=5s --timeout=3s --retries=3 --start-period=15s \
 CMD node -e 'const req = require("http").get({host: "127.0.0.1", port: process.env.PORT || 80, path: "/healthz"}, res => { res.resume(); res.on("end", () => process.exit(res.statusCode === 200 ? 0 : 1)); res.on("error", () => process.exit(1)); }); req.on("error", () => process.exit(1)); setTimeout(() => { req.destroy(); process.exit(1); }, 2500);'

CMD ["node", "server.js"]
