#!/bin/sh
set -e

# Fly attaches the volume at /data after the image is built, and the mount
# arrives owned by root -- silently overriding the chown the Dockerfile did to
# that path. Without this the app runs unprivileged and cannot write the
# uploads it just accepted, surfacing as a permission error deep inside a
# file write rather than anywhere obvious.
#
# Guarded so a volume holding many images is not re-walked on every boot.
if [ "$(stat -c %u /data)" != "$(id -u app)" ]; then
    chown -R app:app /data
fi

exec gosu app "$@"
