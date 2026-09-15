# SCL Table → Excel

Drop in SCL result screenshots, point at your workbook, and the six rows of
numbers from each screenshot are written into **columns C:M of the first
worksheet**, with one blank row between screenshots. The workbook is saved
back to the path it already lives at.

The table is found with classical computer vision, and each number is read
by matching its pixels against the exact shapes of the characters in the
ANSYS font. There's no AI model and no API key. Run it on your laptop and
nothing leaves your machine; it can also be hosted on Streamlit Community
Cloud (see below).

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

1. *(Optional)* Install **Tesseract OCR** from
   <https://github.com/UB-Mannheim/tesseract/wiki> with the default options.
   Screenshots taken straight from ANSYS are read without it. It's only a
   fallback for cells that don't match the ANSYS font, and those cells are
   flagged for you to check either way.
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
- **Reading:** ANSYS draws every number in one screen font, Segoe UI 9pt.
  Every digit is exactly 6px wide (`.` is 3px, `-` 5px, `e` 6px, `+` 8px), and
  every "5" is pixel-for-pixel the same "5". `glyphs.json` holds the shape of
  each character. A cell is read as the sequence of characters whose shapes,
  placed side by side, reproduce its pixels most closely. This works even
  though ClearType smears neighbouring digits together with no gap between
  them. The Subtype label column is never read.
- **Confidence:** each reading gets a mismatch score, where 0 means identical
  pixels. Genuine ANSYS text scores 0.00–0.10; a different font scores above
  0.4. A cell scoring over 0.25 isn't trusted: it's handed to Tesseract
  instead and **flagged for you to check**. It's never accepted silently.

The digits, `.` and `-` were cut from a real ANSYS screenshot. `e` and `+`
don't appear in that screenshot, so they were drawn by Windows in Segoe UI
9pt ClearType, the one font whose character widths match exactly.

Why not Tesseract as the main reader: it guesses. On the SCL-1 screenshot it
read `5.0275` as `9.0275` and `5.0026` as `3.0026`, and on a faithful
re-rendering of that same table it got six cells wrong, most of them 5s.

**Tested on:**

- The real SCL-10 screenshot: 66/66 exact, mismatch 0.000, in half a second.
  Learning the shapes from half the cells and reading the other half gave
  66/66 as well, so this isn't a case of testing on the training data.
- SCL-1's exact values (including `5.0275`, `5.0026` and every `e-002`)
  drawn by Windows in the ANSYS font: 66/66 exact, none flagged.
- A table in a different font (Tahoma): all 66 cells flagged for checking,
  none accepted silently.
- 10 unrelated screenshots: all correctly rejected as "no table".

The one thing still to confirm is a real ANSYS screenshot containing
scientific notation. SCL-1 itself is the ideal test, and any cell that doesn't
match would show up flagged rather than wrong.

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
- **A cell that didn't match the font closely is flagged.** It was read by
  the fallback, so the tool lists it with the value it got, and you check it
  against the image.
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
- **Values are written exactly as read, every digit.** The cells the tool
  writes are set to Excel's General format. Some empty cells in the reference
  workbook still carry an old `0.00E+00` format that would show `-0.040742` as
  `-4.07E-02`. A screenshot only holds the digits ANSYS printed (5 significant
  figures), so that is the most precision any reader can recover from it.
- **Reading the same screenshot again adds a second block.** The tool
  remembers which screenshots went into which workbook and warns you, but it
  doesn't stop you.
- The column and row counts are fixed to the SCL worksheet layout. A
  screenshot of a different table is refused, not misread.
