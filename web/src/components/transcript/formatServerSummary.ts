// Re-export shim. Single source of truth in shared/src/formatServerSummary.ts
// (consumed by both web and server-side tests). Existing imports keep working.

export { formatServerSummary } from "../../../../shared/src/formatServerSummary";
