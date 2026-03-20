# PTY-контроль для Claude Code Listener

## Инструкция для Claude Code

Данный документ описывает план замены текущего `TaskRunner` (использует `claude -p`)
на PTY-реализацию, эмулирующую интерактивную консоль Claude Code.

---

## 1. Проблема

Текущая реализация (`listener/task-runner.js`) запускает:

```
claude -p <prompt> --output-format json [--continue] [--permission-mode ...]
```

Флаг `-p` (pipe mode) — это headless-режим, который:
- Работает значительно хуже интерактивного Claude Code
- Не получает доступ к части возможностей (hooks, интерактивные подтверждения)
- Выдаёт менее качественные результаты при тех же промптах
- Не поддерживает потоковый вывод (результат приходит целиком после завершения)

## 2. Решение: PTY (pseudo-terminal)

Эмулировать "живую консоль" через pseudo-terminal. Claude Code будет думать,
что работает в обычном терминале, и использовать все свои возможности.

### Библиотека: `node-pty`

- npm: `node-pty`
- Кроссплатформенный (Windows ConPTY, Unix pty)
- Нативный модуль (требует компиляции или prebuild)
- Широко используется (VS Code terminal, Hyper)

## 3. Архитектура

### 3.1. Ключевая идея: Hook-based completion detection

**Вместо парсинга ANSI-вывода для определения завершения задачи —
используем штатные хуки Claude Code (событие `Stop`).**

Claude Code при завершении задачи вызывает hook `Stop`, который получает на stdin
богатый JSON с метаданными:

```json
{
  "hook_event_name": "Stop",
  "session_id": "...",
  "cwd": "/path/to/project",
  "last_assistant_message": "...",
  "total_cost_usd": 0.05,
  "num_turns": 3,
  "duration_ms": 12000
  // ... и другие поля
}
```

Это решает сразу три проблемы:
1. **Надёжное определение завершения** — не нужно парсить промпт, хук вызывается штатно
2. **Метрики** — `session_id`, `total_cost_usd`, `num_turns`, `duration_ms` приходят в JSON
3. **Текст ответа** — `last_assistant_message` содержит финальный ответ Claude
   (а не весь поток PTY, в котором перемешаны tool calls, спиннеры и рассуждения)

### 3.2. Схема взаимодействия

```
Telegram → Listener → PtyRunner                     Claude Code (в PTY)
                          │                                │
                          ├─ создаёт PTY ─────────────────→│ claude запускается
                          ├─ pty.write(task + '\n') ──────→│ получает задачу
                          │                                │── работает...
                          │                                │── PTY output → буфер (только для live progress)
                          │                                │── hook "Stop" срабатывает
                          │                                │     ↓
                          │                          notifier.js
                          │                                │ пишет маркер-файл:
                          │                                │   last_assistant_message (= ответ)
                          │                                │   session_id, cost, turns, duration
                          │←── fs.watch ловит маркер ──────│
                          ├─ result.text = marker.lastAssistantMessage
                          ├─ emit('complete', result)       │
                          │                                │← PTY снова в режиме ожидания
                          ├─ pty.write(nextTask + '\n') ──→│ следующая задача
```

### 3.3. IPC между хуком и PtyRunner

Хук (`Stop`) должен сообщить PtyRunner, что задача завершена, и передать метрики.
Варианты IPC-канала:

#### Вариант A: Файл-маркер (рекомендуется — простой и надёжный)

```
Хук записывает:    ~/.claude/pty-done/<sessionId>.json
PtyRunner следит:  fs.watch('~/.claude/pty-done/')
```

**Плюсы**: просто, работает на всех платформах, нет сетевых зависимостей
**Минусы**: небольшая задержка fs.watch (обычно < 100ms)

Формат файла-маркера:
```json
{
  "sessionId": "abc-123",
  "cwd": "/path/to/project",
  "lastAssistantMessage": "Done! I've updated the file...",
  "cost": 0.05,
  "numTurns": 3,
  "durationMs": 12000,
  "totalTokens": 15000,
  "contextWindow": 200000,
  "timestamp": 1710900000000
}
```

`lastAssistantMessage` — это **основной источник текста ответа**.
Он содержит финальное сообщение Claude пользователю — точный аналог
поля `result` из `claude -p --output-format json`.

#### Вариант B: HTTP localhost

```
PtyRunner слушает:  http://127.0.0.1:<port>/pty-done
Хук отправляет:    POST http://127.0.0.1:<port>/pty-done { ...payload }
```

**Плюсы**: мгновенный, структурированный
**Минусы**: нужен свободный порт, firewall issues, сложнее

#### Вариант C: Named pipe / Unix socket

```
PtyRunner создаёт:  /tmp/claude-pty-listener.sock (или \\.\pipe\claude-pty на Windows)
Хук пишет в:       socket connect + JSON
```

**Плюсы**: быстрый, нет файловой системы
**Минусы**: реализация различается Windows vs Unix

**Рекомендация**: Вариант A (файл-маркер) для MVP, с возможностью перехода на B.

### 3.4. Источник текста ответа

**Текст ответа (`result.text`) берётся из `last_assistant_message` в хуке, а НЕ из PTY-потока.**

В интерактивном режиме Claude выводит в терминал всё подряд:
- Свои рассуждения ("I'll read the file...")
- Вызовы инструментов (Read, Edit, Bash — с содержимым)
- Результаты инструментов
- Спиннеры, прогресс-бары
- Финальный ответ

Парсить этот поток для извлечения "чистого ответа" — ненадёжно и бессмысленно,
потому что хук `Stop` уже содержит `last_assistant_message` — последнее сообщение
Claude пользователю. Это точный аналог поля `result` из `claude -p --output-format json`.

PTY-поток используется **только** для опционального live progress в Telegram
(показать пользователю, что Claude сейчас делает).

### 3.5. Новые и изменённые модули

```
listener/
  pty-runner.js        <-- НОВЫЙ: PTY-based runner
  task-runner.js       <-- СТАРЫЙ: оставить как fallback
  listener.js          <-- ИЗМЕНИТЬ: переключить на PtyRunner

notifier/
  notifier.js          <-- ИЗМЕНИТЬ: добавить запись маркера для PTY-режима
```

Модуль `pty-output-parser.js` (ANSI-очиститель) — **опционален**,
нужен только для live progress. Можно реализовать позже или использовать
готовую библиотеку (`strip-ansi`).

### 3.6. Жизненный цикл PTY-сессии

```
1. Создание PTY
   pty.spawn('claude', [], { cwd: workDir, cols: 120, rows: 40 })

2. Ожидание готовности
   Таймаут (5-10 сек) — Claude стартует и показывает промпт
   Определяем готовность по стабилизации вывода (нет новых данных N мс)

3. Отправка задачи
   pty.write(taskText + '\n')

4. Ожидание завершения
   PTY output → (опционально) live progress в Telegram
   fs.watch ожидает файл-маркер от хука Stop

5. Получение маркера
   fs.watch ловит маркер → читает JSON
   ИЛИ таймаут → emit('timeout')

6. Формирование результата
   result.text = marker.lastAssistantMessage   ← из хука, НЕ из PTY
   result.sessionId = marker.sessionId          ← из хука
   result.cost = marker.cost                    ← из хука
   emit('complete', workDir, task, result)

7. Повторное использование или завершение
   Для continueSession: PTY остаётся открытым, ждём следующую задачу
   Для новой сессии: pty.write('/clear\n') или пересоздание PTY
```

### 3.7. Управление сессиями

Ключевое преимущество PTY — возможность переиспользовать живую сессию:

```
Текущий подход (claude -p):
  Задача 1 → spawn claude -p → exit → spawn claude -p --continue → exit → ...

PTY подход:
  spawn claude → [Задача 1] → hook → [Задача 2] → hook → [Задача 3] → ...
  (один процесс, полный контекст, нативные хуки работают)
```

**Пул PTY-сессий** — по одной на `workDir`:

```js
// pty-runner.js — концептуальная структура
class PtyRunner extends EventEmitter {
  // workDir → { pty, state, buffer, currentTask, watcher }
  sessions = new Map();
  // fs.watch на директорию маркеров
  markerWatcher = null;

  run(workDir, task, claudeArgs, continueSession) { ... }
  cancel(workDir) { ... }
  cancelAll() { ... }
  isRunning(workDir) { ... }
}
```

## 4. Детальный план реализации

### Фаза 1: Исследование и прототип

**Цель**: Понять формат вывода Claude Code в PTY и данные хука.

1. **Установить `node-pty`**
   ```bash
   npm install node-pty
   ```
   Примечание: нативный модуль, требует build tools (Python, C++ compiler).
   Альтернатива: prebuild бинарники через `prebuild-install`.

2. **Создать тестовый скрипт** `scripts/pty-test.js`
   - Запустить `claude` через `node-pty`
   - Логировать весь raw output (с ANSI-кодами) в файл
   - Отправить простой промпт
   - Задокументировать:
     - Какие ANSI-последовательности используются
     - Поведение при `--permission-mode auto` vs `bypassPermissions`
     - Формат вывода на Windows (ConPTY) vs Unix

3. **Проверить данные хука `Stop`**
   - Запустить Claude в PTY, убедиться что хуки вызываются
   - Записать JSON, который приходит на stdin хука
   - Подтвердить наличие: `session_id`, `total_cost_usd`, `num_turns`,
     `duration_ms`, `last_assistant_message`, `cwd`

### Фаза 2: IPC-механизм (файл-маркер)

**Цель**: Надёжный канал "хук → PtyRunner".

1. **Директория маркеров**: `~/.claude/pty-signals/`

2. **Изменить `notifier/notifier.js`**:
   При `CLAUDE_NOTIFY_FROM_LISTENER === '1'` и событии `Stop`:
   - Вместо выхода (текущее поведение) — записать файл-маркер
   - Имя файла: `<sessionId>.json` (или `<cwd-hash>.json` если sessionId недоступен)
   - Содержимое: метрики из hook JSON

   ```js
   // В notifier.js, секция Stop при FROM_LISTENER
   if (process.env.CLAUDE_NOTIFY_FROM_LISTENER === '1') {
     const signalDir = path.join(CLAUDE_DIR, 'pty-signals');
     fs.mkdirSync(signalDir, { recursive: true });
     const signalFile = path.join(signalDir, `${sessionId}.json`);
     fs.writeFileSync(signalFile, JSON.stringify({
       sessionId,
       cwd,
       lastAssistantMessage: event.last_assistant_message || '',
       cost: event.total_cost_usd || 0,
       numTurns: event.num_turns || 0,
       durationMs: event.duration_ms || 0,
       timestamp: Date.now(),
     }));
     process.exit(0);
   }
   ```

3. **PtyRunner**: `fs.watch` на директорию маркеров
   - При появлении файла: прочитать, сопоставить с активной задачей по `cwd`
   - Удалить файл после обработки

### Фаза 3: PTY Runner (`pty-runner.js`)

**Цель**: Drop-in замена для `TaskRunner`.

```js
// pty-runner.js — публичный интерфейс (совместим с TaskRunner)
export class PtyRunner extends EventEmitter {
  constructor(logger, timeout, taskLogger) { ... }

  // Запуск задачи — тот же интерфейс
  run(workDir, task, claudeArgs = [], continueSession = false) { ... }

  // Отмена задачи
  cancel(workDir) { ... }

  // Проверка активности
  isRunning(workDir) { ... }

  // Получить активную задачу
  getActive(workDir) { ... }

  // Отмена всех (graceful shutdown)
  cancelAll() { ... }

  // === События (совместимы с listener.js) ===
  // 'complete' → (workDir, task, result)
  //   result: { text, sessionId, cost, numTurns, durationMs, contextWindow, totalTokens }
  // 'error' → (workDir, task, errorMsg)
  // 'timeout' → (workDir, task)
}
```

#### Логика `run()`:

```
1. Есть ли живая PTY-сессия для workDir?
   ├─ Да, continueSession=true  → использовать существующую
   ├─ Да, continueSession=false → pty.write('/clear\n'), подождать
   └─ Нет → создать новую PTY

2. Создание PTY:
   const ptyProcess = pty.spawn('claude', claudeArgs, {
     name: 'xterm-256color',
     cols: 120,
     rows: 40,
     cwd: workDir,
     env: { ...process.env, CLAUDE_NOTIFY_FROM_LISTENER: '1' }
   });

3. Подождать стабилизации вывода (Claude загрузился)

4. Отправить задачу:
   ptyProcess.write(taskText + '\n')

5. Ждать сигнал завершения:
   ptyProcess.onData → (опционально) live progress в Telegram
   ├─ fs.watch ловит маркер-файл → задача завершена
   └─ timeout → emit('timeout')

6. Формировать результат из маркера (НЕ из PTY-потока):
   emit('complete', workDir, task, {
     text: marker.lastAssistantMessage,  // из хука — финальный ответ
     sessionId: marker.sessionId,         // из хука
     cost: marker.cost,                   // из хука
     numTurns: marker.numTurns,           // из хука
     durationMs: marker.durationMs,       // из хука
   })
```

#### Обработка permission requests:

При `--permission-mode auto` или `bypassPermissions` — промптов не будет.
Рекомендация: использовать `--permission-mode auto` для listener.

Для `default` mode — не поддерживается в PTY runner (требует парсинг промпта).
Выдавать ошибку при попытке использовать.

### Фаза 4: Интеграция в listener.js

**Цель**: Переключить listener на PtyRunner.

Изменения в `listener/listener.js`:

```js
// Выбор runner на основе конфигурации
let RunnerClass;
const runnerType = config.listener?.runner || 'pty';

if (runnerType === 'pty') {
  try {
    const { PtyRunner } = await import('./pty-runner.js');
    RunnerClass = PtyRunner;
    logger.info('Using PTY runner');
  } catch (err) {
    logger.warn(`PTY runner unavailable (${err.message}), falling back to pipe runner`);
    const { TaskRunner } = await import('./task-runner.js');
    RunnerClass = TaskRunner;
  }
} else {
  const { TaskRunner } = await import('./task-runner.js');
  RunnerClass = TaskRunner;
  logger.info('Using pipe runner');
}

const runner = new RunnerClass(logger, taskTimeout, taskLogger);
```

Благодаря совместимому интерфейсу, остальной код listener.js не меняется.

### Фаза 5: Live progress в Telegram (опционально)

PTY даёт возможность отправлять промежуточный вывод в Telegram.
Для этого нужна очистка ANSI-кодов из PTY-потока — но это только для отображения,
**не для результата** (результат берётся из хука).

Простейший вариант: библиотека `strip-ansi` (zero-dependency) или regex.

```js
// В pty-runner.js
ptyProcess.onData((data) => {
  rawBuffer += data;

  // Отправлять промежуточные updates каждые N секунд
  if (shouldSendUpdate()) {
    const clean = stripAnsi(rawBuffer.slice(-1000));
    this.emit('progress', workDir, task, clean);
  }
});
```

В `listener.js` — обработчик `progress`:
```js
runner.on('progress', async (workDir, task, partialText) => {
  await poller.editMessage(task.runningMessageId, `⏳ ...\n<pre>${escapeHtml(partialText)}</pre>`);
});
```

Эта фаза полностью опциональна — без неё система работает,
просто пользователь не видит live progress.

## 5. Конфигурация

### Новые параметры в `claude-notify.config.json`:

```json
{
  "listener": {
    "runner": "pty",
    "pty": {
      "cols": 120,
      "rows": 40,
      "sessionTimeout": 3600000,
      "progressUpdates": true,
      "progressInterval": 10000,
      "signalDir": "~/.claude/pty-signals"
    }
  }
}
```

| Параметр | Описание | Default |
|----------|----------|---------|
| `runner` | `"pty"` или `"pipe"` (fallback на старый TaskRunner) | `"pty"` |
| `pty.cols` | Ширина терминала | 120 |
| `pty.rows` | Высота терминала | 40 |
| `pty.sessionTimeout` | Таймаут неактивной PTY-сессии (мс) | 3600000 (1ч) |
| `pty.progressUpdates` | Отправлять progress в Telegram | true |
| `pty.progressInterval` | Интервал progress updates (мс) | 10000 |
| `pty.signalDir` | Директория файлов-маркеров | `~/.claude/pty-signals` |

### Переменная окружения:

```
CLAUDE_NOTIFY_RUNNER=pty|pipe
```

## 6. Зависимости

### Новая зависимость:

```json
{
  "optionalDependencies": {
    "node-pty": "^1.0.0"
  }
}
```

`node-pty` как **optional dependency** — если не установился (нет build tools),
listener автоматически fallback на pipe runner (`TaskRunner`).

### Проблема: нативная компиляция

`node-pty` — нативный модуль. Требуемые build tools:
- Windows: Visual Studio Build Tools (C++ workload)
- macOS: Xcode Command Line Tools
- Linux: `build-essential`, `python3`

Альтернатива: `node-pty-prebuilt-multiarch` — prebuild бинарники,
меньше проблем с компиляцией.

## 7. Изменения в notifier.js

Текущее поведение при `CLAUDE_NOTIFY_FROM_LISTENER === '1'`:
```js
// notifier.js:161-163 — просто выходит, не отправляет нотификации
return process.env.CLAUDE_NOTIFY_FROM_LISTENER === '1'
  && process.env.CLAUDE_NOTIFY_AFTER_LISTENER !== '1';
```

Новое поведение — добавить запись файла-маркера перед выходом:

```js
function isNotifierDisabled () {
  if (process.env.CLAUDE_NOTIFY_DISABLE === '1'
    || process.env.CLAUDE_NOTIFY_DISABLE === 'true') {
    return true;
  }
  if (process.env.CLAUDE_NOTIFY_FROM_LISTENER === '1'
    && process.env.CLAUDE_NOTIFY_AFTER_LISTENER !== '1') {
    // НЕ выходим сразу — сначала пишем маркер (если Stop), потом выходим
    return 'listener-only';  // новый статус
  }
  return false;
}
```

В секции обработки `Stop`:
```js
const disabled = isNotifierDisabled();
if (disabled === true) process.exit(0);

// ... парсинг event, определение eventType ...

if (disabled === 'listener-only' && eventType === 'Stop') {
  // Записать файл-маркер для PtyRunner
  writeSignalFile(event);
  process.exit(0);
}
if (disabled === 'listener-only') {
  process.exit(0);
}
```

## 8. Риски и mitigation

| Риск | Вероятность | Mitigation |
|------|-------------|------------|
| Хуки не вызываются в PTY | Низкая | Хуки — штатный механизм CC, должны работать. Проверить в Фазе 1 |
| Формат hook JSON меняется | Низкая | Defensive parsing, optional fields |
| ANSI-коды различаются Windows vs Unix | Средняя | Тесты на каждой платформе |
| `node-pty` не компилируется у пользователя | Средняя | Optional dep + fallback на pipe mode |
| `fs.watch` ненадёжен на некоторых FS | Низкая | Polling fallback (setInterval + fs.stat) |
| Утечка PTY-процессов при crash | Низкая | Cleanup при SIGTERM/SIGINT, watchdog |
| Race condition: маркер до стабилизации PTY | Низкая | Буфер продолжает собираться после маркера, small delay |
| Несколько Claude в одном workDir | Средняя | sessionId в маркере для точного сопоставления |

**Снятые риски** (по сравнению с чистым PTY-парсингом):
- ~~Определение "промпт готов" ненадёжно~~ → хук надёжно сообщает
- ~~Метрики (cost, tokens) недоступны~~ → приходят в hook JSON
- ~~Permission prompts блокируют выполнение~~ → `--permission-mode auto`

## 9. Тестирование

### Ручные тесты (приоритет):

1. **Хуки в PTY**: Claude запущен через node-pty, хук Stop вызывается, JSON корректный
2. **IPC маркер**: notifier.js записывает маркер, PtyRunner его читает
3. **Базовый цикл**: задача → PTY → хук → маркер → complete event
4. **Продолжение сессии**: две задачи подряд в одном PTY
5. **Новая сессия**: `/clear` между задачами
6. **Таймаут**: задача превышает timeout, PTY убивается
7. **Отмена**: `/cancel` корректно убивает PTY
8. **Параллельные сессии**: два workDir одновременно
9. **Windows + macOS + Linux**: кроссплатформенная проверка
10. **Потоковый вывод**: progress updates в Telegram
11. **Fallback**: `node-pty` отсутствует → работает через pipe mode

### E2E тесты через Playwright + Telegram Web

**Страница**: `https://web.telegram.org/k/#@claude_notify_my_bot`
**Бот**: ClaudeNotify

#### Предусловия

1. Требуется авторизация в Telegram Web (QR-код, сканировать с телефона)
2. Listener должен быть запущен (`claude-notify listener start`)
3. Доступ к `api.telegram.org` из среды выполнения
4. Проекты настроены в `~/.claude/claude-notify.config.json`

#### Алгоритм работы с Telegram Web через Playwright

**Авторизация** (при первом запуске):
```
1. browser_navigate → https://web.telegram.org/k/#@claude_notify_my_bot
2. browser_take_screenshot → проверить: QR-код или чат
3. Если QR-код → пользователь сканирует → browser_wait_for(time: 30)
4. browser_take_screenshot → подтвердить вход
```

**Навигация к боту** (если чат не открыт автоматически):
```
1. browser_snapshot → найти "ClaudeNotify" в списке чатов
2. browser_click → кликнуть по чату ClaudeNotify
3. browser_wait_for(time: 2)
```

**Отправка сообщения боту**:
```
1. browser_snapshot → найти поле ввода (ref содержит "Message")
2. browser_click(ref) → кликнуть по контейнеру поля ввода
3. browser_type(ref, text, slowly: true) → набрать текст
   ВАЖНО: поле ввода — contenteditable div, НЕ input/textarea.
   Использовать slowly: true для посимвольного ввода.
4. browser_press_key("Enter") → отправить
```

**Ожидание ответа от бота**:
```
1. browser_wait_for(time: N) → подождать N секунд (зависит от сложности задачи)
   Для простых задач: 30-60 сек
   Для сложных: 120-300 сек
2. browser_take_screenshot → визуальная проверка
3. browser_snapshot → найти новые сообщения от бота (без "cursor=pointer" на
   timestamp, или по тексту ответа)
```

**Проверка содержимого ответа**:
```
1. browser_snapshot → получить текст всех сообщений
2. Найти сообщения от бота (они слева, без зелёного фона)
3. Проверить наличие ожидаемых маркеров:
   - "Running..." (⏳) — задача принята
   - Результат (✅/❌) — задача завершена
   - Текст ответа Claude
```

#### Тест-кейсы E2E

**Тест 1: Эмуляция Stop-хука → сообщение в чате**
```
Цель: Проверить что notifier.js отправляет уведомление в Telegram

1. [Bash] Отправить UserPromptSubmit:
   echo '{"hook_event_name":"UserPromptSubmit","session_id":"e2e-001",
     "cwd":"/path/to/project","prompt":"test"}' | node notifier/notifier.js

2. [Bash] Подождать 2 сек (чтобы duration > notifyAfterSeconds)

3. [Bash] Отправить Stop:
   echo '{"hook_event_name":"Stop","session_id":"e2e-001",
     "cwd":"/path/to/project",
     "last_assistant_message":"Hook test result"}' | node notifier/notifier.js

4. [Playwright] browser_wait_for(time: 5)
5. [Playwright] browser_take_screenshot → проверить появление сообщения
6. [Playwright] browser_snapshot → найти текст "Hook test result" или
   статус-эмодзи ✅

Ожидаемый результат: В чате появилось сообщение от бота с ✅ и текстом
```

**Тест 2: Задача через listener (pipe mode)**
```
Цель: Полный цикл — отправка задачи → listener → claude -p → ответ в чате

1. [Playwright] Отправить сообщение:
   "/default ответь одним словом: 2+2=?"
   (или "/noti ...", "/web ..." — любой настроенный проект)

2. [Playwright] browser_wait_for(time: 10)
3. [Playwright] browser_take_screenshot → проверить "Running..." (⏳)

4. [Playwright] browser_wait_for(time: 60) — ждём завершения claude -p

5. [Playwright] browser_take_screenshot → проверить результат
6. [Playwright] browser_snapshot → найти ✅ и текст ответа ("4" или "Четыре")

Ожидаемый результат:
  - Сообщение ⏳ "Running..." появилось
  - Сообщение ⏳ удалилось после завершения
  - Сообщение ✅ с ответом "4" появилось
```

**Тест 3: Задача через PTY runner**
```
Цель: Полный цикл в PTY-режиме (после реализации)

Предусловие: listener.runner = "pty" в конфиге

1. [Playwright] Отправить: "/noti ответь одним словом: 2+2=?"
2. [Playwright] browser_wait_for(time: 10) → проверить ⏳
3. [Playwright] browser_wait_for(time: 60) → ждём завершения
4. [Playwright] browser_snapshot → найти ✅ + ответ

Дополнительные проверки:
  - [Bash] Проверить что PTY-процесс жив: ps | grep claude
  - [Bash] Проверить файл-маркер: ls ~/.claude/pty-signals/
  - [Bash] Проверить логи: tail listener.log
```

**Тест 4: Продолжение PTY-сессии**
```
Цель: Вторая задача переиспользует PTY (нет нового spawn)

1. [Playwright] Отправить: "/noti сколько будет 3+3?"
2. [Playwright] browser_wait_for(time: 60)
3. [Playwright] browser_snapshot → проверить 🔄 (continue) + ответ "6"
4. [Bash] Проверить логи — нет нового "PTY created", есть "Reusing PTY session"
```

**Тест 5: Команда /status**
```
1. [Playwright] Отправить: "/status"
2. [Playwright] browser_wait_for(time: 5)
3. [Playwright] browser_snapshot → проверить что бот ответил статусом
```

**Тест 6: Отмена задачи**
```
1. [Playwright] Отправить: "/noti напиши эссе на 1000 слов"
2. [Playwright] browser_wait_for(time: 10) → проверить ⏳
3. [Playwright] Отправить: "/cancel /noti"
4. [Playwright] browser_wait_for(time: 5)
5. [Playwright] browser_snapshot → проверить 🛑 "Task cancelled"
```

**Тест 7: Live progress (PTY mode)**
```
1. Listener runner = "pty", pty.progressUpdates = true
2. [Playwright] Отправить: "/noti прочитай package.json и опиши проект"
3. [Playwright] browser_wait_for(time: 15)
4. [Playwright] browser_take_screenshot → проверить что "Running..." обновляется
   с промежуточным выводом
5. [Playwright] browser_wait_for(time: 60) → дождаться ✅
```

#### Вспомогательные команды Bash для отладки E2E

```bash
# Статус listener
cat ~/.claude/.listener.pid && echo "running" || echo "not running"

# Логи listener (последние 20 строк)
tail -20 D:/logs/.cc-n-listener.log

# State файл notifier
cat ~/.claude/.notifier_state.json

# Проверка доступа к Telegram API
node -e "fetch('https://api.telegram.org/bot<TOKEN>/getMe')
  .then(r=>r.json()).then(console.log).catch(e=>console.error(e.message))"

# Файлы-маркеры PTY (после реализации)
ls ~/.claude/pty-signals/

# Перезапуск listener
claude-notify listener restart
```

### Результаты E2E тестирования (2026-03-20)

**Среда**: Windows 11, Playwright MCP, Telegram Web (`web.telegram.org/k`)

#### Прогон #1

**Тест 1: Эмуляция Stop-хука** — PASSED
- UserPromptSubmit → sleep 2s → Stop с `last_assistant_message`
- Сообщение появилось в чате: `✅ /claude-notification-plugin/master (duration: 8s)`

**Тест 2: Listener pipe mode** — PASSED
- Отправлено через Telegram Web: `/default Ответь одним словом: сколько будет 2+2?`
- Промежуточный статус: `⏳ /default 🔄 #2, ctx 13% Running...`
- Результат через ~6с: `✅ 🔄 /default (#2, 6s, ctx 13%, $0.16)` с ответом Claude

#### Прогон #2 (уточнённый алгоритм)

**Тест 1: Эмуляция Stop-хука (mock stdin)** — PASSED
- Проблема: `echo '...' | node cli.js` не работает на Windows (stdin pipe + ESM).
  Решение: временный скрипт с `Object.defineProperty(process, 'stdin', ...)` + mock Readable.
- Env vars: `CLAUDE_NOTIFY_AFTER_SECONDS=0` (иначе duration=0 < 15 → exit),
  `CLAUDE_NOTIFY_DESKTOP=0`, `CLAUDE_NOTIFY_SOUND=0`, `CLAUDE_NOTIFY_VOICE=0`.
- Ключевое поле: `hook_event_name` (НЕ `hook_type`!) — см. `notifier.js:635`.
- Сообщение `✅ /claude-notification-plugin/master (duration: 0s)` появилось в чате.

**Тест 2: Listener /help** — PASSED
- Отправлено `/help` через Telegram Web (Playwright `pressSequentially` + `Enter`).
- Бот ответил полным списком команд.

**Тест 3: Listener /status** — PASSED
- Отправлено `/status` через Telegram Web.
- Бот ответил: `📊 Status: Uptime: 4m 39s, default: main: ✅ idle`.

#### Важные находки для эмуляции хуков

1. **Формат JSON**: поле `hook_event_name` (не `hook_type`), значения: `Stop`, `UserPromptSubmit`, `Notification`
2. **Таймер**: notifier требует предшествующий `UserPromptSubmit` для session start,
   иначе `duration=0` и `duration < notifyAfterSeconds` (default 15) → silent exit.
   Обходное решение: `CLAUDE_NOTIFY_AFTER_SECONDS=0`
3. **Windows pipe**: `echo '...' | node script.js` ненадёжно работает с ESM + stdin.
   Рабочий подход: mock Readable через `Object.defineProperty(process, 'stdin', ...)`

**Известные нюансы Playwright + Telegram Web**:
- Поле ввода сообщения — `contenteditable div`, не `<input>`. Стандартный `fill` не работает.
  Рабочий подход: `page.locator('.input-message-input[contenteditable="true"]').first()`,
  затем `pressSequentially(text, { delay: 50 })` + `page.keyboard.press('Enter')`.
- Telegram Web кэширует сообщения. Иногда нужен `browser_navigate` для обновления.
- `browser_wait_for(text: "...")` надёжно определяет появление новых сообщений.
- При первом запуске требуется QR-авторизация. Playwright сохраняет сессию в файловом кэше.

#### Перед тестированием — всегда перезапускать listener

```bash
claude-notify listener restart
```

Это критически важно после любых изменений кода listener/notifier.
Без перезапуска listener использует старый код.

### Алгоритм E2E тестирования для PTY runner

```
=== ПРЕДУСЛОВИЯ ===
1. Listener запущен: claude-notify listener start
2. Telegram Web авторизован (Playwright кэш сессии)

=== ТЕСТ A: Notifier → Telegram (без listener) ===
1. [Bash] echo '{"hook_event_name":"UserPromptSubmit","session_id":"<ID>",
     "cwd":"<PATH>"}' | node notifier/notifier.js
3. [Bash] sleep 2
4. [Bash] echo '{"hook_event_name":"Stop","session_id":"<ID>",
     "cwd":"<PATH>","last_assistant_message":"<TEXT>"}' | \
     node notifier/notifier.js
5. [Playwright] browser_wait_for(text: "<TEXT>")
6. [Playwright] browser_snapshot → проверить ✅ + текст
7. [Bash] cat ~/.claude/.notifier_state.json → подтвердить новый sentMessage

=== ТЕСТ B: Listener full cycle (pipe mode) ===
1. [Playwright] browser_navigate → https://web.telegram.org/k/#@claude_notify_my_bot
2. [Playwright] browser_click → чат ClaudeNotify (если не открыт)
3. [Playwright] browser_evaluate → insertText("/default <простой вопрос>")
4. [Playwright] browser_press_key("Enter")
5. [Playwright] browser_wait_for(text: "Running...") → задача принята
6. [Playwright] browser_wait_for(time: 30-60) → ожидание завершения
7. [Playwright] browser_snapshot → проверить ✅ + ответ Claude
8. [Bash] tail -5 <listener-log> → подтвердить "Task completed"

=== ТЕСТ C: Listener full cycle (PTY mode, после реализации) ===
1. [Bash] Убедиться runner=pty в конфиге, listener перезапущен
2. Шаги 2-7 из Теста B
3. [Bash] ls ~/.claude/pty-signals/ → проверить маркер-файл
4. [Bash] tail -10 <listener-log> → "Using PTY runner", "Reusing PTY session"

=== ТЕСТ D: Продолжение PTY-сессии ===
1. Выполнить Тест C (первая задача)
2. Повторить шаги 3-7 с новым вопросом
3. [Bash] Проверить логи: "Reusing PTY session" (не "PTY created")
4. [Playwright] Проверить 🔄 (continue marker) в ответе

=== ПРОВЕРКА ОШИБОК ===
- Если сообщение не появляется:
  1. cat ~/.claude/.notifier_state.json → есть ли новый sentMessage?
  2. curl Telegram API напрямую → проверить доступность бота
  3. Проверить deleteAfterHours в конфиге (слишком маленькое значение?)
```
### Автоматические тесты (unit):

```
tests/
  pty-runner.test.js  — mock pty + mock fs.watch, проверка событий и маркеров
```

## 10. Порядок реализации (шаги)

```
Шаг 1. [Исследование] Тестовый PTY-скрипт
        → Убедиться что хуки работают в PTY-режиме
        → Записать hook JSON: подтвердить наличие last_assistant_message
        → Проверить на Windows и Unix

Шаг 2. [IPC] Файл-маркер
        → Изменить notifier.js: при FROM_LISTENER + Stop → писать маркер
        → Маркер содержит last_assistant_message (= текст ответа) + метрики
        → Тест: хук → маркер → чтение

Шаг 3. [Runner] pty-runner.js
        → Создание/переиспользование PTY сессий
        → fs.watch на директорию маркеров
        → result.text = marker.lastAssistantMessage (из хука, НЕ из PTY)
        → Совместимый EventEmitter интерфейс
        → Timeout и cancel

Шаг 4. [Интеграция] listener.js
        → Переключение на PtyRunner с fallback
        → Конфигурация runner type

Шаг 5. [Live progress] Опционально
        → strip-ansi для PTY-потока
        → Событие 'progress' → обновление Telegram-сообщения

Шаг 6. [Тестирование] Кроссплатформенные тесты
        → Windows, macOS, Linux
        → Стресс-тесты сессий
```

## 11. Файлы для создания/изменения

| Файл | Действие | Описание |
|------|----------|----------|
| `listener/pty-runner.js` | Создать | PTY-based runner с fs.watch на маркеры. Ответ берёт из маркера (last_assistant_message), не из PTY |
| `notifier/notifier.js` | Изменить | При FROM_LISTENER + Stop → записать файл-маркер с last_assistant_message + метриками |
| `listener/listener.js` | Изменить | Выбор runner (pty/pipe), fallback |
| `listener/task-runner.js` | Оставить | Fallback для pipe mode |
| `bin/listener-cli.js` | Изменить | Показывать тип runner в status |
| `package.json` | Изменить | `optionalDependencies: { "node-pty" }` |
| `scripts/pty-test.js` | Создать | Тестовый скрипт (удалить после) |
| `README.md` | Изменить | Документация PTY mode |

## 12. Сравнение подходов

| Аспект | Чистый PTY-парсинг | Hook-based (этот план) |
|--------|-------------------|----------------------|
| Определение завершения | Парсинг промпта (ненадёжно) | Hook `Stop` (штатный механизм) |
| Текст ответа | Парсинг PTY-потока (зашумлён tool calls и спиннерами) | `last_assistant_message` из хука (чистый финальный ответ) |
| Метрики (cost, tokens) | Парсинг `/cost` или потеря | Приходят в hook JSON |
| Сложность парсера | State machine + промпт detection | Не нужен (ANSI cleanup только для опционального progress) |
| Хрупкость | Высокая (зависит от формата вывода) | Низкая (hook API стабильнее) |
| Зависимость от версии CC | Высокая | Низкая |
| Количество нового кода | Большое | Малое (1 новый файл + правка notifier.js) |
| Необходимость в изменении notifier.js | Нет | Да (добавить запись маркера) |
