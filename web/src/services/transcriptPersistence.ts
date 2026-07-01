// transcriptPersistence.ts
// Service to save and restore transcripts using localStorage.
// For larger transcripts, consider switching to IndexedDB.

const STORAGE_KEY = 'transcript';

/**
 * Save a transcript (array of messages) to localStorage.
 * @param transcript - The transcript data to persist.
 */
export function saveTranscript(transcript: unknown[]): void {
  try {
    const serialized = JSON.stringify(transcript);
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (error) {
    console.error('Failed to save transcript:', error);
  }
}

/**
 * Load the saved transcript from localStorage.
 * @returns The saved transcript array, or null if none exists.
 */
export function loadTranscript(): unknown[] | null {
  try {
    const serialized = localStorage.getItem(STORAGE_KEY);
    if (serialized === null) {
      return null;
    }
    return JSON.parse(serialized) as unknown[];
  } catch (error) {
    console.error('Failed to load transcript:', error);
    return null;
  }
}

/**
 * Remove the saved transcript from localStorage.
 */
export function clearTranscript(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear transcript:', error);
  }
}
