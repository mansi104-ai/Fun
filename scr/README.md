# SCL Table → Excel

Streamlit app: upload your reference Excel file and your SCL screenshots, and
each table is read and written into **columns C:M of the first worksheet** —
six rows per image, one blank row between images. No login. The workbook is
edited in place and kept on disk, so it is still there next time.

Tables are read by a vision model through OpenRouter rather than by OCR. A
Tesseract + OpenCV pipeline was tried first and could not read these tables:
on a real screenshot it returned the Membrane row as `'0273837205'`,
`'21254-12686'`, `'-2.9965'` — decimal points gone, two values merged into one
token — and picked up the Geometry/Worksheet tab strip as extra table rows.

## Setup

```bash
pip install -r requirements.txt

# an OpenRouter key with a little credit: https://openrouter.ai/keys
export SCL_API_KEY=sk-or-...      # Windows: set SCL_API_KEY=sk-or-...
```

Reading one screenshot costs roughly 1–2 cents. `SCL_MODEL` overrides the
model (default `anthropic/claude-opus-5`).

## Run

```bash
streamlit run app.py
```

Open the URL Streamlit prints (usually http://localhost:8501).

## How it works

1. **Upload Excel** — stored in `app_data/excel/`. Only one file is kept at
   a time (use "Remove" to swap it).
2. **Upload images** — select all the image files from your folder at once
   (Streamlit can't take a folder path directly, but multi-select works the
   same way). They're stored in `app_data/images/` and remembered across
   sessions.
3. **Extract tables** — click "Process new images" to read only images you
   haven't run yet, or "Re-process ALL" to redo everything.

   Each block is checked against identities that stress linearization
   guarantees: Membrane equals Membrane+Bending (Center), Bending (Inside) is
   the negative of Bending (Outside), their S1/S2/S3 reverse and negate, and
   their SINT and SEQV match. A failure means a number is wrong, and is shown
   as a warning so you can fix it before saving.
4. **Review** — check the numbers against your screenshots and correct
   anything wrong in the editable table. This is the last point before they
   reach the workbook.
5. **Save** — writes into **columns C to M of the first worksheet**, six rows
   per image, appending below whatever is already there and leaving **one
   blank row between images**:

   ```
   row 1    SX  SY  SZ ... SEQV      <- your header row, untouched
   rows 2-7    first image's 6 rows
   row 8       (blank)
   rows 9-14   second image's 6 rows
   row 15      (blank)
   rows 16-21  third image's 6 rows
   ```

   Nothing outside C:M is touched, and the workbook's other sheets are left
   alone — openpyxl edits the file in place rather than rewriting it.

   An image that does not give exactly 6 rows of 11 numbers is **not**
   written; it is listed with the reason so you can fix it in the review
   table and press Save again. A partial block never lands.
6. **Download** — optional. Saving already updates the stored workbook, so
   downloading is only for taking a copy onto your own machine.

## Persistence

Three things are kept on disk:
- `excel/` — the Excel file
- `images/` — all uploaded images
- `processed_log.json` — which images have already been saved

Where that disk is depends on how the app is running:

| Running on | Location | Survives a redeploy? |
|---|---|---|
| Your machine | `app_data/` next to `app.py` | Yes |
| Fly.io | `/data`, a mounted volume | **Yes** |
| Streamlit Community Cloud | `app_data/` in the container | **No** |

`SCL_DATA_DIR` selects the location; unset, it falls back to `app_data/`.

Community Cloud rebuilds its container from the repo every time you push, and
gives no disk to attach, so anything uploaded there is gone after the next
deploy and has to be re-uploaded. That is the reason for the Fly deployment
below — nothing else about the app differs.

## Deploying

### Fly.io (persistent — recommended)

```bash
cd scr
fly deploy --ha=false
```

`fly.toml` mounts the `scl_ocr_data` volume at `/data`. Set the API key once:

```bash
fly secrets set SCL_API_KEY=sk-or-... --app scl-table-ocr
```

`--ha=false` matters:
one volume attaches to one machine, and Streamlit keeps each session's state
in the process serving it, so a second machine would be a second unshared copy
of the app rather than extra capacity.

The machine suspends when nobody is using it and resumes in a second or two,
so it only costs while in use. The volume persists either way.

### Streamlit Community Cloud (no persistence)

Point it at `scr/app.py`, and add the key under **Settings → Secrets** as an
environment variable named `SCL_API_KEY`.

Nothing needs `packages.txt` any more — there is no OCR engine to apt-install,
which removes the trap that `packages.txt` is only read from the repository
root while `requirements.txt` is found by searching upward from the app file.

Uploads still do not survive a redeploy here; use Fly if you want them kept.

## Notes / limitations

- Every screenshot costs an API call, so "Re-process ALL" on a large folder
  costs proportionally. Already-saved images are skipped by default.
- The review table is the last checkpoint before values reach the workbook.
  The consistency checks catch a wrong digit in most positions, but not one
  that is wrong identically in both Bending rows.
- To start over completely, delete the `app_data/` folder.
