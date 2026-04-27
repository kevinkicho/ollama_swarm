// V2 Step 2: re-export from shared/. Single source of truth in
// shared/src/extractJson.ts. Web-side existing imports
// (`import { extractFirstBalancedJson } from "./extractJson"`) keep
// working without touching every callsite.

export {
  extractFirstBalancedJson,
  extractFirstBalanced,
  extractJsonFromText,
} from "../../../shared/src/extractJson";
