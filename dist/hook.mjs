// src/cli/hook.ts
import { spawn } from "child_process";
import { closeSync as closeSync3, openSync as openSync3, statSync as statSync3 } from "fs";
import { tmpdir } from "os";
import { join as join4 } from "path";
import { fileURLToPath } from "url";

// src/payload.ts
import { isAbsolute } from "path";

// src/shared/state.ts
import { randomUUID } from "crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "fs";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
var FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
function isFileId(value) {
  return typeof value === "string" && FILE_ID.test(value);
}
function ensurePrivateDir(dir, options) {
  mkdirSync(dir, { recursive: true, mode: 448 });
  if (options?.tighten === true && process.platform !== "win32") chmodSync(dir, 448);
}

// src/payload.ts
var MODEL_MAX = 256;
function handOff(stop) {
  return JSON.stringify(stop);
}
function readStop(payload, at) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return void 0;
  const given = payload;
  const { session_id: sessionId, transcript_path: transcriptPath, hook_event_name: event } = given;
  if (event !== "Stop" && event !== "SessionEnd") return void 0;
  if (!isFileId(sessionId)) return void 0;
  if (typeof transcriptPath !== "string" || !isAbsolute(transcriptPath) || !transcriptPath.endsWith(".jsonl"))
    return void 0;
  const stop = { sessionId, transcriptPath, event, at };
  if (event === "Stop" && isFileId(given.turn_id)) stop.turnId = given.turn_id;
  if (typeof given.cwd === "string" && isAbsolute(given.cwd)) stop.cwd = given.cwd;
  const model = typeof given.model === "string" ? given.model.trim() : "";
  if (model !== "" && model.length <= MODEL_MAX) stop.model = model;
  return stop;
}

// src/paths.ts
import { homedir } from "os";
import { join as join3 } from "path";

// src/shared/settings.ts
import { createHmac } from "crypto";
import { closeSync as closeSync2, constants, fstatSync, openSync as openSync2, readFileSync as readFileSync2 } from "fs";
import { isAbsolute as isAbsolute2 } from "path";

// src/shared/log.ts
import { appendFileSync, renameSync as renameSync2, statSync as statSync2 } from "fs";
import { join as join2 } from "path";
var LOG_MAX_BYTES = 1024 * 1024;

// src/shared/settings.ts
var MAX_KEY_FILE_BYTES = 64 * 1024;
var SPACE = "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
var ENDS = new RegExp(`^${SPACE}+|${SPACE}+$`, "g");
function trimmed(given) {
  return typeof given === "string" && given.trim() !== "" ? given.trim() : void 0;
}
function absoluteFrom(env, name) {
  const given = trimmed(env[name]);
  return given !== void 0 && isAbsolute2(given) ? given : void 0;
}

// src/paths.ts
function codexHome(env, home = homedir()) {
  return absoluteFrom(env, "CODEX_HOME") ?? join3(home, ".codex");
}
function stateDir(env, home) {
  return absoluteFrom(env, "PLUGIN_DATA") ?? join3(codexHome(env, home), "telmoni");
}

// src/cli/hook.ts
var MAX_INPUT_BYTES = 64 * 1024 * 1024;
var HANDOFF_MS = 2e3;
async function input() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return "";
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function start(stop) {
  const dir = stateDir(process.env);
  let cwd = tmpdir();
  let errors = "ignore";
  try {
    ensurePrivateDir(dir);
    cwd = dir;
    errors = openSync3(join4(dir, "hook.log"), "a", 384);
  } catch {
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, HANDOFF_MS);
    try {
      const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
      const child = spawn(process.execPath, [worker], {
        cwd,
        // A session of its own, out of the hook's process group, which Codex kills at the hook's timeout.
        detached: true,
        stdio: ["pipe", "ignore", errors],
        windowsHide: true
      });
      child.on("error", done);
      child.stdin?.on("error", done);
      child.stdin?.end(handOff(stop), done);
      child.unref();
    } catch {
      done();
    } finally {
      if (typeof errors === "number") closeSync3(errors);
    }
  });
}
try {
  const at = Date.now();
  const stop = readStop(JSON.parse(await input()), at);
  if (stop !== void 0) {
    try {
      stop.size = statSync3(stop.transcriptPath).size;
    } catch {
    }
    await start(stop);
  }
} catch {
}
process.exit(0);
