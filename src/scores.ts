// Offline high-score board (localStorage). These records will move onchain later.
export interface ScoreEntry {
  name: string;
  score: number;
  seed: string;
  commit: string;
  date: string; // ISO
}

const KEY = 'substrate.records.v1';
const HANDLE_KEY = 'substrate.handle';

export function loadScores(): ScoreEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as ScoreEntry[]) : [];
    return Array.isArray(list) ? list.slice(0, 10) : [];
  } catch {
    return [];
  }
}

/** Insert and keep the top 10. Returns the 1-based rank, or 0 if it didn't make the board. */
export function saveScore(entry: ScoreEntry): number {
  const list = loadScores();
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
  const top = list.slice(0, 10);
  try { localStorage.setItem(KEY, JSON.stringify(top)); } catch { /* storage full or blocked */ }
  return top.indexOf(entry) + 1;
}

export function qualifies(score: number): boolean {
  const list = loadScores();
  return list.length < 10 || score > list[list.length - 1].score;
}

export function loadHandle(): string {
  try { return localStorage.getItem(HANDLE_KEY) ?? ''; } catch { return ''; }
}
export function saveHandle(h: string) {
  try { localStorage.setItem(HANDLE_KEY, h); } catch { /* ignore */ }
}
