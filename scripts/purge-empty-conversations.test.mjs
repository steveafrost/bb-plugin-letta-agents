import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CONVERSATIONS_ROOT } from "./purge-empty-conversations.mjs";

const execute = promisify(execFile);

// A Node fixture, never Docker. It accepts only `exec <container> node -e <script>`
// and redirects the fixed in-container conversations root to a temp directory, so
// the real scripts run unmodified against fixture data.
async function fakeDocker() {
  const directory = await mkdtemp(join(tmpdir(), "letta-purge-test-"));
  const executable = join(directory, "docker-fixture.cjs");
  await writeFile(executable, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] !== "exec" || args[1] !== "letta" || args[2] !== "node" || args[3] !== "-e") process.exit(2);
const script = args[4].split(${JSON.stringify(CONVERSATIONS_ROOT)}).join(process.env.PURGE_FIXTURE_ROOT);
const result = spawnSync(process.execPath, ["-e", script, ...args.slice(5)], { encoding: "utf8" });
if (result.status !== 0) { if (result.stderr) process.stderr.write(result.stderr); process.exit(1); }
process.stdout.write(result.stdout);
`, { mode: 0o700 });
  return { directory, executable };
}

async function fixture({ executable, root }) {
  const empty = join(root, "Y29udmVyc2F0aW9uOmVtcHR5");
  const messaged = join(root, "Y29udmVyc2F0aW9uOm1lc3NhZ2Vk");
  const archived = join(root, "Y29udmVyc2F0aW9uOmFyY2hpdmVk");
  const meta = (id, extra = {}) => JSON.stringify({ id, agent_id: "agent-local-test", archived: false, ...extra });
  await mkdir(empty, { recursive: true });
  await mkdir(messaged, { recursive: true });
  await mkdir(archived, { recursive: true });
  await writeFile(join(empty, "conversation.json"), meta("empty"));
  await writeFile(join(empty, "manifest.json"), "{}");
  // An empty messages.jsonl is still a message-free conversation.
  await writeFile(join(empty, "messages.jsonl"), "");
  await writeFile(join(messaged, "conversation.json"), meta("messaged"));
  await writeFile(join(messaged, "messages.jsonl"), `${JSON.stringify({ role: "user", content: "kept" })}\n`);
  await writeFile(join(archived, "conversation.json"), meta("archived", { archived: true }));

  const run = (...flags) => execute(
    process.execPath,
    [join(import.meta.dirname, "purge-empty-conversations.mjs"), "--docker", executable, "--container", "letta", ...flags],
    { encoding: "utf8", env: { ...process.env, PURGE_FIXTURE_ROOT: root } },
  );

  return { run, empty, messaged, archived };
}

test("dry run reports the split, selects only message-free conversations, and mutates nothing", async () => {
  const docker = await fakeDocker();
  try {
    const root = join(docker.directory, "conversations");
    const { run } = await fixture({ executable: docker.executable, root });
    const { stdout } = await run("--json");
    assert.deepEqual(JSON.parse(stdout), { container: "letta", total: 3, withMessages: 1, empty: 2, archivedEmpty: 1, selected: 2 });
    // Nothing removed, including the archived empty conversation.
    assert.deepEqual((await readdir(root)).sort(), ["Y29udmVyc2F0aW9uOm1lc3NhZ2Vk", "Y29udmVyc2F0aW9uOmFyY2hpdmVk", "Y29udmVyc2F0aW9uOmVtcHR5"]);
    assert.equal(JSON.parse(await readFile(join(root, "Y29udmVyc2F0aW9uOm1lc3NhZ2Vk", "messages.jsonl"), "utf8")).content, "kept");
  } finally {
    await rm(docker.directory, { recursive: true, force: true });
  }
});

test("--apply copies conversation.json into the backup dir before removing only empty conversations", async () => {
  const docker = await fakeDocker();
  try {
    const root = join(docker.directory, "conversations");
    const backup = join(docker.directory, "backup");
    const { run, messaged } = await fixture({ executable: docker.executable, root });
    const { stdout } = await run("--json", "--apply", "--backup-dir", backup);
    const result = JSON.parse(stdout);
    assert.equal(result.deleted, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.backupDir, resolve(backup));

    // The messaged conversation survives with its content intact.
    assert.equal(JSON.parse(await readFile(join(messaged, "messages.jsonl"), "utf8")).content, "kept");
    assert.equal(await stat(messaged).then(() => "present"), "present");
    // The empty ones are gone from the fixture root...
    assert.deepEqual(await readdir(root), ["Y29udmVyc2F0aW9uOm1lc3NhZ2Vk"]);
    // ...and their metadata was copied out first.
    assert.deepEqual((await readdir(backup)).sort(), ["Y29udmVyc2F0aW9uOmFyY2hpdmVk", "Y29udmVyc2F0aW9uOmVtcHR5", "backup-index.json"]);
    assert.equal(JSON.parse(await readFile(join(backup, "Y29udmVyc2F0aW9uOmVtcHR5", "conversation.json"), "utf8")).id, "empty");
    assert.equal(await readFile(join(backup, "Y29udmVyc2F0aW9uOmVtcHR5", "manifest.json"), "utf8"), "{}");
    assert.equal(JSON.parse(await readFile(join(backup, "Y29udmVyc2F0aW9uOmFyY2hpdmVk", "conversation.json"), "utf8")).archived, true);
  } finally {
    await rm(docker.directory, { recursive: true, force: true });
  }
});

test("--apply without --backup-dir exits 1 and deletes nothing", async () => {
  const docker = await fakeDocker();
  try {
    const root = join(docker.directory, "conversations");
    const { run } = await fixture({ executable: docker.executable, root });
    await assert.rejects(run("--apply"), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--apply requires --backup-dir/);
      return true;
    });
    assert.equal((await readdir(root)).length, 3);
  } finally {
    await rm(docker.directory, { recursive: true, force: true });
  }
});
