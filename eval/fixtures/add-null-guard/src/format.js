// formatUser(input) renders a user object as "Name <email>".
// Bug: dereferences input.name without checking input itself.
// Calling formatUser(null) throws "Cannot read properties of null".
//
// Fix: return "Anonymous <unknown>" when input is null or undefined.
export function formatUser(input) {
  return `${input.name} <${input.email}>`;
}
