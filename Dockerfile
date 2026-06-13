# Stage 1: Build TypeScript to JavaScript
FROM node:20-alpine AS builder
WORKDIR /usr/src/app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Stage 2: Production Execution Layer
FROM node:20-alpine
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /usr/src/app/dist ./dist

# Mount location for Plotly HTML audits
RUN mkdir reports

EXPOSE 9001
CMD ["node", "dist/simulator.js"]