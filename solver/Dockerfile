# syntax=docker/dockerfile:1

# Solver service: cgo + Ceres-Solver. Private, no public ingress — called
# only by the api service via SOLVER_URL. Designed to scale to zero;
# cold-start cost is paid when a user-triggered solve fires. Surface is two
# endpoints (/solve and /solve/stream) plus /stop.
#
# Build context is the REPO ROOT (one level above solver/) so the
# `replace ../shared` directive in solver/go.mod resolves at build time:
#   docker build -f solver/Dockerfile -t panorama-solver:dev .   # from repo root

FROM golang:1.25-bookworm AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
      libceres-dev \
      libeigen3-dev \
      libsuitesparse-dev \
      libgoogle-glog-dev \
      libgflags-dev \
      pkg-config \
      build-essential \
  && rm -rf /var/lib/apt/lists/*
COPY solver/go.mod solver/go.sum ./solver/
COPY shared/go.mod ./shared/
RUN cd solver && go mod download
COPY shared/ ./shared/
COPY solver/ ./solver/
RUN cd solver && CGO_ENABLED=1 GOOS=linux go build -o /out/panorama-solver .

FROM debian:bookworm-slim
# libceres3 pulls its full runtime dependency closure (SuiteSparse,
# BLAS/LAPACK, glog, gflags).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libceres3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/panorama-solver /panorama-solver
EXPOSE 8080
ENV LISTEN_ADDR=:8080
ENTRYPOINT ["/panorama-solver"]
