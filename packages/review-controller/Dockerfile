# syntax=docker/dockerfile:1
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/review-controller/package.json packages/review-controller/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --workspace=@open-inspect/shared --workspace=@open-inspect/review-controller
COPY packages/shared/ packages/shared/
COPY packages/review-controller/ packages/review-controller/
COPY review-policies/malicious-code/v1/policy.json review-policies/malicious-code/v1/policy.json
RUN npm run build -w @open-inspect/shared && npm run build -w @open-inspect/review-controller

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
# Source bundle creation uses GNU tar; do not install repository dependencies at runtime.
RUN tar --version && mkdir -p /data && chown 1001:1001 /data && chmod 700 /data
WORKDIR /app
COPY --from=build /app/packages/review-controller/dist/main.js /app/main.js
ENV NODE_ENV=production REVIEW_HOSTNAME=0.0.0.0 REVIEW_PORT=8788 REVIEW_DATABASE_PATH=/data/runs.db
USER 1001:1001
EXPOSE 8788
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8788/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "/app/main.js"]
