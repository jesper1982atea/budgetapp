# FROM node:20 AS client-build
# WORKDIR /app/client
# COPY client/package*.json ./
# RUN npm install
# COPY client/ .
# RUN npm run build

# FROM node:20 AS server-build
# WORKDIR /app/server
# COPY server/package*.json ./
# RUN npm install --production
# COPY server/ .
# COPY --from=client-build /app/client/dist /app/client/dist
# ENV NODE_ENV=production
# EXPOSE 6000
# CMD ["node", "index.js"]
FROM node:20 AS base
WORKDIR /app
COPY package*.json ./
RUN npm install

FROM node:20 AS client-build
WORKDIR /app
COPY client/package*.json client/
RUN cd client && npm install
COPY client client
RUN cd client && npm run build

FROM node:20 AS server-build
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm install --production
COPY server server
COPY --from=client-build /app/client/dist /app/client/dist
ENV NODE_ENV=production
WORKDIR /app/server
EXPOSE 4000
CMD ["node", "index.js"]
