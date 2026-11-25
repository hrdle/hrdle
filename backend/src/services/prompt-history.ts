import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { homeShortPath } from '../utils/home-path';

interface PromptEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

export interface PromptSearchResult {
  display: string;
  timestamp: string;
  project: string;
  projectName: string;
  sessionId: string;
}

export class PromptHistoryService {
  private historyPath: string;

  constructor() {
    this.historyPath = join(homedir(), '.claude', 'history.jsonl');
  }

  async searchPrompts(query: string, limit: number = 20): Promise<PromptSearchResult[]> {
    const results: PromptSearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    try {
      const fileStream = createReadStream(this.historyPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      const allEntries: PromptEntry[] = [];

      for await (const line of rl) {
        try {
          const entry: PromptEntry = JSON.parse(line);

          // Skip empty prompts
          if (!entry.display || entry.display.trim().length === 0) continue;

          // Check if query matches (case-insensitive)
          if (entry.display.toLowerCase().includes(lowerQuery)) {
            allEntries.push(entry);
          }
        } catch {
          // Skip invalid lines
        }
      }

      // Sort by timestamp descending (newest first)
      allEntries.sort((a, b) => b.timestamp - a.timestamp);

      // Take limit and format results
      for (const entry of allEntries.slice(0, limit)) {
        results.push({
          display: entry.display,
          timestamp: new Date(entry.timestamp).toISOString(),
          project: entry.project,
          projectName: homeShortPath(entry.project),
          sessionId: entry.sessionId,
        });
      }
    } catch {
      // Return empty on error
    }

    return results;
  }

  async getRecentPrompts(limit: number = 20): Promise<PromptSearchResult[]> {
    const results: PromptSearchResult[] = [];

    try {
      const fileStream = createReadStream(this.historyPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      const allEntries: PromptEntry[] = [];

      for await (const line of rl) {
        try {
          const entry: PromptEntry = JSON.parse(line);

          // Skip empty prompts
          if (!entry.display || entry.display.trim().length === 0) continue;

          allEntries.push(entry);
        } catch {
          // Skip invalid lines
        }
      }

      // Sort by timestamp descending (newest first)
      allEntries.sort((a, b) => b.timestamp - a.timestamp);

      // Take limit and format results
      for (const entry of allEntries.slice(0, limit)) {
        results.push({
          display: entry.display,
          timestamp: new Date(entry.timestamp).toISOString(),
          project: entry.project,
          projectName: homeShortPath(entry.project),
          sessionId: entry.sessionId,
        });
      }
    } catch {
      // Return empty on error
    }

    return results;
  }
}
