#!/bin/sh
set -eu

if [ "${BIOMETRIC_MODEL_LICENSE_ACCEPTED:-false}" != "true" ]; then
  echo "Refusing to install face models: review the model licence and set BIOMETRIC_MODEL_LICENSE_ACCEPTED=true only if your intended use is permitted." >&2
  exit 78
fi

if [ -z "${INSIGHTFACE_API_KEY:-}" ] || [ "${#INSIGHTFACE_API_KEY}" -lt 32 ]; then
  echo "INSIGHTFACE_API_KEY must be configured with a random value of at least 32 characters." >&2
  exit 78
fi

export INSIGHTFACE_AUTH_ENABLED=true
export INSIGHTFACE_DATA_DIR="${INSIGHTFACE_DATA_DIR:-/data}"
export INSIGHTFACE_MODELS_DIR="${INSIGHTFACE_MODELS_DIR:-/data/models}"
export INSIGHTFACE_CONFIG_FILE="${INSIGHTFACE_CONFIG_FILE:-/etc/insightface/server.toml}"
PORT="${PORT:-10000}"
mkdir -p "$INSIGHTFACE_DATA_DIR" "$INSIGHTFACE_MODELS_DIR"

# The image contains code, not model weights. Use the persistent disk for
# both the SQLite index/data and model/addon files. --enable-liveness writes
# the activation into server.toml for this start; it never runs unless the
# environment contains an explicit model-licence acceptance.
python -m insightface_server.models_cli install buffalo_l --accept-license --enable-liveness

exec python /opt/insightface/server/scripts/verify_runtime.py --mode startup --provider CPUExecutionProvider -- \
  python -m uvicorn insightface_server.app:app --host 0.0.0.0 --port "$PORT" --no-access-log
