// JSON with comments and trailing commas (wrangler's config format) to JSON, without a dependency: comments and
// trailing commas are removed outside string literals only, so URLs and paths inside strings are untouched.
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  // trailing commas before a closing bracket or brace (outside strings, which are already intact)
  let result = "";
  inString = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j]!;
    if (inString) {
      result += c;
      if (c === "\\") {
        result += out[j + 1] ?? "";
        j++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k]!)) k++;
      if (out[k] === "}" || out[k] === "]") continue;
    }
    result += c;
  }
  return result;
}

export function parseJsonc<T>(text: string): T {
  return JSON.parse(stripJsonc(text)) as T;
}
