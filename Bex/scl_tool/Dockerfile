# syntax=docker/dockerfile:1

FROM python:3.12-slim
WORKDIR /app

# Tesseract is the OCR engine pytesseract shells out to. It is a system binary,
# not a Python package, so `pip install -r requirements.txt` on its own yields
# an app that imports cleanly and then fails on the first image. This is the
# same dependency packages.txt declares for Streamlit Community Cloud.
#
# tesseract-ocr-eng carries the English traineddata. It arrives today as a
# dependency of tesseract-ocr, but naming it keeps a future Debian repackaging
# from quietly leaving the image with an OCR engine and no language model.
#
# gosu is used by the entrypoint to drop privileges after fixing up the
# volume's ownership — see entrypoint.sh for why that cannot be done at build
# time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng gosu \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Only the modules the web UI needs. run.py and the run.bat / run.sh launchers
# are the desktop CLI and have no role in a container.
COPY app.py scl_core.py store.py ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Streamlit config lives in env vars rather than a .streamlit/config.toml so it
# applies to the container only, leaving a local `streamlit run app.py`
# behaving exactly as the README describes.
ENV STREAMLIT_SERVER_PORT=8080 \
    STREAMLIT_SERVER_ADDRESS=0.0.0.0 \
    STREAMLIT_SERVER_HEADLESS=true \
    STREAMLIT_SERVER_FILE_WATCHER_TYPE=none \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false

# Hides the "Local folder (this machine only)" mode, which reads and writes
# paths on whatever machine serves the app — here a Fly VM holding none of the
# user's files. Left visible it would do nothing useful and would put an
# arbitrary-path reader on a public URL.
ENV SCL_HOSTED=1

# The Fly volume. Everything that has to outlive a restart lives under here:
# the reference workbooks, the screenshot folders, and the active selection.
ENV SCL_DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

RUN useradd --create-home --shell /usr/sbin/nologin app && chown -R app:app /app /data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/_stcore/health').read().strip()==b'ok' else 1)"

# Starts as root only long enough to chown the mounted volume, then execs
# Streamlit as the unprivileged `app` user.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["streamlit", "run", "app.py"]
