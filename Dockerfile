# Use standard Node.js LTS image
FROM node:20-alpine

# Set internal container path
WORKDIR /usr/src/app

# Copy dependency descriptors for caching
COPY package.json tsconfig.json ./

# Install packages
RUN npm install

# Copy source tree
COPY src/ ./src/

# Compile TypeScript to JavaScript
RUN npm run build

# Expose Simulator Control Panel port
EXPOSE 9001

# Boot the compiled simulator script
CMD ["node", "dist/simulator.js"]