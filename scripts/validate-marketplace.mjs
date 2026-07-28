import {access, readFile, stat} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = path.resolve(
  rootIndex >= 0 && args[rootIndex + 1]
    ? args[rootIndex + 1]
    : "release/siyuan-table-merge",
);

const requiredFiles = [
  "icon.png",
  "preview.png",
  "README.md",
  "README.zh-CN.md",
  "README-install.zh-CN.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "plugin.json",
  "index.js",
];

const failures = [];

for (const name of requiredFiles) {
  try {
    await access(path.join(root, name));
  } catch {
    failures.push(`missing required package file: ${name}`);
  }
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const plugin = await readJson(path.join(root, "plugin.json"));
const packageJson = await readJson(path.resolve("package.json"));
const packageLock = await readJson(path.resolve("package-lock.json"));
const expectedName = "siyuan-table-merge";
const expectedUrl = `https://github.com/Acetab/${expectedName}`;

if (plugin.name !== expectedName) {
  failures.push(`plugin.json name must be ${expectedName}, got ${plugin.name}`);
}
if (packageJson.name !== expectedName || packageLock.name !== expectedName) {
  failures.push("package.json and package-lock.json names must match plugin.json");
}
if (plugin.url !== expectedUrl) {
  failures.push(`plugin.json url must be ${expectedUrl}, got ${plugin.url}`);
}
if (
  plugin.version !== packageJson.version
  || plugin.version !== packageLock.version
  || plugin.version !== packageLock.packages?.[""]?.version
) {
  failures.push("versions in plugin.json, package.json, and package-lock.json are not aligned");
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(plugin.version)) {
  failures.push(`plugin version is not clean semantic version text: ${plugin.version}`);
}
if (!plugin.readme?.default || !plugin.displayName?.default || !plugin.description?.default) {
  failures.push("plugin.json must define default readme, displayName, and description");
}
for (const readme of Object.values(plugin.readme ?? {})) {
  try {
    await access(path.join(root, readme));
  } catch {
    failures.push(`plugin.json references missing readme: ${readme}`);
  }
}

const validateImage = async (name, expectedWidth, expectedHeight, maxBytes) => {
  const file = path.join(root, name);
  try {
    const info = await stat(file);
    const metadata = await sharp(file).metadata();
    if (info.size > maxBytes) {
      failures.push(`${name} is ${info.size} bytes; limit is ${maxBytes}`);
    }
    if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
      failures.push(
        `${name} must be ${expectedWidth}x${expectedHeight}, got ${metadata.width}x${metadata.height}`,
      );
    }
  } catch (error) {
    failures.push(`cannot validate ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

await validateImage("icon.png", 160, 160, 20 * 1024);
await validateImage("preview.png", 1024, 768, 200 * 1024);

if (failures.length > 0) {
  console.error("Marketplace validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Marketplace validation passed: ${root}`);
}
