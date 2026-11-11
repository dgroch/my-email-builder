"use strict";
const render = require("./render");
const { Parser } = require("htmlparser2");
const images = require("./imageOptimiser");
const {
  freezeArtifactInputs,
  compileArtifact,
  binaryHash,
} = require("./campaignArtifact");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const templateSource = require("./templateSource");
const brandTokens = require("./brandTokens");
// Total raw bytes of every source image captured into the frozen snapshot. Capture bounds the
// persisted snapshot and the memory needed to inflate it again for rendering, not the weight of
// the uploaded email. 2 MiB raw becomes ~2.67 MiB base64 and still leaves room under the 8 MiB
// export JSON bound, while staying exactly 2x the previous cap. The 1 MiB per-download limit in
// loadImage below is deliberately separate: one source may be up to 1 MiB, but several such
// sources may be captured together.
const CAPTURED_IMAGE_BUDGET = 2 * 1024 * 1024;
// Extract the readable alternative, not CSS/source text, from the frozen markup.
function plainText(html) {
  const parts = [],
    links = [];
  let hidden = 0;
  const nonContent = new Set(["style", "script", "head", "template"]);
  const blocks = new Set([
    "p",
    "div",
    "tr",
    "td",
    "th",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "br",
  ]);
  new Parser(
    {
      onopentag(name, attrs) {
        if (hidden || nonContent.has(name)) {
          hidden++;
          return;
        }
        if (blocks.has(name)) parts.push("\n");
        if (name === "img" && attrs.alt) parts.push(" " + attrs.alt + " ");
        if (name === "a")
          links.push(/^https?:\/\//i.test(attrs.href || "") ? attrs.href : "");
      },
      ontext(value) {
        if (!hidden) parts.push(value);
      },
      onclosetag(name) {
        if (hidden) {
          hidden--;
          return;
        }
        if (name === "a") {
          const href = links.pop();
          if (href) parts.push(" (" + href + ")");
        }
        if (blocks.has(name)) parts.push("\n");
      },
    },
    { decodeEntities: true },
  ).end(html);
  return parts
    .join("")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function loadImage(src) {
  if (src.startsWith("/design-system/assets/")) {
    const root = path.resolve(render.DS, "assets");
    const file = path.resolve(root, src.slice("/design-system/assets/".length));
    if (!file.startsWith(root + path.sep)) throw Error("ASSET_PATH");
    return fs.readFileSync(file);
  }
  const u = new URL(src);
  const allowed = (
    process.env.BUILDER_IMAGE_HOSTS ||
    "cdn.shopify.com,images.unsplash.com,figandbloom.com,www.figandbloom.com"
  ).split(",");
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !allowed.includes(u.hostname)
  )
    throw Error("ASSET_HOST_NOT_REGISTERED");
  const res = await fetch(u, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok || !res.body) throw Error("ASSET_UNAVAILABLE");
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    // Per-download guard, not the total-capture budget: no single source image may exceed 1 MiB.
    if (size > 1024 * 1024) throw Error("ASSET_SIZE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Rewrite parsed resource values only; URLs in links, copy, or longer URLs are independent.
function rewriteResources(html, replacements) {
  const edits = [];
  let inStyle = false;
  const escape = (value) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const css = (value) =>
    value.replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
      (original, a, b, c) => {
        const replacement = replacements.get((a || b || c || "").trim());
        return replacement ? 'url("' + replacement + '")' : original;
      },
    );
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        inStyle = name === "style";
        let changed = false;
        for (const key of ["src", "background"]) {
          if (replacements.has(attrs[key])) {
            attrs[key] = replacements.get(attrs[key]);
            changed = true;
          }
        }
        if (attrs.style) {
          const next = css(attrs.style);
          changed ||= next !== attrs.style;
          attrs.style = next;
        }
        if (changed)
          edits.push({
            start: parser.startIndex,
            end: parser.endIndex + 1,
            value:
              "<" +
              name +
              Object.entries(attrs)
                .map(([key, value]) => " " + key + '="' + escape(value) + '"')
                .join("") +
              ">",
          });
      },
      onclosetag(name) {
        if (name === "style") inStyle = false;
      },
      ontext(value) {
        if (!inStyle) return;
        const next = css(value);
        if (next !== value)
          edits.push({
            start: parser.startIndex,
            end: parser.endIndex + 1,
            value: next,
          });
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  for (const edit of edits.reverse())
    html = html.slice(0, edit.start) + edit.value + html.slice(edit.end);
  return html;
}

// Every image resource a live row still points at. Data URLs are already self-contained; any
// other value must have been rewritten from a captured frozen-asset reference.
function liveImageResources(html) {
  const resources = new Set();
  const css = (value) => {
    for (const match of value.matchAll(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    )) {
      const source = (match[1] || match[2] || match[3] || "").trim();
      if (source && !/^data:/i.test(source)) resources.add(source);
    }
  };
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        for (const key of ["src", "background"])
          if (attrs[key] && !/^data:/i.test(attrs[key]))
            resources.add(attrs[key]);
        if (attrs.style) css(attrs.style);
      },
      ontext(text) {
        css(text);
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return resources;
}

// Split a selector list only at top-level commas so a comma inside :not(), an attribute
// value, or a quoted string cannot turn one selector into two.
function splitSelectorList(selector) {
  const out = [];
  let current = "";
  let quote = null;
  let square = 0;
  let paren = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      current += ch;
      if (ch === quote && selector[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "(") paren++;
    else if (ch === ")") paren--;
    if (ch === "," && square === 0 && paren === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote || square !== 0 || paren !== 0)
    throw new Error("LIVE_STYLE_SELECTOR_UNSUPPORTED: " + JSON.stringify(selector));
  out.push(current.trim());
  return out;
}

function unsupportedStyleSelector(selector) {
  throw new Error("LIVE_STYLE_SELECTOR_UNSUPPORTED: " + JSON.stringify(selector));
}

// Parse a declaration block without treating semicolons inside quotes or parentheses as
// separators. Ordinary declarations may carry !important for cascade decisions, but every
// emitted style attribute strips the flag because the engine contract only accepts plain
// declarations. Sanctioned media blocks may retain it (it is required to beat inline styles).
function cssDeclarations(value, options = {}) {
  const { strict = false, allowImportant = false } = options;
  const out = new Map();
  let current = "";
  let quote = null;
  let depth = 0;
  const flush = () => {
    const text = current.trim();
    current = "";
    if (!text) return;
    const colon = text.indexOf(":");
    if (colon < 1) {
      if (strict)
        throw new Error(
          "LIVE_STYLE_DECLARATION_UNSUPPORTED: " + JSON.stringify(text),
        );
      return;
    }
    const property = text.slice(0, colon).trim().toLowerCase();
    let declaration = text.slice(colon + 1).trim();
    let important = false;
    if (/!\s*important\s*$/i.test(declaration)) {
      important = true;
      declaration = declaration.replace(/!\s*important\s*$/i, "").trim();
    }
    if (/!\s*important/i.test(declaration)) {
      if (strict)
        throw new Error(
          "LIVE_STYLE_DECLARATION_UNSUPPORTED: " + JSON.stringify(text),
        );
      declaration = declaration.replace(/!\s*important\s*/gi, "").trim();
    }
    if (
      !property ||
      !declaration ||
      property.startsWith("--") ||
      !/^[a-z-]+$/.test(property)
    ) {
      if (strict)
        throw new Error(
          "LIVE_STYLE_DECLARATION_UNSUPPORTED: " + JSON.stringify(text),
        );
      return;
    }
    if (important && strict && !allowImportant)
      throw new Error(
        "LIVE_STYLE_DECLARATION_UNSUPPORTED: !important outside media",
      );
    const previous = out.get(property);
    // In one block an earlier !important declaration beats a later normal duplicate, even
    // though same-importance duplicates otherwise resolve to the later declaration.
    if (previous && previous.important && !important) return;
    out.set(property, { value: declaration, important });
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      current += ch;
      if (ch === quote && value[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) flush();
    else current += ch;
  }
  flush();
  return out;
}

// Read a stylesheet's top-level blocks. Nested braces are handled by the caller so malformed
// or brace-abusive input is rejected instead of being partially applied.
function cssBlocks(source) {
  const blocks = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index++;
    if (index >= source.length) break;
    const start = index;
    let quote = null;
    let parens = 0;
    let brace = -1;
    let statement = -1;
    for (; index < source.length; index++) {
      const ch = source[index];
      if (quote) {
        if (ch === quote && source[index - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "(") parens++;
      else if (ch === ")") parens = Math.max(0, parens - 1);
      else if (ch === "{" && parens === 0) {
        brace = index;
        break;
      } else if (ch === ";" && parens === 0) {
        statement = index;
        break;
      } else if (ch === "}")
        throw new Error("LIVE_STYLE_UNSUPPORTED: unexpected }");
    }
    if (statement >= 0) {
      const prelude = source.slice(start, statement).trim();
      // A top-level semicolon ends a block-less at-rule such as @charset or @import. Record it
      // separately so it cannot absorb the rule that follows it.
      if (!prelude.startsWith("@"))
        throw new Error("LIVE_STYLE_UNSUPPORTED: unexpected ;");
      blocks.push({ prelude, body: null, statement: true });
      index = statement + 1;
      continue;
    }
    if (brace < 0) throw new Error("LIVE_STYLE_UNSUPPORTED: missing {");
    const prelude = source.slice(start, brace).trim();
    let depth = 1;
    quote = null;
    let end = brace + 1;
    for (; end < source.length && depth; end++) {
      const ch = source[end];
      if (quote) {
        if (ch === quote && source[end - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth) throw new Error("LIVE_STYLE_UNSUPPORTED: missing }");
    blocks.push({ prelude, body: source.slice(brace + 1, end - 1) });
    index = end;
  }
  return blocks;
}

function selectorCompound(text) {
  if (!/^(?:[a-zA-Z][\w-]*)?(?:[.#][\w-]+)*$/.test(text) || !text)
    unsupportedStyleSelector(text);
  const compound = { tag: null, classes: [], ids: [] };
  const tag = text.match(/^([a-zA-Z][\w-]*)/);
  if (tag) compound.tag = tag[1].toLowerCase();
  for (const match of text.matchAll(/\.([\w-]+)/g))
    compound.classes.push(match[1]);
  for (const match of text.matchAll(/#([\w-]+)/g))
    compound.ids.push(match[1]);
  return compound;
}

// Only tag/class/id compounds joined by descendant or child combinators are supported. Any
// attribute, pseudo, sibling, universal, :not(), or other selector fails closed instead of
// being silently over- or under-applied.
function selectorParts(selector) {
  const text = selector.trim();
  if (!text || /[+~\[\]:(),*\\]/.test(text)) unsupportedStyleSelector(selector);
  const raw = text.replace(/\s*>\s*/g, " > ").trim().split(/\s+/);
  const parts = [];
  let combinator = "descendant";
  let expectCompound = true;
  for (const token of raw) {
    if (token === ">") {
      if (expectCompound) unsupportedStyleSelector(selector);
      combinator = "child";
      expectCompound = true;
      continue;
    }
    const compound = selectorCompound(token);
    parts.push({
      compound,
      combinator: parts.length ? combinator : "descendant",
    });
    combinator = "descendant";
    expectCompound = false;
  }
  if (expectCompound || !parts.length) unsupportedStyleSelector(selector);
  return parts;
}

function selectorSpecificity(parts) {
  let ids = 0,
    classes = 0,
    tags = 0;
  for (const part of parts) {
    ids += part.compound.ids.length;
    classes += part.compound.classes.length;
    if (part.compound.tag) tags++;
  }
  return [ids, classes, tags];
}

function compoundMatches(element, compound) {
  if (compound.tag && element.name !== compound.tag) return false;
  const classes = new Set((element.attrs.class || "").split(/\s+/).filter(Boolean));
  if (compound.classes.some((name) => !classes.has(name))) return false;
  const id = element.attrs.id;
  if (compound.ids.some((name) => id !== name)) return false;
  return true;
}

const MEDIA_PROPERTIES = new Set(
  "color background-color background font-family font-size font-weight font-style line-height letter-spacing text-align text-decoration text-transform vertical-align display width max-width height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-top border-right border-bottom border-left border-collapse border-spacing white-space overflow-wrap".split(
    " ",
  ),
);
const MEDIA_FONT_FAMILIES = new Set([
  "arial",
  "helvetica",
  "georgia",
  "verdana",
  "tahoma",
  "sans-serif",
  "serif",
  "calibri",
  "lust",
  "neuzeitgro",
  "gill sans",
  "gill sans mt",
  "times new roman",
  "palatino linotype",
  "palatino",
]);
function safeMediaFontFamily(value) {
  const families = value.split(",").map((part) => {
    const trimmed = part.trim();
    return trimmed.replace(/^(['"])(.*)\1$/, "$2").trim().toLowerCase();
  });
  return (
    families.length > 0 &&
    families.every((family) => family.length > 0 && MEDIA_FONT_FAMILIES.has(family))
  );
}
function validateMediaDeclaration(property, declaration) {
  if (
    !MEDIA_PROPERTIES.has(property) ||
    !declaration.value ||
    !/^[a-zA-Z0-9 #.,%+'"\-/]+$/.test(declaration.value) ||
    /url|expression|import|javascript|behavior|var\b/i.test(declaration.value) ||
    (property === "font-family" && !safeMediaFontFamily(declaration.value))
  )
    throw new Error(
      "LIVE_STYLE_DECLARATION_UNSUPPORTED: " +
        property +
        ":" +
        declaration.value,
    );
}
function mediaCondition(prelude) {
  const match =
    /^@media\s+(?:(?:only\s+)?screen\s+and\s+)?\(\s*(max|min)-width\s*:\s*(\d{1,5})px\s*\)$/i.exec(
      prelude.trim(),
    );
  if (!match) return null;
  const px = Number(match[2]);
  if (!Number.isInteger(px) || px < 1 || px > 10000) return null;
  return { kind: match[1].toLowerCase(), px };
}
function parseMediaRules(body) {
  const rules = [];
  for (const block of cssBlocks(body)) {
    if (block.statement || !block.prelude || block.prelude.startsWith("@"))
      throw new Error("LIVE_STYLE_UNSUPPORTED: nested at-rule");
    const selectors = splitSelectorList(block.prelude);
    for (const selector of selectors) {
      const parts = selectorParts(selector);
      if (
        parts.some((part) => part.combinator === "child") ||
        !parts.some((part) => part.compound.classes.length) ||
        parts.some((part) => part.compound.ids.length)
      )
        unsupportedStyleSelector(selector);
    }
    const declarations = cssDeclarations(block.body, {
      strict: true,
      allowImportant: true,
    });
    if (!declarations.size)
      throw new Error("LIVE_STYLE_DECLARATION_UNSUPPORTED: empty rule");
    for (const [property, declaration] of declarations) {
      validateMediaDeclaration(property, declaration);
      // These declarations live in a stylesheet while the same property may be inlined on the
      // element; without !important the media rule would silently lose to that inline style.
      if (!declaration.important)
        throw new Error(
          "LIVE_STYLE_DECLARATION_UNSUPPORTED: media declaration must be !important",
        );
    }
    rules.push({ selector: selectors.join(","), declarations });
  }
  return rules;
}
function parseStyleSheet(css, startOrder = 0) {
  const ordinary = [];
  const media = [];
  let order = startOrder;
  for (const block of cssBlocks(css.replace(/\/\*[\s\S]*?\*\//g, ""))) {
    if (block.prelude.startsWith("@")) {
      if (block.statement)
        throw new Error(
          "LIVE_STYLE_UNSUPPORTED: " + JSON.stringify(block.prelude),
        );
      if (/^@media\b/i.test(block.prelude)) {
        const condition = mediaCondition(block.prelude);
        if (!condition)
          throw new Error(
            "LIVE_STYLE_UNSUPPORTED: " + JSON.stringify(block.prelude),
          );
        const rules = parseMediaRules(block.body);
        if (rules.length) media.push({ condition, rules });
      } else
        throw new Error(
          "LIVE_STYLE_UNSUPPORTED: " + JSON.stringify(block.prelude),
        );
      order++;
      continue;
    }
    const selectors = splitSelectorList(block.prelude);
    const declarations = cssDeclarations(block.body);
    if (!declarations.size) {
      order++;
      continue;
    }
    for (const selector of selectors) {
      const parts = selectorParts(selector);
      ordinary.push({
        parts,
        specificity: selectorSpecificity(parts),
        declarations,
        order,
      });
    }
    order++;
  }
  return { ordinary, media, order };
}
function mediaCss(condition, rules) {
  return (
    "@media (" +
    condition.kind +
    "-width:" +
    condition.px +
    "px){" +
    rules
      .map(
        (rule) =>
          rule.selector +
          "{" +
          [...rule.declarations]
            .map(
              ([property, declaration]) =>
                property +
                ":" +
                declaration.value +
                (declaration.important ? "!important" : "") +
                ";",
            )
            .join("") +
          "}",
      )
      .join("") +
    "}"
  );
}

const VOID_TAGS = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

function htmlElements(html) {
  const elements = [];
  const stack = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        elements.push({
          name,
          attrs: { ...attrs },
          parent: stack.length ? stack[stack.length - 1] : null,
          start: parser.startIndex,
          end: parser.endIndex + 1,
        });
        if (!VOID_TAGS.has(name)) stack.push(elements.length - 1);
      },
      onclosetag(name) {
        if (VOID_TAGS.has(name)) return;
        for (let i = stack.length - 1; i >= 0; i--)
          if (elements[stack[i]].name === name) {
            stack.length = i;
            return;
          }
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return elements;
}

function cascadeWins(candidate, current) {
  if (!current) return true;
  if (candidate.important !== current.important) return candidate.important;
  for (let i = 0; i < 3; i++)
    if (candidate.specificity[i] !== current.specificity[i])
      return candidate.specificity[i] > current.specificity[i];
  return candidate.order >= current.order;
}

function styleMediaAttribute(attributes) {
  const match =
    /(?:^|\s)media\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attributes);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3];
}

// Inline ordinary <style> rules into matching style attributes, remove unsupported selectors
// before they can over-apply, strip ids after selector matching, and keep sanctioned responsive
// media blocks in one <style> per live row. Style attributes never retain !important.
function inlineStyleElements(html) {
  const styles = [];
  let output = html.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_, attributes, css) => {
      styles.push({ css, media: styleMediaAttribute(attributes) });
      return "";
    },
  );
  const sheet = { ordinary: [], media: [] };
  // Carry the source-order counter across separate <style> elements. Resetting it per element
  // would let an earlier stylesheet win an otherwise equal-specificity cascade.
  let order = 0;
  for (const { css, media } of styles) {
    let parsed;
    if (media == null) parsed = parseStyleSheet(css, order);
    else {
      const condition = mediaCondition("@media " + media);
      if (!condition)
        throw new Error(
          "LIVE_STYLE_UNSUPPORTED: style media " + JSON.stringify(media),
        );
      // A <style media="..."> scopes its whole sheet. Re-parse it as the sanctioned media
      // block so its declarations are never promoted to unconditional inline styles.
      parsed = parseStyleSheet(
        "@media (" +
          condition.kind +
          "-width:" +
          condition.px +
          "px){" +
          css +
          "}",
        order,
      );
    }
    order = parsed.order;
    sheet.ordinary.push(...parsed.ordinary);
    sheet.media.push(...parsed.media);
  }
  const elements = htmlElements(output);
  const computed = new Map();
  for (const rule of sheet.ordinary) {
    const matches = (index, part) => {
      const element = elements[index];
      if (!compoundMatches(element, rule.parts[part].compound)) return false;
      if (part === 0) return true;
      let parent = element.parent;
      if (rule.parts[part].combinator === "child")
        return parent != null && matches(parent, part - 1);
      while (parent != null) {
        if (matches(parent, part - 1)) return true;
        parent = elements[parent].parent;
      }
      return false;
    };
    for (let i = 0; i < elements.length; i++) {
      if (!matches(i, rule.parts.length - 1)) continue;
      const target = computed.get(i) || new Map();
      for (const [property, declaration] of rule.declarations) {
        const candidate = {
          value: declaration.value,
          important: declaration.important,
          specificity: rule.specificity,
          order: rule.order,
        };
        if (cascadeWins(candidate, target.get(property)))
          target.set(property, candidate);
      }
      computed.set(i, target);
    }
  }
  const escape = (value) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const edits = [];
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    const declarations = computed.get(index);
    const originalStyle = element.attrs.style || "";
    const inline = cssDeclarations(originalStyle);
    const hadImportant = /!\s*important/i.test(originalStyle);
    const hadId = Object.prototype.hasOwnProperty.call(element.attrs, "id");
    let changed = false;
    if (declarations)
      for (const [property, declaration] of declarations) {
        const current = inline.get(property);
        // Inline styles outrank normal stylesheet declarations. A stylesheet !important rule
        // still wins over an inline normal declaration, but the flag is removed on emit.
        if (current && (current.important || !declaration.important)) continue;
        inline.set(property, {
          value: declaration.value,
          important: false,
        });
        changed = true;
      }
    if (!hadId && !changed && !hadImportant) continue;
    const attrs = { ...element.attrs };
    delete attrs.id;
    if (changed || hadImportant) {
      const style = [...inline]
        .map(
          ([property, declaration]) =>
            property +
            ":" +
            declaration.value.replace(/!\s*important\s*/gi, "").trim(),
        )
        .filter((declaration) => !declaration.endsWith(":"))
        .join(";");
      if (style) attrs.style = style;
      else delete attrs.style;
    }
    edits.push({
      start: element.start,
      end: element.end,
      value:
        "<" +
        element.name +
        Object.entries(attrs)
          .map(([key, value]) => " " + key + '="' + escape(value) + '"')
          .join("") +
        ">",
    });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  // Collapse only adjacent identical media blocks. A global Set would drop a later duplicate
  // and could let an intervening rule win the media cascade.
  const mediaParts = sheet.media.map(({ condition, rules }) =>
    mediaCss(condition, rules),
  );
  const media = mediaParts
    .filter((part, index) => index === 0 || part !== mediaParts[index - 1])
    .join("");
  return (media ? "<style>" + media + "</style>" : "") + output;
}

// Live rows may only carry images the engine can substitute: <img src="asset:id">. Captured
// frozen references become export assets, and any background/CSS image is rejected because
// the engine contract has no substitute form for it.
function assertLiveAssetReferences(html, assetIds) {
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "img") {
          const source = attrs.src || "";
          if (!source.startsWith("asset:") || !assetIds.has(source.slice(6)))
            throw new Error("LIVE_IMAGE_ASSET_REQUIRED");
        } else if ((attrs.src || "").startsWith("asset:"))
          throw new Error("LIVE_NON_IMAGE_ASSET");
        for (const key of ["background"])
          if ((attrs[key] || "").startsWith("asset:"))
            throw new Error("LIVE_BACKGROUND_ASSET_UNSUPPORTED");
        if (/url\s*\(/i.test(attrs.style || ""))
          throw new Error("LIVE_CSS_ASSET_UNSUPPORTED");
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
}

async function freezeSavedDesign(design, options = {}) {
  const resolve = options.resolve || templateSource.resolve,
    brand = options.brand || brandTokens.getBrand();
  const components = [];
  const overrides = {};
  for (const block of design.campaign.blocks) {
    const src = resolve(block.component);
    if (!src) throw new Error("MISSING_COMPONENT");
    overrides[block.component] = src.html;
    if (!components.some((c) => c.name === block.component))
      components.push({
        name: block.component,
        version: String(src.version || "disk-v1"),
        markup: src.html,
      });
  }
  const frozen = freezeArtifactInputs(design, components, brand);
  const opts = {
    templateOverrides: overrides,
    brand: frozen.provenance.brand,
    assetsBase: options.assetsBase || "/design-system/assets",
    production: true,
    markBlocks: true,
  };
  const assembled = render.assemble(frozen.provenance.design.campaign, opts);
  if (assembled.unfilled.length) throw new Error("UNFILLED_TOKENS");
  const meta = render.assembleBlocks(frozen.provenance.design.campaign, opts);
  const htmlOnly = render.htmlOnlyComponents();
  const blocks = meta.blocks.map((b) => ({
    ...b,
    html: render.stripDocComments(b.html),
    footer: b.component === "footer",
    live: render.isHtmlOnlyComponent(b.component, htmlOnly),
  }));
  if (blocks.filter((b) => b.footer).length !== 1 || !blocks.at(-1).footer)
    throw new Error("KNOWN_FINAL_FOOTER_REQUIRED");
  for (const b of blocks)
    if (!b.footer && !b.live && require("./templateTags").hasMergeTags(b.html))
      throw new Error("UNSUPPORTED_DYNAMIC_BLOCK_" + b.index);
  const capturedMedia = {};
  const sources = new Set();
  const css = (style) => {
    if (/@import|expression\s*\(|javascript:/i.test(style))
      throw Error("UNSUPPORTED_RENDER_RESOURCE");
    for (const match of style.matchAll(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    )) {
      const source = (match[1] || match[2] || match[3] || "").trim();
      if (!source.startsWith("data:")) sources.add(source);
    }
  };
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (
          [
            "script",
            "iframe",
            "object",
            "embed",
            "svg",
            "math",
            "form",
          ].includes(name) ||
          attrs.srcset ||
          Object.keys(attrs).some((key) => /^on/i.test(key))
        )
          throw Error("UNSUPPORTED_RENDER_RESOURCE");
        for (const key of ["src", "background"])
          if (
            attrs[key] &&
            (!attrs[key].startsWith("data:") || /^data:image\/gif[;,]/i.test(attrs[key]))
          )
            sources.add(attrs[key]);
        if (name === "link" && attrs.href)
          throw Error("UNSUPPORTED_RENDER_RESOURCE");
        if (attrs.style) css(attrs.style);
      },
      ontext(text) {
        css(text);
      },
    },
    { decodeEntities: true },
  );
  parser.write(assembled.html);
  parser.end();
  let total = 0;
  const replacements = new Map();
  for (const src of sources) {
    let bytes;
    if (/^data:/i.test(src)) {
      const match = /^data:image\/gif;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(src);
      if (!match || !match[1] || match[1].length % 4 !== 0)
        throw Error("INLINE_IMAGE_ENCODING");
      // Base64 is 4/3 the raw size. Use the same total-capture constant as the running total
      // below so the inline and downloaded paths cannot drift apart.
      if (match[1].length > 4 * Math.ceil(CAPTURED_IMAGE_BUDGET / 3))
        throw Error("CAPTURED_IMAGE_BUDGET");
      bytes = Buffer.from(match[1], "base64");
      if (bytes.toString("base64") !== match[1])
        throw Error("INLINE_IMAGE_ENCODING");
    } else {
      bytes = await (options.loadImage || loadImage)(
        src.replace(/&amp;/g, "&"),
      );
    }
    total += bytes.length;
    if (total > CAPTURED_IMAGE_BUDGET) throw Error("CAPTURED_IMAGE_BUDGET");
    const metadata = await sharp(bytes, {
      animated: true,
      limitInputPixels: 40000000,
    }).metadata();
    const mime = {
      png: "image/png",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    }[metadata.format];
    if (!mime) throw Error("CAPTURED_IMAGE_FORMAT");
    const base64 = bytes.toString("base64");
    const reference = "frozen-asset:" + binaryHash(bytes);
    capturedMedia[reference] = { base64, mime };
    replacements.set(src, reference);
  }
  assembled.html = rewriteResources(assembled.html, replacements);
  for (const block of blocks)
    block.html = rewriteResources(block.html, replacements);
  const imageConfig = images.config();
  delete imageConfig.logger;
  return {
    ...frozen,
    capturedMedia,
    rendered: { html: assembled.html, blocks },
    imageConfig,
  };
}
async function renderFrozenArtifact(frozen, signal) {
  const abort = () => {
    void render.closeBrowser();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    // Inflate only for this render. Persist each captured body once, independent of use count.
    const replacements = new Map();
    const mediaByUrl = {};
    for (const [reference, media] of Object.entries(frozen.capturedMedia)) {
      const dataUrl = "data:" + media.mime + ";base64," + media.base64;
      replacements.set(reference, dataUrl);
      mediaByUrl[dataUrl] = media;
    }
    const { slices: raw, brokenImages } = await render.renderSlices(
      rewriteResources(frozen.rendered.html, replacements),
      { scale: frozen.imageConfig.scale, frozenResources: true },
    );
    if (signal?.aborted) throw new Error("RENDER_TIMEOUT");
    if (brokenImages?.length) throw new Error("BROKEN_IMAGES");
    const notUploadedIndexes = new Set(
      frozen.rendered.blocks
        .filter((b) => b.footer || b.live)
        .map((b) => b.index),
    );
    const { slices, report } = await images.optimiseSlices(raw, {
      config: frozen.imageConfig,
      notUploadedIndexes,
    });
    if (report.budget.status === "fail") throw new Error("IMAGE_WEIGHT_BUDGET");
    const rows = [],
      media = [];
    let ordinal = 0;
    const liveAssets = new Map();
    async function cell(s, b, width) {
      const buffer =
        s.kind === "gif"
          ? Buffer.from(mediaByUrl[s.src]?.base64 || "", "base64")
          : s.buffer;
      if (!buffer?.length) throw Error("CAPTURED_MEDIA_MISSING_" + b.index);
      const assetId = "asset-" + ++ordinal;
      media.push({ assetId, buffer });
      const href = s.name != null ? s.href : render.deriveLink(b.tokens);
      const alt =
        s.name != null
          ? s.alt
          : render.deriveAlt(b.tokens) || plainText(b.html);
      return {
        assetId,
        width,
        alt: alt || "",
        ...(href ? { href } : {}),
        ...(s.bg ? { backgroundColor: s.bg } : {}),
      };
    }
    for (const b of frozen.rendered.blocks) {
      if (b.footer) {
        rows.push({ kind: "legal_footer" });
        continue;
      }
      if (b.live) {
        // Live rows must not carry data: images. Convert every captured frozen reference they
        // use into an export asset/media pair and emit the engine's asset: reference instead.
        // The same captured reference is uploaded once even when several rows use it.
        const liveHtml = inlineStyleElements(
          render.stripDocComments(b.html),
        );
        const liveReplacements = new Map();
        for (const reference of liveImageResources(liveHtml)) {
          if (!reference.startsWith("frozen-asset:") || !frozen.capturedMedia[reference])
            throw new Error("LIVE_ASSET_CAPTURE_REQUIRED_" + b.index);
          let assetId = liveAssets.get(reference);
          if (!assetId) {
            assetId = "asset-" + ++ordinal;
            liveAssets.set(reference, assetId);
            media.push({
              assetId,
              buffer: Buffer.from(frozen.capturedMedia[reference].base64, "base64"),
            });
          }
          liveReplacements.set(reference, "asset:" + assetId);
        }
        // Preserve Outlook conditionals. Inline ordinary style rules and drop <style>
        // elements; media-only rules cannot be expressed in a style attribute and are removed with their at-rule.
        const html = rewriteResources(liveHtml, liveReplacements);
        assertLiveAssetReferences(html, new Set(liveAssets.values()));
        if (/data:image|frozen-asset:/i.test(html))
          throw new Error("LIVE_ASSET_CAPTURE_REQUIRED_" + b.index);
        rows.push({
          kind: "live",
          html,
          text: render.deriveAlt(b.tokens) || plainText(b.html),
        });
        continue;
      }
      const segs = slices.filter((s) => s.index === b.index);
      if (!segs.length) throw new Error("MISSING_BLOCK_SLICE_" + b.index);
      if (segs[0].layout === "cols") {
        const cells = [];
        for (const s of segs) cells.push(await cell(s, b, s.width));
        rows.push({ kind: "columns", cells });
      } else
        for (const s of segs)
          rows.push({ kind: "image", ...(await cell(s, b, 600)) });
    }
    if (signal?.aborted) throw new Error("RENDER_TIMEOUT");
    return await compileArtifact(frozen, {
      rows,
      media,
      text: frozen.rendered.blocks
        .filter((b) => !b.footer)
        .map((b) => plainText(b.html))
        .filter(Boolean)
        .join("\n\n"),
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
module.exports = {
  freezeSavedDesign,
  renderFrozenArtifact,
  inlineStyleElements,
  CAPTURED_IMAGE_BUDGET,
};
