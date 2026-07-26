# Playwright's official image ships Chromium + all system deps, so there is
# nothing to apt-install. Pin to match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=4000
EXPOSE 4000
CMD ["node", "server.js"]
