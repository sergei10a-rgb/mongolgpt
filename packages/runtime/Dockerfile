FROM docker.io/alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS workspace-launcher
RUN apk add --no-cache build-base linux-headers tini-static=0.19.0-r3
COPY container/workspace-launcher.c /build/workspace-launcher.c
RUN cc -Os -s -Wall -Wextra -Werror -static /build/workspace-launcher.c -o /workspace-launcher

FROM docker.io/cloudflare/sandbox:0.12.9

COPY --chmod=0555 container/sandbox /container-server/sandbox
COPY container/sandbox-build.json /usr/share/mongolgpt/sandbox-build.json
COPY vendor/sandbox-control/LICENSE /usr/share/licenses/mongolgpt-sandbox/LICENSE
COPY vendor/sandbox-control/upstream.json /usr/share/licenses/mongolgpt-sandbox/upstream.json
COPY --chmod=0755 container/mongolgpt /usr/local/bin/mongolgpt
COPY --from=workspace-launcher --chmod=0755 /workspace-launcher /usr/local/bin/mongolgpt-workspace-launcher
COPY --from=workspace-launcher --chmod=0755 /sbin/tini-static /usr/local/bin/mongolgpt-init
COPY container/licenses/musl.COPYRIGHT /usr/share/licenses/mongolgpt-workspace-launcher/musl.COPYRIGHT
COPY container/licenses/tini.LICENSE /usr/share/licenses/mongolgpt-init/LICENSE

RUN mkdir -p \
  /workspace/.mongolgpt/data \
  /workspace/.mongolgpt/config \
  /workspace/.mongolgpt/cache

EXPOSE 4096

ENV MONGOLGPT_CONTAINER_ENTRYPOINT=true
ENTRYPOINT ["/usr/local/bin/mongolgpt-init", "--", "/usr/local/bin/mongolgpt", "serve"]
