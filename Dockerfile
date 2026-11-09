# Always-on bot container (onpod worker / any VPS). No dependencies to install.
FROM node:22-alpine
WORKDIR /app
COPY package.json .env.example ./
COPY src ./src
# Settings come from environment variables (set them on the server, never bake keys into the image).
# Defaults = paper mode, committee strategy, 4h, BTC/ETH/SOL. Logs go to stdout.
ENV MODE=paper
CMD ["node", "src/chief.js"]
