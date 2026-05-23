# syntax=docker/dockerfile:1

# API service: pure-Go HTTP frontend for the panorama app. No cgo, no Ceres,
# no glibc — drops onto distroless-static. Frontend's only origin in prod;
# forwards solve calls to the private solver service via SOLVER_URL.
# Designed for min-instances=1 — fast cold start, warm always.
#
# Build context is the REPO ROOT (one level above backend/) so the node
# builder stage can see frontend/ AND shared/ (the api's go.mod has a
# `replace ../shared` directive). Local dev:
#   docker build -f backend/Dockerfile -t panorama-api:dev .   # from repo root

# --- frontend builder ---
FROM node:lts-alpine AS frontend-build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm ci
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# --- go builder ---
FROM golang:1.25-alpine AS build
WORKDIR /src
# Pre-cache module deps for the api. The `replace ../shared` directive in
# backend/go.mod expects shared/ as a sibling, so we mirror that layout.
COPY backend/go.mod backend/go.sum ./backend/
COPY shared/go.mod ./shared/
RUN cd backend && go mod download
COPY shared/ ./shared/
COPY backend/ ./backend/
RUN cd backend && CGO_ENABLED=0 GOOS=linux go build \
      -ldflags '-s -w' \
      -o /out/panorama-api .

# --- runtime ---
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/panorama-api /panorama-api
COPY --from=frontend-build /src/frontend/dist /static
EXPOSE 8080
ENV LISTEN_ADDR=:8080 \
    STATIC_DIR=/static
USER nonroot:nonroot
ENTRYPOINT ["/panorama-api"]
