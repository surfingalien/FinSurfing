FROM node:18-alpine

WORKDIR /app

# Install dependencies (cached layer)
COPY package*.json ./
RUN npm install

# Copy source and build the React app
COPY . .
RUN npm run build

# Railway injects PORT at runtime — don't hardcode EXPOSE
ENV NODE_ENV=production

CMD ["node", "server.js"]
