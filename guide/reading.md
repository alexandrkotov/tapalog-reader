# Reading books

How the readers work: the PDF reader and what it can do for scans, the e-book and text readers, and the places a reader keeps (bookmarks, projects, where you stopped). Nothing here ever changes a book's file.

[← README](../README.md) · [Reading](reading.md) · [The library](library.md) · [Scanned books](scans.md) · [Access and sharing](access.md) · [Plugins](plugins.md)

## PDF reader

The PDF reader is pdf.js, loaded on demand; it works for scans too (JBIG2 and JPEG 2000 decoders, fonts and CMaps are embedded). The address bar always holds the current *view*: page, position, zoom and an optional highlighted rectangle drawn with **Area**; the same link reproduces it in a window of any size

### Whole page and reading mode

**Whole page** fits a page entirely into the window (next to **Fit width**), and a fitted page keeps following the window. **Reading mode** (⛶ in the PDF toolbar) hides the top bar, the library panel and the title bar so the page has the whole screen; the toolbar stays, and the same button or Esc brings the rest back

### Rotate

**Rotate** (⟳) turns every page of the book a quarter clockwise, for scans that were fed in sideways. It is a setting of how *you* see the book, not a change to the file: it is kept per account and book (by content, so a rename or move keeps it, in the backup like reading places; a visitor without an account keeps it in that browser only), and a fourth turn is the file's own look again. Areas, bookmarks and share links stay in the page as the file has it, so they mean the same place whatever the turn; the Print dialog prints the pages turned the way you see them

### Crop

**Crop** (✂) cuts away the margins of scanned pages: the pages are shown whole with a frame on the one being read, everything outside it dimmed. Drag the frame's edges and corners (or focus an edge and use the arrow keys, Shift for bigger steps), look at the result with **Preview**, then **Apply**; **Cancel** or Esc leaves with nothing changed and **Reset** brings back the file's own pages. The cut is for the whole book or only the odd or the even pages (a book scanned two pages at a time has its margins mirrored; a crop for the whole book replaces separate ones). Like turning, it is how *you* see the book, not a change to the file, and it is kept in the same place (per account and book content, in the backup, in the browser for a visitor). Only the cut part is drawn, selectable and printed; areas, bookmarks and share links keep naming places of the whole page, so they mean the same wherever the margins are cut, and an area lying in a margin that is cut away is simply not drawn

### Printed page numbers

**№** sets the book's *printed page numbers*: the cover and front matter come first, so printed page 1 is not page 1 of the file. Say which number is printed on the page you are reading and a second box appears next to the page box, showing the printed number of the page you are on; type a printed number there to go to it. Bookmarks and **Continue reading** are named by the printed page ("Page 4"; front matter, which has no printed number, is "File page 3"). Links, bookmarks and areas keep using the file's own page numbers, so they work the same for everybody; print ranges and the page strip stay in the file's numbers. It is kept like turning and cropping, and none of the three ever changes the PDF file itself (a test compares the file's hash and modification time before and after)

## EPUB, FB2, MOBI and comics

EPUB, FB2, MOBI/AZW3 and CBZ comics open in [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT, loaded on demand): contents, pages or continuous scroll, text size, arrow keys. A passage selected with **Mark** is highlighted, and the address bar holds the position and the mark (as EPUB CFIs, so they survive another window or text size). Books are third-party content: the page's Content-Security-Policy stops scripts and inline handlers inside an EPUB from running, and links in a book open only if they are http(s) or mailto

## Text files

Encoding detected automatically (UTF-8, UTF-16 with BOM, Windows-1251, Windows-1252), text size, **Mark** a passage; the address bar holds the top line and the mark as character offsets, so a link reproduces them in any window

## Page previews

**▥** in the toolbar of a PDF or a comic opens a strip of small pages down the left side, drawn only as they scroll into view and one at a time, so a thousand-page book stays light. The page being read is highlighted, a click goes to a page, and the strip is remembered between visits (PDF; closed on a phone). For a comic it replaces the list of file names

## Print and save as PDF

**Print / PDF** in the reader bar (PDF, EPUB, FB2, MOBI, CBZ and TXT) lets you choose choose the whole book, this page or chapter, a range of pages (PDF, comics), the marked passage (TXT) or the **highlighted area** of a PDF page, then the browser's print window opens, where "Save as PDF" as the printer writes a file. The printout is prepared in a hidden shadow tree (the book's own CSS cannot touch the app, and scripts, frames and event handlers in a book are stripped), PDF pages are drawn as ~200 dpi pictures so they look the same in every browser, and e-book text stays real, selectable text in the saved PDF. The dialog also offers the original file for download. Catalogs keep the PDF export of their own viewer

## Bookmarks

Bookmarks are kept per reader. **★ Bookmarks** in the reader bar saves the current place (PDF page, catalog view, EPUB/FB2/MOBI position, TXT line, with its marked passage) under a name that is suggested from the place (a page number, the chapter), and **My bookmarks** lists them all across books. They are stored on the server under the reader's account, so they follow the reader to any device, and they are keyed by book content, so renaming or moving a book keeps them. A visitor without an account who clicks the button is offered to sign in or create one (when registration is allowed)

## My projects

A project is a collection that gathers places from different books and the reader's own notes, for example "My amplifier" with a schematic from one book, a table from another and comments between them. **＋ To project** in the reader bar adds the place on screen, or the passage selected in a text book (EPUB, FB2, MOBI, TXT) with its words as a quote; the project is chosen from a list or made on the spot, and the reader stays where it was. **My projects** (in the account menu) lists the projects: create, rename and delete them, put the items in order (↑ ↓), edit the title, comment and quote of an item, add notes that belong to no book, and take items out (after a question). Several places and passages of one book, and one book in several projects, are fine. An item opens its book at the saved place; since it names the book by content, a rename or move keeps it, and when the book has left the library the item says so and keeps its quote, comment and source. A PDF item shows a picture of its saved area (the whole page when it has none), drawn in the browser from the file the reader may open anyway and turned the way the reader turned the book; catalogs (`.ecatm`) are not pictured, because their engine draws no picture of an area and a picture made elsewhere would bypass a catalog's password. Projects are personal (there is no sharing) and need an account, like bookmarks. **⤓** saves a project as a Markdown file (title, description, each item with its source, quote, comment and a link that opens the book at the saved place; the links work only while the server can be reached, and the file says so), and **🖶** prints it or saves it as PDF through the print window (with a picture of each saved area for PDF books if asked, or only titles, sources, quotes and comments). The screen of a project says how it is used (where places come from, what the buttons are, what an own note is), its **?** button starts a tour that points at the real buttons, and every step of the quick tours (the library, an open book, a project's screen) has a **More** button that opens a longer explanation with a small picture of the buttons and dialogs it is about (drawn as SVG in the theme's colours, in the language of the interface; a test checks that every step of the three tours has one and that its words fit). Limits: 200 projects per reader, 1000 items per project

## Continue reading

A book opens where the reader left it, and the top shelf lists the last 12 books read under **Continue reading**, each with its place ("Page 12"). The place is whatever the reader reports as its view (the same one bookmarks and share links carry, so plugin readers with a `getView` take part), saved a moment after the reader stops moving, and when the page is closed or hidden. A signed-in reader's places are kept on the server per account and per book content (a rename or move keeps them, the last 200 books are remembered, and they are in the backup); a visitor without an account keeps theirs in that browser only, and they are never handed over to an account. What a book opens at: the place named by the link, bookmark or search result followed, else the saved place, else the start, so a share link always shows what its author chose. If the same book is read in two tabs or on two devices, the place saved last is the one that stays

## Theme

Light, dark or the system's theme (the ◐ button in the top bar, remembered in the browser; the readers follow it)
