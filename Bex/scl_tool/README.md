# SCL Table → Excel

Drop in SCL result screenshots, point at your workbook, and the six rows of
numbers from each screenshot are written into **columns C:M of the first
worksheet**, with one blank row between screenshots. The workbook is saved
back to the path it already lives at.

The table is found and read with classical computer vision and the free
Tesseract OCR engine. There's no AI model and no API key. Run it on your
laptop and nothing leaves your machine; it can also be hosted on Streamlit
Community Cloud (see below).

## The four steps

1. **Screenshots on the left, the workbook on the right.** You upload the
   screenshots. You choose the workbook by its path, because a browser upload
   gives the file's bytes but never its path, and saving in place needs the path.
2. **The table is found and the graph is left out.** The table's grid lines
   are located in the image, and only the cells inside that grid are read. The
   plot, axis labels and tab strip below are never looked at.
3. **The numbers go into C:M**, six rows per screenshot. Each block starts one
   blank row below the last row that has anything in C:M.
4. **The workbook is saved to its own path.** There's no download and no copy
   to move back.

## Setup

1. Install **Tesseract OCR** once from
   <https://github.com/UB-Mannheim/tesseract/wiki> with the default options.
   It installs to `C:\Program Files\Tesseract-OCR\`, where the tool looks for
   it automatically.
2. Double-click **`Run SCL Tool.bat`**. The first run installs the Python
   packages the tool needs, then opens it at <http://localhost:8501>.

To run it by hand instead:

```powershell
cd Bex\scl_tool
python -m pip install -r requirements.txt
python -m streamlit run app.py
```

## Hosted on Streamlit Community Cloud

The same app deploys unchanged: point Community Cloud at this repository with
main file path **`Bex/scl_tool/app.py`**. It installs Tesseract from the
repository-root `packages.txt` (Community Cloud only reads that file at the
root) and the Python packages from `requirements.txt` beside the app.

Hosted, one of the four steps works differently, because a server cannot
reach your laptop:

| | On your laptop | Hosted |
|---|---|---|
| Workbook in | chosen by path | uploaded |
| Workbook out | saved in place | **downloaded**, then saved over the original |
| Backup | copy beside the file | not needed: your original is untouched |

The app detects which mode it's in by itself: Community Cloud checks apps out
under `/mount/src`. Setting `SCL_HOSTED=1` forces hosted mode anywhere else.

Uploaded files stay in the server's memory and a temporary folder for your
session only. Nothing is shared between visitors or kept afterwards.

## How the table is read

The table is a drawn grid, so the tool locates every cell by geometry before
it reads any text. Pixel values measured from a real screenshot:

| What | Grey level |
|---|---|
| Panel background | 160 |
| Table grid lines | 192 |
| Cell background | 255 (white) |

- **Rows:** a grid line is a thin line that is non-white across the whole
  width, with a row of white cells next to it. The table's lines come as an
  evenly spaced run (8 lines, 17px apart), while the graph adds only a few
  lines far below. The first tight run is the table.
- **Columns:** within the table band, a vertical grid line is a narrow column
  with almost no white, directly beside a white cell.
- **Shape check:** the grid must have exactly 7 rows (a header plus 6 data
  rows) and 12 columns (Subtype plus 11 values). Any other shape means the
  table wasn't found. The tool then refuses the image rather than reading the
  wrong boxes.
- **Reading:** each of the 66 cells is cut out, enlarged 6×, surrounded by a
  white margin, and read on its own by Tesseract. Only `0-9 . - e +` are
  allowed. The Subtype label column is never read.

Reading one cell at a time is what makes Tesseract work here. Pointed at the
whole table, it returned the Membrane row as `'0273837205'`, `'21254-12686'`,
`'-2.9965'`: decimal points lost and neighbouring values merged together.

**Tested on:**

- One real screenshot (SCL-10): all 66 values read exactly.
- A synthetic table built from SCL-1's values, including scientific notation
  such as `-4.0742e-002`: all 66 read exactly.
- 10 unrelated screenshots: all correctly rejected as "no table".
- The same checks on Linux (Debian 12, Tesseract 5.3.0, what Community Cloud
  installs): 66/66 on both tables.

These tests don't cover your other screenshots yet. Check the first few batches
in the review step.

## Where the numbers land

The layout matches what the reference workbook already uses. Row 1 is the
header (`C1:M1` = SX … SEQV), followed by blocks of six rows with one blank row
between them. The tool doesn't touch column A (the SCL number) or column B
(the row labels).

```
row 1     SX  SY  SZ ... SEQV     <- header, untouched
rows 30-35   an existing block
row 36       (blank)
rows 37-42   the first screenshot written this run
row 43       (blank)
rows 44-49   the second
```

**"The last occupied row" means the last row with anything in C:M**, not the
last row on the sheet. This matters for the real workbook: column A is
pre-numbered with empty blocks far below where the data stops (numbers at rows
37, 44, 51 … while C:M ends at row 35). Counting the whole sheet would push
each new block hundreds of rows down. Counting only C:M puts it at row 37,
exactly on the next pre-numbered block.

## Review before writing

Each table appears under the part of the screenshot it came from, in an
editable grid. The tool does no checking of what the numbers mean. The only
checks are structural:

- **A cell that doesn't read as a number is left empty.** It's never guessed.
  The tool lists it by row and column so you can type it in.
- **A screenshot that doesn't give exactly 6 rows of 11 numbers isn't written.**
  It stays on screen so you can fix it and press the button again. A partial
  block never reaches the sheet.

## Notes

- **Close the workbook in Excel before saving.** Excel locks the file while
  it's open, and the tool tells you when that's the problem.
- **A backup is made by default** next to the workbook (for example
  `name.backup-20260915-102459.xlsx`). A checkbox turns it off. Saving rewrites
  the whole file through openpyxl, so anything openpyxl doesn't support would
  be lost. The reference workbook contains only sheets, values and merged
  cells, all of which survive, but the backup lets you undo a bad save.
- **Reading the same screenshot again adds a second block.** The tool
  remembers which screenshots went into which workbook and warns you, but it
  doesn't stop you.
- The column and row counts are fixed to the SCL worksheet layout. A
  screenshot of a different table is refused, not misread.
