FROM node:18-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY app.js ./ 
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "app.js"]

