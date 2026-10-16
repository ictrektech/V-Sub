# Application-only updates preserve the already verified platform native runtime.
ARG WORKBENCH_IMAGE
ARG BASE_IMAGE
FROM ${WORKBENCH_IMAGE} AS build
WORKDIR /opt/v-sub
COPY . .
RUN npm run build:vos

FROM ${BASE_IMAGE} AS runtime
ARG PROFILE
ENV VSUB_PROFILE=${PROFILE}
COPY --from=build /opt/v-sub/app /opt/v-sub/app
COPY --from=build /opt/v-sub/vos /opt/v-sub/vos
COPY --from=build /opt/v-sub/extraResources/whisper-scheduled-worker.cjs /opt/v-sub/extraResources/whisper-scheduled-worker.cjs
