import xtermPkg from '@xterm/headless';

const { Terminal } = xtermPkg;

// Must match the dimensions PTY sessions are spawned with (pty-runner.js).
// Mismatch produces wrap artifacts in the rendered viewport.
const COLS = 120;
const ROWS = 40;

// Run raw PTY bytes through a headless xterm.js so the *final* visible screen
// is what we read out — cursor positioning, line erases, scroll-up, etc. are
// all honored. Without this, transient UI (e.g. the slash-command popup that
// briefly appears while typing `/clear`) leaks into the captured output even
// though the real terminal has long since cleared those rows.
//
// Returns the viewport text (ROWS lines joined by \n) with trailing empty
// lines trimmed. Scrollback is intentionally ignored — Telegram messages
// reflect the on-screen state, not the entire session history.
export async function renderPtyScreen (raw) {
  if (!raw) {
    return '';
  }
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  await new Promise((resolve) => term.write(raw, resolve));
  const buf = term.buffer.active;
  const lines = [];
  const startY = buf.viewportY;
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(startY + y);
    lines.push(line ? line.translateToString(true) : '');
  }
  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop();
  }
  if (typeof term.dispose === 'function') {
    term.dispose();
  }
  return lines.join('\n');
}

export { COLS as RENDER_COLS, ROWS as RENDER_ROWS };
