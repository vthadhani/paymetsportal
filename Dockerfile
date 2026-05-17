FROM node:18-alpine

# Install nginx and supervisord
RUN apk add --no-cache nginx supervisor

# ── Backend: install deps ─────────────────────────────────────────────────────
WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install --omit=dev && echo "node_modules installed:" && ls node_modules | head -5

# ── Backend: copy source ──────────────────────────────────────────────────────
COPY backend/server.js ./

# ── Frontend: copy static files ───────────────────────────────────────────────
RUN mkdir -p /usr/share/nginx/html
COPY public/ /usr/share/nginx/html/

# ── nginx config ──────────────────────────────────────────────────────────────
COPY nginx.conf /etc/nginx/http.d/payportal.conf
RUN rm -f /etc/nginx/http.d/default.conf /etc/nginx/conf.d/default.conf 2>/dev/null; \
    nginx -t && echo "nginx config OK"

# ── supervisord config ────────────────────────────────────────────────────────
COPY supervisord.conf /etc/supervisord.conf

EXPOSE 6680

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:6680/health || exit 1

CMD ["supervisord", "-c", "/etc/supervisord.conf"]
