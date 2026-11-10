## English

What's new:
- **Isolated plugins.** A plugin can now ask to run in a sandboxed frame (`"api": 2` and `"isolated": true` in its `plugin.json`). The frame has no way to reach the program's page, cookies or login, cannot open windows or navigate the page, and reaches no site except the program's own address as a stranger; the plugin gets the book's bytes from `await context.file()` and draws into its own document, and covers are drawn in a hidden frame the same way. Plugins that say nothing run in the page as before (plugin API 1 goes on working), and the plugin guide says how to move one over. A new example, `text-lines-sandboxed`, comes with the program.

Unzip and run the file for your system; the page opens in your browser. Nothing is installed.

**The programs are not code-signed**, so the system may warn on first start:
- Windows SmartScreen: "More info" → "Run anyway".
- macOS: once, `xattr -d com.apple.quarantine tapalog-reader-macos-*` in Terminal, then run it.
- Linux: `chmod +x` is already set in the archive.

Check a download against `SHA256SUMS.txt`.

## Русский

Что нового:
- **Изолированные плагины.** Плагин теперь может попросить запуск в изолированном фрейме (`"api": 2` и `"isolated": true` в его `plugin.json`). Фрейм не может добраться до страницы программы, её cookie и входа, не может открывать окна и уводить страницу, и достаёт только до собственного адреса программы как чужой; плагин получает байты книги из `await context.file()` и рисует в собственном документе, а обложки так же рисуются в скрытом фрейме. Плагины, которые ничего не говорят, работают в странице, как раньше (API плагинов 1 продолжает работать), а в руководстве по плагинам сказано, как перевести плагин. В поставку добавлен новый пример `text-lines-sandboxed`.

Распакуйте и запустите файл для вашей системы: страница откроется в браузере. Ничего не устанавливается.

**Программы не подписаны**, поэтому при первом запуске система может предупредить:
- Windows SmartScreen: «Подробнее» → «Всё равно запустить».
- macOS: один раз выполните в Терминале `xattr -d com.apple.quarantine tapalog-reader-macos-*`, затем запустите.
- Linux: право на запуск (`chmod +x`) уже стоит в архиве.

Скачанный файл можно сверить с `SHA256SUMS.txt`.

## Українська

Що нового:
- **Ізольовані плагіни.** Плагін тепер може попросити запуск в ізольованому фреймі (`"api": 2` і `"isolated": true` у його `plugin.json`). Фрейм не може дістатися сторінки програми, її cookie і входу, не може відкривати вікна й відводити сторінку, і сягає лише власної адреси програми як чужий; плагін отримує байти книги з `await context.file()` і малює у власному документі, а обкладинки так само малюються у прихованому фреймі. Плагіни, що нічого не кажуть, працюють у сторінці, як раніше (API плагінів 1 продовжує працювати), а в посібнику з плагінів сказано, як перенести плагін. До поставки додано новий приклад `text-lines-sandboxed`.

Розпакуйте та запустіть файл для вашої системи: сторінка відкриється в браузері. Нічого не встановлюється.

**Програми не підписані**, тому під час першого запуску система може попередити:
- Windows SmartScreen: «Докладніше» → «Все одно запустити».
- macOS: один раз виконайте в Терміналі `xattr -d com.apple.quarantine tapalog-reader-macos-*`, потім запустіть.
- Linux: право на запуск (`chmod +x`) уже стоїть в архіві.

Завантажений файл можна звірити з `SHA256SUMS.txt`.

---
