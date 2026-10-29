#!/usr/bin/env node
// Opt-in offline cleanup for retained EMPTY Letta conversations.
//
// Letta has no supported conversation delete: `DELETE /v1/conversations/<id>`
// returns 404, the SDK only exposes `update({ archived: true })`, and
// `conversations.list()` still returns archived records. Retained empty
// conversations therefore accumulate on disk. This script removes those
// directories directly, and ONLY those with zero messages.
//
// It never reads or writes the SQLite database, and it never deletes a
// directory that contains a message. Dry run is the default.
//
// See the "Maintenance: purge retained empty conversations" README section.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Conversations root inside the Letta container (local letta-code layout). */
export const CONVERSATIONS_ROOT = "/root/.letta/lc-local-backend/conversations";

// Same shape the plugin's backend policy accepts for a container name.
const CONTAINER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
// Same shape the plugin's backend policy accepts for a Letta agent id.
const AGENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
// Conversation directories are base64url of "conversation:<id>". The literal
// below is both compiled here and spliced into the in-container scripts, so a
// name can never be a path, a glob, or anything but one directory component.
const DIRECTORY_SOURCE = "^[A-Za-z0-9_-]{1,200}$";
const DIRECTORY_PATTERN = new RegExp(DIRECTORY_SOURCE);
// Fail at import time rather than inside a container with a broken pattern.
if (!DIRECTORY_PATTERN.test("Y29udmVyc2F0aW9uOjE") || DIRECTORY_PATTERN.test("a/b")) {
  throw new Error("Conversation directory pattern is invalid.");
}

const BACKED_UP_FILES = ["conversation.json", "manifest.json", "system-prompt.json"];

const USAGE = `Usage: node scripts/purge-empty-conversations.mjs [options]

Removes retained Letta conversation directories that contain ZERO messages.
Dry run by default: nothing is deleted unless --apply is passed.

Options:
  --json                     Print the JSON summary instead of readable text.
  --apply                    Delete the selected directories. Requires --backup-dir.
  --backup-dir <path>        Local directory that receives a copy of each selected
                             conversation.json (plus manifest.json and
                             system-prompt.json when present) before deletion.
                             Required with --apply. Printed as an absolute path.
  --agent <letta-agent-id>   Limit scope to one Letta agent.
  --include-archived         Select archived empty conversations too. This is the
                             DEFAULT; the flag exists to state it explicitly.
  --exclude-archived         Narrow the selection to non-archived empty
                             conversations only.
  --docker <executable>      Docker executable name on PATH or absolute path.
                             Default: docker
  --container <name>         Letta container name. Default: letta
  --help                     Print this help and exit 0.

Defaults: every conversation directory whose messages.jsonl is missing or
empty is selected, archived or not, for every agent.

What is removed: only <root>/<conversation-dir>/ itself, for directories that
re-verify as message-free inside the container immediately before removal.
What is not touched: the Letta database, message content in non-empty
conversations, agents, and message-free directories that --agent or
--exclude-archived excluded.

Exit codes: 0 on success (including a dry run), 1 on refusal or error.
`;

function fail(message) {
  process.stderr.write(`purge-empty-conversations: ${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = {
    json: false, apply: false, backupDir: null, agent: null,
    includeArchived: true, docker: "docker", container: "letta", help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    // A single-value flag takes the next argument; refuse a missing value or a
    // second flag rather than silently consuming it.
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) fail(`${flag} requires a value.`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--json": options.json = true; break;
      case "--apply": options.apply = true; break;
      case "--backup-dir": options.backupDir = value(); break;
      case "--agent": options.agent = value(); break;
      case "--include-archived": options.includeArchived = true; break;
      case "--exclude-archived": options.includeArchived = false; break;
      case "--docker": options.docker = value(); break;
      case "--container": options.container = value(); break;
      case "--help": case "-h": options.help = true; break;
      default: fail(`unknown argument ${flag}. Use --help for the accepted flags.`);
    }
  }
  return options;
}

function validate(options) {
  const docker = options.docker.trim();
  if (!docker || docker.startsWith("-") || /[\r\n\0]/.test(docker)) {
    fail("--docker must be an executable name or absolute path, not a shell command.");
  }
  if (!CONTAINER_PATTERN.test(options.container)) fail(`invalid container name: ${options.container}`);
  if (options.agent !== null) {
    if (!AGENT_PATTERN.test(options.agent)) fail(`invalid Letta agent id: ${options.agent}`);
  }
  if (options.apply && !options.backupDir) {
    fail("--apply requires --backup-dir; no conversation was deleted.");
  }
  return docker;
}

async function runInContainer(docker, container, script, args = []) {
  const { stdout } = await execute(docker, ["exec", container, "node", "-e", script, ...args], {
    timeout: 120_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8",
  });
  return JSON.parse(stdout);
}

// Enumerate every conversation directory. Message counts come from the file
// itself, so a directory with any message is classified as non-empty even when
// its conversation.json is missing or unparsable.
const SCAN_SCRIPT = `const fs=require("fs"),root=${JSON.stringify(CONVERSATIONS_ROOT)};
const entries=[];
for(const name of fs.readdirSync(root)){
  const dir=root+"/"+name;
  if(!fs.statSync(dir).isDirectory())continue;
  let meta=null;
  try{meta=JSON.parse(fs.readFileSync(dir+"/conversation.json","utf8"));}catch{}
  let messages=0;
  try{messages=fs.readFileSync(dir+"/messages.jsonl","utf8").split("\\n").filter(line=>line.trim()!=="").length;}catch{}
  entries.push({name,id:meta&&typeof meta.id==="string"?meta.id:null,agentId:meta&&typeof meta.agent_id==="string"?meta.agent_id:null,archived:meta?meta.archived===true:null,hasMetadata:meta!==null,messages});
}
process.stdout.write(JSON.stringify(entries));`;

// Read the backup payload as base64, only from names that resolve to a direct
// child of the conversations root. No message file is read.
const READBACK_SCRIPT = `const fs=require("fs"),path=require("path");
const root=${JSON.stringify(CONVERSATIONS_ROOT)},rootReal=fs.realpathSync(root);
const names=${JSON.stringify(BACKED_UP_FILES)};
const out={};
for(const name of process.argv.slice(1)){
  if(!/${DIRECTORY_SOURCE}/.test(name))continue;
  const dir=path.resolve(rootReal,name);
  if(path.dirname(dir)!==rootReal)continue;
  const files={};
  for(const file of names){
    try{files[file]=fs.readFileSync(dir+"/"+file).toString("base64");}catch{}
  }
  out[name]=files;
}
process.stdout.write(JSON.stringify(out));`;

// Deletion re-verifies every precondition inside the container: an exact
// direct child of the root, a parsed conversation.json, and zero messages.
// No SQL, no glob, and no directory outside the selected one is touched.
const DELETE_SCRIPT = `const fs=require("fs"),path=require("path");
const root=${JSON.stringify(CONVERSATIONS_ROOT)},rootReal=fs.realpathSync(root);
const results=[];
for(const name of process.argv.slice(1)){
  if(!/${DIRECTORY_SOURCE}/.test(name)){results.push({name,deleted:false,reason:"invalid-directory-name"});continue;}
  const dir=path.resolve(rootReal,name);
  if(dir===rootReal||path.dirname(dir)!==rootReal){results.push({name,deleted:false,reason:"not-a-direct-child"});continue;}
  if(!fs.existsSync(dir)){results.push({name,deleted:false,reason:"already-absent"});continue;}
  let meta;
  try{meta=JSON.parse(fs.readFileSync(dir+"/conversation.json","utf8"));}
  catch{results.push({name,deleted:false,reason:"conversation-json-unreadable"});continue;}
  let messages;
  try{messages=fs.readFileSync(dir+"/messages.jsonl","utf8").split("\\n").filter(line=>line.trim()!=="").length;}
  catch{messages=0;}
  if(messages>0){results.push({name,deleted:false,reason:"has-messages"});continue;}
  try{fs.rmSync(dir,{recursive:true});results.push({name,deleted:true,id:meta&&typeof meta.id==="string"?meta.id:null});}
  catch{results.push({name,deleted:false,reason:"remove-failed"});}
}
process.stdout.write(JSON.stringify(results));`;

function summarise(entries, options) {
  const withMetadata = entries.filter(entry => entry.hasMetadata);
  const withMessages = entries.filter(entry => entry.messages > 0).length;
  const empty = withMetadata.filter(entry => entry.messages === 0);
  const archivedEmpty = empty.filter(entry => entry.archived === true).length;
  const selected = empty.filter(entry => {
    if (options.agent !== null) {
      if (entry.agentId === null) return false;
      if (entry.agentId !== options.agent) return false;
    }
    return options.includeArchived || entry.archived !== true;
  });
  return {
    summary: {
      container: options.container,
      total: entries.length,
      withMessages,
      empty: empty.length,
      archivedEmpty,
      selected: selected.length,
    },
    selected,
  };
}

async function writeBackup(backupDir, container, payload) {
  const absolute = resolve(backupDir);
  const names = Object.keys(payload);
  for (const name of names) {
    const directory = join(absolute, name);
    await mkdir(directory, { recursive: true });
    for (const [file, encoded] of Object.entries(payload[name])) {
      await writeFile(join(directory, file), Buffer.from(encoded, "base64"));
    }
  }
  await writeFile(join(absolute, "backup-index.json"), `${JSON.stringify({
    container,
    conversationsRoot: CONVERSATIONS_ROOT,
    createdAt: new Date().toISOString(),
    directories: names,
  }, null, 2)}\n`);
  return absolute;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const docker = validate(options);

  let entries;
  try {
    entries = await runInContainer(docker, options.container, SCAN_SCRIPT);
  } catch (error) {
    fail(`could not read ${CONVERSATIONS_ROOT} in container ${options.container} via ${docker} (${error.code ?? "error"}). Check Docker, the container name, and container access.`);
  }
  if (!Array.isArray(entries)) fail(`unexpected scan output from container ${options.container}.`);

  const { summary, selected } = summarise(entries, options);
  const selectedNames = selected.map(entry => entry.name);

  if (!options.apply) {
    if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    else {
      process.stdout.write([
        `Container: ${summary.container} (${CONVERSATIONS_ROOT})`,
        `Conversations: ${summary.total} total, ${summary.empty} empty (${summary.archivedEmpty} archived), ${summary.withMessages} with messages`,
        `Selected for deletion: ${summary.selected}`,
        "Dry run: nothing was deleted. Re-run with --apply --backup-dir <dir> to delete.",
        "",
      ].join("\n"));
    }
    return 0;
  }

  // Backup before any removal, from the same validated directory set.
  let backupPath = null;
  try {
    const payload = await runInContainer(docker, options.container, READBACK_SCRIPT, selectedNames);
    backupPath = await writeBackup(options.backupDir, options.container, payload);
  } catch (error) {
    fail(`backup failed for ${CONVERSATIONS_ROOT} in container ${options.container} (${error.code ?? "error"}); no conversation was deleted.`);
  }

  let results;
  try {
    results = await runInContainer(docker, options.container, DELETE_SCRIPT, selectedNames);
  } catch (error) {
    fail(`deletion command failed in container ${options.container} (${error.code ?? "error"}); backups are at ${backupPath}.`);
  }
  if (!Array.isArray(results)) fail(`unexpected delete output from container ${options.container}; backups are at ${backupPath}.`);

  const deleted = results.filter(result => result.deleted === true).length;
  const skipped = results.filter(result => result.deleted !== true);
  const output = {
    ...summary,
    backupDir: backupPath,
    deleted,
    skipped: skipped.length,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(output)}\n`);
  else {
    process.stdout.write([
      `Container: ${summary.container} (${CONVERSATIONS_ROOT})`,
      `Conversations: ${summary.total} total, ${summary.empty} empty (${summary.archivedEmpty} archived), ${summary.withMessages} with messages`,
      `Selected: ${summary.selected}`,
      `Backup: ${backupPath}`,
      `Deleted: ${deleted}`,
      `Skipped: ${skipped.length}`,
      "",
    ].join("\n"));
  }
  if (skipped.length > 0) {
    for (const result of skipped) {
      process.stderr.write(`purge-empty-conversations: skipped ${result.name}: ${result.reason}\n`);
    }
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`purge-empty-conversations: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments, summarise, main };
