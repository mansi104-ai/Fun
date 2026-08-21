# syntax=docker/dockerfile:1

FROM python:3.12-slim
WORKDIR /app

# Tesseract is the OCR engine pytesseract shells out to -- a system binary, not
# a Python package, which is why requirements.txt alone leaves the app able to
# import pytesseract and unable to read a single image. tesseract-ocr-eng is the
# English language data; it comes in as a dependency today, but naming it stops
# a future repackaging leaving an OCR engine with no model.
#
# libglib2.0-0 is what opencv-python-headless still links against. The headless
# wheel is chosen precisely to avoid the much heavier libGL/GUI stack.
#
# gosu lets the entrypoint drop privileges after fixing the volume's ownership.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng libglib2.0-0 gosu \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ocr_table.py ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Streamlit settings as env vars rather than a .streamlit/config.toml, so they
# apply only in the container and a local `streamlit run app.py` is unchanged.
ENV STREAMLIT_SERVER_PORT=8080 \
    STREAMLIT_SERVER_ADDRESS=0.0.0.0 \
    STREAMLIT_SERVER_HEADLESS=true \
    STREAMLIT_SERVER_FILE_WATCHER_TYPE=none \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false \
    STREAMLIT_SERVER_MAX_UPLOAD_SIZE=200

# The Fly volume. app.py reads this and keeps the uploaded workbook, the stored
# images and the processed-image log here, so they survive restarts and
# redeploys -- the thing a Community Cloud container cannot do.
ENV SCL_DATA_DIR=/data
RUN mkdir -p /data

RUN useradd --create-home --shell /usr/sbin/nologin app && chown -R app:app /app /data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/_stcore/health').read().strip()==b'ok' else 1)"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["streamlit", "run", "app.py"]
