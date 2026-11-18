FROM node:20-bookworm-slim
# Python و curl للبوتات (PHP بيتنزّل لوحده عند الحاجة). gosu عشان نظبط صلاحيات الـ Volume
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates curl unzip git gosu \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --chown=node:node . .
ENV NODE_ENV=production DATA_DIR=/data PORT=8000 TRUST_PROXY=1
EXPOSE 8000
# الـ Volume بيتركّب بصلاحيات root، فنظبطها ثم نشغّل الموقع بمستخدم عادي
CMD ["sh", "-c", "mkdir -p \"$DATA_DIR\" && chown -R node:node \"$DATA_DIR\" && exec gosu node node src/server.js"]
