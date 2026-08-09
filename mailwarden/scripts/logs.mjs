#!/usr/bin/env node
/**
 * Readable Mailwarden logs.
 *
 *   pnpm logs           recent history
 *   pnpm logs --tail    follow live
 *   pnpm logs --all     include the health checks
 *   pnpm logs --local   read a local container instead of Fly
 *
 * Fly emits one ANSI-wrapped JSON blob per line, and a health check every 30
 * seconds. Watching a scan in that is impossible, so this correlates each
 * request/response pair by reqId and prints one line per exchange:
 *
 *   13:40:10  GET  /api/scan            200   4ms
 *
 * Lines our own code writes with console.log — sync and classify progress,
 * which are the ones you actually want during a scan — are passed through in
 * full and highlighted.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const argv = new Set(process.argv.slice(2));
const tail = argv.has("--tail") || argv.has("-f");
const showAll = argv.has("--all");
const local = argv.has("--local");

const cmd = local
  ? { bin: "docker", args: ["logs", ...(tail ? ["-f"] : ["--tail", "300"]), "mw-test"] }
  : {
      bin: path.join(os.homedir(), ".fly", "bin", "flyctl"),
      args: ["logs", "--app", "mailwarden", ...(tail ? [] : ["--no-tail"])],
    };

const C = {
  dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", off: "\x1b[0m",
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** reqId -> "METHOD /path", so the response line can name what it answered. */
const pending = new Map();

/** Paths worth seeing even in the default (quiet) view. */
const isNoise = (url) => url === "/healthz";

function render(raw) {
  const line = strip(raw);
  if (!line.trim()) return;

  const ts = line.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? "";
  const at = line.indexOf("{");

  // Non-JSON: a console.log from our own code. During a scan these are the
  // interesting ones ("[sync] incremental ...", "[classify] ...").
  if (at === -1) {
    const msg = line.replace(/^\S+\s+app\[\w+\]\s+\w+\s+\[[^\]]*\]/, "").trim();
    if (msg) console.log(`${C.dim}${ts}${C.off}  ${C.magenta}${msg}${C.off}`);
    return;
  }

  let j;
  try {
    j = JSON.parse(line.slice(at));
  } catch {
    const msg = line.slice(at).trim();
    if (msg) console.log(`${C.dim}${ts}${C.off}  ${C.magenta}${msg}${C.off}`);
    return;
  }

  if (j.req) {
    pending.set(j.reqId, `${j.req.method} ${j.req.url}`);
    return;
  }

  if (j.res) {
    const what = pending.get(j.reqId) ?? "";
    pending.delete(j.reqId);
    const url = what.split(" ")[1] ?? "";
    if (!showAll && isNoise(url)) return;

    const s = j.res.statusCode;
    const col = s >= 500 ? C.red : s >= 400 ? C.yellow : C.green;
    const ms = j.responseTime != null ? `${j.responseTime.toFixed(0)}ms` : "";
    const [method, ...rest] = what.split(" ");
    // Query strings on the OAuth callback carry the auth code — never print it.
    const safe = (rest.join(" ") || "").split("?")[0];
    console.log(
      `${C.dim}${ts}${C.off}  ${(method ?? "").padEnd(4)} ${safe.padEnd(28)} ${col}${s}${C.off} ${C.dim}${ms}${C.off}`,
    );
    return;
  }

  if (j.msg) {
    const col = j.level >= 50 ? C.red : j.level >= 40 ? C.yellow : C.cyan;
    console.log(`${C.dim}${ts}${C.off}  ${col}${j.msg}${C.off}`);
  }
}

const proc = spawn(cmd.bin, cmd.args, { shell: true });
let buf = "";
const pump = (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const l of lines) render(l);
};
proc.stdout.on("data", pump);
proc.stderr.on("data", (d) => {
  const t = strip(d.toString()).trim();
  // flyctl writes a metrics-token warning on every invocation; it is not news.
  if (t && !/^Warning/.test(t)) console.error(`${C.dim}${t}${C.off}`);
});
proc.on("close", (code) => process.exit(code ?? 0));
