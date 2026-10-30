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
// the real scripts run unmodified against fixture data. Every invocation appends
// to a log file, so a test can prove that no container call was made at all.
async function fakeDocker() {
  const directory = await mkdtemp(join(tmpdir(), "letta-purge-test-"));
  const executable = join(directory, "docker-fixture.cjs");
  const log = join(directory, "invocations.log");
  await writeFile(executable, `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (process.env.PURGE_FIXTURE_LOG) appendFileSync(process.env.PURGE_FIXTURE_LOG, args.join(" ") + "\\n");
if (args[0] !== "exec" || args[1] !== "letta" || args[2] !== "node" || args[3] !== "-e") process.exit(2);
const script = args[4].split(${JSON.stringify(CONVERSATIONS_ROOT)}).join(process.env.PURGE_FIXTURE_ROOT);
const result = spawnSync(process.execPath, ["-e", script, ...args.slice(5)], { encoding: "utf8" });
if (result.status !== 0) { if (result.stderr) process.stderr.write(result.stderr); process.exit(1); }
process.stdout.write(result.stdout);
`, { mode: 0o700 });
  return { directory, executable, log };
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

// Same fixture run, but with the invocation log enabled so a test can assert on
// how many container calls were made (and with which scripts).
async function loggedRun(executable, log, root, ...flags) {
  return execute(
    process.execPath,
    [join(import.meta.dirname, "purge-empty-conversations.mjs"), "--docker", executable, "--container", "letta", ...flags],
    { encoding: "utf8", env: { ...process.env, PURGE_FIXTURE_ROOT: root, PURGE_FIXTURE_LOG: log } },
  );
}

test("dry run reports the split, selects only message-free conversations, and mutates nothing", async () => {
  const docker = await fakeDocker();
  try {
    const root = join(docker.directory, "conversations");
    const { run } = await fixture({ executable: docker.executable, root });
    const { stdout } = await run("--json");
    assert.deepEqual(JSON.parse(stdout), {
      container: "letta",
      conversationsRoot: CONVERSATIONS_ROOT,
      total: 3,
      withMessages: 1,
      empty: 2,
      archivedEmpty: 1,
      selected: 2,
    });
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

test("--conversations-root targets a non-default layout for both the scan and the delete path", async () => {
  const docker = await fakeDocker();
  try {
    // Deliberately NOT under the fixture's PURGE_FIXTURE_ROOT: the custom root is
    // a real absolute path, so the container scripts must use the passed value.
    const customRoot = join(docker.directory, "elsewhere", "conversations");
    const defaultRoot = join(docker.directory, "conversations");
    const backup = join(docker.directory, "backup");
    const { run } = await fixture({ executable: docker.executable, root: customRoot });

    const { stdout: dryRun } = await run("--json", "--conversations-root", customRoot);
    assert.deepEqual(JSON.parse(dryRun), {
      container: "letta",
      conversationsRoot: customRoot,
      total: 3,
      withMessages: 1,
      empty: 2,
      archivedEmpty: 1,
      selected: 2,
    });

    const { stdout } = await run("--json", "--conversations-root", customRoot, "--apply", "--backup-dir", backup);
    const result = JSON.parse(stdout);
    assert.equal(result.conversationsRoot, customRoot);
    assert.equal(result.deleted, 2);
    assert.equal(result.skipped, 0);
    // Deletion happened in the custom root...
    assert.deepEqual(await readdir(customRoot), ["Y29udmVyc2F0aW9uOm1lc3NhZ2Vk"]);
    // ...and the default root was never created or touched.
    await assert.rejects(stat(defaultRoot), error => error.code === "ENOENT");
    // The backup index records the root that was actually used.
    const index = JSON.parse(await readFile(join(backup, "backup-index.json"), "utf8"));
    assert.equal(index.conversationsRoot, customRoot);
  } finally {
    await rm(docker.directory, { recursive: true, force: true });
  }
});

test("a --conversations-root that does not exist exits 1 naming the path and deletes nothing", async () => {
  const docker = await fakeDocker();
  try {
    const root = join(docker.directory, "conversations");
    const missing = join(docker.directory, "does-not-exist");
    const { run } = await fixture({ executable: docker.executable, root });
    await assert.rejects(run("--json", "--conversations-root", missing), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(error.stderr, /--conversations-root/);
      assert.match(error.stderr, /does not exist/);
      assert.equal(error.stdout, "");
      return true;
    });
    // Nothing was scanned as zero and nothing was removed.
    assert.equal((await readdir(root)).length, 3);
  } finally {
    await rm(docker.directory, { recursive: true, force: true });
  }
});

test("an invalid --conversations-root exits 1 before any container call", async () => {
  const docker = await fakeDocker();
  try {
    const root = join(docker.directory, "conversations");
    await fixture({ executable: docker.executable, root });
    for (const invalid of ["relative/path", "/root/.letta/../secrets", "/root/.letta/conversations/", ""]) {
      await assert.rejects(loggedRun(docker.executable, docker.log, root, "--json", "--conversations-root", invalid), error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /invalid --conversations-root/);
        return true;
      });
    }
    // The fake docker was never invoked: validation precedes every container call.
    await assert.rejects(readFile(docker.log, "utf8"), error => error.code === "ENOENT");
    assert.equal((await readdir(root)).length, 3);
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
