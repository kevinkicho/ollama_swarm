// V2 Step 2: re-export from shared/. Single source of truth in
// shared/src/extractJson.ts (consumed by both server and web). This
// file kept as a back-compat re-export so existing imports
// (`import { extractJsonFromText } from "../extractJson.js"`) keep
// working without touching every prompt parser.

export { extractJsonFromText, extractFirstBalanced } from "../../../shared/src/extractJson.js";
