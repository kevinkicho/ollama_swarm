// Returns the numbers from `start` down to and INCLUDING 1.
// countDown(3) should return [3, 2, 1].
//
// Bug: the loop terminates one iteration too early.
// Fixture: a swarm or baseline run should change `i > 1` to `i >= 1`
// (or `i > 0`) so the returned array includes 1.
export function countDown(start) {
  const out = [];
  for (let i = start; i > 1; i--) {
    out.push(i);
  }
  return out;
}
