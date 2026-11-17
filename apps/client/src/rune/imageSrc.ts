import { BEARER } from "../lib/api";

/**
 * The address Rune can fetch an image from, or "" when it can't: a server
 * file behind a bearer can't be fetched by address (the session never goes in
 * a URL), so that image stays the web's, as an island.
 */
export const runeImageSrc = (src: string) => (src.startsWith("/files/") && BEARER ? "" : src);
