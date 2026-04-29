// Tiny module exporting a function called oldSum.
// The directive: rename oldSum to addNumbers across the entire repo.
// Verify checks that NO file in src/ still references oldSum.
export function oldSum(a, b) {
  return a + b;
}
