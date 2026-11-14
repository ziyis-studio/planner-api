FROM node:24.19.0-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
ENV HOST=0.0.0.0 PORT=3001
EXPOSE 3001
USER node
CMD ["pnpm","start"]
