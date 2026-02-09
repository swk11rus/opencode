// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { afterAll } from "bun:test"

const dir = path.join(os.tmpdir(), "opencode-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(() => {
  fsSync.rmSync(dir, { recursive: true, force: true })
})
// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["OPENCODE_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["OPENCODE_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "opencode")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "21")

// Provide a minimal, deterministic fetch stub for skill discovery tests to avoid network access.
const realFetch: typeof fetch = globalThis.fetch
const CLOUDFLARE_SKILLS_BASE = "https://developers.cloudflare.com/.well-known/skills/"
const CLOUDFLARE_INDEX_URL = new URL("index.json", CLOUDFLARE_SKILLS_BASE).href
const skillIndex = {
  skills: [
    {
      name: "agents-sdk",
      description: "Local test skill",
      files: ["SKILL.md", "references/ref.md"],
    },
  ],
}
const skillFiles: Record<string, string> = {
  "agents-sdk/SKILL.md": `---
name: agents-sdk
description: Local test skill.
---

# Agents SDK
`,
  "agents-sdk/references/ref.md": "# Reference\n",
}
const mockFetch = (async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  if (url === CLOUDFLARE_INDEX_URL) {
    return new Response(JSON.stringify(skillIndex), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
  if (url.startsWith(CLOUDFLARE_SKILLS_BASE)) {
    const rel = url.slice(CLOUDFLARE_SKILLS_BASE.length)
    const body = skillFiles[rel]
    if (body !== undefined) {
      return new Response(body, { status: 200 })
    }
    return new Response("not found", { status: 404 })
  }
  if (url === "https://example.com/") {
    return new Response("<html>example</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
  }
  if (url.startsWith("https://example.invalid/")) {
    return new Response("not found", { status: 404 })
  }
  return realFetch(input, init)
}) as typeof fetch
mockFetch.preconnect = realFetch.preconnect
globalThis.fetch = mockFetch

// Create a lightweight rg stub in the test data bin dir to avoid network downloads.
const binDir = path.join(dir, "share", "opencode", "bin")
await fs.mkdir(binDir, { recursive: true })
if (process.platform !== "win32") {
  const rgPath = path.join(binDir, "rg")
  const rgScript = [
    "#!/usr/bin/env bun",
    "import fs from \"fs\"",
    "import path from \"path\"",
    "",
    "const args = process.argv.slice(2)",
    "const isFiles = args.includes(\"--files\")",
    "const hidden = args.includes(\"--hidden\")",
    "",
    "let maxDepth = undefined",
    "const globs = []",
    "let pattern = undefined",
    "let searchPath = undefined",
    "",
    "for (let i = 0; i < args.length; i++) {",
    "  const arg = args[i]",
    "  if (arg.startsWith(\"--max-depth=\")) {",
    "    maxDepth = Number(arg.split(\"=\")[1])",
    "    continue",
    "  }",
    "  if (arg.startsWith(\"--glob=\")) {",
    "    globs.push(arg.slice(\"--glob=\".length))",
    "    continue",
    "  }",
    "  if (arg === \"--glob\") {",
    "    if (i + 1 < args.length) globs.push(args[++i])",
    "    continue",
    "  }",
    "  if (arg === \"--regexp\") {",
    "    if (i + 1 < args.length) pattern = args[++i]",
    "    continue",
    "  }",
    "}",
    "",
    "const cwd = process.cwd()",
    "if (!isFiles) {",
    "  const last = args[args.length - 1]",
    "  if (last && !last.startsWith(\"-\")) searchPath = path.resolve(cwd, last)",
    "}",
    "",
    "function matchesGlob(filePath, glob) {",
    "  if (glob === \"!.git/*\") return filePath.startsWith(\".git/\")",
    "  if (glob.startsWith(\"!\")) {",
    "    const inner = glob.slice(1)",
    "    return matchesGlob(filePath, inner)",
    "  }",
    "  if (glob === \"*\") return true",
    "  if (glob.startsWith(\"*.\")) {",
    "    return path.basename(filePath).endsWith(glob.slice(1))",
    "  }",
    "  return path.basename(filePath) === glob",
    "}",
    "",
    "function includeByGlobs(relPath) {",
    "  if (globs.length === 0) return true",
    "  let hasPositive = false",
    "  let included = false",
    "  for (const glob of globs) {",
    "    const isNeg = glob.startsWith(\"!\")",
    "    if (matchesGlob(relPath, glob)) {",
    "      if (isNeg) return false",
    "      hasPositive = true",
    "      included = true",
    "    } else if (!isNeg) {",
    "      hasPositive = true",
    "    }",
    "  }",
    "  return hasPositive ? included : true",
    "}",
    "",
    "function isHiddenPath(relPath) {",
    "  return relPath.split(path.sep).some((part) => part.startsWith(\".\") && part.length > 1)",
    "}",
    "",
    "function walk(dir, depth, out) {",
    "  if (maxDepth !== undefined && depth > maxDepth) return",
    "  const entries = fs.readdirSync(dir, { withFileTypes: true })",
    "  for (const entry of entries) {",
    "    const full = path.join(dir, entry.name)",
    "    const rel = path.relative(rootDir, full)",
    "    if (!hidden && isHiddenPath(rel)) continue",
    "    if (entry.isDirectory()) {",
    "      walk(full, depth + 1, out)",
    "      continue",
    "    }",
    "    if (!includeByGlobs(rel)) continue",
    "    out.push(rel)",
    "  }",
    "}",
    "",
    "const rootDir = isFiles ? cwd : (searchPath ?? cwd)",
    "const files = []",
    "walk(rootDir, 0, files)",
    "",
    "if (isFiles) {",
    "  for (const rel of files.sort()) {",
    "    console.log(rel)",
    "  }",
    "  process.exit(0)",
    "}",
    "",
    "const regex = pattern ? new RegExp(pattern) : null",
    "let matchCount = 0",
    "for (const rel of files) {",
    "  const full = path.join(rootDir, rel)",
    "  let text",
    "  try {",
    "    text = fs.readFileSync(full, \"utf8\")",
    "  } catch {",
    "    continue",
    "  }",
    "  const lines = text.split(/\\r?\\n/)",
    "  for (let idx = 0; idx < lines.length; idx++) {",
    "    const line = lines[idx]",
    "    if (regex && !regex.test(line)) continue",
    "    matchCount++",
    "    console.log(`${full}|${idx + 1}|${line}`)",
    "  }",
    "}",
    "",
    "process.exit(matchCount > 0 ? 0 : 1)",
    "",
  ].join("\n")
  await fs.writeFile(rgPath, rgScript, { mode: 0o755 })
}

// Stub @aws-sdk/credential-providers in the test cache to avoid network installs.
const cachePkgPath = path.join(cacheDir, "package.json")
const cachePkg = await Bun.file(cachePkgPath)
  .json()
  .catch(() => ({ dependencies: {} }))
cachePkg.dependencies = cachePkg.dependencies ?? {}
if (!cachePkg.dependencies["@aws-sdk/credential-providers"]) {
  cachePkg.dependencies["@aws-sdk/credential-providers"] = "0.0.0-test"
}
await fs.writeFile(cachePkgPath, JSON.stringify(cachePkg, null, 2))

const awsCredDir = path.join(cacheDir, "node_modules", "@aws-sdk", "credential-providers")
await fs.mkdir(awsCredDir, { recursive: true })
await fs.writeFile(
  path.join(awsCredDir, "package.json"),
  JSON.stringify(
    {
      name: "@aws-sdk/credential-providers",
      version: "0.0.0-test",
      type: "module",
      main: "./index.js",
    },
    null,
    2,
  ),
)
await fs.writeFile(
  path.join(awsCredDir, "index.js"),
  "export const fromNodeProviderChain = () => async () => ({ accessKeyId: \"test\", secretAccessKey: \"test\" })\n",
)

// Clear provider env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]

// Now safe to import from src/
const { Log } = await import("../src/util/log")

Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})
