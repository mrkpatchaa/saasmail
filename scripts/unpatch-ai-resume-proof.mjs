import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const distPath = resolve(process.cwd(), "node_modules/ai/dist/index.js");
const seedLine =
  '    const seedToolContinuation = trigger === "resume-stream" && this.transport?._expectToolContinuation === true;\n';
const patched =
  'lastMessage: trigger === "regenerate-message" || (trigger === "resume-stream" && !seedToolContinuation) ? void 0 : this.state.snapshot(lastMessage),';
const original =
  'lastMessage: trigger === "resume-stream" || trigger === "regenerate-message" ? void 0 : this.state.snapshot(lastMessage),';

let source = await readFile(distPath, "utf8");
source = source.replace(seedLine, "");
source = source.replace(patched, original);
await writeFile(distPath, source, "utf8");
console.log("[unpatch-ai-resume-proof] restored unpatched ai@7.0.109 behavior");
