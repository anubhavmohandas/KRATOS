# KRATOS in one container: the API serves the built UI. Mount a persistent volume at /data
# (DB + daily backups) and set KRATOS_PASSWORD and KRATOS_HOSTS as secrets, never in the image.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.14-slim
WORKDIR /app/api
COPY api/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY api/ ./
COPY --from=web /web/dist /app/web/dist
ENV KRATOS_DB=/data/kratos.db
RUN mkdir /data
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
