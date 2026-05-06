FROM node:18-alpine AS base

WORKDIR /app

# Copy dependency configs
COPY package.json package-lock.json* ./
RUN npm install

# Copy application files
COPY . .

# Build Next.js project
RUN npm run build

# Expose new target port
EXPOSE 4000

ENV PORT 4000
ENV NODE_ENV production

CMD ["npm", "run", "start"]
