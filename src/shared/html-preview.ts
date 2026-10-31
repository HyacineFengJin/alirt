const removedTags = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base']);
const disabledControls = new Set(['button', 'input', 'select', 'textarea', 'option', 'optgroup', 'fieldset']);
const removedAttributes = new Set(['href', 'xlink:href', 'action', 'formaction', 'target', 'formtarget', 'ping', 'srcdoc', 'srcset', 'autofocus', 'autoplay', 'contenteditable']);

/** Presentation-only HTML/CSS. The result must additionally be mounted in an
 * iframe sandbox with no permissions. This never grants imported code execution. */
export function safeFrontendPreview(html: string): string {
  const fenced = html.match(/^\s*(`{3,}|~{3,})[ \t]*html[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*\s*$/i);
  const source = fenced ? fenced[2] : html;
  const body = source.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, '')
    .replace(/<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (tag, name: string) => {
      const lower = name.toLowerCase();
      if (removedTags.has(lower)) return '';
      if (/^<\//.test(tag)) return tag;
      const prefix = tag.match(/^<[^\s/>]+/)![0];
      const attributes = tag.slice(prefix.length, tag.length - (tag.endsWith('/>') ? 2 : 1));
      const retained: string[] = [], names = new Set<string>();
      for (const match of attributes.matchAll(/\s+([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
        const attribute = match[1].toLowerCase();
        if (attribute.startsWith('on') || removedAttributes.has(attribute)) continue;
        if (attribute === 'src') {
          const raw = match[2] ?? '', value = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
          if (lower !== 'img' || !/^data:image\//i.test(value.trim())) continue;
        }
        names.add(attribute); retained.push(match[0]);
      }
      if (disabledControls.has(lower) && !names.has('disabled')) retained.push(' disabled');
      if (lower === 'form' && !names.has('inert')) retained.push(' inert');
      return prefix + retained.join('') + (tag.endsWith('/>') ? '/>' : '>');
    });
  return '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; script-src \'none\'; font-src \'none\'; form-action \'none\'; base-uri \'none\'"><meta charset="utf-8">' + body;
}
