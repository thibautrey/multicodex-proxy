# syntax=docker/dockerfile:1

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

ARG MULTIVIBE_VERSION=unknown
ARG MULTIVIBE_SOURCE_COMMIT=unknown

LABEL org.opencontainers.image.title="MultiVibe Host" \
      org.opencontainers.image.description="Security-bounded MultiVibe provider host for Linux NVIDIA systems" \
      org.opencontainers.image.source="https://github.com/thibautrey/multivibe" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$MULTIVIBE_VERSION" \
      org.opencontainers.image.revision="$MULTIVIBE_SOURCE_COMMIT"

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      ca-certificates \
      git \
      libstdc++6 \
      passwd \
      util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 multivibe \
 && useradd --uid 10001 --gid 10001 --home-dir /data --no-create-home --shell /usr/sbin/nologin multivibe \
 && install -d -o 10001 -g 10001 -m 0700 /data /models /tmp

COPY --chown=10001:10001 bundle/ /opt/multivibe-host/
COPY --chmod=0555 entrypoint.sh /usr/local/bin/multivibe-host-container

ENV HOME=/data \
    MULTIVIBE_HOST_DATA_DIR=/data \
    MULTIVIBE_HOST_MANAGED_DIR=/models/runtime \
    MULTIVIBE_HOST_BIND=0.0.0.0 \
    MULTIVIBE_HOST_PORT=1455 \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

VOLUME ["/data", "/models"]
EXPOSE 1455

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/opt/multivibe-host/bin/node", "--eval", "fetch('http://127.0.0.1:'+(process.env.MULTIVIBE_HOST_PORT||'1455')+'/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/multivibe-host-container"]
CMD ["run"]
