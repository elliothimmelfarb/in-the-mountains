"use client";
import { ASSETS } from "@/lib/render/asset-manifest.generated";

// id → raw svg, built once.
const SVGS = new Map(ASSETS.map((a) => [a.id, a.svg]));
// (id|size) → processed inline svg, cached so the per-tick re-render stays cheap.
const cache = new Map<string, string>();

function processed(name: string, size: number): string | null {
  const key = name + "|" + size;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let svg = SVGS.get(name);
  if (!svg) {
    cache.set(key, "");
    return null;
  }
  // ink lines inherit the surrounding text colour (so active/hover states tint the icon),
  // while authored accent colours (amber, red, faction blue/teal/green) stay put.
  svg = svg.replace(/#d8d6c4/g, "currentColor");
  svg = svg.replace(/<svg /, `<svg width="${size}" height="${size}" `);
  cache.set(key, svg);
  return svg;
}

/**
 * Renders an authored SVG asset (UI icon, crest, role badge…) inline, sized and
 * colour-inheriting. Used throughout the command UI to replace Unicode glyphs.
 */
export function Icon({ name, size = 16, className, style }: { name: string; size?: number; className?: string; style?: React.CSSProperties }) {
  const svg = processed(name, size);
  if (!svg) return null;
  return (
    <span
      className={className}
      aria-hidden
      style={{ display: "inline-flex", width: size, height: size, lineHeight: 0, verticalAlign: "middle", flexShrink: 0, ...style }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function hasIcon(name: string): boolean {
  return SVGS.has(name);
}
