/**
 * Names that are never listed, read or handed to a program, wherever they are (places.ts, rea.ts):
 * dotfiles and dot-folders (.env, .git, .ssh, .aws, .claude, .config, .gnupg, .npmrc …), keys,
 * certificates, credential stores and node_modules. Pure: no database, no file system.
 */
const SECRET = [
  /^\./, // dotfiles and dot-folders
  /^node_modules$/i,
  /\.(pem|key|pfx|p12|jks|keystore|kdbx|ppk|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /credential/i,
  /^secrets?(\.|$)/i,
  /^ntuser\./i,
  /^(desktop\.ini|thumbs\.db)$/i,
];
export const isSecretName = (name: string) => SECRET.some((r) => r.test(name));
