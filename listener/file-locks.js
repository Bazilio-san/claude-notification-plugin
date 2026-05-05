import { spawn } from 'child_process';

// PowerShell + Win32 Restart Manager API. Compiles a tiny C# helper on first
// run (~1–2s cold start) and reuses it for the life of the process. Reads
// file paths from stdin (one per line, UTF-8) — avoids argv escaping issues
// for paths with spaces, quotes, or non-ASCII characters.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace ResMgr {
  public static class Locker {
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME t; }
    const int N_APP = 256; const int N_SVC = 64;
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct RM_PROCESS_INFO {
      public RM_UNIQUE_PROCESS Process;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst=N_APP)] public string strAppName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst=N_SVC)] public string strServiceShortName;
      public uint ApplicationType; public uint AppStatus; public uint TSSessionId;
      [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
    static extern int RmStartSession(out uint h, int f, string k);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
    static extern int RmRegisterResources(uint h, uint nF, string[] f, uint nA, [In] RM_UNIQUE_PROCESS[] a, uint nS, string[] s);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint h, out uint need, ref uint cnt, [In, Out] RM_PROCESS_INFO[] info, ref uint reason);
    public static List<int> WhoIsLocking(string path) {
      var pids = new List<int>();
      uint handle;
      if (RmStartSession(out handle, 0, Guid.NewGuid().ToString()) != 0) return pids;
      try {
        if (RmRegisterResources(handle, 1, new []{path}, 0, null, 0, null) != 0) return pids;
        uint need = 0, cnt = 0, reason = 0;
        int res = RmGetList(handle, out need, ref cnt, null, ref reason);
        if (res == 234 && need > 0) {
          var info = new RM_PROCESS_INFO[need]; cnt = need;
          if (RmGetList(handle, out need, ref cnt, info, ref reason) == 0) {
            for (int i = 0; i < cnt; i++) pids.Add(info[i].Process.dwProcessId);
          }
        }
      } finally { RmEndSession(handle); }
      return pids;
    }
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop | Out-Null
$line = $null
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line -eq '') { continue }
  try {
    $pids = [ResMgr.Locker]::WhoIsLocking($line)
    Write-Output ("OK\`t" + $line + "\`t" + ($pids -join ','))
  } catch {
    Write-Output ("ERR\`t" + $line + "\`t" + $_.Exception.Message)
  }
}
`;

/**
 * Find PIDs of processes that have an open handle to each given file path.
 * Returns a Map<filePath, number[]>. Paths absent from the map mean "no
 * detection (tool unavailable or error)" — callers should treat as unknown,
 * not as "free".
 *
 * On Windows, spawns a single PowerShell with the Restart Manager API and
 * feeds all paths via stdin to amortize PowerShell's ~1–2s cold start.
 * On Linux/macOS, uses `lsof -F p` for the same.
 */
export async function findLocking (filePaths, logger) {
  if (!filePaths || filePaths.length === 0) {
    return new Map();
  }
  if (process.platform === 'win32') {
    return findLockingWindows(filePaths, logger);
  }
  return findLockingUnix(filePaths, logger);
}

function findLockingWindows (filePaths, logger) {
  return new Promise((resolve) => {
    const result = new Map();
    let proc;
    try {
      proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', PS_SCRIPT,
      ], { windowsHide: true });
    } catch (err) {
      logger?.warn(`file-locks: spawn powershell failed: ${err.message}`);
      resolve(result);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith('OK\t')) {
          continue;
        }
        const parts = line.split('\t');
        const filePath = parts[1];
        const pids = (parts[2] || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
        result.set(filePath, pids);
      }
      if (stderr.trim() && logger) {
        logger.warn(`file-locks: powershell stderr: ${stderr.trim().slice(0, 200)}`);
      }
      resolve(result);
    };

    proc.stdout.on('data', (d) => {
      stdout += d.toString('utf-8'); 
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString('utf-8'); 
    });
    proc.on('close', finish);
    proc.on('error', (err) => {
      logger?.warn(`file-locks: powershell error: ${err.message}`);
      finish();
    });

    const timer = setTimeout(() => {
      try {
        proc.kill(); 
      } catch { /* ignore */ }
      logger?.warn('file-locks: powershell timed out (15s)');
      finish();
    }, 15_000);
    proc.on('close', () => clearTimeout(timer));

    try {
      proc.stdin.write(filePaths.join('\n') + '\n', 'utf-8');
      proc.stdin.end();
    } catch (err) {
      logger?.warn(`file-locks: stdin write failed: ${err.message}`);
      finish();
    }
  });
}

function findLockingUnix (filePaths, logger) {
  return new Promise((resolve) => {
    const result = new Map();
    let proc;
    try {
      proc = spawn('lsof', ['-F', 'pn', '--', ...filePaths]);
    } catch (err) {
      logger?.warn(`file-locks: spawn lsof failed: ${err.message}`);
      resolve(result);
      return;
    }
    let stdout = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString('utf-8'); 
    });
    proc.on('error', () => resolve(result));
    proc.on('close', () => {
      // lsof -F pn: lines starting with `p` are PIDs, `n` are file names.
      // Parse pairs: each `n<path>` belongs to the most recent `p<pid>`.
      let currentPid = 0;
      const pathSet = new Set(filePaths);
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = parseInt(line.slice(1), 10) || 0;
        } else if (line.startsWith('n') && currentPid > 0) {
          const p = line.slice(1);
          if (pathSet.has(p)) {
            const arr = result.get(p) || [];
            if (!arr.includes(currentPid)) {
              arr.push(currentPid);
            }
            result.set(p, arr);
          }
        }
      }
      resolve(result);
    });
  });
}

/**
 * Forcefully kill a process by PID. Returns true on success.
 */
export async function killPid (pid, logger) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const proc = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', (err) => {
        logger?.warn(`file-locks: taskkill error: ${err.message}`);
        resolve(false);
      });
    });
  }
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (err) {
    logger?.warn(`file-locks: kill ${pid} failed: ${err.message}`);
    return false;
  }
}
