#!/bin/sh
set -e

# Fly attaches the volume at /data *after* the image is built, and the mount
# arrives owned by root — which silently overrides any chown the Dockerfile did
# to that path. Without this the app process, running unprivileged, cannot
# write the workbook it just updated, and the failure surfaces as a permission
# error deep inside openpyxl's save rather than anywhere obvious.
#
# Guarded so a volume with many files is not re-walked on every boot.
if [ "$(stat -c %u /data)" != "$(id -u app)" ]; then
    chown -R app:app /data
fi

exec gosu app "$@"
