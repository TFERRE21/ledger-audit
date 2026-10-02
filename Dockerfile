FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN rm -rf node_modules
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "start.js"]
