module.exports = {
  plugins: {
    // Tailwind v4 is a single PostCSS plugin and does its own vendor
    // prefixing, so there is no `autoprefixer` entry beside it any more.
    "@tailwindcss/postcss": {},
  },
};
