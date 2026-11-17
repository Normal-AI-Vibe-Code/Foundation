/**
 * Fold one Foundation user into another (one person, two sign-ins):
 *   npm run link-accounts -- <keep email> <other email>
 */
import { linkAccounts } from "../src/flowform.ts";

const [keep, other] = process.argv.slice(2);
if (!keep || !other) {
  console.error("usage: npm run link-accounts -- <keep email> <other email>");
  process.exit(1);
}
console.log(JSON.stringify(linkAccounts(keep, other), null, 2));
