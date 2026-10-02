import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createJeview, DATABASE, llmsText, requestDisplay, summarize, type JeviewSummary } from "../src/jeview.ts";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
type Hooks = { after(fn: () => unknown): void };
const listen = (server: Server) => new Promise<number>((accept) => server.listen(0, "127.0.0.1", () => accept((server.address() as AddressInfo).port)));

/** A stand-in for the local Laya adapter: records what it was sent and answers with `reply`. */
async function laya(t: Hooks, reply: (seen: Seen) => { status?: number; headers?: Record<string, string>; body: string }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const call = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(call);
      const { status = 200, headers = { "content-type": "application/json" }, body } = reply(call);
      res.writeHead(status, headers);
      res.end(body);
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { seen, url: `http://127.0.0.1:${port}/v1/systemone` };
}

async function proxy(t: Hooks, layaEndpoint: string, { dir = mkdtempSync(join(tmpdir(), "layaview-")) } = {}) {
  const made = createJeview({ dir, layaEndpoint });
  t.after(() => { made.server.close(); rmSync(dir, { recursive: true, force: true }); });
  const port = await listen(made.server);
  return { ...made, dir, base: `http://127.0.0.1:${port}` };
}

const question = { type: "choice", instructions: "What kind of message is `ticket`?", criteria: { bug_report: "a report of something broken", none: "none of the listed options fits" } };
const layaBody = JSON.stringify({
  model: "laya-typed-decisions",
  state: { ticket: { subject: "LOGIN broken", plan: "pro" } },
  questions: {
    kind: question,
    is_urgent: { type: "noul", instructions: "Is it urgent?" },
    severity: { type: "score", instructions: "How severe?", criteria: ["none", "low", "medium", "high"] },
  },
});
const layaAnswer = JSON.stringify({
  model: "convaiinnovations/laya-typed-decisions",
  answers: {
    kind: { type: "choice", choice: "bug_report", probabilities: { bug_report: 0.9, none: 0.1 }, confidence: 0.9 },
    is_urgent: { type: "noul", noul: 0.04 },
    severity: { type: "score", score: 2.1, probabilities: { "0": 0.03, "1": 0.17, "2": 0.7, "3": 0.1 }, confidence: 0.7 },
  },
  usage: { input_tokens: 1000 },
});
const records = async (base: string) => (await (await fetch(`${base}/_/api/records`)).json()) as {
  cursor: number; records: JeviewSummary[]; database: string; laya: string;
};

test("a Laya request needs no key, keeps the body whole, strips caller auth, adds events, and records local metadata", async (t) => {
  const upstream = await laya(t, () => ({ body: layaAnswer, headers: { "content-type": "application/json", "x-request-id": "r-1" } }));
  const { base, dir } = await proxy(t, upstream.url);
  const response = await fetch(`${base}/mythos/stage-2/v1/systemone`, {
    method: "POST",
    headers: { authorization: "Bearer caller-secret", "proxy-authorization": "Basic proxy-secret", "content-type": "application/json" },
    body: layaBody,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "r-1");
  assert.deepEqual(await response.json(), {
    ...JSON.parse(layaAnswer),
    events: { kind: "1:kind", is_urgent: "1:is_urgent", severity: "1:severity" },
  });

  assert.equal(upstream.seen.length, 1);
  const sent = upstream.seen[0]!;
  assert.deepEqual([sent.method, sent.url, sent.body, sent.headers.authorization, sent.headers["proxy-authorization"]], ["POST", "/v1/systemone", layaBody, undefined, undefined]);

  const listed = await records(base), summary = listed.records[0]!;
  assert.deepEqual([listed.cursor, summary.label, summary.trigger], [1, "mythos/stage-2", null]);
  assert.match(listed.laya, /^127\.0\.0\.1:/);
  assert.equal(summary.key, createHash("sha256").update(layaBody).digest("hex"));
  assert.deepEqual([summary.model, summary.answeredBy, summary.inputTokens, summary.cost], [
    "laya-typed-decisions", "convaiinnovations/laya-typed-decisions", 1000, null,
  ]);
  assert.deepEqual(summary.questions, [
    { id: "kind", type: "choice", asks: "What kind of message is `ticket`?", options: ["bug_report", "none"], choice: "bug_report", confidence: 0.9, p: 0.9, probabilities: { bug_report: 0.9, none: 0.1 } },
    { id: "is_urgent", type: "noul", asks: "Is it urgent?", noul: 0.04, p: 0.96 },
    { id: "severity", type: "score", asks: "How severe?", levels: 4, score: 2.1, confidence: 0.7, p: 0.7, probabilities: { "0": 0.03, "1": 0.17, "2": 0.7, "3": 0.1 } },
  ]);
  const record = await (await fetch(`${base}/_/api/records/${summary.id}`)).json() as { request: unknown; response: unknown };
  assert.deepEqual([record.request, record.response], [JSON.parse(layaBody), JSON.parse(layaAnswer)]);

  await fetch(`${base}/june/laya/v1/systemone`, { method: "POST", body: layaBody });
  assert.equal((await records(base)).records[1]!.label, "june");

  const database = join(dir, DATABASE);
  assert.ok(!readFileSync(database).includes("caller-secret"));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(database).mode & 0o777, 0o600);
});

test("Layaview-Trigger links a later call to an answer; legacy Jeview-Trigger is accepted and neither reaches Laya", async (t) => {
  const upstream = await laya(t, () => ({ body: layaAnswer }));
  const { base } = await proxy(t, upstream.url);
  const ask = (trigger?: string, legacy = false) => fetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: trigger === undefined ? {} : { [legacy ? "Jeview-Trigger" : "Layaview-Trigger"]: trigger, "Layaview-Anything": "ours", "Jeview-Anything": "legacy" },
    body: layaBody,
  });

  const first = await (await ask()).json() as { events: Record<string, string> };
  assert.equal(first.events.kind, "1:kind");
  const second = await (await ask(first.events.kind)).json() as { events: Record<string, string> };
  assert.equal(second.events.kind, "2:kind");
  await ask(first.events.is_urgent, true);

  assert.deepEqual(upstream.seen.map((seen) => [seen.url, seen.body]), Array(3).fill(["/v1/systemone", layaBody]));
  assert.deepEqual(upstream.seen.flatMap((seen) => Object.keys(seen.headers).filter((name) => name.startsWith("layaview-") || name.startsWith("jeview-"))), []);
  assert.deepEqual((await records(base)).records.map((r) => [r.id, r.trigger]), [[1, null], [2, "1:kind"], [3, "1:is_urgent"]]);

  for (const bad of ["", "x".repeat(201)]) {
    const refused = await ask(bad);
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /trigger must be the event id of an earlier answer/);
  }
  assert.equal(upstream.seen.length, 3);
});

test("Layaview-Display and legacy Jeview-Display are visualization-only aliases and never reach Laya", async (t) => {
  const upstream = await laya(t, () => ({ body: layaAnswer }));
  const { base } = await proxy(t, upstream.url);
  const ask = (display?: string, legacy = false) => fetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: display === undefined ? {} : { [legacy ? "Jeview-Display" : "Layaview-Display"]: display },
    body: layaBody,
  });
  await ask();
  await ask("name");
  await ask("kind=name, is_urgent=meta.title");
  await ask("kind=label", true);
  assert.deepEqual((await records(base)).records.map((r) => r.display ?? null), [
    null, { "*": "name" }, { kind: "name", is_urgent: "meta.title" }, { kind: "label" },
  ]);
  assert.deepEqual(upstream.seen.flatMap((seen) => Object.keys(seen.headers).filter((name) => name.startsWith("layaview-") || name.startsWith("jeview-"))), []);
  assert.deepEqual([requestDisplay(null), requestDisplay(""), requestDisplay("a.b-c_d"), requestDisplay("a..b"), requestDisplay("q=a=b")], [null, null, { "*": "a.b-c_d" }, null, { q: "a" }]);
});

test("Laya refusals pass through without an API-key gate, while unsupported routes and methods remain closed", async (t) => {
  const upstream = await laya(t, () => ({ status: 429, headers: { "content-type": "application/json", "retry-after": "2" }, body: JSON.stringify({ error: "slow down" }) }));
  const { base } = await proxy(t, upstream.url);
  const busy = await fetch(`${base}/v1/systemone`, { method: "POST", body: layaBody });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "2");
  assert.equal((await records(base)).records[0]!.status, 429);
  assert.equal(upstream.seen.length, 1);

  assert.equal((await fetch(`${base}/v1/systemone`)).status, 405);
  assert.equal((await fetch(`${base}/openrouter/api/v1/chat/completions`, { method: "POST", body: "{}" })).status, 405);
  assert.equal((await fetch(`${base}/_/api/settings`)).status, 404);
  assert.equal(upstream.seen.length, 1);
});

test("a page on another site cannot send model calls or read the private API, and adapter CORS grants are not passed on", async (t) => {
  const upstream = await laya(t, () => ({ body: layaAnswer, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "x-request-id" } }));
  const { base } = await proxy(t, upstream.url);
  const from = (origin?: string) => fetch(`${base}/run/v1/systemone`, { method: "POST", headers: { "content-type": "text/plain", ...(origin === undefined ? {} : { origin }) }, body: layaBody });
  for (const origin of ["https://attacker.example", "http://attacker.example:4777", "null"]) {
    const refused = await from(origin);
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as { error: string }).error, /cannot come from a page on another site/);
  }
  assert.deepEqual([upstream.seen.length, (await records(base)).records.length], [0, 0]);

  for (const origin of [undefined, base, "http://localhost:3000"]) {
    const answered = await from(origin);
    assert.equal(answered.status, 200);
    assert.deepEqual([answered.headers.get("access-control-allow-origin"), answered.headers.get("access-control-expose-headers")], [null, null]);
  }
  assert.deepEqual([upstream.seen.length, (await records(base)).records.length], [3, 3]);

  const get = (path: string, site: string) => new Promise<number>((accept, reject) => httpRequest({ host: "127.0.0.1", port: new URL(base).port, path, headers: { "sec-fetch-site": site } }, (res) => { res.resume(); accept(res.statusCode ?? 0); }).on("error", reject).end());
  assert.deepEqual(await Promise.all([get("/_/api/search?q=login", "cross-site"), get("/_/api/records", "cross-site")]), [403, 403]);
  assert.deepEqual(await Promise.all([get("/_/api/search?q=login", "same-origin"), get("/_/api/records", "same-site"), get("/", "cross-site"), get("/llms.txt", "cross-site")]), [200, 200, 200, 200]);
});

test("an unreachable Laya adapter is a recorded 502, and Layaview refuses to proxy to itself", async (t) => {
  const { base } = await proxy(t, "http://127.0.0.1:9/v1/systemone");
  const down = await fetch(`${base}/run/v1/systemone`, { method: "POST", body: layaBody });
  assert.equal(down.status, 502);
  const [summary] = (await records(base)).records;
  assert.deepEqual([summary!.status, summary!.label], [502, "run"]);
  assert.match(summary!.error ?? "", /Laya unreachable/);
  const selfDir = mkdtempSync(join(tmpdir(), "layaview-"));
  t.after(() => rmSync(selfDir, { recursive: true, force: true }));
  assert.throws(() => createJeview({ dir: selfDir, layaEndpoint: "http://localhost:4777/v1/systemone", port: 4777 }), /is this proxy/);
});

test("the viewer answers loopback hosts only, serves Layaview, and a non-JSON body is kept as sent", async (t) => {
  const upstream = await laya(t, () => ({ status: 400, body: "bad request" }));
  const { base } = await proxy(t, upstream.url);
  const port = new URL(base).port;
  const status = (host: string) => new Promise<number>((accept, reject) => httpRequest({ host: "127.0.0.1", port, path: "/_/api/records", headers: { host } }, (res) => { res.resume(); accept(res.statusCode ?? 0); }).on("error", reject).end());
  assert.equal(await status(`localhost:${port}`), 200);
  assert.equal(await status("attacker.example"), 403);
  assert.deepEqual(await Promise.all([`layaview.localhost:${port}`, "my.layaview.localhost"].map(status)), [200, 200]);
  assert.deepEqual(await Promise.all(["localhost.attacker.example", `layaview.localhost.attacker.example:${port}`, "attackerlocalhost", "layaview.localhost@attacker.example", ".localhost"].map(status)), [403, 403, 403, 403, 403]);
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(await page.text(), /<title>Layaview<\/title>/);
  assert.equal((await fetch(`${base}/_/ui/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await fetch(`${base}/_/ui/app.css`)).status, 200);

  await fetch(`${base}/v1/systemone`, { method: "POST", body: "not json" });
  const [summary] = (await records(base)).records;
  const record = await (await fetch(`${base}/_/api/records/${summary!.id}`)).json() as { request: unknown; response: unknown };
  assert.deepEqual([summary!.status, summary!.questions, record.request, record.response], [400, [], "not json", "bad request"]);
});

test("calls survive a restart in the database, ids continue, and search reads every request and answer", async (t) => {
  const upstream = await laya(t, () => ({ body: layaAnswer }));
  const dir = mkdtempSync(join(tmpdir(), "layaview-"));
  const first = createJeview({ dir, layaEndpoint: upstream.url });
  t.after(() => { first.server.close(); rmSync(dir, { recursive: true, force: true }); });
  const firstBase = `http://127.0.0.1:${await listen(first.server)}`;
  await fetch(`${firstBase}/v1/systemone`, { method: "POST", body: layaBody });
  await fetch(`${firstBase}/v1/systemone`, { method: "POST", body: layaBody.replace("LOGIN broken", "Other_Thing 100%") });
  await new Promise((accept) => first.server.close(accept));

  const { base } = await proxy(t, upstream.url, { dir });
  assert.deepEqual((await records(base)).records.map((r) => r.id), [1, 2]);
  await fetch(`${base}/v1/systemone`, { method: "POST", body: layaBody });
  const listed = await records(base);
  assert.deepEqual(listed.records.map((r) => r.id), [1, 2, 3]);
  assert.equal(listed.records[0]!.stateKey, listed.records[2]!.stateKey);
  assert.notEqual(listed.records[0]!.stateKey, listed.records[1]!.stateKey);
  const search = async (q: string) => ((await (await fetch(`${base}/_/api/search?q=${encodeURIComponent(q)}`)).json()) as { ids: number[] }).ids;
  assert.deepEqual(await search("login"), [3, 1]);
  assert.deepEqual(await search("other_THING"), [2]);
  assert.deepEqual(await search("100%"), [2]);
  assert.deepEqual(await search("convaiinnovations bug_report"), [3, 2, 1]);
  assert.deepEqual(await search(""), []);
});

test("a long history is paged from the latest calls when asked, and calls are found by id", async (t) => {
  const upstream = await laya(t, () => ({ body: layaAnswer }));
  const { base } = await proxy(t, upstream.url);
  for (let i = 0; i < 5; i++) await fetch(`${base}/v1/systemone`, { method: "POST", body: layaBody });
  type Page = { records: JeviewSummary[]; cursor: number; more: boolean; older?: number };
  const page = async (query: string) => (await (await fetch(`${base}/_/api/records?${query}`)).json()) as Page;
  const shape = ({ records, cursor, more, older }: Page) => [records.map((r) => r.id), cursor, more, older ?? null];

  assert.deepEqual(shape(await page("since=0&limit=2")), [[1, 2], 2, true, null]);
  assert.deepEqual(shape(await page("since=2&limit=2")), [[3, 4], 4, true, null]);
  assert.deepEqual(shape(await page("since=4&limit=2")), [[5], 5, false, null]);
  assert.deepEqual(shape(await page("since=99")), [[], 5, false, null]);
  assert.deepEqual(shape(await page("latest=2")), [[4, 5], 5, false, 3]);
  assert.deepEqual(shape(await page("latest=3&limit=2")), [[3, 4], 4, true, 2]);
  assert.deepEqual((await page("ids=5,2,2,nope,77")).records.map((r) => r.id), [2, 5]);
});

test("two Layaviews sharing a folder never hand out the same call id, and each shows the calls of both", async (t) => {
  const upstream = await laya(t, () => ({ body: layaAnswer }));
  const one = await proxy(t, upstream.url);
  const two = await proxy(t, upstream.url, { dir: one.dir });
  const ask = (base: string) => fetch(`${base}/v1/systemone`, { method: "POST", body: layaBody }).then((response) => response.json()) as Promise<{ events: Record<string, string> }>;
  const answers = await Promise.all([one, two, one, two, two, one].map(({ base }) => ask(base)));
  assert.deepEqual(answers.map((answer) => answer.events.kind).sort(), ["1:kind", "2:kind", "3:kind", "4:kind", "5:kind", "6:kind"]);
  for (const { base } of [one, two]) assert.deepEqual((await records(base)).records.map((r) => r.id).sort(), [1, 2, 3, 4, 5, 6]);
  assert.equal(one.store.allocate(), 7);
  const three = await proxy(t, upstream.url, { dir: one.dir });
  assert.equal(three.store.allocate(), 8);
  const request = JSON.parse(layaBody) as unknown, response = JSON.parse(layaAnswer) as unknown;
  one.store.save({ summary: summarize({ id: 20, at: new Date().toISOString(), label: "", trigger: null, status: 200, elapsedMs: 1 }, Buffer.from(layaBody), request, response), request, response });
  assert.deepEqual([two.store.allocate(), three.store.allocate()], [21, 22]);
});

test("the generated llms.txt matches the repository copy", () => {
  assert.equal(readFileSync(new URL("../llms.txt", import.meta.url), "utf8"), llmsText("http://127.0.0.1:4777"));
});

test("the local guide and metadata are Laya-native: no key gate, TypeSafe endpoint, or fake dollar cost", async (t) => {
  const upstream = await laya(t, () => ({ body: layaAnswer }));
  const { base } = await proxy(t, upstream.url);
  const guide = await fetch(`${base}/llms.txt`);
  assert.equal(guide.headers.get("content-type"), "text/plain; charset=utf-8");
  const text = await guide.text();
  assert.ok(text.includes(`${base}/v1/systemone`) && text.includes(`${base}/<label>/v1/systemone`) && text.includes("Layaview-Trigger: <event id>"));
  assert.ok(!/TypeSafe|Jev key|api\.typesafe\.ai/.test(text));

  const meta = await records(base);
  assert.match(meta.laya, /^127\.0\.0\.1:/);
  assert.ok(!("keyed" in meta));
  await fetch(`${base}/v1/systemone`, { method: "POST", body: layaBody });
  assert.equal((await records(base)).records[0]!.cost, null);
});
