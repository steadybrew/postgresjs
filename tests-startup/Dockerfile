# Both versions can be overridden with --build-arg; use supported matrix versions.
ARG POSTGRES_VERSION=17.11
FROM postgres:${POSTGRES_VERSION}-bookworm
ARG NODE_VERSION=24.21.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openssl xz-utils coreutils libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && case "$(dpkg --print-architecture)" in \
         amd64) task_arch=x64 ;; \
         arm64) task_arch=arm64 ;; \
         *) echo 'Unsupported Node architecture' >&2; exit 1 ;; \
       esac \
    && task_archive="node-v${NODE_VERSION}-linux-${task_arch}.tar.xz" \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${task_archive}" \
    && curl -fsSLo SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    && grep " ${task_archive}$" SHASUMS256.txt | sha256sum -c - \
    && tar -xJf "$task_archive" -C /usr/local --strip-components=1 \
    && rm "$task_archive" SHASUMS256.txt
CMD ["sh", "/repo/tests-startup/isolated.sh"]
