import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import nextEnv from "@next/env";

// Read credentials only to compare in memory. Never print values or file contents.
nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const staged = process.argv.includes("--staged");
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

try {
  const files = [...new Set(git(staged ? ["ls-files", "--cached", "-z"] : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))];
  const sensitive = ["GOOGLE_SHEETS_PRIVATE_KEY", "GOOGLE_SHEETS_CLIENT_EMAIL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]
    .flatMap((name) => {
      const value = process.env[name]?.trim();
      if (!value) return [];
      const normalized = value.replace(/\\n/g, "\n");
      return [value, normalized, normalized.replace(/\n/g, "\\n"), ...normalized.split("\n").filter((line) => line.length >= 40 && !line.startsWith("-----"))];
    }).filter((value) => value.length >= 8);
  const findings = [];
  for (const file of files) {
    if (/(?:^|\/)(?:\.env[^/]*|credentials[^/]*\.json[^/]*|[^/]*service[-_]?account[^/]*\.json[^/]*|credentials|secrets)(?:\/|$)/i.test(file) && file !== ".env.example") {
      findings.push([file, "forbidden credential path"]);
      continue;
    }
    if (/\.(?:pem|key|p12|pfx)$/i.test(file)) {
      findings.push([file, "key file"]);
      continue;
    }
    const content = staged ? git(["show", `:${file}`]) : readFileSync(file, "utf8");
    if (sensitive.some((value) => content.includes(value))) findings.push([file, "matches local secret"]);
    if (/\b\d{6,15}:[A-Za-z0-9_-]{30,}\b/.test(content)) findings.push([file, "possible Telegram token"]);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\\A-Za-z0-9+/=]{64,}/.test(content)) findings.push([file, "possible private key"]);
    if (/"type"\s*:\s*"service_account"/.test(content)) findings.push([file, "service account JSON"]);
    if (file === ".env.example" && content.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith("#") && !/^[A-Z][A-Z0-9_]*=$/.test(line.trim()))) {
      findings.push([file, "example must contain empty assignments only"]);
    }
  }
  if (findings.length) {
    for (const [file, reason] of findings) console.error(`${JSON.stringify(file)}: ${reason}`);
    console.error("Secret check failed. Values are intentionally withheld.");
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${files.length} ${staged ? "staged" : "repository candidate"} files checked; no detected credentials. No secret values printed.`);
  }
} catch {
  console.error("Secret check could not complete. No sensitive details printed.");
  process.exitCode = 1;
}
