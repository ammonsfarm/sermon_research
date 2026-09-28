import { html, type Html } from "./html.ts";

/**
 * Color schemes an admin can pick in Admin → Ministry. Each is three colors:
 * `ink` for the header and banners, `brand` for links and buttons, and `trim`
 * for small highlights. The stylesheet derives every other shade, in light
 * and dark mode, from these three.
 */
export const SCHEMES = [
  { id: "navy", label: "Navy and gold", ink: "#16233a", brand: "#1f4e79", trim: "#a8812f" },
  { id: "forest", label: "Forest and brass", ink: "#18301f", brand: "#2d6a4a", trim: "#a88a3a" },
  { id: "burgundy", label: "Burgundy and gold", ink: "#361520", brand: "#7c2438", trim: "#b1883a" },
  { id: "slate", label: "Slate and teal", ink: "#1d2830", brand: "#1c6d77", trim: "#6f9a9f" },
  { id: "plum", label: "Plum and gold", ink: "#281a38", brand: "#5b3a88", trim: "#b18c3c" },
  { id: "walnut", label: "Walnut and copper", ink: "#33251a", brand: "#86472a", trim: "#a57a3e" },
] as const;

export type SchemeId = (typeof SCHEMES)[number]["id"];
export const DEFAULT_SCHEME: SchemeId = "navy";

export function isScheme(value: unknown): value is SchemeId {
  return SCHEMES.some((scheme) => scheme.id === value);
}

/** CSS that sets the three base colors for each scheme, on the page and on the swatches in Admin. */
export function schemeStyles(): string {
  return SCHEMES.map((scheme) => `[data-scheme="${scheme.id}"] { --scheme-ink: ${scheme.ink}; --scheme-brand: ${scheme.brand}; --scheme-trim: ${scheme.trim}; }`).join("\n");
}

/** Light, dark, or follow the device ("system"), chosen by each visitor and kept in a cookie. */
export type Mode = "light" | "dark" | "system";
export const MODE_COOKIE = "sr_mode";
const MODES: readonly Mode[] = ["system", "light", "dark"];

export function parseMode(value: unknown): Mode {
  return MODES.includes(value as Mode) ? value as Mode : "system";
}

export function modeCookie(mode: Mode): string {
  return mode === "system"
    ? `${MODE_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`
    : `${MODE_COOKIE}=${mode}; Path=/; Secure; SameSite=Lax; Max-Age=${365 * 86_400}`;
}

/** Where to go back to after switching: a path on this site, never another host. */
export function safeBack(value: unknown): string {
  const back = String(value ?? "");
  return back.startsWith("/") && !back.startsWith("//") && !back.startsWith("/\\") ? back.slice(0, 2000) : "/";
}

const MODE_LABELS: Record<Mode, readonly [string, string]> = {
  system: ["◐", "Match my device"],
  light: ["☀", "Light"],
  dark: ["☾", "Dark"],
};

/** The light / dark / system switch in the header. A plain form, so it works without the script. */
export function modeSwitch(mode: Mode, back: string): Html {
  return html`<form class="mode-switch" method="post" action="/appearance" aria-label="Appearance">
<input type="hidden" name="back" value="${back}">
${MODES.map((option) => html`<button type="submit" name="mode" value="${option}" title="${MODE_LABELS[option][1]}" aria-pressed="${option === mode ? "true" : "false"}"><span aria-hidden="true">${MODE_LABELS[option][0]}</span><span class="visually-hidden">${MODE_LABELS[option][1]}</span></button>`)}
</form>`;
}

/** The scheme picker in the ministry form. */
export function schemePicker(selected: string | undefined): Html {
  const current = isScheme(selected) ? selected : DEFAULT_SCHEME;
  return html`<fieldset class="choices schemes">
<legend>Color scheme</legend>
<p class="hint">Used for the header, buttons and highlights. Each visitor can still choose light or dark.</p>
${SCHEMES.map((scheme) => html`<label class="choice scheme" data-scheme="${scheme.id}"><input type="radio" name="colorScheme" value="${scheme.id}"${scheme.id === current ? html` checked` : ""}>
<span class="swatch" aria-hidden="true"><span class="ink"></span><span class="brand"></span><span class="trim"></span></span>${scheme.label}</label>`)}
</fieldset>`;
}
