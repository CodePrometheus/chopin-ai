import { MessageChannel } from "node:worker_threads";
import { openEncryptedDatabase } from "../dist/encrypted-store.js";

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

const base = new URL(required("CHOPIN_CONTROL_URL"));
const credential = required("CHOPIN_CONTROL_TOKEN");
const identity = { agentId: required("CHOPIN_AGENT_ID"), epoch: Number(required("CHOPIN_RUNTIME_EPOCH")), owner: "local" };
if (!Number.isSafeInteger(identity.epoch) || identity.epoch < 1) throw new Error("the trusted runtime generation is invalid");
const fault = process.env.CHOPIN_TEST_STORAGE_FAULT;
class InjectedTransportFailure extends Error {}

async function pause(stage) {
  if (process.env.CHOPIN_TEST_STORAGE_PAUSE !== stage) return;
  const keepAlive = new MessageChannel();
  keepAlive.port1.on("message", () => {});
  process.stdout.write(`${JSON.stringify({ stage })}\n`);
  await new Promise(() => {});
  keepAlive.port1.close();
  keepAlive.port2.close();
}

async function call(operation, body, missing = false) {
  const response = await fetch(new URL(`/internal/v1/anchor/${operation}`, base), {
    method: "POST", redirect: "error",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ ...identity, ...body }),
  });
  if (missing && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`the trusted storage host refused ${operation}: ${response.status}`);
  return response.json();
}

const anchor = {
  generation: identity.epoch,
  read: () => call("read", {}, true),
  init: (head) => call("init", { head }),
  prepare: async (expected, pending) => {
    const response = await call("prepare", { expected, pending });
    await pause("prepared");
    if (fault === "after_prepare") throw new InjectedTransportFailure("the original prepare response was lost");
    return response;
  },
  confirm: async (pending, local) => {
    await pause("durable");
    if (fault === "before_confirm") throw new InjectedTransportFailure("the original confirmation could not be observed");
    const response = await call("confirm", { pending, local });
    await pause("confirmed");
    return response;
  },
  abort: (pending, verifiedLocal) => call("abort", { pending, verifiedLocal }),
};

const action = required("CHOPIN_TEST_STORAGE_ACTION");
if (!["init", "read", "write"].includes(action)) throw new Error("this probe does not implement the requested storage scenario");
const encoded = required("CHOPIN_TEST_STORAGE_KEY");
const key = Buffer.from(encoded, "base64url");
if (key.length !== 32 || key.toString("base64url") !== encoded) throw new Error("the synthetic fixture key is invalid");
let database;
try {
  database = await openEncryptedDatabase({
    dir: required("CHOPIN_TEST_STORAGE_DIR"), key, anchor, queueCapacity: 1,
    create: action === "init", nativeModule: required("CHOPIN_STORAGE_NATIVE"),
  });
} finally { key.fill(0); }
try {
  if (action === "init") {
    await database.exec("CREATE TABLE probe_entries(id INTEGER PRIMARY KEY) STRICT");
    await database.confirmedHead();
    process.stdout.write(`${JSON.stringify({ acknowledged: true })}\n`);
  } else if (action === "read") {
    const rows = await database.all("SELECT id FROM probe_entries ORDER BY id");
    await database.confirmedHead();
    process.stdout.write(`${JSON.stringify({ rows })}\n`);
  } else {
    const entry = Number(required("CHOPIN_TEST_STORAGE_ENTRY"));
    if (!Number.isSafeInteger(entry) || entry < 1) throw new Error("the synthetic fixture entry is invalid");
    try {
      await database.run("INSERT INTO probe_entries(id) VALUES(?1)", entry);
      await database.confirmedHead();
      process.stdout.write(`${JSON.stringify({ acknowledged: true })}\n`);
    } catch (error) {
      if (!(error instanceof InjectedTransportFailure)) throw error;
      process.stdout.write(`${JSON.stringify({ acknowledged: false, uncertain: true })}\n`);
    }
  }
} finally { await database.close(); }
