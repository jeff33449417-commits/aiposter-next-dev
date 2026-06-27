// Tests for the modularized frontend + mobile touch enhancements.
// Run with: npm test  (node --test tests/*.test.mjs)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("index.html references the external stylesheet and scripts", () => {
  const html = read("public/index.html");
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(html, /src="\/js\/products\.js"/);
  assert.match(html, /src="\/js\/app\.js"/);
});

test("index.html no longer embeds inline CSS or JS", () => {
  const html = read("public/index.html");
  assert.ok(!/<style[\s>]/i.test(html), "no inline <style>");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "no src-less <script>");
});

test("extracted assets are non-empty", () => {
  for (const p of ["public/styles.css", "public/js/products.js", "public/js/app.js"]) {
    assert.ok(read(p).trim().length > 0, `${p} is non-empty`);
  }
});

test("product catalog data is present and well-formed", () => {
  const products = read("public/js/products.js");
  assert.match(products, /const\s+AI_POSTER_PRODUCTS\s*=\s*\[/);
  const ids = products.match(/id:\s*'p\d+'/g) || [];
  assert.ok(ids.length >= 10, `expected >=10 products, found ${ids.length}`);
});

test("mobile touch enhancements are present in stylesheet", () => {
  const css = read("public/styles.css");
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /touch-action:\s*none/);
  assert.match(css, /-webkit-touch-callout:\s*none/);
});
