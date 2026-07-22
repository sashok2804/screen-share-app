import { describe, expect, it } from 'vitest';
import { findProcessBySourceName } from '../src/hooks/useScreenShare';
import type { AudioProcess } from '../src/electron';

/**
 * Tests for the `findProcessBySourceName` heuristic used by the auto-audio
 * picker. The function resolves a chosen video window source's `name` (a
 * window title as returned by Electron's `desktopCapturer`) to a PID by
 * joining against the PowerShell `Get-Process` result from `audio:listProcesses`.
 *
 * Strategies exercised here (in priority order):
 *   (1) exact title equality
 *   (2) title ↔ source.name substring either way
 *   (3) source.name contains process.name (e.g. "...Google Chrome" → "chrome")
 *   (4) leading-token equality
 *
 * Each test seeds a small list of fake processes and asserts the resolved PID
 * (or `null` when no match is expected).
 */

const PROCS: AudioProcess[] = [
  { pid: 1001, name: 'chrome', title: 'YouTube — Google Chrome' },
  { pid: 1002, name: 'Discord', title: 'Discord' },
  { pid: 1003, name: 'Spotify', title: 'Menu — Spotify' },
  { pid: 1004, name: 'javaw', title: 'Minecraft 1.20.4' },
];

describe('findProcessBySourceName', () => {
  it('returns null for an empty process list', () => {
    expect(findProcessBySourceName([], 'anything')).toBeNull();
  });

  it('returns null for an empty source name', () => {
    expect(findProcessBySourceName(PROCS, '')).toBeNull();
    expect(findProcessBySourceName(PROCS, '   ')).toBeNull();
  });

  it('strategy (1): exact title match', () => {
    expect(findProcessBySourceName(PROCS, 'Discord')).toEqual(PROCS[1]);
  });

  it('strategy (2): source.name is a substring of the title', () => {
    // Window title "Menu — Spotify" → matched when source.name is the title
    // fragment used by desktopCapturer (it varies; sometimes the full title,
    // sometimes a trimmed form). We accept either direction.
    expect(findProcessBySourceName(PROCS, 'Menu — Spotify')?.pid).toBe(1003);
    // And the reverse — source.name contains title.
    expect(findProcessBySourceName(PROCS, 'Minecraft 1.20.4')?.pid).toBe(1004);
  });

  it('strategy (3): source.name contains process.name (case-insensitive)', () => {
    // desktopCapturer window title for a Chrome tab usually embeds "Chrome".
    expect(findProcessBySourceName(PROCS, 'some tab — Google Chrome')?.pid).toBe(1001);
  });

  it('returns null when nothing matches', () => {
    expect(findProcessBySourceName(PROCS, 'Totally Unknown App 9000')).toBeNull();
  });

  it('is case-insensitive on the contains check', () => {
    expect(findProcessBySourceName(PROCS, ' watching CHROME ')?.pid).toBe(1001);
  });

  it('strategy (4): falls back to leading-token equality', () => {
    // Build a list where only the leading-token rule can match: source.name
    // starts with the bare process name but contains it nowhere else.
    const procs: AudioProcess[] = [
      { pid: 5555, name: 'Calculator', title: 'something else entirely' },
    ];
    expect(findProcessBySourceName(procs, 'Calculator Plus Plus')?.pid).toBe(5555);
  });

  it('does not match a 1-char process name (avoids "c"/"a" false positives)', () => {
    const procs: AudioProcess[] = [
      { pid: 9, name: 'a', title: 'aaa' },
    ];
    // contains check should be skipped for 1-char names; no other strategy
    // applies → null.
    expect(findProcessBySourceName(procs, 'a window')).toBeNull();
  });
});
