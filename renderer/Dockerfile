FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js /app/server.js

ENV NODE_ENV=production
ENV PORT=8788

EXPOSE 8788
CMD ["node", "/app/server.js"]
