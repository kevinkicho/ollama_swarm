// V2 Step 2: shared types + parsers used by both server (envelope
// validation, prompt response parsing) and web (transcript bubble
// rendering, structured summary derivation). Single source of truth.

export {
  extractJsonFromText,
  extractFirstBalanced,
  extractFirstBalancedJson,
} from "./extractJson.js";
