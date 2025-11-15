FROM node:18-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:18-slim

# Install minimal runtime tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/cert

WORKDIR /app

# Copy deps and app
COPY --from=build /app/node_modules /app/node_modules
COPY . .

EXPOSE 6969

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]