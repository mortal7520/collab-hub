FROM node:22-alpine

WORKDIR /app

COPY package.json LICENSE README.md README.zh-CN.md server.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY docs/UPSTREAM-REUSE.md ./docs/UPSTREAM-REUSE.md

RUN mkdir -p /data /workspace && chown -R node:node /app /data /workspace

USER node

ENV NODE_ENV=production \
    COLLAB_HUB_HOME=/data \
    COLLAB_HUB_WORKSPACE=/workspace \
    COLLAB_HUB_PORT=5290

EXPOSE 5290

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.COLLAB_HUB_PORT||5290)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bin/collab-hub.mjs", "start", "--port", "5290"]
