// A stand-in for Ollama that answers from a queue and records what it was asked.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Fake {
  host: string;
  replies: (object | string | number)[];
  requests: { model: string; messages: { role: string; content: string }[]; format?: unknown; options?: { temperature?: number } }[];
  fail: number | null;
  close: () => Promise<void>;
}

export async function startFake(): Promise<Fake> {
  const fake: Partial<Fake> = { replies: [], requests: [], fail: null };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    fake.requests!.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (fake.fail) { res.statusCode = fake.fail; res.end("{}"); return; }
    const next = fake.replies!.shift() ?? {};
    const send = (b: object | string) => res.end(JSON.stringify({ message: { content: typeof b === "string" ? b : JSON.stringify(b) } }));
    if (typeof next === "number") { setTimeout(() => send({}), next); return; }
    send(next);
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Node's fetch keeps connections alive, and server.close() waits for them, so they are closed
  // explicitly or a test file hangs after its last request.
  fake.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return fake as Fake;
}

/** The line numbers firstfail offered the model, which is what a choice has to match. */
export function linesInPrompt(f: Fake, n = 0): number[] {
  const user = f.requests[n]?.messages?.[1]?.content ?? "";
  return [...user.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
}

export const promptOf = (f: Fake, n = 0): string => f.requests[n]?.messages?.[1]?.content ?? "";
