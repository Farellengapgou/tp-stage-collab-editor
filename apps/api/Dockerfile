FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci
COPY . .
RUN npm run build -w @collab/api
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npm", "start"]
