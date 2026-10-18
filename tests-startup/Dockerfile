ARG POSTGRES_IMAGE=postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
FROM ${POSTGRES_IMAGE}
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
