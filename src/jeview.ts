// Layaview: a local visualizer for Laya decisions, with a live view of every call (README.md). A client sends
// System One-shaped requests here (POST /v1/systemone, or /<label>/v1/systemone to group requests); the proxy
// calls a local Laya adapter, answers the client with Laya's answer, and keeps each call whole in a private SQLite
// database. Loopback only: calls can hold private data.
//
// Every answer Laya gives gets an event id, "<call>:<question>", returned with the answers as `events`. A later request
// that follows from one of those answers says so in a header, `Layaview-Trigger: <event id>`, so the viewer can grow
// that question as a branch off the answer that led to it. Layaview's own headers are dropped before Laya, and the
// body goes to the adapter byte for byte.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const LAYA_PATH = "/v1/systemone";
/** Compatibility alias for callers that imported Jeview's original constant. */
export const JEV_PATH = LAYA_PATH;
/** Default local Laya adapter endpoint. */
export const LAYA_ENDPOINT = "http://127.0.0.1:4778/v1/systemone";
/** Compatibility alias for callers that imported Jeview's original constant. */
export const JEV_ENDPOINT = LAYA_ENDPOINT;
export const DATABASE = "layaview.sqlite";
const BODY_LIMIT = 16 * 1024 * 1024;
const PAGE = 5000, IDS_LISTED = 1000; // summaries in one answer: a page of the history, or the calls named by id (as many as a search finds)
const REQUEST_DROP = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "content-length", "accept-encoding", "authorization", "proxy-authorization", "cookie", "origin", "referer"]);
// fetch has already decoded the body, so its length and encoding no longer describe what is sent on
const RESPONSE_DROP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);
// the names this machine goes by. Any name ending in .localhost is one of them: that ending is reserved for the machine
// itself, so no other site can have it, and http://layaview.localhost:4777/ opens the viewer with no hosts entry
const LOOPBACK = /^(127\.0\.0\.1|\[::1\]|([a-z0-9-]+\.)*localhost)(:\d+)?$/;
/** A page on another site can POST here without asking first. A browser names the page's site in Origin ("null" for
 * a sandboxed one); a caller that is not a page sends none. */
const foreign = (origin: string | undefined) => origin !== undefined && !LOOPBACK.test(origin.replace(/^https?:\/\//, ""));
const UI_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

/** One question as listed: its id, what it asks in its own words, what it offered (a choice's options, a score's
 * number of levels) and the answer's headline. `p` is viewer-derived from an observed probability or yes/no value;
 * `confidence` exists only when the model actually supplied it. */
export type AnswerSummary = { id: string; type: string; asks: string; options?: string[]; levels?: number; choice?: string; score?: number; noul?: number; confidence?: number; p?: number; probabilities?: Record<string, number> };
export const DECISION_EVENT_SCHEMA = "layaview.decision-event.v1" as const;
export type SourceProvenance = { kind: string; id?: string; at?: string; text?: string; uri?: string };
export type DecisionEventV1 = {
  schema: typeof DECISION_EVENT_SCHEMA; eventId: string; parentEventId: string | null; callId: number;
  provenance: { source: SourceProvenance; label: string; at: string; requestKey: string; stateKey: string | null };
  request: { questionId: string; type: string; asks: string; requestedModel: string | null; options?: string[]; levels?: number };
  model: { answeredBy: string | null; observed: { choice?: string; score?: number; noul?: number; confidence?: number; probabilities?: Record<string, number> } };
  derived: { landing: string | null; selectedProbability?: number; uncertainty: { confidence: "reported" | "missing"; calibration: "warning" | "unspecified"; warnings?: string[] } };
};
/** Display cap for the compact summary's option/probability lists only. Canonical decision events are never capped. */
const OPTIONS_LISTED = 60;
/** One recorded Laya call, as listed. `key` is the sha256 of the exact body sent to Laya: the same request always has
 * the same key, so a client that caches Laya answers by that hash can find the call here. */
export type JeviewSummary = {
  id: number; at: string; label: string; trigger: string | null; display?: Record<string, string>; source: SourceProvenance;
  key: string; stateKey: string | null; status: number; elapsedMs: number; bytes: number;
  model: string | null; answeredBy: string | null; inputTokens: number | null; cost: number | null; questions: AnswerSummary[]; events: DecisionEventV1[]; error?: string;
};
/** The whole call: the request as sent to Laya (parsed, or its text when it was not JSON) and the response as Laya returned it. */
export type JeviewRecord = { summary: JeviewSummary; request: unknown; response: unknown };

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return text; } };

/** The event id of one answer: the call it came in and the question it answered. */
export const eventId = (call: number, question: string) => `${call}:${question}`;
/** Layaview's own headers, including Jeview's legacy spellings, are read here and never sent on to Laya. */
const OWN_HEADERS = ["layaview-", "jeview-"];
const ownHeader = (req: IncomingMessage, name: string) => req.headers[`layaview-${name}`] ?? req.headers[`jeview-${name}`];
/** The answer a request follows from, if its Layaview-Trigger header names one: an event id of at most 200 characters. */
export function requestTrigger(value: string | null): string | null {
  if (value === null) return null;
  if (!value.trim() || value.length > 200) throw Error("trigger must be the event id of an earlier answer, such as \"57:personal\"");
  return value.trim();
}

/** Which part of an option's criteria the viewer shows for it, from a Layaview-Display header: one field for every question
 * ("name"), or a field per question ("category=name, kind=title"); a field may be a path ("meta.title"). "*" holds the
 * field for every question. Without the header an option is shown by its key. The header is only for show, so one that
 * cannot be read is dropped: it is never a reason to refuse a call. */
const DISPLAY_FIELD = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
export function requestDisplay(value: string | null): Record<string, string> | null {
  if (!value || value.length > 500) return null;
  const display: Record<string, string> = {};
  for (const part of value.split(",")) {
    const [left = "", right] = part.split("=").map((word) => word.trim());
    if (right === undefined) { if (DISPLAY_FIELD.test(left)) display["*"] = left; }
    else if (left && left.length <= 100 && DISPLAY_FIELD.test(right)) display[left] = right;
  }
  return Object.keys(display).length ? display : null;
}

/** The question's own sentence: its instructions, or their `question` field when they carry context beside it. */
export function asks(instructions: unknown): string {
  const text = typeof instructions === "string" ? instructions : object(instructions) && typeof instructions.question === "string" ? instructions.question : JSON.stringify(instructions) ?? "";
  return text.length > 300 ? text.slice(0, 297) + "..." : text;
}

export function summarize(call: { id: number; at: string; label: string; trigger: string | null; display?: Record<string, string>; source?: SourceProvenance; status: number; elapsedMs: number; error?: string }, body: Buffer, request: unknown, response: unknown): JeviewSummary {
  const questions = object(request) && object(request.questions) ? request.questions : {};
  const answers = object(response) && object(response.answers) ? response.answers : {};
  const usage = object(response) && object(response.usage) ? response.usage : {};
  const runtime = object(response) && object(response.runtime) ? response.runtime : {};
  const warnings = Array.isArray(runtime.warnings) ? runtime.warnings.filter((value): value is string => typeof value === "string") : [];
  const calibration = runtime.calibration === "warning" ? "warning" as const : "unspecified" as const;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
  const key = sha256(body), stateKey = object(request) && "state" in request ? sha256(JSON.stringify(request.state) ?? "null") : null;
  const model = object(request) && typeof request.model === "string" ? request.model : null;
  const answeredBy = object(response) && typeof response.model === "string" ? response.model : null;
  const source = call.source ?? { kind: "live" };
  const summaries: AnswerSummary[] = [], events: DecisionEventV1[] = [];
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id], summary: AnswerSummary = { id, type: object(question) && typeof question.type === "string" ? question.type : "unknown", asks: asks(object(question) ? question.instructions : undefined) };
    // The compact summary lists at most OPTIONS_LISTED options for display; the canonical event keeps them all.
    const allOptions = object(question) && question.type === "choice" && object(question.criteria) ? Object.keys(question.criteria) : undefined;
    if (allOptions) summary.options = allOptions.slice(0, OPTIONS_LISTED);
    if (object(question) && question.type === "score" && Array.isArray(question.criteria)) summary.levels = question.criteria.length;
    if (object(answer)) for (const field of ["choice", "score", "noul", "confidence"] as const) if (typeof answer[field] === (field === "choice" ? "string" : "number")) (summary as Record<string, unknown>)[field] = answer[field];
    const probabilities = object(answer) && object(answer.probabilities) ? Object.fromEntries(Object.entries(answer.probabilities).filter(([, value]) => typeof value === "number")) as Record<string, number> : undefined;
    if (probabilities && Object.keys(probabilities).length) summary.probabilities = Object.fromEntries(Object.entries(probabilities).slice(0, OPTIONS_LISTED));
    const landing = summary.choice ?? (summary.noul === undefined ? (summary.score === undefined ? null : `level ${Math.round(summary.score)}`) : summary.noul >= 0.5 ? "yes" : "no");
    const probabilityKey = summary.choice ?? (summary.score === undefined ? undefined : String(Math.round(summary.score)));
    const selectedProbability = probabilityKey !== undefined && probabilities && typeof probabilities[probabilityKey] === "number" ? probabilities[probabilityKey] : summary.noul === undefined ? undefined : Math.max(summary.noul, 1 - summary.noul);
    if (selectedProbability !== undefined) summary.p = selectedProbability;
    const observed: DecisionEventV1["model"]["observed"] = {};
    for (const field of ["choice", "score", "noul", "confidence"] as const) if (summary[field] !== undefined) (observed as Record<string, unknown>)[field] = summary[field];
    if (probabilities && Object.keys(probabilities).length) observed.probabilities = probabilities;
    events.push({
      schema: DECISION_EVENT_SCHEMA, eventId: eventId(call.id, id), parentEventId: call.trigger, callId: call.id,
      provenance: { source, label: call.label, at: call.at, requestKey: key, stateKey },
      request: { questionId: id, type: summary.type, asks: summary.asks, requestedModel: model, ...(allOptions ? { options: allOptions } : {}), ...(summary.levels !== undefined ? { levels: summary.levels } : {}) },
      model: { answeredBy, observed },
      derived: { landing, ...(selectedProbability !== undefined ? { selectedProbability } : {}), uncertainty: { confidence: summary.confidence === undefined ? "missing" : "reported", calibration, ...(warnings.length ? { warnings } : {}) } },
    });
    summaries.push(summary);
  }
  return { ...call, source, key, stateKey, bytes: body.length, model, answeredBy, inputTokens, cost: null, questions: summaries, events };
}

/** Everything the proxy keeps, in one SQLite database in a folder private to the user: each call whole, in the order
 * calls finished (so a reader polling from a position never misses a slower call). Nothing is held in memory, so a
 * long history costs nothing to start with, and two Layaviews may share a folder. */
export class JeviewStore {
  readonly dir: string;
  readonly database: string;
  private readonly db: DatabaseSync;
  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    this.database = join(this.dir, DATABASE);
    this.db = new DatabaseSync(this.database);
    chmodSync(this.database, 0o600);
    const calls = "(seq INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL UNIQUE, at TEXT NOT NULL, label TEXT NOT NULL, trigger TEXT, key TEXT NOT NULL, status INTEGER NOT NULL, summary TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL)";
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS calls ${calls};
      CREATE INDEX IF NOT EXISTS calls_trigger ON calls (trigger);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
  }
  /** The next call id. A call is given its id when it starts and saved when it ends, so the ids in flight are counted
   * in the database, in one statement: two Layaviews sharing a folder never hand out the same one. It also stays ahead
   * of every id already saved, in case an older Layaview, which counted in memory, is writing to the same folder. */
  allocate(): number {
    return Number(this.db.prepare("INSERT INTO counters (name, value) VALUES ('call', (SELECT COALESCE(MAX(id), 0) + 1 FROM calls)) ON CONFLICT (name) DO UPDATE SET value = MAX(value, (SELECT COALESCE(MAX(id), 0) FROM calls)) + 1 RETURNING value").get()!.value);
  }
  save(record: JeviewRecord) {
    const { summary } = record;
    this.db.prepare("INSERT INTO calls (id, at, label, trigger, key, status, summary, request, response) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(summary.id, summary.at, summary.label, summary.trigger, summary.key, summary.status, JSON.stringify(summary), JSON.stringify(record.request), JSON.stringify(record.response));
  }
  /** The position of the latest call: positions count calls in the order they finished. */
  last(): number { return Number(this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM calls").get()!.seq); }
  count(): number { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM calls").get()!.n); }
  /** Summaries after position `since`, at most `limit` at a time: `cursor` is the next `since`, and `more` says the
   * next page is already there. A position from a database that has since been replaced falls back to this one's end. */
  list(since: number, limit: number): { records: JeviewSummary[]; cursor: number; more: boolean } {
    const rows = this.db.prepare("SELECT seq, summary FROM calls WHERE seq > ? ORDER BY seq LIMIT ?").all(since, limit + 1), page = rows.slice(0, limit);
    return { records: page.map((row) => JSON.parse(String(row.summary)) as JeviewSummary), cursor: page.length ? Number(page.at(-1)!.seq) : Math.min(since, this.last()), more: rows.length > limit };
  }
  /** Where the latest `n` calls begin, and how many older calls come before them. */
  latest(n: number): { since: number; older: number } {
    const since = Math.max(0, this.last() - n);
    return { since, older: since ? Number(this.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE seq <= ?").get(since)!.n) : 0 };
  }
  /** The summaries of the calls with these ids, for a reader that has not loaded them. */
  summariesOf(ids: number[]): JeviewSummary[] {
    if (!ids.length) return [];
    return this.db.prepare(`SELECT summary FROM calls WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`).all(...ids).map((row) => JSON.parse(String(row.summary)) as JeviewSummary);
  }
  read(id: number): JeviewRecord | null {
    const row = this.db.prepare("SELECT summary, request, response FROM calls WHERE id = ?").get(id);
    return row ? { summary: JSON.parse(String(row.summary)), request: JSON.parse(String(row.request)), response: JSON.parse(String(row.response)) } : null;
  }
  /** Ids of calls whose provenance, label, trigger, request or response contains every word, case-insensitively. */
  search(query: string, limit = 1000): number[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const like = words.map(() => "lower(summary || ' ' || label || ' ' || COALESCE(trigger, '') || ' ' || request || ' ' || response) LIKE ? ESCAPE '\\'").join(" AND ");
    return this.db.prepare(`SELECT id FROM calls WHERE ${like} ORDER BY id DESC LIMIT ?`).all(...words.map((word) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), limit).map((row) => Number(row.id));
  }
  setting(name: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE name = ?").get(name);
    return row ? String(row.value) : undefined;
  }
  setSetting(name: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM settings WHERE name = ?").run(name);
    else this.db.prepare("INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").run(name, value);
  }
  private closed = false;
  close() { if (!this.closed) { this.closed = true; this.db.close(); } } // the server may be closed more than once
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) { reject(Object.assign(Error(`request body exceeds ${limit} bytes`), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on("error", reject);
    req.on("end", () => accept(Buffer.concat(chunks)));
  });
}
const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

/** How to connect, for people and agents: served at /llms.txt with this proxy's own address. */
export function llmsText(origin: string, _legacyKeyed = false): string {
  return `# Layaview

A local visualizer for Laya decisions at ${origin}, with a live view of every call at ${origin}/
Layaview is a gateway, not a model: it sits between a System One-shaped client and a local Laya adapter. Each request
goes to that adapter, Laya's answer goes back to the caller, and the call is kept whole (what was asked, what Laya
answered) in a SQLite database on this machine. By default both Layaview and the Laya adapter stay on loopback.

## Send Laya decision requests here

Send ${origin}/v1/systemone a JSON body { model, state, questions }. To group requests under a project or label, add it
to the path: ${origin}/<label>/v1/systemone.

## Import transcript or history

POST ${origin}/_/api/ingest with { source, request, label?, trigger? }. source.kind must be "transcript" or "history" and
may carry id, at, text and uri. request is the ordinary { model, state, questions } object. Layaview runs it through the
same Laya adapter and persistence path as live traffic; it does not invent questions or answers from raw text.
It imports structured items only: it does not automatically turn arbitrary transcripts into questions.

Recorded summaries include layaview.decision-event.v1 events. model.observed contains only fields returned by Laya;
derived contains viewer-computed landing, selected probability and uncertainty labels. Missing confidence stays missing.

## Link a question to the answer that led to it

Every answer comes back with an event id in "events": { "<question id>": "<call>:<question id>" }.
When a later request follows from one of those answers, send its event id in a header:
Layaview-Trigger: <event id>.
The viewer grows that request's questions as a branch off the answer that triggered them. Layaview strips both
Layaview-* headers and legacy Jeview-* aliases before calling Laya, and sends the body on exactly as it came.

## Show an option by its name, not its key

The viewer labels each answer with the option's key, such as "c14". When the criteria behind the keys are objects, use
Layaview-Display: name, or a field per question: Layaview-Display: category=name, kind=title. A field may be a path,
such as meta.title. Legacy Jeview-Display remains accepted as a compatibility alias.

## When a call is refused

Whatever the Laya adapter answers, a refusal included, comes back to the caller. Layaview's own refusals are JSON,
{ "error": "..." }:

- 400: a Layaview-Trigger that is empty or longer than 200 characters.
- 413: a body over ${BODY_LIMIT / 1024 / 1024} MB.
- 502: Laya could not be reached, or its answer was cut short.
- 403: the request came from a web page on another site. Layaview serves programs on this machine, not pages elsewhere.

Laya's answers and refusals are recorded, and so are 502s. The 400s, 413s and 403s are not.

## Read what was recorded (JSON, from this machine only)

- GET ${origin}/_/api/records?since=<n>: summaries in the order calls finished, at most ${PAGE.toLocaleString("en")} at a time.
- GET ${origin}/_/api/records?ids=<id>,<id>: summaries of named calls, at most ${IDS_LISTED.toLocaleString("en")}.
- GET ${origin}/_/api/records/<id>: one call, the request sent to Laya and the response it returned.
- GET ${origin}/_/api/search?q=<words>: ids of calls whose provenance, label, trigger, request or response contains every word.

A record's "key" is the sha256 of the exact body sent to Laya.
`;
}

export type JeviewOptions = { dir: string; layaEndpoint?: string; jevEndpoint?: string; port?: number; fetch?: typeof fetch; ui?: string | URL };
export type Jeview = { server: Server; store: JeviewStore };

export function createJeview(options: JeviewOptions): Jeview {
  const endpoint = new URL(options.layaEndpoint ?? options.jevEndpoint ?? LAYA_ENDPOINT);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw Error(`layaview: the Laya endpoint must be an http(s) URL, not ${endpoint.protocol}`);
  if (options.port !== undefined && LOOPBACK.test(endpoint.hostname) && Number(endpoint.port || 80) === options.port) throw Error(`layaview: the Laya endpoint ${endpoint.origin} is this proxy`);
  const layaEndpoint = endpoint.href, request = options.fetch ?? fetch, store = new JeviewStore(options.dir);
  const ui = resolve(fileURLToPath(options.ui ?? new URL("../ui/", import.meta.url)));

  type RunResult = { status: number; headers: Record<string, string>; reply: Buffer };
  type RunMeta = { label: string; trigger: string | null; display?: Record<string, string>; source: SourceProvenance };

  /** One Laya call shared by live proxy traffic and imported history. Raw model output is persisted; events are viewer metadata. */
  async function runCall(sent: Buffer, requestValue: unknown, headers: Record<string, string>, meta: RunMeta): Promise<RunResult> {
    const id = store.allocate(), at = new Date().toISOString(), started = Date.now();
    const keep = (status: number, text: string, error?: string) => {
      const responseValue = text ? parse(text) : null;
      store.save({ summary: summarize({ id, at, label: meta.label, trigger: meta.trigger, source: meta.source, ...(meta.display ? { display: meta.display } : {}), status, elapsedMs: Date.now() - started, ...(error ? { error } : {}) }, sent, requestValue, responseValue), request: requestValue, response: responseValue });
    };
    const fail = (status: number, message: string): RunResult => {
      keep(status, "", message);
      return { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, reply: Buffer.from(JSON.stringify({ error: message })) };
    };
    let response: Response;
    try { response = await request(layaEndpoint, { method: "POST", headers, body: new Uint8Array(sent), redirect: "manual" }); }
    catch (error) { return fail(502, `Laya unreachable: ${(error as Error).message}`); }
    let text: Buffer;
    try { text = Buffer.from(await response.arrayBuffer()); } catch (error) { return fail(502, `Laya's answer was cut short: ${(error as Error).message}`); }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => { if (!RESPONSE_DROP.has(name) && !name.startsWith("access-control-")) responseHeaders[name] = value; });
    const returned = parse(text.toString("utf8"));
    const events = object(returned) && object(returned.answers) ? Object.fromEntries(Object.keys(returned.answers).map((question) => [question, eventId(id, question)])) : null;
    const reply = events && object(returned) ? Buffer.from(JSON.stringify({ ...returned, events })) : text;
    keep(response.status, text.toString("utf8"));
    return { status: response.status, headers: responseHeaders, reply };
  }

  async function ask(req: IncomingMessage, res: ServerResponse, label: string) {
    let body: Buffer;
    try { body = await readBody(req, BODY_LIMIT); } catch (error) { return send(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message }); }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) if (!REQUEST_DROP.has(name) && !OWN_HEADERS.some((prefix) => name.startsWith(prefix)) && value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    const triggerHeader = ownHeader(req, "trigger");
    let trigger: string | null;
    try { trigger = requestTrigger(triggerHeader === undefined ? null : String(triggerHeader)); } catch (error) { return send(res, 400, { error: `layaview: ${(error as Error).message}` }); }
    const displayHeader = ownHeader(req, "display"), display = requestDisplay(displayHeader === undefined ? null : String(displayHeader));
    const result = await runCall(body, parse(body.toString("utf8")), headers, { label, trigger, source: { kind: "live" }, ...(display ? { display } : {}) });
    res.writeHead(result.status, result.headers);
    res.end(result.reply);
  }

  /** Replay one transcript/history item through Laya without inventing questions, branches, or model fields. */
  async function ingest(req: IncomingMessage, res: ServerResponse) {
    let body: Buffer;
    try { body = await readBody(req, BODY_LIMIT); } catch (error) { return send(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message }); }
    const envelope = parse(body.toString("utf8"));
    if (!object(envelope) || !object(envelope.request) || !object(envelope.source)) return send(res, 400, { error: "layaview: ingest requires { source, request }" });
    const kind = typeof envelope.source.kind === "string" ? envelope.source.kind.trim() : "";
    if (kind !== "transcript" && kind !== "history") return send(res, 400, { error: "layaview: source.kind must be transcript or history" });
    const source: SourceProvenance = { kind };
    for (const field of ["id", "at", "text", "uri"] as const) if (typeof envelope.source[field] === "string") source[field] = envelope.source[field];
    const label = typeof envelope.label === "string" ? envelope.label : "";
    const triggerValue = envelope.trigger === undefined || envelope.trigger === null ? null : String(envelope.trigger);
    let trigger: string | null;
    try { trigger = requestTrigger(triggerValue); } catch (error) { return send(res, 400, { error: `layaview: ${(error as Error).message}` }); }
    const sent = Buffer.from(JSON.stringify(envelope.request));
    const result = await runCall(sent, envelope.request, { "content-type": "application/json" }, { label, trigger, source });
    res.writeHead(result.status, result.headers);
    res.end(result.reply);
  }

  const server = createServer((req, res) => {
    void (async () => {
      // Host allowlist against DNS rebinding: a page on another site must not read the records through a local name.
      if (!LOOPBACK.test(req.headers.host ?? "")) return send(res, 403, { error: "Host not allowed" });
      const url = new URL(req.url ?? "/", "http://proxy");
      // a Laya request: POST .../v1/systemone; whatever comes before names the run
      if (url.pathname.endsWith(LAYA_PATH) && !url.pathname.startsWith("/_/")) {
        if (req.method !== "POST") return send(res, 405, { error: "Laya requests are POSTed" });
        if (foreign(req.headers.origin)) return send(res, 403, { error: "Laya requests cannot come from a page on another site" }); // refused unrecorded: such a page could otherwise fill the database
        const segments = url.pathname.slice(0, -LAYA_PATH.length).split("/").filter(Boolean).map(decodeURIComponent);
        if (segments.at(-1) === "typesafe" || segments.at(-1) === "laya") segments.pop(); // compatibility/vendor path segment
        return ask(req, res, segments.join("/"));
      }
      if (url.pathname === "/_/api/ingest") {
        if (req.method !== "POST") return send(res, 405, { error: "Imported history is POSTed to /_/api/ingest" });
        if (foreign(req.headers.origin) || req.headers["sec-fetch-site"] === "cross-site") return send(res, 403, { error: "The ingest API is not for pages on other sites" });
        return ingest(req, res);
      }
      if (req.method !== "GET") return send(res, 405, { error: "Send live Laya requests to /v1/systemone or imported history to /_/api/ingest" });
      // a page on another site cannot read what the API answers, and should not get to make it search either; the viewer
      // itself stays reachable, since a link to it from another site is that kind of request too
      if (req.headers["sec-fetch-site"] === "cross-site" && url.pathname.startsWith("/_/api/")) return send(res, 403, { error: "The API is not for pages on other sites" });
      if (url.pathname === "/llms.txt") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return void res.end(llmsText(`http://${req.headers.host}`));
      }
      const file = url.pathname === "/" ? "index.html" : /^\/_\/ui\/([a-z-]+\.(?:css|js))$/.exec(url.pathname)?.[1];
      if (file) {
        let content: Buffer;
        try { content = readFileSync(join(ui, file)); } catch { return send(res, 404, { error: "Not found" }); }
        res.writeHead(200, { "content-type": UI_TYPES[extname(file)]!, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": CSP });
        return void res.end(content);
      }
      if (url.pathname === "/_/api/records") {
        const whole = (name: string) => Math.max(0, Math.floor(Number(url.searchParams.get(name)) || 0)), ids = url.searchParams.get("ids");
        if (ids !== null) return send(res, 200, { records: store.summariesOf([...new Set(ids.split(",").map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, IDS_LISTED)) });
        // everything after a position, or (for a viewer opening on a long history) only the latest calls; a page at a time
        const from = whole("latest") ? store.latest(whole("latest")) : null;
        return send(res, 200, { ...store.list(from ? from.since : whole("since"), Math.min(whole("limit") || PAGE, PAGE)), ...(from ? { older: from.older } : {}), laya: endpoint.host, database: store.database });
      }
      const one = /^\/_\/api\/records\/(\d+)$/.exec(url.pathname);
      if (one) { const record = store.read(Number(one[1])); return record ? send(res, 200, record) : send(res, 404, { error: "No such record" }); }
      if (url.pathname === "/_/api/search") return send(res, 200, { ids: store.search(url.searchParams.get("q") ?? "") });
      return send(res, 404, { error: "Not found" });
    })().catch((error: unknown) => { if (!res.headersSent) send(res, 500, { error: (error as Error).message }); else res.destroy(); });
  });
  server.on("close", () => store.close());
  return { server, store };
}
