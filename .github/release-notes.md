## English

What's new:
- **Plugins have a version of their contract with the program.** A plugin's `plugin.json` can say which version of the plugin API it was written for (`"api": 1`; plugins that say nothing are version 1, so existing ones go on working). The plugin is told the version it is given, **Settings → Plugins** shows the program's version and each plugin's, and a plugin written for a newer version than the program's is skipped with the reason shown there instead of failing in somebody's reader. The rules of compatibility are in the plugin guide.

Unzip and run the file for your system; the page opens in your browser. Nothing is installed.

**The programs are not code-signed**, so the system may warn on first start:
- Windows SmartScreen: "More info" → "Run anyway".
- macOS: once, `xattr -d com.apple.quarantine tapalog-reader-macos-*` in Terminal, then run it.
- Linux: `chmod +x` is already set in the archive.

Check a download against `SHA256SUMS.txt`.

## Русский

Что нового:
- **У плагинов появилась версия их соглашения с программой.** В `plugin.json` плагина можно указать, для какой версии API плагинов он написан (`"api": 1`; у плагинов без этого поля версия 1, так что существующие продолжают работать). Плагину сообщается версия, которую он получает, **Настройки → Плагины** показывают версию программы и каждого плагина, а плагин, написанный для более новой версии, пропускается с причиной там же, вместо того чтобы ломаться в чьей-то читалке. Правила совместимости описаны в руководстве по плагинам.

Распакуйте и запустите файл для вашей системы: страница откроется в браузере. Ничего не устанавливается.

**Программы не подписаны**, поэтому при первом запуске система может предупредить:
- Windows SmartScreen: «Подробнее» → «Всё равно запустить».
- macOS: один раз выполните в Терминале `xattr -d com.apple.quarantine tapalog-reader-macos-*`, затем запустите.
- Linux: право на запуск (`chmod +x`) уже стоит в архиве.

Скачанный файл можно сверить с `SHA256SUMS.txt`.

## Українська

Що нового:
- **У плагінів з'явилася версія їхньої угоди з програмою.** У `plugin.json` плагіна можна вказати, для якої версії API плагінів його написано (`"api": 1`; у плагінів без цього поля версія 1, тож наявні продовжують працювати). Плагіну повідомляється версія, яку він отримує, **Налаштування → Плагіни** показують версію програми та кожного плагіна, а плагін, написаний для новішої версії, пропускається з причиною там-таки, замість того щоб ламатися в чиїйсь читалці. Правила сумісності описано в посібнику з плагінів.

Розпакуйте та запустіть файл для вашої системи: сторінка відкриється в браузері. Нічого не встановлюється.

**Програми не підписані**, тому під час першого запуску система може попередити:
- Windows SmartScreen: «Докладніше» → «Все одно запустити».
- macOS: один раз виконайте в Терміналі `xattr -d com.apple.quarantine tapalog-reader-macos-*`, потім запустіть.
- Linux: право на запуск (`chmod +x`) уже стоїть в архіві.

Завантажений файл можна звірити з `SHA256SUMS.txt`.

---
