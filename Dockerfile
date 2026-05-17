# ── PayPortal BZ — Single container (nginx + Node.js) ──────────────────────
# Runs both the frontend (nginx) and backend (Node.js) in one image.
# supervisord manages both processes.
# ────────────────────────────────────────────────────────────────────────────

FROM node:18-alpine

# Install nginx and supervisord
RUN apk add --no-cache nginx supervisor

# ── Backend ──────────────────────────────────────────────────────────────────
WORKDIR /app/backend
COPY backend/package.json .
RUN npm install --omit=dev
COPY backend/server.js .

# ── Frontend ─────────────────────────────────────────────────────────────────
RUN mkdir -p /usr/share/nginx/html
COPY public/ /usr/share/nginx/html/

# ── Nginx config ─────────────────────────────────────────────────────────────
COPY nginx.conf /etc/nginx/http.d/payportal.conf
# Remove default site if it exists
RUN rm -f /etc/nginx/http.d/default.conf /etc/nginx/conf.d/default.conf 2>/dev/null || true

# ── Supervisord config ───────────────────────────────────────────────────────
COPY supervisord.conf /etc/supervisord.conf

EXPOSE 6680

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:6680/health || exit 1

CMD ["supervisord", "-c", "/etc/supervisord.conf"]
