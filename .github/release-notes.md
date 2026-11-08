## English

What's new:
- **Scanned books can be searched.** A PDF made of page pictures has no text, so search used to find nothing in it. **Read scanned pages…** in Settings (and a button on a PDF's own card) now lists the PDFs without text and reads the ticked ones in your browser with Tesseract, in Russian, English or both. Search then finds the words with the page number and the text around them, and opens the book at that page.
- **Nothing leaves your machine.** The engine and the language models are inside the program (about 10 MB more), so nothing is downloaded. Pages are read on up to four lanes at once and sent to the server one by one: a stop or a closed window loses only the pages in hand, and a second run skips the pages already read. The window has to stay open while it works.
- **Kept apart from the index.** The text read from scans is not lost when the search index is rebuilt; **Forget** removes it for one book. The PDF file itself is never changed.
- **About lists Tesseract** among the parts the program is built from.

Unzip and run the file for your system; the page opens in your browser. Nothing is installed.

**The programs are not code-signed**, so the system may warn on first start:
- Windows SmartScreen: "More info" → "Run anyway".
- macOS: once, `xattr -d com.apple.quarantine tapalog-reader-macos-*` in Terminal, then run it.
- Linux: `chmod +x` is already set in the archive.

Check a download against `SHA256SUMS.txt`.

## Русский

Что нового:
- **Сканы теперь ищутся.** PDF из картинок страниц не содержит текста, и поиск в нём ничего не находил. **Прочитать сканы…** в настройках (и кнопка на карточке самого PDF) показывает PDF без текста и читает отмеченные в вашем браузере с помощью Tesseract — по-русски, по-английски или обоими языками. Поиск находит слова с номером страницы и текстом вокруг и открывает книгу на этой странице.
- **Ничего не уходит с вашего компьютера.** Движок и языковые модели лежат внутри программы (примерно на 10 МБ больше), ничего не скачивается. Страницы читаются на нескольких потоках (до четырёх) сразу и уходят на сервер по одной: остановка или закрытое окно теряют только те страницы, что были в работе, а повторный запуск пропускает уже прочитанные. Пока идёт чтение, окно должно оставаться открытым.
- **Отдельно от индекса.** Текст, прочитанный со сканов, не пропадает при перестройке поискового индекса; **Забыть** убирает его для одной книги. Сам PDF-файл не меняется никогда.
- **В «О программе»** среди составных частей теперь есть Tesseract.

Распакуйте и запустите файл для вашей системы: страница откроется в браузере. Ничего не устанавливается.

**Программы не подписаны**, поэтому при первом запуске система может предупредить:
- Windows SmartScreen: «Подробнее» → «Всё равно запустить».
- macOS: один раз выполните в Терминале `xattr -d com.apple.quarantine tapalog-reader-macos-*`, затем запустите.
- Linux: право на запуск (`chmod +x`) уже стоит в архиве.

Скачанный файл можно сверить с `SHA256SUMS.txt`.

## Українська

Що нового:
- **Скани тепер шукаються.** PDF із картинок сторінок не містить тексту, і пошук у ньому нічого не знаходив. **Прочитати скани…** в налаштуваннях (і кнопка на картці самого PDF) показує PDF без тексту й читає позначені у вашому браузері за допомогою Tesseract — російською, англійською або обома мовами. Пошук знаходить слова з номером сторінки й текстом навколо та відкриває книгу на цій сторінці.
- **Нічого не залишає ваш комп’ютер.** Рушій і мовні моделі лежать усередині програми (приблизно на 10 МБ більше), нічого не завантажується. Сторінки читаються на кількох потоках (до чотирьох) одразу й надходять на сервер по одній: зупинка або закрите вікно втрачають лише ті сторінки, що були в роботі, а повторний запуск пропускає вже прочитані. Поки триває читання, вікно має лишатися відкритим.
- **Окремо від індексу.** Текст, прочитаний зі сканів, не зникає під час перебудови пошукового індексу; **Забути** прибирає його для однієї книги. Сам PDF-файл не змінюється ніколи.
- **У «Про програму»** серед складових частин тепер є Tesseract.

Розпакуйте та запустіть файл для вашої системи: сторінка відкриється в браузері. Нічого не встановлюється.

**Програми не підписані**, тому під час першого запуску система може попередити:
- Windows SmartScreen: «Докладніше» → «Все одно запустити».
- macOS: один раз виконайте в Терміналі `xattr -d com.apple.quarantine tapalog-reader-macos-*`, потім запустіть.
- Linux: право на запуск (`chmod +x`) уже стоїть в архіві.

Завантажений файл можна звірити з `SHA256SUMS.txt`.

---
