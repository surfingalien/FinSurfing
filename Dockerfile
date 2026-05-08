FROM node:18-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

EXPOSE 3001

ENV NODE_ENV=production

CMD ["node", "server.js"]
