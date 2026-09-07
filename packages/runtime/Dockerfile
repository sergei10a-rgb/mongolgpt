FROM docker.io/cloudflare/sandbox:0.12.9

COPY --chmod=0755 container/mongolgpt /usr/local/bin/mongolgpt

RUN mkdir -p \
  /workspace/.mongolgpt/data \
  /workspace/.mongolgpt/config \
  /workspace/.mongolgpt/cache

EXPOSE 4096
