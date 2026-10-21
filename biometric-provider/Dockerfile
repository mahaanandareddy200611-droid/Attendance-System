FROM ghcr.io/deepinsight/insightface-server:0.3.1-cpu

# Keep liveness off the default image path; the entrypoint enables it only
# after an operator explicitly confirms the selected model licence.
COPY server.toml /etc/insightface/server.toml
COPY entrypoint.sh /usr/local/bin/attendance-insightface-entrypoint
RUN chmod 0755 /usr/local/bin/attendance-insightface-entrypoint

ENV INSIGHTFACE_DATA_DIR=/data \
    INSIGHTFACE_MODELS_DIR=/data/models \
    INSIGHTFACE_CONFIG_FILE=/etc/insightface/server.toml \
    INSIGHTFACE_EXECUTION_PROVIDER=CPUExecutionProvider

EXPOSE 10000
ENTRYPOINT ["/usr/local/bin/attendance-insightface-entrypoint"]
