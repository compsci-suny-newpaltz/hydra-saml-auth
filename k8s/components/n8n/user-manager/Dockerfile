FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application code
COPY server.js ./

# Expose the port
EXPOSE 3000

# Run as non-root user
USER node

# Start the application
CMD ["node", "server.js"]
