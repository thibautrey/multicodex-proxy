FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY web/package.json web/package-lock.json* ./web/
RUN npm --prefix web install

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 4010
CMD ["node", "dist/index.js"]
