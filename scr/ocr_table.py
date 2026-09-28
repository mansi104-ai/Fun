"""
Reads the 6 x 11 SCL table out of a screenshot using a vision model via
OpenRouter.

This replaced a Tesseract + OpenCV pipeline. On a real screenshot that read the
Membrane row as `'0273837205', '21254-12686', '-2.9965'` -- decimal points
gone, two values merged into one token, minus signs turned into dashes -- and
picked up the "Geometry | Worksheet" tab strip and the "[MPa]" axis label as
extra table rows. Dense numeric tables at screenshot resolution are genuinely
hard for OCR; the model reads them without tuning.

Needs an OpenRouter key in SCL_API_KEY (or OPENROUTER_API_KEY).
"""

import os
import json
import base64
import urllib.error
import urllib.request

import pandas as pd

API_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.environ.get("SCL_MODEL", "anthropic/claude-opus-5")

COLUMNS = ["SX", "SY", "SZ", "SXY", "SYZ", "SXZ", "S1", "S2", "S3", "SINT", "SEQV"]
SUBTYPES = [
    "Membrane", "Bending (Inside)", "Bending (Outside)",
    "Membrane+Bending (Inside)", "Membrane+Bending (Center)",
    "Membrane+Bending (Outside)",
]

MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff"}

PROMPT = f"""Read the stress-classification (SCL) results table in this screenshot.

It has exactly 6 data rows, in this order:
{chr(10).join(f"  {i + 1}. {s}" for i, s in enumerate(SUBTYPES))}

and exactly 11 numeric columns, in this order:
  {", ".join(COLUMNS)}

Return ONLY a JSON object, no prose and no markdown fence:
{{"title": "<the SCL label, e.g. 'SCL- 10', or null>",
  "rows": [[11 numbers], [11 numbers], [11 numbers],
           [11 numbers], [11 numbers], [11 numbers]]}}

Rules:
- Copy each value EXACTLY as printed, including the minus sign and every
  decimal place. Do not round, reformat, or convert units.
- Values may be in scientific notation such as -4.0742e-002; keep them as
  numbers (-0.040742 is fine, -4.0742 is not).
- Ignore the chart, axis labels and the Geometry/Worksheet tabs below the table.
- If a cell is genuinely unreadable, use null. Never guess a digit.
"""


def api_key():
    for var in ("SCL_API_KEY", "OPENROUTER_API_KEY"):
        if os.environ.get(var):
            return os.environ[var]
    return None


def model_ready():
    """Return None when the app can run, or a message explaining what's missing."""
    if not api_key():
        return (
            "**No OpenRouter API key is set, so screenshots cannot be read.**\n\n"
            "Get one at https://openrouter.ai/keys and add a little credit, then:\n\n"
            "*On Fly:* `fly secrets set SCL_API_KEY=sk-or-... --app scl-table-ocr`\n\n"
            "*Locally:* `set SCL_API_KEY=sk-or-...` on Windows, "
            "`export SCL_API_KEY=sk-or-...` elsewhere.\n\n"
            f"Reading one screenshot costs roughly 1-2 cents on {MODEL}."
        )
    return None


def read_table(image_path, timeout=120):
    """Ask the model for the table. Returns (title, rows); raises RuntimeError."""
    key = api_key()
    if not key:
        raise RuntimeError("No OpenRouter API key set (SCL_API_KEY).")

    with open(image_path, "rb") as f:
        raw = f.read()
    media = MEDIA_TYPES.get(os.path.splitext(image_path)[1].lower(), "image/png")
    data_url = f"data:{media};base64,{base64.b64encode(raw).decode()}"

    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]}],
        "response_format": {"type": "json_object"},
        "max_tokens": 2000,
    }).encode()

    req = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "X-Title": "SCL Table Extractor",
    })

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"OpenRouter returned {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Could not reach OpenRouter: {e.reason}")

    if "choices" not in payload:
        raise RuntimeError(f"Unexpected API response: {str(payload)[:300]}")

    text = payload["choices"][0]["message"]["content"].strip()
    if text.startswith("```"):          # some models fence their JSON anyway
        text = text.strip("`")
        text = text[text.find("{"):]
    try:
        parsed = json.loads(text)
    except ValueError:
        raise RuntimeError(f"Model did not return JSON: {text[:200]}")

    rows = parsed.get("rows")
    if not isinstance(rows, list) or len(rows) != 6:
        got = len(rows) if isinstance(rows, list) else type(rows).__name__
        raise RuntimeError(f"Expected 6 rows, got {got}")
    for i, row in enumerate(rows):
        if not isinstance(row, list) or len(row) != 11:
            got = len(row) if isinstance(row, list) else "?"
            raise RuntimeError(f"Row {i + 1} has {got} values, expected 11")

    return parsed.get("title"), rows


def validate_rows(rows, rel_tol=1e-4):
    """
    Cross-check a block against identities that stress linearization
    guarantees, so a misread or invented number is caught before you save it:

      1. Membrane == Membrane+Bending (Center)   -- bending is zero mid-surface
      2. Bending (Inside) == -Bending (Outside)  for SX..SXZ, being antisymmetric
      3. their S1/S2/S3 reverse and negate       -- negating a tensor does that
      4. their SINT and SEQV are identical       -- both invariant under negation

    rel_tol sits just above one unit in the last printed place (~3e-5), so
    genuine rounding passes and a wrong digit does not.

    Returns a list of readable failures; empty means the block is consistent.
    """
    import math

    def close(a, b):
        if a is None or b is None:
            return False
        return math.isclose(a, b, rel_tol=rel_tol, abs_tol=1e-9)

    problems = []
    membrane, bend_in, bend_out, _mb_in, mb_centre, _mb_out = rows

    for j, name in enumerate(COLUMNS):
        if not close(membrane[j], mb_centre[j]):
            problems.append(f"{name}: Membrane ({membrane[j]}) != M+B Center ({mb_centre[j]})")

    for j in range(6):
        neg = -bend_out[j] if bend_out[j] is not None else None
        if not close(bend_in[j], neg):
            problems.append(f"{COLUMNS[j]}: Bending Inside ({bend_in[j]}) != -Outside ({bend_out[j]})")

    for j, k in ((6, 8), (7, 7), (8, 6)):      # S1<->-S3, S2<->-S2, S3<->-S1
        neg = -bend_out[k] if bend_out[k] is not None else None
        if not close(bend_in[j], neg):
            problems.append(
                f"{COLUMNS[j]}: Bending Inside ({bend_in[j]}) != -Outside {COLUMNS[k]} ({bend_out[k]})")

    for j in (9, 10):
        if not close(bend_in[j], bend_out[j]):
            problems.append(f"{COLUMNS[j]}: Bending Inside ({bend_in[j]}) != Outside ({bend_out[j]})")

    return problems


def extract_table_from_image(image_path):
    """
    Returns (DataFrame of 6 rows x 11 columns, title, problems).

    The DataFrame has a Subtype label column plus SX..SEQV, so the review table
    is readable; app.py drops non-numeric values when it writes to C:M.
    Raises RuntimeError if the table could not be read at all.
    """
    title, rows = read_table(image_path)
    problems = validate_rows(rows)
    df = pd.DataFrame(rows, columns=COLUMNS)
    df.insert(0, "Subtype", SUBTYPES)
    return df, title, problems
