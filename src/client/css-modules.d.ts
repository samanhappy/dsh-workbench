// Ambient module for the CSS text imports: build.mjs loads `.css` files as
// plain text (esbuild loader '.css' = 'text'), so each import is a string.
declare module '*.css' {
  const text: string
  export default text
}
