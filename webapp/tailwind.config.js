/*
 * Tailwind build config for SpoLocal.
 * Scans templates and keeps required classes in generated CSS.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./templates/**/*.html", "./static/js/**/*.js"],
  safelist: [
    "w-32",
    "h-32",
    "gap-px",
    "grid-rows-2",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
