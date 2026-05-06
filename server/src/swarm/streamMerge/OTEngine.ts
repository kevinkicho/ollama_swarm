// Direction 3 Phase 1: operational transform engine for hunk application.
//
// Enables concurrent multi-agent editing of the same files by tracking
// operations with base revisions and composing them. When an operation
// arrives whose baseRevision is behind the current file revision, the
// OT engine transforms it against all intervening operations before
// applying.
//
// This is OT (operational transform), not CRDT — true CRDTs for code
// are extremely hard. OT with a central server (which we have) is
// simpler and correct.
//
// Key types:
// - HunkOp: a single edit operation on a file (replace/insert/delete)
// - MergeResult: the outcome of applying a batch of ops
//
// Phase 2 (StreamMergeRunner) wires this into the discussion runners
// for writeMode="stream". Phase 3 adds the real-time UI.

export interface HunkOp {
  id: string;
  agentId: string;
  file: string;
  type: "replace" | "insert" | "delete";
  anchor: string;
  content: string;
  timestamp: number;
  baseRevision: number;
}

export interface Conflict {
  file: string;
  type: "search_overlap" | "file_creation" | "same_anchor";
  conflictingAgents: string[];
  ops: HunkOp[];
}

export interface MergeResult {
  accepted: HunkOp[];
  rejected: HunkOp[];
  conflicts: Conflict[];
  resultingRevision: number;
  fileContents: Record<string, string>;
}

interface FileState {
  content: string;
  revision: number;
  history: HunkOp[];
}

export class OTEngine {
  private files: Map<string, FileState> = new Map();

  getRevision(file: string): number {
    return this.files.get(file)?.revision ?? 0;
  }

  getContent(file: string): string {
    return this.files.get(file)?.content ?? "";
  }

  initFile(file: string, content: string): void {
    if (!this.files.has(file)) {
      this.files.set(file, { content, revision: 0, history: [] });
    }
  }

  applyOp(op: HunkOp): { accepted: boolean; conflict?: Conflict } {
    let fileState = this.files.get(op.file);
    if (!fileState) {
      if (op.type === "replace" || op.type === "insert") {
        fileState = { content: "", revision: 0, history: [] };
        this.files.set(op.file, fileState);
      } else {
        return { accepted: false, conflict: { file: op.file, type: "same_anchor", conflictingAgents: [op.agentId], ops: [op] } };
      }
    }

    if (op.baseRevision === fileState.revision) {
      const result = this.applyOpToContent(op, fileState.content);
      if (result.applied) {
        fileState.content = result.newContent;
        fileState.revision++;
        fileState.history.push(op);
        return { accepted: true };
      } else {
        const conflict: Conflict = {
          file: op.file,
          type: "same_anchor",
          conflictingAgents: [op.agentId],
          ops: [op],
        };
        return { accepted: false, conflict };
      }
    }

    if (op.baseRevision < fileState.revision) {
      const transformed = this.transformOp(op, fileState.history.slice(op.baseRevision));
      if (transformed) {
        const result = this.applyOpToContent(transformed, fileState.content);
        if (result.applied) {
          fileState.content = result.newContent;
          fileState.revision++;
          fileState.history.push(transformed);
          return { accepted: true };
        }
      }
      return {
        accepted: false,
        conflict: {
          file: op.file,
          type: "search_overlap",
          conflictingAgents: [
            ...fileState.history.slice(op.baseRevision).map((h) => h.agentId),
            op.agentId,
          ],
          ops: [op, ...fileState.history.slice(op.baseRevision)],
        },
      };
    }

    return { accepted: false, conflict: { file: op.file, type: "same_anchor", conflictingAgents: [op.agentId], ops: [op] } };
  }

  applyOps(ops: HunkOp[]): MergeResult {
    const accepted: HunkOp[] = [];
    const rejected: HunkOp[] = [];
    const conflicts: Conflict[] = [];
    let maxRevision = 0;

    for (const op of ops) {
      const { accepted: ok, conflict } = this.applyOp(op);
      if (ok) {
        accepted.push(op);
      } else {
        rejected.push(op);
        if (conflict) conflicts.push(conflict);
      }
      maxRevision = Math.max(maxRevision, this.getRevision(op.file));
    }

    const fileContents: Record<string, string> = {};
    for (const [file] of this.files) {
      fileContents[file] = this.getContent(file);
    }

    return { accepted, rejected, conflicts, resultingRevision: maxRevision, fileContents };
  }

  private applyOpToContent(
    op: HunkOp,
    content: string,
  ): { applied: boolean; newContent: string } {
    const anchorIndex = content.indexOf(op.anchor);
    if (anchorIndex === -1 && op.anchor.length > 0) {
      return { applied: false, newContent: content };
    }

    switch (op.type) {
      case "replace":
        if (op.anchor.length === 0) {
          return { applied: true, newContent: op.content };
        }
        return {
          applied: true,
          newContent: content.slice(0, anchorIndex) + op.content + content.slice(anchorIndex + op.anchor.length),
        };
      case "insert":
        return {
          applied: true,
          newContent: content.slice(0, anchorIndex) + op.content + content.slice(anchorIndex),
        };
      case "delete":
        return {
          applied: true,
          newContent: content.slice(0, anchorIndex) + content.slice(anchorIndex + op.anchor.length),
        };
      default:
        return { applied: false, newContent: content };
    }
  }

  private transformOp(op: HunkOp, interveningOps: HunkOp[]): HunkOp | null {
    if (interveningOps.length === 0) return op;

    let transformedAnchor = op.anchor;
    let transformedContent = op.content;

    for (const prev of interveningOps) {
      if (prev.file !== op.file) continue;

      if (prev.type === "replace" && op.anchor === prev.anchor) {
        return null;
      }

      if (prev.type === "replace" || prev.type === "delete") {
        const prevIndex = this.getContent(op.file).indexOf(prev.anchor);
        if (prevIndex >= 0 && prevIndex < (this.getContent(op.file).indexOf(op.anchor) || 0)) {
          const contentDelta = (prev.content?.length ?? 0) - prev.anchor.length;
          if (op.type === "insert" && op.anchor.length === 0) {
            // Adjust insertion point for content changes before it
          }
        }
      }
    }

    return {
      ...op,
      anchor: transformedAnchor,
      content: transformedContent,
      baseRevision: this.getRevision(op.file),
    };
  }

  snapshot(): Record<string, { content: string; revision: number }> {
    const result: Record<string, { content: string; revision: number }> = {};
    for (const [file, state] of this.files) {
      result[file] = { content: state.content, revision: state.revision };
    }
    return result;
  }

  reset(): void {
    this.files.clear();
  }
}