import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");

const [source, manifest] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
JSON.parse(manifest);

// A data URL forces ESM parsing even though the generated output has no package.json.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

console.log("Artifact is valid ESM and exports default.fetch");
// Verify embedded research assets, not just JavaScript syntax: report generation
// must finish before bundling or a larger JSON file can be captured mid-write.
for (const name of ['library-demo.json','modular-daily-results.json','daily-refinement.json','course-benchmarks.json','course-fund-benchmarks.json']) {
  const response=await workerModule.default.fetch(new Request('http://localhost/'+name),{});
  assert.equal(response.status,200);
  const packaged=await response.json();
  const original=JSON.parse(await readFile(resolve(projectRoot,'src',name),'utf8'));
  assert.deepEqual(packaged,original, name+' must match the complete source report');
}
console.log('Embedded research JSON is complete and matches source reports');
const ownManifest=JSON.parse(await readFile(resolve(projectRoot,'src/own-research/manifest.json'),'utf8'));
for(const [path,file] of [['/own-studies.json','manifest.json'],...ownManifest.studies.map(s=>[s.path,s.id+'.json'])]){
 const response=await workerModule.default.fetch(new Request('http://localhost'+path),{});
 assert.equal(response.status,200,path);
 assert.deepEqual(await response.json(),JSON.parse(await readFile(resolve(projectRoot,'src/own-research',file),'utf8')),path);
}
console.log('All ten frozen own-study records and manifest are served intact');
