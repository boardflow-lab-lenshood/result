FROM node:18-slim

# The delivery runner supplies Docker's init process and observes HTTP itself.

WORKDIR /usr/local/app

COPY package*.json ./

RUN npm ci && \
 npm cache clean --force && \
 mv /usr/local/app/node_modules /node_modules

COPY . .

ENV PORT=80
EXPOSE 80

CMD ["node", "server.js"]
