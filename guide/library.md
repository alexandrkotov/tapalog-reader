# The library

How the program finds, names, shows, searches and keeps books: the library folder, covers, cards and tags, the shelf and its bar, search by name and inside books, editing the folders, downloads and duplicates.

[← README](../README.md) · [Reading](reading.md) · [The library](library.md) · [Scanned books](scans.md) · [Access and sharing](access.md) · [Plugins](plugins.md)

## Scanning and change tracking

Library scan with content-based book ids (a rename or move keeps bookmarks and links valid)

Automatic change tracking (file watcher + periodic rescan fallback)

## The panel, search and badges

Collapsible tree panel, search with a drop-down list and a page of results (see [Search](#search-inside-books)), format badges

## Catalogs

`.ecatm` catalogs in the built-in viewer (region selection, search, PDF export)

## Covers

Cover previews for PDF, EPUB, FB2, MOBI, CBZ and `.ecatm` (TXT shows a format tile). Folders open as a shelf of covers (click a folder's name, or the title to go back to the library root), and search results show thumbnails. Covers are drawn by the **administrator's browser** (pdf.js, the book engine) and uploaded as small JPEGs, because the server has no image decoder; they are made while an administrator has the page open, one at a time, and kept per book content (a rename or move keeps them). Catalog covers are read on the server with the viewer engine. A comic larger than 300 MB gets no cover, and covers of books gone for 30 days are removed

## Book cards

Every book has a card with a title, authors, year, series, description, language and tags. The shelf, the tree, the search list, the reader's bar, the page title, bookmarks, project items, the list of links and the page of a share link show the **title** (the file's name when the book has none), and the file's name and path are kept in the card and as a hint. EPUB (the package file) and FB2 (`title-info`) are read in the background after each scan, one book at a time; PDF, MOBI and the other formats have no automatic reading and keep their file name until the administrator types a title. **ⓘ** on a shelf card and **ⓘ About** in the reader's bar open the window "About the book": a reader sees it read-only, the **administrator** edits it. Details are library-wide (the same for everybody, keyed by book content, so a rename or move keeps them): a value typed by the administrator wins over what the file says field by field, the form shows "The file says: …" beside a typed value, a button beside a typed field takes it back (**↺ Use the file's value** where the file says something, **↺ Clear my text** where it says nothing: the title is then the file's name again and the other fields are empty), and an emptied field hides what the file says. Identical files are one card; the same book in two formats is two cards, never merged on its own. Names, titles, authors, series and tags are all found by search. The typed values (not what was read from the files) are in the backup

## Tags

The administrator gives books tags in their window (separated by commas; one spelling is offered as "+ tag" buttons, a comma inside a tag becomes a space). The top shelf shows the tags in use as buttons with the number of books each has (the 30 biggest, the rest behind "More tags"); a click shows the books that have the tag from every folder, more clicks narrow the choice to books that have **all** the chosen tags, and the address (`#tags=radio,circuits`) holds the choice. "Radio" and "radio" are one tag, shown the way most books write it. In the window of a book a reader's tags are links to the books that have them. The administrator's **⚙** button after the tags opens "Tags of the library": every tag with its number of books, **Rename** (to a name already in use it merges the two tags, after a question) and **Remove** (after a question), each applied to all the books at once; "Radio" and "radio" stay one tag there too

## The bar above a shelf

Above a shelf (a folder or a tag's books) the bar has: **▦ covers** or **☰ list** (title, authors, year, the day the book came, ⓘ), an order by title, author, year, **date added** or **last opened by me** (the arrow reverses it; a book without the value is always last), and filters by format, tag and part of an author's name. While a filter is on, the books come from the folder and every folder below it (the folders give way) and a line says how many of how many are shown. The layout and the order are kept in the browser; filters are forgotten on another shelf. The date added is the day the library first saw the file (the file's own date for books found by the very first scan and in a database made before this feature; a move or rename keeps it); "last opened" uses the places of "Continue reading" (the last 200 books of a signed-in reader, 50 of a visitor)

## The page of search results

Page of search results (**Enter** in the search box, or the last line of the drop-down; `#search=words&format=pdf&tag=radio&author=name`, so a search can be kept or sent): books found by name, title, author, series or tag, then (when search inside books is on) the books that contain the words, each with a few places, the page, section or share of the book ("44% of the book" for a plain text file, which has no pages) next to the text around the words (marked), a link that opens the book at that place, and **More places in this book** for all of them. Filters by format, tag and author narrow both lists on the server, so the limits count what is left. The drop-down stays for a quick jump: an arrow and Enter, or a click, open a book. While the books are still being read the page says how far the reading has got and that the results may be incomplete, and offers **Search again** once more books have been read

## Search inside books

Optional and off by default; the administrator turns it on in Settings. PDF text, EPUB, FB2 (any encoding), MOBI, TXT and catalog texts are read in the background, one book at a time, into a SQLite FTS5 index (`fulltext.db`, roughly as large as the text itself). Words are matched case- and accent-insensitively and the last word may be unfinished. Results appear in the search box under "Inside books" and on the page of results with a snippet and open the book at the place: the PDF page, the catalog picture and hotspot, the marked word in a TXT, the chapter of an EPUB, and roughly the right spot (a fraction of the book) for FB2 and MOBI. The words that were found are marked on the page the book opens at, in whatever form the text has them (the snippet's marks, not only what was typed): on the text layer of a PDF, on the words laid over a recognized scan, in the text of a TXT and in the chapter of an EPUB, FB2 or MOBI (a place is marked in at most a few hundred spots a page or chapter, and the first one is brought into view). The address carries them (`#book=…&view=…&find=words`), so the marks follow a link from the page of results; opening the book any other way, or opening the next one, leaves them off. In a browser that cannot mark text this way (the highlighter of CSS, Chrome and Safari have it, Firefox from version 140) a PDF and a TXT open without marks. Scans have no text layer, so their text is recognized separately (see [Scanned books](scans.md)). A book is read once per content, so renames and moves cost nothing; the index of books gone for 30 days is dropped

## Edit mode

Administrator only, **✎ Edit** in the top bar: drag books and folders in the tree, or the covers of a shelf, into any folder or onto the "Library" row to move them; ✎ (or a double click) renames, ⇄ moves through a list of folders (for phones and keyboards); **＋ New folder** makes arbitrary hierarchies. Changes are made to the **real files and folders** in the library folder, so they show up in the file manager too; nothing is ever overwritten (a name already taken is refused), a rename keeps the file extension, and there is no delete. The library must be writable, otherwise the button is disabled. Because book ids come from the content, bookmarks, share links, covers and the search index all survive a move or rename

## Download a book by link

Administrator only, **⬇ Download by link** in the top bar: paste the address of a file on any site (PDF, EPUB, FB2, DJVU, CBZ, MOBI, TXT) or a Google Drive share link of a file that is open to anyone with the link (a link wrapped in a Facebook redirect works too). The dialog shows the file's name in an editable field (without the extension; taken from the server's answer or the end of the address) and its size, with the cover Drive draws for it when it is a Drive link, and a choice of folder (the library's root by default), and only then downloads, with progress and a Cancel button. **The server only ever connects to addresses on the public internet**: a link into this computer or its local network (`localhost`, `192.168.x.x`, `10.x.x.x`, link-local and cloud-metadata addresses, IPv6 forms of those, numbers like `2130706433`) is refused, and the address is checked at the moment of connecting, so a name that resolves to an inside address is refused too, and so is every redirect hop. Only `http` and `https` are used, a link with a password in it is refused, and the size limit is 2 GB. The file is saved under a hidden name next to its final place, checked to be what its name claims (a web page or a different file type is thrown away), and renamed into the library only when complete, never over an existing file. **A zip archive** (a name like `book.fb2.zip` or just `book.zip`) is unpacked after it arrives: the one file in it that is a book is taken out under the name you chose, with the extension it has inside (FB2, DJVU, PDF and so on, a `readme.txt` beside the book is ignored), and the zip is not kept. A zip with no book or with several books, one that needs a password or is damaged is refused with a reason and nothing is saved; a "zip" that is really an EPUB or only pictures is kept as an EPUB or a CBZ. The unpacked book is checked against the library like any download, and it may not exceed the size limit. Drive folders, Google Docs and files of a format the library can't read are refused with a reason. Drive links rely on its public download address, not on an API key, so Google may change it. The cover in the library is drawn by the browser from the book itself, as for any other

## The same book is not saved twice

After a download the program compares what arrived with the library (by content, under any name and in any folder) and, if it is already there, says where and asks whether to keep it anyway. A file with a name already used in the folder is refused before anything is fetched.

## Finding duplicates

Administrator only, Settings → **Find duplicates…**: *identical files* (the same content, confirmed by reading the files whole, not only by the quick id the library keeps) and *alike names* (different files whose names are the same once case, punctuation, accents and the word copy/копия are ignored: maybe the same book in another format, maybe not). In each group of identical files one stays unchecked; the others are moved to the trash after a confirmation. The trash is the hidden folder `.tapalog-trash` inside the library (on the same disk, skipped by the scanner): nothing is deleted, and the file name keeps the original folder so a book can be moved back by hand. The last copy of a book that exists more than once is never taken, checked on the server by reading the files. Bookmarks and share links follow the content, so they keep working when one copy is removed.

## Files and the data folder

Range requests for book files; everything the app creates lives in `tapalog-reader-data/` next to the executable (falls back to `~/.tapalog-reader-data` if that is not writable)
