# Controlled test fixture (no npm dependencies).
FROM apify/actor-node:22
COPY --chown=myuser:myuser package.json main.js ./
COPY --chown=myuser:myuser .actor ./.actor
CMD ["node", "main.js"]
