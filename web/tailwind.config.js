/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          900: "#0b0d10",
          800: "#13161b",
          700: "#1c2028",
          600: "#2a2f3a",
          500: "#3a4150",
          400: "#6b7280",
          100: "#e5e7eb",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
