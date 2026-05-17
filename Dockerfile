# ── PayPortal BZ — Dockerfile ──────────────────────────────────────────────
# Static HTML app served by nginx. No build step needed.
# ────────────────────────────────────────────────────────────────────────────

FROM nginx:1.25-alpine

# Remove default nginx config and site
RUN rm /etc/nginx/conf.d/default.conf

# Copy our nginx config
COPY nginx.conf /etc/nginx/conf.d/payportal.conf

# Copy the app
COPY public/ /usr/share/nginx/html/

# Expose port 6680
EXPOSE 6680

# Healthcheck so Coolify knows the container is alive
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:6680/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
