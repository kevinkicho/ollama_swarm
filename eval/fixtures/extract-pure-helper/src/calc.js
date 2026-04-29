// computePrice(items) returns the subtotal + 7% tax + $5 shipping.
// The tax math is inlined here. Refactor task: extract the tax calc
// into a pure helper called `applyTax(amount)` so it's reusable + testable.
//
// Constraints: behavior must be preserved exactly. The exported
// computePrice signature must NOT change. The tests exercising it
// must keep passing.
export function computePrice(items) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  // INLINE: tax math. Refactor target.
  const withTax = subtotal + subtotal * 0.07;
  return withTax + 5;
}
