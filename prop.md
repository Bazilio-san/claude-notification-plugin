# Предложение: команда `/add-project` в Telegram listener

## Задача

Добавить в Telegram-бота listener'а команду, которая создаёт запись в
`config.listener.projects` без ручного редактирования конфига.

Две формы вызова:

1. **Явный путь** — `/add-project mj D:/DEV/FA/_cur/mcp-jira`
2. **По basename из уведомления** — `/add-project mj /mcp-jira`
   Здесь `/mcp-jira` — это шапка, которую notifier уже показывал
   в сообщении (`✅ /mcp-jira/master`). Listener должен знать, какой
   абсолютный путь соответствует этому basename.

## Ключевая проблема формы #2

Notifier и listener — два независимых процесса. Notifier видит `cwd`
во время хука, listener — нет. Чтобы listener смог резолвить `/mcp-jira`
→ `D:/DEV/FA/_cur/mcp-jira`, **notifier должен где-то сохранять
соответствие basename → absolutePath**, а listener — читать его.

## Архитектурное решение

### 1. Хранилище "seen projects" — отдельный файл

Создаём `~/.claude/claude-notify.seen.json`. Храним **массив** записей
(не словарь), ключом на уникальность — абсолютный нормализованный путь.
Максимум **30 записей**, старые вытесняются по `lastSeen`.

```json
{
  "entries": [
    {
      "path": "D:/DEV/FA/_cur/mcp-jira",
      "basename": "mcp-jira",
      "lastSeen": "2026-04-12T10:15:00.000Z"
    },
    {
      "path": "C:/work/my-app",
      "basename": "my-app",
      "lastSeen": "2026-04-11T22:03:11.000Z"
    }
  ]
}
```

**Почему массив, а не словарь по basename:**

- команда `/seen` должна показывать ВСЕ последние 30 папок, включая
  коллизии по basename (две папки `mcp-jira` в разных местах);
- массив тривиально сортируется и обрезается по `lastSeen`;
- лукап формы `/mcp-jira` — линейный фильтр по `basename` + выбор
  самой свежей записи (O(30), несущественно).

**Почему отдельный файл, а не `claude-notify.config.json`:**

- notifier запускается многократно и конкурентно с listener;
- запись в общий конфиг гонка vs. `saveConfig(config)` в listener
  (например, `/setdefault` может затереть свежую запись notifier'а);
- отдельный файл → notifier пишет только в него, listener только читает
  → безопасно без локов.

**Уникальность записи** — по `normalizeForCompare(path)`. При повторном
вызове с тем же путём обновляем `lastSeen` in-place, не плодим дубликаты.

**Коллизия basename'ов** (две папки `mcp-jira` в разных местах): в seen
они живут как отдельные записи. При резолве формы `/mcp-jira` listener
берёт запись с максимальным `lastSeen` среди совпадающих по basename —
это та папка, из которой пользователь только что получил уведомление.

**Ограничение 30 записей.** Если после добавления/обновления в массиве
стало больше 30 — сортируем по `lastSeen` desc и обрезаем хвост.

### 2. Изменения в notifier (`notifier/notifier.js`)

В `resolveProjectName` (или сразу после, в месте формирования header'а)
дописать вызов:

```js
recordSeenProject(cwd);
```

Реализация `recordSeenProject` (в `bin/constants.js`, см. ниже):

```js
const MAX_SEEN_ENTRIES = 30;

export function recordSeenProject (cwd) {
  try {
    const normalized = normalizeForCompare(cwd);
    const data = loadSeenProjects();           // { entries: [...] }
    const entries = Array.isArray(data.entries) ? data.entries : [];

    const now = new Date().toISOString();
    const idx = entries.findIndex(
      (e) => normalizeForCompare(e.path) === normalized,
    );
    if (idx >= 0) {
      entries[idx].lastSeen = now;
    } else {
      entries.push({
        path: cwd.replace(/\\/g, '/'),
        basename: path.basename(cwd),
        lastSeen: now,
      });
    }

    // Sort by lastSeen desc, trim to MAX_SEEN_ENTRIES
    entries.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
    const trimmed = entries.slice(0, MAX_SEEN_ENTRIES);

    // Atomic write: temp file + rename
    const tmp = `${SEEN_PROJECTS_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries: trimmed }, null, 2));
    fs.renameSync(tmp, SEEN_PROJECTS_PATH);
  } catch {
    // silent: notifier must not crash on seen-file errors
  }
}
```

Запись делаем **всегда**, даже если уже есть запись о том же проекте —
обновляем `lastSeen` (нужно для сортировки и команды `/seen`).

### 3. Изменения в listener (`listener/listener.js`)

#### 3.1. Чтение seen-файла

Функция `loadSeenProjects()` (в `bin/constants.js`) — читает и парсит
файл, возвращает `{ entries: [] }` при любой ошибке/отсутствии.
Вызывается **при каждом** вызове `handleAddProject` / `handleSeen`
(а не один раз на старте), чтобы видеть свежайшие записи.

#### 3.2. Регистрация команды

В `handleCommand` (listener.js:501):

```js
case '/add-project':
  return handleAddProject(args);
case '/seen':
  return handleSeen();
```

Плюс в `setMyCommands` (listener.js:1163) добавить:

```js
{ command: 'add-project', description: 'Register a project alias' },
{ command: 'seen',        description: 'Recent folders seen by notifier' },
```

И строки в `/help` (listener.js:1014 район).

#### 3.3. `handleAddProject(args)`

Логика:

```
args = "mj D:/DEV/FA/_cur/mcp-jira"     → alias=mj, target=...
args = "mj /mcp-jira"                    → alias=mj, target=/mcp-jira
args = ""                                → usage help
```

Псевдокод:

```js
function handleAddProject (args) {
  const parts = (args || '').trim().split(/\s+/);
  if (parts.length < 2) {
    return '❌ Usage: /add-project <alias> <path-or-/basename>\n' +
           'Examples:\n' +
           '  /add-project mj D:/DEV/FA/_cur/mcp-jira\n' +
           '  /add-project mj /mcp-jira';
  }
  const [alias, rawTarget] = [parts[0], parts.slice(1).join(' ')];

  // validate alias: [a-zA-Z0-9_-]+
  if (!/^[a-zA-Z0-9_-]+$/.test(alias)) {
    return `❌ Invalid alias "${escapeHtml(alias)}".`;
  }
  if (listenerConfig.projects[alias]) {
    return `❌ Alias "<b>${escapeHtml(alias)}</b>" already exists. ` +
           `Use /projects to list.`;
  }

  // Resolve target → absolute path
  let absPath;
  if (isBasenameRef(rawTarget)) {              // "/mcp-jira" — single segment, no drive
    const { entries } = loadSeenProjects();
    const basename = rawTarget.replace(/^\/+/, '');
    // Pick the most recent entry matching this basename
    const matches = entries
      .filter((e) => e.basename === basename)
      .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
    if (matches.length === 0) {
      return `❌ Unknown basename "/${escapeHtml(basename)}". ` +
             `No notification from such folder was seen yet. ` +
             `Use /seen to list recent folders.`;
    }
    absPath = matches[0].path;
  } else {
    absPath = rawTarget;                        // assume explicit path
  }

  // Validate directory exists
  try {
    if (!fs.statSync(absPath).isDirectory()) {
      return `❌ Path is not a directory: <code>${escapeHtml(absPath)}</code>`;
    }
  } catch {
    return `❌ Path does not exist: <code>${escapeHtml(absPath)}</code>`;
  }

  // Normalize to forward slashes (match existing config style)
  absPath = absPath.replace(/\\/g, '/');

  // Check: path already registered under another alias?
  // Compare normalized (resolved + lowercased on Windows) paths.
  const normalizedNew = normalizeForCompare(absPath);
  for (const [existingAlias, proj] of Object.entries(listenerConfig.projects)) {
    const existingPath = typeof proj === 'string' ? proj : proj?.path;
    if (!existingPath) continue;
    if (normalizeForCompare(existingPath) === normalizedNew) {
      return `❌ Path already registered as ` +
             `<b>&${escapeHtml(existingAlias)}</b> → ` +
             `<code>${escapeHtml(existingPath)}</code>`;
    }
  }

  // Mutate config + persist
  listenerConfig.projects[alias] = {
    path: absPath,
    claudeArgs: [],
    worktrees: {},
  };
  try {
    saveConfig(config);
  } catch (err) {
    delete listenerConfig.projects[alias];
    return `❌ Failed to save config: ${escapeHtml(err.message)}`;
  }

  // Discover worktrees for the new project (consistency with startup flow)
  worktreeManager.discoverWorktrees(alias);

  logger.info(`Project added: ${alias} → ${absPath}`);
  return `✅ Project added: <b>&${escapeHtml(alias)}</b> → ` +
         `<code>${escapeHtml(absPath)}</code>`;
}
```

#### 3.4. `handleSeen()` — вывод последних 30 папок

Показывает содержимое `claude-notify.seen.json` в виде таблицы.
Для папок, уже зарегистрированных в `listenerConfig.projects`
(сравнение через `normalizeForCompare`), в колонку `alias` подставляется
существующий алиас; для остальных — прочерк (`—`).

**Формат вывода.** Telegram HTML поддерживает `<pre>` — моноширинный
блок, в котором можно выровнять колонки пробелами. Колонки:

| # | alias  | age     | path                              |
|---|--------|---------|-----------------------------------|
| 1 | mj     | 2m ago  | D:/DEV/FA/_cur/mcp-jira           |
| 2 | —      | 1h ago  | C:/work/side-project              |
| 3 | notify | 3d ago  | D:/DEV/FA/_pub/claude-notif...    |

Псевдокод:

```js
function handleSeen () {
  const { entries } = loadSeenProjects();
  if (!entries || entries.length === 0) {
    return 'ℹ No seen folders yet. Notifier will populate this list ' +
           'as you receive notifications.';
  }

  // Build alias index: normalized project path → alias
  const aliasByPath = new Map();
  for (const [alias, proj] of Object.entries(listenerConfig.projects)) {
    const p = typeof proj === 'string' ? proj : proj?.path;
    if (p) aliasByPath.set(normalizeForCompare(p), alias);
  }

  // Sort by lastSeen desc (already trimmed to 30 by notifier, but re-sort
  // defensively in case of manual edits)
  const sorted = [...entries].sort(
    (a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''),
  );

  // Compute column widths for alignment
  const rows = sorted.map((e, i) => ({
    num:   String(i + 1),
    alias: aliasByPath.get(normalizeForCompare(e.path)) || '—',
    age:   formatAge(e.lastSeen),
    path:  e.path,
  }));
  const wNum   = Math.max(...rows.map((r) => r.num.length));
  const wAlias = Math.max(...rows.map((r) => r.alias.length), 5);
  const wAge   = Math.max(...rows.map((r) => r.age.length), 3);

  const lines = rows.map((r) =>
    `${r.num.padStart(wNum)}  ${r.alias.padEnd(wAlias)}  ` +
    `${r.age.padStart(wAge)}  ${r.path}`,
  );

  return {
    text: `📂 <b>Recent folders</b> (${rows.length}/${MAX_SEEN_ENTRIES}):\n` +
          `<pre>${escapeHtml(lines.join('\n'))}</pre>`,
  };
}

function formatAge (iso) {
  if (!iso) return '?';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return 'now';
  const s = Math.floor(diffMs / 1000);
  if (s < 60)        return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)        return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)        return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)        return `${d}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
```

**Ограничение длины.** Telegram-сообщение limit ≈ 4096 символов.
30 строк × ~100 символов = ~3000 — с запасом. Если путь очень длинный,
можно обрезать до 60 символов с эллипсисом, но в MVP оставим как есть.

**Интеграция с `/add-project`.** В тексте ошибки "Unknown basename"
и в `/help` упоминаем `/seen` как способ посмотреть, что доступно для
резолва.

Хелперы:

```js
function isBasenameRef (s) {
  // "/foo" — one leading slash + single path segment, no drive letter, no backslash
  return /^\/[^/\\:]+$/.test(s);
}

function normalizeForCompare (p) {
  // path.resolve canonicalizes ".", "..", trailing slashes, mixed separators.
  // On Windows FS is case-insensitive → lowercase for comparison.
  const resolved = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
```

> Примечание: `normalizeForCompare` — та же логика, что уже используется
> в `notifier/notifier.js:29` (`normalizePath`). Имеет смысл вынести
> единый хелпер в `bin/constants.js` и переиспользовать из обоих мест.

> **Примечание для Unix-пользователей.** Путь вида `/mcp-jira` формально
> является абсолютным путём. Но в рамках listener'а политика такая:
> **один сегмент после `/` без концевого слэша = ссылка на basename из seen-файла**.
>
> Если у вас реально есть каталог `/mcp-jira` в корне ФС и вы хотите
> зарегистрировать именно его (а не разрешить через seen), используйте
> один из способов обхода:
>
> 1. **Концевой слэш:** `/add-project mj /mcp-jira/`
>    Регэксп `^\/[^/\\:]+$` не матчится (в строке два `/`), значение
>    уходит в ветку "explicit path", `fs.statSync('/mcp-jira/')` работает.
> 2. **Точка в конце:** `/add-project mj /mcp-jira/.`
>    То же самое — содержит второй `/`, интерпретируется как явный путь.
> 3. **Любой более глубокий путь:** `/add-project mj /mcp-jira/src/..`
>    или просто укажите подкаталог и поднимитесь — но проще варианты 1-2.
>
> Вариант 1 — рекомендуемый и самый короткий. Это надо задокументировать
> в README и в тексте ошибки команды (в usage-подсказке):
>
> ```
> /add-project <alias> <path-or-/basename>
>
> Examples:
>   /add-project mj D:/DEV/FA/_cur/mcp-jira   — explicit path
>   /add-project mj /mcp-jira                  — resolve from last notification
>   /add-project mj /mcp-jira/                 — Unix: literal /mcp-jira directory
> ```

### 4. Константы

В `bin/constants.js` добавить:

```js
export const SEEN_PROJECTS_PATH = path.join(CLAUDE_DIR, 'claude-notify.seen.json');
export const MAX_SEEN_ENTRIES = 30;
```

И экспортировать общий хелпер `recordSeenProject(cwd)` / `loadSeenProjects()`
/ `normalizeForCompare(p)` — чтобы и notifier, и listener брали код
из одного места.

## Что нужно поменять (файлы)

| Файл | Изменение |
|---|---|
| `bin/constants.js` | `SEEN_PROJECTS_PATH`, `MAX_SEEN_ENTRIES`, `recordSeenProject`, `loadSeenProjects`, `normalizeForCompare` |
| `notifier/notifier.js` | вызов `recordSeenProject(cwd)` после `resolveProjectName`; убрать локальный `normalizePath` в пользу общего |
| `listener/listener.js` | `case '/add-project'` + `handleAddProject`, `case '/seen'` + `handleSeen`, `formatAge`, записи в `setMyCommands`, строки в `/help` |
| `README.md` | документировать `/add-project`, `/seen` и семантику `/basename` |
| `listener/LISTENER-DETAILED.md` | добавить `/add-project` и `/seen` в раздел "Bot commands" |

## Edge-cases и валидация

1. **Пустой алиас / невалидные символы** → ошибка, пример использования.
2. **Алиас уже существует** → ошибка (не перезаписываем молча; если
   захочется "update" — отдельная команда `/rename-project` или флаг).
3. **Путь уже зарегистрирован под другим алиасом** → ошибка с указанием
   существующего алиаса. Сравнение через `normalizeForCompare` (resolve +
   прямые слэши + lowercase на Windows) — чтобы `D:/foo`, `D:\foo\`,
   `d:/foo/./` считались одним путём.
4. **Путь не существует / не директория** → ошибка, не пишем в конфиг.
5. **`/basename` не найден в seen** → подсказать: "нужно сначала получить
   уведомление из этой папки".
6. **Коллизия basename** (две папки `mcp-jira` в разных местах) —
   в seen живут обе записи; при резолве `/mcp-jira` берётся самая
   свежая по `lastSeen`. `/seen` покажет обе, так что пользователь
   видит конфликт и может при необходимости передать явный путь.
7. **Notifier не смог записать seen-файл** (права, диск) — молча
   игнорируем, notifier не должен падать из-за этого.
8. **Гонка запись/чтение seen-файла** — атомарная запись через temp+rename
   решает проблему (reader либо видит старую версию, либо новую).
9. **Путь с пробелами** — сейчас разделяем по `\s+` и джойним хвост;
   работает, если алиас один токен без пробелов (что и так требование).

## Что НЕ делаем в этой задаче

- Не добавляем команду `/remove-project` (отдельная задача, если понадобится).
- Не добавляем ручную очистку `/seen clear` — при достижении 30 записей
  старые сами вытесняются notifier'ом.
- Не трогаем механизм `resolveProjectName` — он продолжает работать
  как раньше, seen-файл только добавляется параллельно.

## Порядок реализации

1. `bin/constants.js` — хелперы + путь + `MAX_SEEN_ENTRIES`.
2. Patch notifier — вызов `recordSeenProject(cwd)` + обработка ошибок.
3. Publish + install + тест: получить уведомление из 2-3 разных папок →
   убедиться, что seen-файл содержит массив entries с корректными
   `path`, `basename`, `lastSeen`.
4. Patch listener — `handleAddProject`, `handleSeen`, `formatAge`,
   регистрация команд, help.
5. Publish + restart listener.
6. Тест через `/test-telegram` skill:
   - `/seen` на пустом файле → "No seen folders yet".
   - Получить несколько уведомлений → `/seen` показывает таблицу,
     отсортированную по времени, с прочерками в колонке alias.
   - `/add-project mj D:/DEV/FA/_cur/mcp-jira` → `/seen` теперь
     показывает `mj` в колонке alias для этой строки.
   - `/add-project mj2 /mcp-jira` → резолвится в тот же путь,
     ошибка "Path already registered as &mj".
   - `/add-project other /unknown-xyz` → "Unknown basename".
   - Негативные: дубликат алиаса, несуществующий путь.
   - Проверить вытеснение: симулировать >30 папок, убедиться что
     файл обрезан до 30 и самые старые удалены.
7. README + LISTENER-DETAILED.md.
