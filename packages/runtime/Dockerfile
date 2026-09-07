FROM docker.io/alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS workspace-launcher
RUN apk add --no-cache build-base linux-headers
COPY container/workspace-launcher.c /build/workspace-launcher.c
RUN cc -Os -s -Wall -Wextra -Werror -static /build/workspace-launcher.c -o /workspace-launcher

FROM docker.io/cloudflare/sandbox:0.12.9

COPY --chmod=0755 container/mongolgpt /usr/local/bin/mongolgpt
COPY --from=workspace-launcher --chmod=0755 /workspace-launcher /usr/local/bin/mongolgpt-workspace-launcher
COPY container/licenses/musl.COPYRIGHT /usr/share/licenses/mongolgpt-workspace-launcher/musl.COPYRIGHT

RUN mkdir -p \
  /workspace/.mongolgpt/data \
  /workspace/.mongolgpt/config \
  /workspace/.mongolgpt/cache

EXPOSE 4096
