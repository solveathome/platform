import { migrate } from "../src/db/index.js";
import { proposeCuration } from "../src/lib/files.js";
await migrate();
console.log(`curation: opened ${await proposeCuration()} curate job(s) for uploaders over their allowance`);
process.exit(0);
